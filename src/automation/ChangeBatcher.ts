/**
 * Collapses a burst of change notifications into one emit. `notify()` is cheap and may be called any number of times
 * in a row; `emit` runs once when the deferred callback fires (a microtask by default, so one tick or catch-up burst
 * gives one broadcast). Tests inject `defer` or call `flush()` instead of waiting.
 */
export class ChangeBatcher {
  private pending = false;

  constructor(
    private readonly emit: () => void,
    private readonly defer: (fn: () => void) => void = queueMicrotask,
  ) {}

  notify(): void {
    if (this.pending) return;
    this.pending = true;
    this.defer(() => this.flush());
  }

  /** Emits now if anything is pending. */
  flush(): void {
    if (!this.pending) return;
    this.pending = false;
    try { this.emit(); } catch {}
  }
}
