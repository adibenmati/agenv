import type { PersistedState } from "../core/types";

interface StateFile { load(): PersistedState | null; save(v: PersistedState | null): void }

/**
 * Saves the session state file. `save()` is debounced: it writes immediately, then coalesces everything that
 * arrives in the next window into one trailing write. Prompt/cwd detection can request a save many times a
 * second, and each write is an AES pass plus a synchronous disk write on the event loop.
 */
export class StateStore {
  private timer: NodeJS.Timeout | null = null;
  private pending = false;

  constructor(private readonly file: StateFile, private readonly snapshot: () => PersistedState, private readonly debounceMs = 1000) {}

  load(): PersistedState | null { return this.file.load(); }

  saveNow(): void {
    try { this.file.save(this.snapshot()); } catch {}
  }

  save(): void {
    if (this.timer) { this.pending = true; return; }
    this.saveNow();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.pending) { this.pending = false; this.save(); }
    }, this.debounceMs);
    if (this.timer.unref) this.timer.unref();
  }
}
