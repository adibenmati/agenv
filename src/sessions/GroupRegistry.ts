import { HttpError } from "../core/HttpError";
import type { GroupDef } from "../core/types";

const MAX_GROUP_DEPTH = 8;
const MAX_GROUP_SEGMENT = 64;
const MAX_GROUPS = 500;

const isIn = (p: string, root: string): boolean => p === root || p.startsWith(root + "/");
const ancestors = (p: string): string[] => p.split("/").map((_, i, a) => a.slice(0, i + 1).join("/"));

/**
 * Session groups form a folder tree: a group is a "/"-separated path ("project1/marketing/seo"). Sessions carry
 * their own path; the registry adds folders that have no sessions yet, plus colors.
 */
export class GroupRegistry {
  private stored: GroupDef[];
  private readonly sessions: () => Iterable<{ group: string }>;
  private readonly emitChanged: () => void;

  constructor(o: { sessions: () => Iterable<{ group: string }>; emitChanged: () => void; defs?: GroupDef[] }) {
    this.sessions = o.sessions;
    this.emitChanged = o.emitChanged;
    this.stored = Array.isArray(o.defs) ? o.defs : [];
  }

  /** Trim segments, drop empties, limit segment length and depth. */
  static normalize(p: unknown): string {
    return String(p == null ? "" : p).split("/")
      .map((seg) => seg.trim().slice(0, MAX_GROUP_SEGMENT)).filter(Boolean)
      .slice(0, MAX_GROUP_DEPTH).join("/");
  }

  /** The stored folder definitions (what gets saved to disk). */
  get defs(): GroupDef[] { return this.stored; }

  /** Every folder: stored ones, the ones sessions sit in, and all their ancestors. */
  list(): GroupDef[] {
    const colors = new Map<string, string>();
    const all = new Set<string>();
    for (const g of this.stored) {
      for (const a of ancestors(g.path)) all.add(a);
      if (g.color) colors.set(g.path, g.color);
    }
    for (const s of this.sessions()) if (s.group) for (const a of ancestors(s.group)) all.add(a);
    return [...all].sort().map((path) => ({ path, color: colors.get(path) || "" }));
  }

  replace(groups: unknown[]): GroupDef[] {
    const byPath = new Map<string, GroupDef>();
    for (const g of groups.slice(0, MAX_GROUPS) as any[]) {
      const p = GroupRegistry.normalize(g && g.path);
      if (p) byPath.set(p, { path: p, color: g && typeof g.color === "string" ? g.color.slice(0, 32) : "" });
    }
    this.stored = [...byPath.values()];
    this.emitChanged();
    return this.list();
  }

  /** Rename or move a folder; everything under it follows. */
  rename(fromRaw: unknown, toRaw: unknown): GroupDef[] {
    const from = GroupRegistry.normalize(fromRaw);
    const to = GroupRegistry.normalize(toRaw);
    if (!from || !to) throw new HttpError(400, "from and to required");
    if (to !== from && isIn(to, from)) throw new HttpError(400, "Can't move a group into itself");
    const move = (p: string): string => GroupRegistry.normalize(to + p.slice(from.length));
    for (const s of this.sessions()) if (s.group && isIn(s.group, from)) s.group = move(s.group);
    const byPath = new Map<string, GroupDef>();
    for (const g of this.stored) {
      const p = isIn(g.path, from) ? move(g.path) : g.path;
      byPath.set(p, { path: p, color: g.color || byPath.get(p)?.color || "" });
    }
    if (!byPath.has(to)) byPath.set(to, { path: to, color: "" });
    this.stored = [...byPath.values()];
    this.emitChanged();
    return this.list();
  }

  /** Remove a folder and its subfolders. Its sessions move up to the parent folder. */
  remove(pathRaw: unknown): GroupDef[] {
    const p = GroupRegistry.normalize(pathRaw);
    if (!p) throw new HttpError(400, "path required");
    const parent = p.split("/").slice(0, -1).join("/");
    for (const s of this.sessions()) if (s.group && isIn(s.group, p)) s.group = parent;
    this.stored = this.stored.filter((g) => !isIn(g.path, p));
    this.emitChanged();
    return this.list();
  }
}
