import type { Run } from "./RunStore";

/** Handed to `execute` so the queue can reach the running job: call `register(cancel)` once the job can be cancelled. */
export type RegisterCancel = (cancel: () => void) => void;

export interface RunQueueOptions {
  limit: number;
  execute: (run: Run, register: RegisterCancel) => Promise<void> | void;
  /** Called when `execute` throws or rejects; the slot is freed regardless. */
  onError?: (run: Run, err: unknown) => void;
}

interface Active { run: Run; cancel: (() => void) | null; cancelRequested: boolean }

/** FIFO queue running at most `limit` jobs at once. Never throws from enqueue. */
export class RunQueue {
  private readonly waiting: Run[] = [];
  private readonly active = new Map<string, Active>();
  private idleWaiters: Array<() => void> = [];
  private readonly limit: number;

  constructor(private readonly o: RunQueueOptions) {
    this.limit = Math.max(1, Math.floor(o.limit) || 1);
  }

  enqueue(run: Run): void {
    this.waiting.push(run);
    this.pump();
  }

  /** Queued run: removed (the owner marks it cancelled). Running run: its cancel handle is called. False for an unknown id. */
  cancel(runId: string): boolean {
    const qi = this.waiting.findIndex((r) => r.id === runId);
    if (qi >= 0) { this.waiting.splice(qi, 1); this.settleIdle(); return true; }
    const a = this.active.get(runId);
    if (!a) return false;
    this.requestCancel(a);
    return true;
  }

  /** Cancels everything: queued runs are dropped (returned so the owner can mark them cancelled), running ones are cancelled. */
  drain(): Run[] {
    const dropped = this.waiting.splice(0);
    for (const a of [...this.active.values()]) this.requestCancel(a);
    this.settleIdle();
    return dropped;
  }

  size(): number { return this.waiting.length; }
  running(): number { return this.active.size; }

  idle(): Promise<void> {
    if (!this.waiting.length && !this.active.size) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private requestCancel(a: Active): void {
    a.cancelRequested = true;
    if (a.cancel) { try { a.cancel(); } catch {} }
  }

  private pump(): void {
    while (this.active.size < this.limit && this.waiting.length) {
      const run = this.waiting.shift() as Run;
      const a: Active = { run, cancel: null, cancelRequested: false };
      this.active.set(run.id, a);
      const register: RegisterCancel = (fn) => {
        a.cancel = fn;
        if (a.cancelRequested) { try { fn(); } catch {} }
      };
      let p: Promise<void>;
      try { p = Promise.resolve(this.o.execute(run, register)); } catch (e) { p = Promise.reject(e); }
      void p.then(() => undefined, (err) => { try { this.o.onError?.(run, err); } catch {} })
        .then(() => { this.active.delete(run.id); this.pump(); this.settleIdle(); });
    }
  }

  private settleIdle(): void {
    if (this.waiting.length || this.active.size) return;
    const w = this.idleWaiters;
    this.idleWaiters = [];
    for (const r of w) r();
  }
}
