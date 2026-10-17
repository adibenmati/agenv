import type { JsonStore } from "../core/JsonStore";

const MAX_HISTORY = 1000;

/** Command history shared by every terminal (~/.agenv-history.enc). */
export class HistoryStore {
  constructor(private readonly store: JsonStore<string[]>) {}

  list(): string[] { return this.store.load(); }

  add(command: string): void {
    const trimmed = command.trim();
    if (!trimmed) return;
    const history = this.store.load();
    if (history.length > 0 && history[history.length - 1] === trimmed) return;   // consecutive duplicate
    history.push(trimmed);
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
    this.store.save(history);
  }
}
