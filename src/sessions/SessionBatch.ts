import type { Session } from "./Session";

export interface ResumeResult {
  id: number;
  name: string;
  action: "resumed" | "woke" | "skipped";
  reason?: string;
}

export interface SessionBatchOptions {
  sessions: { all(): Session[]; wake(s: Session): void };
  /** A woken shell needs a moment before it can take typed input. */
  wakeDelayMs?: number;
}

/** Flags a client may add to `claude --resume` (its model and permission settings); anything else is dropped. */
const SAFE_ARG = /^[\w@.:=/\-]+$/;

/**
 * Whole-set actions on sessions: bring back every tab that was asleep after a restart and resume the Claude
 * conversation each one had, the same thing "Continue Agent" does for one tab.
 */
export class SessionBatch {
  constructor(private readonly o: SessionBatchOptions) {}

  resumeAll(opts: { group?: string; extraArgs?: unknown } = {}): ResumeResult[] {
    const group = typeof opts.group === "string" ? opts.group : undefined;
    const extra = (Array.isArray(opts.extraArgs) ? opts.extraArgs : []).filter((a): a is string => typeof a === "string" && SAFE_ARG.test(a)).slice(0, 8);
    const results: ResumeResult[] = [];
    for (const s of this.o.sessions.all()) {
      if (group !== undefined && !(s.group === group || s.group.startsWith(group + "/"))) continue;
      const name = s.name || "session " + s.id;
      const done = (action: ResumeResult["action"], reason?: string): void => { results.push({ id: s.id, name, action, reason }); };
      const command = s.claudeSessionId ? ["claude", "--resume", s.claudeSessionId, ...extra].join(" ") : "";
      if (!s.live || !s.pty) {
        this.o.sessions.wake(s);
        if (command) { this.type(s, command, this.o.wakeDelayMs ?? 1200); done("resumed"); } else done("woke", "no conversation to resume");
        continue;
      }
      if (s.claudeRunning) { done("skipped", "already running"); continue; }
      if (!command) { done("skipped", "no conversation to resume"); continue; }
      if (s.status !== "idle") { done("skipped", "busy"); continue; }
      this.type(s, command, 0);
      done("resumed");
    }
    return results;
  }

  private type(s: Session, text: string, delayMs: number): void {
    const go = (): void => { try { s.pty?.write(text + "\r"); } catch {} };
    if (delayMs > 0) setTimeout(go, delayMs).unref(); else go();
  }
}
