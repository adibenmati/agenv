import { HttpError } from "../core/HttpError";
import type { ArchiveEntry, GroupDef, PersistedSession } from "../core/types";
import type { ArchiveStore } from "../persistence/ArchiveStore";
import { GroupRegistry } from "./GroupRegistry";
import type { SessionManager } from "./SessionManager";

const FORMAT = "agenv-sessions";
const MAX_SESSIONS = 2000;

/** The Sessions tree as a file: every session (open or asleep), the folders with their colours, and the closed list. */
export interface SessionExport {
  format: typeof FORMAT;
  version: 1;
  exportedAt: string;
  sessions: Array<Omit<PersistedSession, "id">>;
  groups: GroupDef[];
  archive: ArchiveEntry[];
}

export interface ImportResult { sessions: number; skipped: number; groups: number; archive: number }

const s = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const n = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const sessionKey = (r: { name: string; cwd: string; group: string; claudeSessionId: string | null; launchCommand: string }): string =>
  r.claudeSessionId ? "c:" + r.claudeSessionId : ["n", r.name.toLowerCase(), r.cwd.toLowerCase(), r.group, r.launchCommand].join("\u0001");

/** Save and bring back the session tree. Import only adds: nothing that exists is changed or replaced. */
export class SessionTransfer {
  constructor(private readonly o: { sessions: SessionManager; groups: GroupRegistry; archive: ArchiveStore }) {}

  export(): SessionExport {
    return {
      format: FORMAT, version: 1, exportedAt: new Date().toISOString(),
      sessions: this.o.sessions.all().map((x) => { const { id: _id, ...rest } = x.toPersisted(); return rest; }),
      groups: this.o.groups.list(),
      archive: this.o.archive.list(),
    };
  }

  import(payload: unknown): ImportResult {
    const p = payload as Partial<SessionExport> | null;
    if (!p || p.format !== FORMAT || !Array.isArray(p.sessions)) throw new HttpError(400, "This is not an agenv sessions file");
    if (p.sessions.length > MAX_SESSIONS) throw new HttpError(400, "Too many sessions in the file (max " + MAX_SESSIONS + ")");

    const records: Array<Omit<PersistedSession, "id">> = [];
    for (const raw of p.sessions as Array<Record<string, unknown>>) {
      if (!raw || typeof raw !== "object") continue;
      const now = Date.now();
      records.push({
        name: s(raw.name, 64), cwd: s(raw.cwd, 1024), tool: s(raw.tool, 32) || "terminal",
        lastCommand: s(raw.lastCommand, 1024), launchCommand: s(raw.launchCommand, 1024),
        userNamed: raw.userNamed === true, group: GroupRegistry.normalize(raw.group), note: s(raw.note, 2000),
        claudeSessionId: s(raw.claudeSessionId, 64) || null, created: n(raw.created, now), lastActivity: n(raw.lastActivity, now),
      });
    }
    const added = this.o.sessions.importRecords(records, sessionKey);

    // folders: add the ones that are missing; colours of folders that exist stay as they are
    const have = new Set(this.o.groups.list().map((g) => g.path));
    const incoming = (Array.isArray(p.groups) ? p.groups : []) as Array<{ path?: unknown; color?: unknown }>;
    const fresh: GroupDef[] = [];
    for (const g of incoming) {
      const path = GroupRegistry.normalize(g && g.path);
      if (path && !have.has(path)) { have.add(path); fresh.push({ path, color: s(g.color, 32) }); }
    }
    if (fresh.length) this.o.groups.replace([...this.o.groups.list(), ...fresh]);

    // closed sessions: only the ones whose close time and conversation are not already listed
    const seen = new Set(this.o.archive.list().map((a) => a.closed + ":" + a.claudeSessionId));
    let archived = 0;
    for (const a of (Array.isArray(p.archive) ? p.archive : []) as unknown as Array<Record<string, unknown>>) {
      if (!a || typeof a !== "object") continue;
      const entry: ArchiveEntry = {
        name: s(a.name, 64), cwd: s(a.cwd, 1024), tool: s(a.tool, 32) || "terminal", lastCommand: s(a.lastCommand, 1024),
        launchCommand: s(a.launchCommand, 1024), group: GroupRegistry.normalize(a.group), claudeSessionId: s(a.claudeSessionId, 64) || null,
        created: n(a.created, 0), lastActivity: n(a.lastActivity, 0), closed: n(a.closed, Date.now()),
      };
      const key = entry.closed + ":" + entry.claudeSessionId;
      if (seen.has(key)) continue;
      seen.add(key); this.o.archive.add(entry); archived++;
    }
    return { sessions: added, skipped: records.length - added, groups: fresh.length, archive: archived };
  }
}
