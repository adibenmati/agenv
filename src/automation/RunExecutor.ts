import { HttpError } from "../core/HttpError";
import { isSafeId } from "../core/ids";
import type { AgentService } from "../agents/AgentService";
import type { RunResult } from "../agents/ClaudeRunner";
import type { Routine } from "./Routine";
import type { Run, RunStore } from "./RunStore";

/** The run never started: the target, folder or conversation was unavailable. */
export interface SkippedResult { status: "skipped"; reason: string }
export type RunOutcome = RunResult | SkippedResult;

export interface ExecutorHooks { onStart: () => void }
export interface RunExecutor {
  /** Never throws and `done` never rejects; every failure is a resolved outcome. */
  execute(run: Run, routine: Routine, hooks: ExecutorHooks): { done: Promise<RunOutcome>; cancel(): void };
}

const MAX_ERROR = 500;
const clip = (s: string): string => (s.length > MAX_ERROR ? s.slice(0, MAX_ERROR - 1) + "…" : s);

export interface AgentRunExecutorOptions {
  agents: Pick<AgentService, "run" | "runInFolder">;
  runs: Pick<RunStore, "logPath" | "update">;
  now?: () => number;
  /**
   * Called at the start of execute(), i.e. when the queue actually dequeues the run and before anything spawns. A non-null
   * reason (pause, daily limit, cost cap that changed while the run waited) resolves the run as skipped.
   */
  preflight?: (run: Run, routine: Routine) => string | null;
}

function cancelledOutcome(): RunResult {
  return { status: "cancelled", conversationId: "", text: "", costUsd: 0, numTurns: 0, durationMs: 0, exitCode: null, error: "Cancelled before it started" };
}

/** Runs a routine's prompt through AgentService (agent target) or in a folder with no agent (folder target). */
export class AgentRunExecutor implements RunExecutor {
  private readonly now: () => number;
  constructor(private readonly o: AgentRunExecutorOptions) { this.now = o.now ?? Date.now; }

  execute(run: Run, routine: Routine, hooks: ExecutorHooks): { done: Promise<RunOutcome>; cancel(): void } {
    if (this.o.preflight) {
      let reason: string | null;
      try { reason = this.o.preflight(run, routine); } catch (e) { reason = `preflight failed: ${e instanceof Error ? e.message : String(e)}`; }
      if (reason) return { done: Promise.resolve({ status: "skipped", reason: clip(reason) }), cancel() {} };
    }

    const token = { cancelled: false };
    let handle: (() => void) | null = null;
    let started = false;
    let settle: (o: RunOutcome) => void = () => {};
    const done = new Promise<RunOutcome>((resolve) => { settle = resolve; });
    // The agent layer reports the handle once the process exists: that is the moment the run actually started.
    const onHandle = (cancel: () => void): void => {
      handle = cancel;
      if (started) return;
      started = true;
      try { this.o.runs.update(run.id, { status: "running", startedAt: this.now() }); } catch {}
      try { hooks.onStart(); } catch {}
    };
    const cancel = (): void => {
      token.cancelled = true;
      if (handle) { try { handle(); } catch {} return; }
      // Not started yet (possibly still waiting behind another run of the same agent): settle now so the queue slot frees
      // at once. The token stays set, so the agent layer's chain job becomes a no-op when its turn comes.
      if (!started) settle(cancelledOutcome());
    };

    const timeoutMs = routine.timeoutMin * 60_000;
    const t = routine.target;
    let call: Promise<RunResult>;
    try {
      const logPath = this.o.runs.logPath(run.id);
      const model = routine.model || undefined;
      call = t.kind === "agent"
        ? this.o.agents.run(t.agentId, routine.prompt, {
          conversation: routine.conversation, permission: routine.permission, model,
          maxBudgetUsd: routine.maxBudgetUsd, timeoutMs, logPath, cancelToken: token, onHandle,
        })
        : this.o.agents.runInFolder(t.cwd, routine.prompt, {
          permission: routine.permission, model, maxBudgetUsd: routine.maxBudgetUsd, timeoutMs, logPath, cancelToken: token, onHandle,
        });
    } catch (e) { call = Promise.reject(e); }

    void call.then<RunOutcome, RunOutcome>(
      (r) => r,
      (e) => {
        if (e instanceof HttpError) {
          if (e.status === 404 && t.kind === "agent") return { status: "skipped", reason: "agent no longer exists" };
          return { status: "skipped", reason: clip(e.message) };
        }
        const msg = e instanceof Error ? e.message : String(e);
        return { status: "failed", conversationId: "", text: "", costUsd: 0, numTurns: 0, durationMs: 0, exitCode: null, error: clip(msg || "unexpected error") };
      }).then(settle);
    return { done, cancel };
  }
}

/** Writes a finished outcome into the run record. Does not touch the routine (the scheduler owns lastRunAt). */
export function applyResult(runs: Pick<RunStore, "update">, run: Run, routine: Routine, result: RunOutcome, now: () => number = Date.now): Run {
  if (result.status === "skipped") {
    return runs.update(run.id, { status: "skipped", reason: result.reason, finishedAt: now(), durationMs: 0 });
  }
  // A run killed on timeout never reaches a result event, so its cost would be recorded as $0 and a routine that always
  // times out would never move the daily cap. Charge the budget it was allowed to spend. (User cancels keep the reported cost.)
  const costUsd = result.status === "timed_out" ? Math.max(result.costUsd, routine.maxBudgetUsd) : result.costUsd;
  return runs.update(run.id, {
    status: result.status,
    finishedAt: now(),
    durationMs: result.durationMs,
    costUsd,
    numTurns: result.numTurns,
    conversationId: result.conversationId && isSafeId(result.conversationId) ? result.conversationId : "",
    exitCode: result.exitCode,
    error: result.error ?? "",
    summary: result.text,
  });
}

/**
 * applyResult that cannot throw and cannot leave the run `running`: if recording the outcome fails, the run is marked
 * failed with a short error instead. Returns the stored run, or undefined if even that fallback could not be written.
 */
export function finishRun(runs: Pick<RunStore, "update">, run: Run, routine: Routine, result: RunOutcome, now: () => number = Date.now): Run | undefined {
  try { return applyResult(runs, run, routine, result, now); } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try { return runs.update(run.id, { status: "failed", finishedAt: now(), error: clip(`could not record the result: ${msg}`) }); } catch { return undefined; }
  }
}
