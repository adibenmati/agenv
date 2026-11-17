// What a session is working on right now, for the live line under each session in the sidebar.
//
// Two sources:
//  - the terminal title. Claude Code writes its current task there ("◐ Fix the login bug"), with a spinner glyph
//    while it works and "✳" when it is done. Shells write their own path or program name, which says nothing.
//  - what the user typed and sent (a shell command, or a prompt to an agent).
// Every change of text is also kept in a short history that the session's info panel shows.

import { STRIP_ANSI } from "./OutputAnalyzer";

export type ActivitySource = "task" | "input";

export interface Activity {
  text: string;
  source: ActivitySource;
  /** true = working, false = finished / waiting for you, null = unknown. */
  busy: boolean | null;
  at: number;
}

export interface HasActivity {
  activity: Activity | null;
  activityLog: Activity[];
}

export const ACTIVITY_LOG_MAX = 20;
const MAX_TEXT = 200;

const ESC = "\x1b";
const BEL = "\x07";
// OSC 0 (icon + title) and OSC 2 (title), ended by BEL or ST.
const TITLE_RE = new RegExp(ESC + "\\][02];([^" + BEL + ESC + "]*)(?:" + BEL + "|" + ESC + "\\\\)", "g");

/** The last window title set in a chunk of output, or null when it sets none. */
export function lastTitle(raw: string): string | null {
  let last: string | null = null;
  for (const m of raw.matchAll(TITLE_RE)) last = m[1];
  return last;
}

// Titles that only name the program or the folder.
const GENERIC = [
  /^(claude( code)?|codex|gemini( cli)?|opencode|aider|bash|zsh|sh|fish|pwsh|powershell|windows powershell|cmd|node)$/i,
  /^administrator:/i,
  /\.exe\b/i,
  /^[a-z]:[\\/]/i,          // C:\path
  /^[~/]/,                  // ~/path, /path
  /^(mingw|msys|cygwin)\w*:/i,
  /^[\w.-]+@[\w.-]+:/,      // user@host:path
];

const IDLE_GLYPHS = new Set(["✳"]);

/**
 * The task a title names, or null for a title that only names the program or folder. `busy` comes from the glyph in
 * front of it: a spinner means working, "✳" means done; no glyph means unknown.
 */
export function parseTitle(title: string): { text: string; busy: boolean | null } | null {
  const t = String(title || "").trim();
  const m = t.match(/^([^\p{L}\p{N}"'(\[]+)\s+(.*)$/u);
  const glyph = m ? m[1].trim() : "";
  const text = clean(m ? m[2] : t);
  if (!text || GENERIC.some((re) => re.test(text))) return null;
  const busy = glyph ? !IDLE_GLYPHS.has(glyph) : null;
  return { text, busy };
}

function clean(s: string): string {
  const one = String(s || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return one.length > MAX_TEXT ? one.slice(0, MAX_TEXT - 1) + "…" : one;
}

/** Note what a session is doing. Returns true when anything visible changed. */
export function recordActivity(s: HasActivity, text: string, source: ActivitySource, busy: boolean | null, now = Date.now()): boolean {
  const t = clean(text);
  if (!t) return false;
  const cur = s.activity;
  if (cur && cur.text === t && cur.source === source) {
    if (cur.busy === busy) return false;
    cur.busy = busy;
    return true;
  }
  const a: Activity = { text: t, source, busy, at: now };
  s.activity = a;
  if (!Array.isArray(s.activityLog)) s.activityLog = [];
  // The same task again (back from a command typed in between) is already in the history.
  let lastTask: Activity | undefined;
  for (let i = s.activityLog.length - 1; i >= 0 && !lastTask; i--) if (s.activityLog[i].source === "task") lastTask = s.activityLog[i];
  if (source === "task" && lastTask && lastTask.text === t) return true;
  s.activityLog.push({ ...a });
  if (s.activityLog.length > ACTIVITY_LOG_MAX) s.activityLog.splice(0, s.activityLog.length - ACTIVITY_LOG_MAX);
  return true;
}

/** The last `n` non-empty lines of terminal output, without escape codes. */
export function tailLines(text: string, n: number): string[] {
  const plain = String(text || "").replace(STRIP_ANSI, "");
  const lines: string[] = [];
  for (const raw of plain.split(/\r?\n/)) {
    // A carriage return without a newline redraws the line; keep what was drawn last.
    const parts = raw.split("\r");
    const line = parts[parts.length - 1].replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trimEnd();
    if (line.trim()) lines.push(line.length > 300 ? line.slice(0, 300) + "…" : line);
  }
  return lines.slice(-n);
}
