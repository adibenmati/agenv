import * as fs from "fs";
import * as path from "path";

/** Where Claude Code keeps its data, plus agenv's own session-index cache. */
export function claudePaths(home: string): { home: string; projects: string; sessions: string; indexFile: string } {
  const dir = path.join(home, ".claude");
  return {
    home: dir,
    projects: path.join(dir, "projects"),
    sessions: path.join(dir, "sessions"),
    indexFile: path.join(dir, "agenv-session-index.json"),
  };
}

/**
 * "C--Projects-remotecontrol" → "C:\Projects\remotecontrol". A drive letter followed by -- encodes the colon and
 * backslash; the remaining hyphens encode path separators (ambiguous with real hyphens, best-effort).
 */
export function decodeClaudeProjectPath(dirName: string): string {
  return dirName.replace(/^([A-Za-z])--/, "$1:\\").replace(/-/g, "\\");
}

/** Claude's folder name for a working directory: every character outside A-Za-z0-9 becomes "-". */
export const encodeClaudeProjectPath = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, "-");

/**
 * Full path of the transcript for a conversation id, or null. Tries the folder encoded from `cwd` first (when given),
 * then scans every project folder. Ids that are not plain file-name-safe tokens never reach the file system.
 */
export function findTranscript(projectsDir: string, id: string, cwd?: string): string | null {
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) return null;
  const file = id + ".jsonl";
  if (cwd) {
    const direct = path.join(projectsDir, encodeClaudeProjectPath(cwd), file);
    if (fs.existsSync(direct)) return direct;
  }
  let dirs: string[];
  try { dirs = fs.readdirSync(projectsDir); } catch { return null; }
  for (const d of dirs) {
    const f = path.join(projectsDir, d, file);
    if (fs.existsSync(f)) return f;
  }
  return null;
}
