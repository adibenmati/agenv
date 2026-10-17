import type { RunHandle, RunHooks, RunSpec } from "./ClaudeRunner";

/** Anything that can start a headless claude run. */
export interface RunnerLike { run(spec: RunSpec, hooks?: RunHooks): RunHandle }

/** Wraps a runner and remembers every live run, so one cancelAll() reaches runs started by any user of it. */
export class TrackedRunner implements RunnerLike {
  private readonly live = new Set<RunHandle>();

  constructor(private readonly inner: RunnerLike) {}

  run(spec: RunSpec, hooks?: RunHooks): RunHandle {
    const h = this.inner.run(spec, hooks);
    this.live.add(h);
    void h.done.then(() => { this.live.delete(h); }, () => { this.live.delete(h); });
    return h;
  }

  cancelAll(): void { for (const h of [...this.live]) h.cancel(); }
}
