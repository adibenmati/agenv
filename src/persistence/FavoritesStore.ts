import type { JsonStore } from "../core/JsonStore";
import type { Favorite } from "../core/types";

/** Saved folder + command combos (~/.agenv-favorites.enc). */
export class FavoritesStore {
  constructor(private readonly store: JsonStore<Favorite[]>) {}

  list(): Favorite[] {
    const f = this.store.load();
    return Array.isArray(f) ? f : [];
  }

  /** Returns false when the same folder + command is already saved. */
  add(b: { name?: string; cwd?: string; command?: string; tool?: string }): boolean {
    const favs = this.list();
    const cwd = b.cwd || "", command = b.command || "";
    if (favs.some((f) => f.cwd === cwd && f.command === command)) return false;
    favs.push({ name: b.name || "", cwd, command, tool: b.tool || "terminal", created: Date.now() });
    this.store.save(favs);
    return true;
  }

  removeAt(index: number): boolean {
    const favs = this.list();
    if (index < 0 || index >= favs.length) return false;
    favs.splice(index, 1);
    this.store.save(favs);
    return true;
  }
}
