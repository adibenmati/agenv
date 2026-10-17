import { HttpError } from "../core/HttpError";
import { safeId } from "../core/ids";
import type { AgentService } from "../agents/AgentService";
import type { Session } from "../sessions/Session";
import type { AutomationSettings, AutomationSettingsData } from "./AutomationSettings";
import { nextCronTime } from "./cron";
import { resolveCron, Routine, RoutineInput, validateRoutineInput } from "./Routine";
import type { RoutineStore } from "./RoutineStore";
import type { RoutineScheduler } from "./RoutineScheduler";
import type { RunQueue } from "./RunQueue";
import { MAX_RUNS, Run, RunStore } from "./RunStore";

/** How long cancel / delete / dispose wait for a killed process to be recorded. */
const SETTLE_TIMEOUT_MS = 10_000;
const DISPOSE_WAIT_MS = 3000;
const isActive = (r: Run): boolean => r.status === "queued" || r.status === "running";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface AutomationServiceOptions {
  routines: RoutineStore;
  runs: RunStore;
  settings: AutomationSettings;
  scheduler: RoutineScheduler;
  queue: RunQueue;
  agents: Pick<AgentService, "openTerminal" | "openConversation" | "get">;
  isDir: (p: string) => boolean;
  agentExists: (id: string) => boolean;
  now: () => number;
  /** Timer functions for dispose's bounded wait; injectable so tests can prove none is left pending. */
  timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
  /** Called after any routine, run or settings change (wired to gateway.broadcastEvent("runs-updated")). */
  onChange: () => void;
}

/** What the HTTP layer calls: routines, runs, logs and the global switches. Every method throws HttpError for bad input. */
const realTimers = {
  set(fn: () => void, ms: number): unknown { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  clear(h: unknown): void { clearTimeout(h as NodeJS.Timeout); },
};

export class AutomationService {
  private readonly timers: NonNullable<AutomationServiceOptions["timers"]>;
  constructor(private readonly o: AutomationServiceOptions) { this.timers = o.timers ?? realTimers; }

  // ---- routines ----

  listRoutines(): Routine[] { return this.o.routines.list(); }

  /** Validates, computes nextRunAt from now and stores. A permission the client omits is acceptEdits (the agent's is not inherited). */
  createRoutine(input: unknown): Routine {
    const now = this.o.now();
    const v: RoutineInput = validateRoutineInput(input, { isDir: this.o.isDir, agentExists: this.o.agentExists, now });
    const routine = this.o.routines.add(v, nextCronTime(v.cron, v.timezone, now));
    this.change();
    return routine;
  }

  /**
   * Applies the editable fields of `patch`; `id`, `nextRunAt`, `lastRunAt`, `created` and `updated` from the client are
   * ignored. Changing the cron or timezone, or enabling a disabled routine, recomputes nextRunAt from now (so enabling
   * never replays what was missed while it was off).
   */
  updateRoutine(id: string, patch: unknown): Routine {
    const cur = this.must(id);
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new HttpError(400, "patch must be an object");
    const { id: _i, nextRunAt: _n, lastRunAt: _l, created: _c, updated: _u, ...edit } = patch as Record<string, unknown>;
    const cron = edit.cron !== undefined ? resolveCron(edit.cron) : cur.cron;
    const tz = edit.timezone !== undefined ? edit.timezone : cur.timezone;
    const enabled = edit.enabled !== undefined ? edit.enabled : cur.enabled;
    const scheduleChanged = cron !== cur.cron || tz !== cur.timezone || (!!enabled && !cur.enabled);
    const toStore: Record<string, unknown> = { ...edit };
    if (scheduleChanged) toStore.nextRunAt = nextCronTime(cron, tz as string, this.o.now());
    const routine = this.o.routines.update(id, toStore as Partial<Routine>);
    this.change();
    return routine;
  }

  /**
   * Removes the routine so nothing can fire it, cancels its queued and running runs, waits for the killed processes to be
   * recorded and then deletes its history and logs.
   */
  async deleteRoutine(id: string): Promise<void> {
    this.must(id);
    this.o.routines.remove(id);
    for (const run of this.o.runs.list(id, MAX_RUNS).filter(isActive)) this.cancelNow(run);
    await this.settled(() => this.o.runs.active(id) === undefined);
    // A process that would not die in time is closed by hand so the history can go.
    for (const run of this.o.runs.list(id, MAX_RUNS).filter(isActive)) this.markCancelled(run.id, "cancelled (routine deleted)");
    this.o.runs.removeForRoutine(id);
    this.change();
  }

  /** Run now. Throws 409 with the reason when paused or a daily limit is reached; never touches nextRunAt. */
  runNow(id: string): Run { return this.o.scheduler.runManually(this.must(id)); }

  // ---- runs ----

  /** Newest first; an unknown routine is a 404. */
  listRuns(routineId?: string, limit?: number): Run[] {
    if (routineId !== undefined) this.must(routineId);
    return this.o.runs.list(routineId, limit);
  }

  getRun(id: string): Run { return this.mustRun(id); }

  /** The last `tail` bytes of the run's log (at most 1 MB). */
  readLog(id: string, tail: number): string {
    this.mustRun(id);
    return this.o.runs.readLog(id, tail);
  }

  /** Queued: removed. Running: its process tree is killed and the final record is returned. Finished: 409. */
  async cancelRun(id: string): Promise<Run> {
    const run = this.mustRun(id);
    if (!isActive(run)) throw new HttpError(409, "the run has already finished");
    this.cancelNow(run);
    await this.settled(() => !isActive(this.o.runs.get(id) as Run));
    const cur = this.o.runs.get(id) as Run;
    if (isActive(cur)) this.markCancelled(id, "cancelled");
    this.change();
    return this.o.runs.get(id) as Run;
  }

  /**
   * "Open interactively": a normal terminal session. Conversation mode "agent" opens the agent's own terminal; fork, fresh
   * and folder runs open the run's conversation (in the agent's or the folder's cwd). 404 when the run produced no
   * conversation, 409 when it is still running and has none yet.
   */
  openRun(id: string): Session {
    const run = this.mustRun(id);
    const routine = this.o.routines.get(run.routineId);
    if (!routine) throw new HttpError(404, "routine not found");
    if (routine.conversation === "agent" && routine.target.kind === "agent") return this.o.agents.openTerminal(routine.target.agentId);
    if (!run.conversationId) {
      throw isActive(run) ? new HttpError(409, "the run has no conversation yet") : new HttpError(404, "the run has no conversation to open");
    }
    const cwd = routine.target.kind === "folder" ? routine.target.cwd : this.o.agents.get(routine.target.agentId).cwd;
    return this.o.agents.openConversation(run.conversationId, cwd);
  }

  // ---- global switches ----

  getSettings(): AutomationSettingsData { return this.o.settings.get(); }

  setSettings(patch: Partial<AutomationSettingsData>): AutomationSettingsData {
    const s = this.o.settings.set(patch);
    this.change();
    return s;
  }

  // ---- lifecycle ----

  /** Stops the tick, drops queued runs and cancels running ones, then waits (bounded) for them to be recorded. Call before agents.cancelAll(). */
  async dispose(): Promise<void> {
    this.o.scheduler.stop();
    for (const run of this.o.queue.drain()) this.markCancelled(run.id, "cancelled (server stopping)");
    let handle: unknown;
    const timeout = new Promise<void>((resolve) => { handle = this.timers.set(resolve, DISPOSE_WAIT_MS); });
    try { await Promise.race([this.o.queue.idle(), timeout]); } finally { this.timers.clear(handle); }
    this.change();
  }

  // ---- helpers ----

  private must(id: string): Routine {
    const r = this.o.routines.get(id);
    if (!r) throw new HttpError(404, "routine not found");
    return r;
  }

  private mustRun(id: string): Run {
    safeId(id, "invalid run id");
    const r = this.o.runs.get(id);
    if (!r) throw new HttpError(404, "run not found");
    return r;
  }

  /** Takes a queued run off the queue (recording it cancelled) or signals a running one; the running record follows asynchronously. */
  private cancelNow(run: Run): void {
    const known = this.o.queue.cancel(run.id);
    const cur = this.o.runs.get(run.id);
    if (cur && cur.status === "queued") this.markCancelled(run.id, "cancelled");
    else if (!known && cur && isActive(cur)) this.markCancelled(run.id, "cancelled");    // not in the queue: nothing will finish it
  }

  private markCancelled(id: string, reason: string): void {
    try { this.o.runs.update(id, { status: "cancelled", reason, finishedAt: this.o.now() }); } catch {}
  }

  private async settled(done: () => boolean): Promise<void> {
    const end = Date.now() + SETTLE_TIMEOUT_MS;
    while (!done() && Date.now() < end) await sleep(5);
  }

  private change(): void { try { this.o.onChange(); } catch {} }
}
