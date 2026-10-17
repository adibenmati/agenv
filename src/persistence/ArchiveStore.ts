import type { JsonStore } from "../core/JsonStore";
import type { ArchiveEntry } from "../core/types";

const MAX_ARCHIVE = 100;

/** Closed sessions, kept so they can be resumed (~/.agenv-archive.enc). */
export class ArchiveStore {
  constructor(private readonly store: JsonStore<ArchiveEntry[]>) {}

  list(): ArchiveEntry[] {
    const a = this.store.load();
    return Array.isArray(a) ? a : [];
  }

  add(entry: ArchiveEntry): void {
    const archive = this.list();
    archive.push(entry);
    if (archive.length > MAX_ARCHIVE) archive.splice(0, archive.length - MAX_ARCHIVE);
    this.store.save(archive);
  }

  remove(closed: number): void {
    this.store.save(this.list().filter((a) => a.closed !== closed));
  }
}
