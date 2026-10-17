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
}

/** Runs a routine's prompt through AgentService (agent target) or in a folder with no agent (folder target). */
export class AgentRunExecutor implements RunExecutor {
  private readonly now: () => number;
  constructor(private readonly o: AgentRunExecutorOptions) { this.now = o.now ?? Date.now; }

  execute(run: Run, routine: Routine, hooks: ExecutorHooks): { done: Promise<RunOutcome>; cancel(): void } {
    const token = { cancelled: false };
    let handle: (() => void) | null = null;
    let started = false;
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
      if (handle) { try { handle(); } catch {} }
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

    const done = call.then<RunOutcome, RunOutcome>(
      (r) => r,
      (e) => {
        if (e instanceof HttpError) {
          if (e.status === 404 && t.kind === "agent") return { status: "skipped", reason: "agent no longer exists" };
          return { status: "skipped", reason: clip(e.message) };
        }
        const msg = e instanceof Error ? e.message : String(e);
        return { status: "failed", conversationId: "", text: "", costUsd: 0, numTurns: 0, durationMs: 0, exitCode: null, error: clip(msg || "unexpected error") };
      });
    return { done, cancel };
  }
}

/** Writes a finished outcome into the run record. Does not touch the routine (the scheduler owns lastRunAt). */
export function applyResult(runs: Pick<RunStore, "update">, run: Run, result: RunOutcome, now: () => number = Date.now): Run {
  if (result.status === "skipped") {
    return runs.update(run.id, { status: "skipped", reason: result.reason, finishedAt: now(), durationMs: 0 });
  }
  return runs.update(run.id, {
    status: result.status,
    finishedAt: now(),
    durationMs: result.durationMs,
    costUsd: result.costUsd,
    numTurns: result.numTurns,
    conversationId: result.conversationId && isSafeId(result.conversationId) ? result.conversationId : "",
    exitCode: result.exitCode,
    error: result.error ?? "",
    summary: result.text,
  });
}
