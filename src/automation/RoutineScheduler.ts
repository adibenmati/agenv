import * as path from "path";
import { HttpError } from "../core/HttpError";
import type { AutomationGuards } from "./AutomationGuards";
import { nextCronTime } from "./cron";
import { DEFAULT_BUDGET_USD, Routine } from "./Routine";
import type { RoutineStore } from "./RoutineStore";
import { finishRun, RunExecutor, RunOutcome } from "./RunExecutor";
import { RunQueue } from "./RunQueue";
import { MAX_RUNS, Run, RunStore, RunTrigger } from "./RunStore";

export const TICK_MS = 30_000;
/**
 * A due routine more than this late (a sleeping laptop, a clock jump) is a missed run, handled by its catch-up policy.
 * This is the minimum: the effective grace is max(120 s, 4 x tick interval), so a custom interval scales it.
 */
export const MISSED_GRACE_MS = 120_000;
/** Missed slots are counted (for the visible note) up to this many; more shows as "N+". */
const MISSED_COUNT_CAP = 1000;
/** Most missed slots `enqueue_missed_with_cap` replays. */
export const CATCH_UP_CAP = 25;

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Budget already promised to running runs other than `exceptRunId` (their cost is only recorded when they finish). */
export function reservedUsd(runs: Pick<RunStore, "list">, routines: Pick<RoutineStore, "get">, exceptRunId?: string): number {
  let sum = 0;
  for (const r of runs.list(undefined, MAX_RUNS)) {
    if (r.status !== "running" || r.id === exceptRunId) continue;
    sum += routines.get(r.routineId)?.maxBudgetUsd ?? DEFAULT_BUDGET_USD;
  }
  return sum;
}

export interface PreflightOptions {
  runs: Pick<RunStore, "list" | "update">;
  routines: Pick<RoutineStore, "get">;
  guards: Pick<AutomationGuards, "check">;
  now: () => number;
}

/**
 * The executor's dequeue-time check. It CLAIMS atomically: when it returns null it has, in the same synchronous step,
 * marked the run running with startedAt = now, so the next dequeue's guard check counts this run (runs/day) and reserves its
 * budget (cost cap) even though its process has not spawned yet.
 */
export function makePreflight(o: PreflightOptions): (run: Run, routine: Routine) => string | null {
  return (run, routine) => {
    const g = o.guards.check(routine, run.trigger, { reservedUsd: reservedUsd(o.runs, o.routines, run.id) });
    if (!g.ok) return g.reason;
    o.runs.update(run.id, { status: "running", startedAt: o.now() });
    return null;
  };
}

export interface RunQueueWiring {
  limit: number;
  routines: Pick<RoutineStore, "get" | "setSchedule">;
  runs: Pick<RunStore, "update">;
  executor: RunExecutor;
  now: () => number;
  onChange: () => void;
}

/**
 * The global run queue with the job that runs one routine: execute through the executor, record the outcome with
 * finishRun, then bookkeeping on the routine (lastRunAt). Whatever happens, the run ends in a final status.
 */
export function createRunQueue(o: RunQueueWiring): RunQueue {
  const failed = (e: unknown): RunOutcome => ({
    status: "failed", conversationId: "", text: "", costUsd: 0, numTurns: 0, durationMs: 0, exitCode: null, error: errMsg(e) || "unexpected error",
  });

  const settle = (run: Run, routine: Routine | undefined, outcome: RunOutcome): void => {
    try {
      finishRun(o.runs, run, routine ?? ({ maxBudgetUsd: DEFAULT_BUDGET_USD } as Routine), outcome, o.now);
      if (outcome.status === "skipped") {
        o.runs.update(run.id, { startedAt: null });          // the dequeue claim marked it started; it never ran
      } else if (routine) {
        const cur = o.routines.get(routine.id);
        if (cur) o.routines.setSchedule(cur.id, { nextRunAt: cur.nextRunAt, lastRunAt: o.now() });
      }
    } finally {
      try { o.onChange(); } catch {}
    }
  };

  return new RunQueue({
    limit: o.limit,
    keyOf: (run) => {
      const t = o.routines.get(run.routineId)?.target;
      if (!t) return null;
      return t.kind === "agent" ? `agent:${t.agentId}` : `folder:${path.resolve(t.cwd)}`;   // same keys as AgentService's chains
    },
    execute: async (run, register) => {
      const routine = o.routines.get(run.routineId);
      if (!routine) { settle(run, undefined, { status: "skipped", reason: "routine no longer exists" }); return; }
      let handle: ReturnType<RunExecutor["execute"]>;
      try {
        handle = o.executor.execute(run, routine, { onStart: () => { try { o.onChange(); } catch {} } });
      } catch (e) { settle(run, routine, failed(e)); return; }
      register(handle.cancel);
      let outcome: RunOutcome;
      try { outcome = await handle.done; } catch (e) { outcome = failed(e); }
      settle(run, routine, outcome);
    },
    onError: (run, err) => {
      try { o.runs.update(run.id, { status: "failed", finishedAt: o.now(), error: `unexpected error: ${errMsg(err)}` }); } catch {}
      try { o.onChange(); } catch {}
    },
  });
}

export interface RoutineSchedulerOptions {
  routines: RoutineStore;
  runs: RunStore;
  guards: Pick<AutomationGuards, "check">;
  queue: RunQueue;
  now: () => number;
  onChange: () => void;
  /** Lateness beyond which a due routine counts as missed instead of firing. Default max(120 s, 4 x tick interval). */
  missedGraceMs?: number;
  /** The tick interval the grace scales with until start(intervalMs) says otherwise. Default 30 s. */
  tickMs?: number;
  log?: (msg: string) => void;
}

/**
 * Fires routines. Every decision is made against the injected clock. A due routine is claimed (its nextRunAt advanced and
 * persisted) before anything else happens, so a crash can never fire the same slot twice.
 */
export class RoutineScheduler {
  private timer: NodeJS.Timeout | null = null;
  private intervalMs: number;
  private readonly log: (msg: string) => void;

  constructor(private readonly o: RoutineSchedulerOptions) {
    this.intervalMs = o.tickMs ?? TICK_MS;
    this.log = o.log ?? ((m) => console.error(`[agenv] ${m}`));
  }

  private graceMs(): number { return this.o.missedGraceMs ?? Math.max(MISSED_GRACE_MS, 4 * this.intervalMs); }

  /**
   * Fires every enabled routine whose slot has come (up to the grace late); one that is further overdue (clock jump, sleep)
   * follows its catch-up policy. A routine whose nextRunAt is later than the next real slot (the clock moved back) gets it recomputed.
   */
  tick(): void {
    const now = this.o.now();
    let routines: Routine[];
    try { routines = this.o.routines.list().filter((r) => r.enabled && r.nextRunAt !== null); } catch (e) {
      this.log(`scheduler could not read routines: ${errMsg(e)}`);
      return;
    }
    for (const r of routines) {
      try {
        if ((r.nextRunAt as number) <= now) this.handleDue(r, now);
        else this.fixBackwardJump(r, now);
      } catch (e) { this.log(`routine ${r.id} could not be fired: ${errMsg(e)}`); }
    }
  }

  /** After a restart: close runs the dead server left active, then treat every due routine exactly as the tick would. */
  startup(): void {
    let interrupted = 0;
    try { interrupted = this.o.runs.markInterrupted(); } catch (e) { this.log(`could not close interrupted runs: ${errMsg(e)}`); }
    const now = this.o.now();
    for (const r of this.o.routines.list()) {
      if (!r.enabled || r.nextRunAt === null || r.nextRunAt > now) continue;
      try { this.handleDue(r, now); } catch (e) { this.log(`catch-up of routine ${r.id} failed: ${errMsg(e)}`); }
    }
    if (interrupted) this.change();
  }

  start(intervalMs: number = TICK_MS): void {
    if (this.timer) return;
    this.intervalMs = intervalMs;
    this.timer = setInterval(() => {
      try { this.tick(); } catch (e) { this.log(`scheduler tick failed: ${errMsg(e)}`); }
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Run now: obeys pause and the guards (a refusal is a 409 with the reason and records nothing) and the routine's
   * concurrency policy (an already active run gives a coalesced / skipped record); never touches nextRunAt.
   */
  runManually(routine: Routine): Run { return this.dispatch(routine, "manual", true); }

  /** A due routine: on time (within the grace) it fires as a normal scheduled run, otherwise its slots were missed. */
  private handleDue(r: Routine, now: number): void {
    if (now - (r.nextRunAt as number) <= this.graceMs()) {
      if (this.claim(r, now)) this.dispatch(r, "schedule");
    } else this.catchUp(r, now);
  }

  /**
   * Persists the next future slot. Must happen before the run is created. False when the schedule cannot be evaluated:
   * the routine is then stopped (nextRunAt null) and the failure is recorded once as a skipped run.
   */
  private claim(r: Routine, now: number): boolean {
    let next: number | null;
    try { next = nextCronTime(r.cron, r.timezone, now); } catch (e) { this.invalidSchedule(r, e); return false; }
    this.o.routines.setSchedule(r.id, { nextRunAt: next });
    return true;
  }

  private invalidSchedule(r: Routine, e: unknown): void {
    this.o.routines.setSchedule(r.id, { nextRunAt: null });
    this.record(r, "schedule", "skipped", `invalid schedule: ${errMsg(e)}`);
  }

  private fixBackwardJump(r: Routine, now: number): void {
    let next: number | null;
    try { next = nextCronTime(r.cron, r.timezone, now); } catch { return; }
    if (next !== null && (r.nextRunAt as number) > next) this.o.routines.setSchedule(r.id, { nextRunAt: next });
  }

  /**
   * The routine's slot(s) passed unnoticed (more than the grace ago). Ruling (spec section 5.6 vs the brief): `skip_missed`
   * means slots older than the grace are NOT run, not even once; the routine just jumps to its next future slot. A slot
   * within the grace is not missed: it fires as one normal scheduled run (never twice for one slot).
   * `enqueue_missed_with_cap` replays the earliest 25 missed slots as `catch_up` runs. Either way one visible `skipped` row
   * says what was not run, and the next future slot is claimed before any run is created.
   */
  private catchUp(r: Routine, now: number): void {
    const windowStart = now - this.graceMs();
    const replay = r.catchUp === "enqueue_missed_with_cap";
    const slots: number[] = [];
    let missed = 0, current = false;
    try {
      let s: number | null = r.nextRunAt;
      while (s !== null && s < windowStart && missed < MISSED_COUNT_CAP) {
        if (slots.length < CATCH_UP_CAP) slots.push(s);
        missed++;
        s = nextCronTime(r.cron, r.timezone, s);
      }
      const first = nextCronTime(r.cron, r.timezone, windowStart - 1);
      current = first !== null && first <= now;
    } catch (e) { this.invalidSchedule(r, e); return; }
    if (!this.claim(r, now)) return;
    const n = missed >= MISSED_COUNT_CAP ? `${missed}+` : String(missed);
    if (replay) {
      for (let i = 0; i < slots.length; i++) {
        try { this.dispatch(r, "catch_up"); } catch (e) { this.log(`catch-up run of routine ${r.id} failed: ${errMsg(e)}`); }
      }
      if (missed > slots.length) this.record(r, "catch_up", "skipped", `catch-up: ran ${slots.length} of ${n} missed slots`);
    } else if (missed > 0) {
      this.record(r, "catch_up", "skipped", `missed ${n} slot${missed === 1 ? "" : "s"} while agenv was not running (skip_missed)`);
    }
    if (current) this.dispatch(r, "schedule", false, replay && slots.length > 0);   // queued behind the replay, not coalesced into it
    this.change();
  }

  /** Guards, then the concurrency policy, then the queue. Catch-up runs always queue (they are a replay of distinct slots). */
  private dispatch(r: Routine, trigger: RunTrigger, manual = false, forceQueue = false): Run {
    const { runs } = this.o;
    let verdict: { ok: true } | { ok: false; reason: string };
    try {
      verdict = this.o.guards.check(r, trigger, { reservedUsd: reservedUsd(runs, this.o.routines) });
    } catch (e) { verdict = { ok: false, reason: `guard check failed: ${errMsg(e)}` }; }
    if (!verdict.ok) {
      if (manual) throw new HttpError(409, verdict.reason);
      return this.record(r, trigger, "skipped", verdict.reason);
    }
    const policy = trigger === "catch_up" || forceQueue ? "always_enqueue" : r.concurrency;
    const active = runs.active(r.id);
    if (active && policy === "coalesce_if_active") return this.record(r, trigger, "coalesced", `coalesced into run ${active.id}`);
    if (active && policy === "skip_if_active") return this.record(r, trigger, "skipped", `previous run ${active.id} is still ${active.status}`);
    const run = runs.create(r.id, trigger, "queued");
    this.change();
    this.o.queue.enqueue(run);
    return runs.get(run.id) ?? run;
  }

  private record(r: Routine, trigger: RunTrigger, status: "skipped" | "coalesced", reason: string): Run {
    const run = this.o.runs.create(r.id, trigger, status, reason);
    this.change();
    return run;
  }

  private change(): void { try { this.o.onChange(); } catch {} }
}
