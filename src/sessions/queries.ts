import * as fs from "fs";

// Small read models over sessions and the archive, shared by the API and the page builder.

interface HasFolder { cwd?: string; lastActivity?: number }

/** Folders worked in recently — from live sessions and the closed-session archive — newest first. Folders that no longer exist are dropped. */
export function recentFolders(
  sessions: Iterable<HasFolder>,
  archive: Array<HasFolder & { closed?: number }>,
  limit: number,
  exists: (p: string) => boolean = fs.existsSync,
): Array<{ cwd: string; lastActivity: number }> {
  const folders = new Map<string, number>();   // cwd -> lastActivity
  for (const s of sessions) if (s.cwd) folders.set(s.cwd, Math.max(folders.get(s.cwd) || 0, s.lastActivity || 0));
  for (const a of archive) if (a.cwd) folders.set(a.cwd, Math.max(folders.get(a.cwd) || 0, a.lastActivity || a.closed || 0));
  return [...folders.entries()]
    .map(([cwd, lastActivity]) => ({ cwd, lastActivity }))
    .filter((f) => { try { return exists(f.cwd); } catch { return false; } })
    .sort((a, b) => b.lastActivity - a.lastActivity)
    .slice(0, limit);
}

interface AnalyticsSession {
  id: number; name?: string; detectedTool?: string; status?: string; created: number;
  analytics?: { inputTokens?: number; outputTokens?: number; estimatedCost?: number; turnCount?: number; commandCount?: number; startTime?: number };
}

export function sessionAnalytics(sessions: AnalyticsSession[]): {
  sessions: Record<number, Record<string, unknown>>;
  totals: { inputTokens: number; outputTokens: number; estimatedCost: number; sessionCount: number };
} {
  const result = { sessions: {} as Record<number, Record<string, unknown>>, totals: { inputTokens: 0, outputTokens: 0, estimatedCost: 0, sessionCount: sessions.length } };
  for (const s of sessions) {
    const a = s.analytics || {};
    result.sessions[s.id] = {
      name: s.name || "Session " + s.id, tool: s.detectedTool || "terminal",
      status: s.status, duration: Date.now() - (a.startTime || s.created),
      inputTokens: a.inputTokens || 0, outputTokens: a.outputTokens || 0,
      estimatedCost: a.estimatedCost || 0, turnCount: a.turnCount || 0,
      commandCount: a.commandCount || 0,
    };
    result.totals.inputTokens += a.inputTokens || 0;
    result.totals.outputTokens += a.outputTokens || 0;
    result.totals.estimatedCost += a.estimatedCost || 0;
  }
  return result;
}

/** The old flat view: session ids by group name ("ungrouped" for none). */
export function legacyGroups(sessions: Array<{ id: number; group?: string }>): Record<string, number[]> {
  const groups = new Map<string, number[]>();
  for (const s of sessions) {
    const g = s.group || "ungrouped";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(s.id);
  }
  return Object.fromEntries(groups);
}

/** The real working folder of a shell process (Linux only, via /proc); null elsewhere or when it can't be read. */
export async function readLiveCwd(pid: number): Promise<string | null> {
  if (process.platform === "win32") return null;
  try { return (await fs.promises.realpath(`/proc/${pid}/cwd`)) || null; } catch { return null; }
}
