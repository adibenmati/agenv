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
