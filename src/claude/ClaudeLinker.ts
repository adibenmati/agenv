import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { SessionBus } from "../sessions/events";
import type { Session } from "../sessions/Session";
import type { TranscriptScanner } from "./TranscriptScanner";

const CLAUDE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a string is a Claude Code conversation id (a UUID). */
export function isClaudeSessionId(id: string): boolean { return CLAUDE_UUID.test(id); }

/** One running Claude Code process, as it registers itself in ~/.claude/sessions/<pid>.json. */
export interface RegistryEntry { pid: number; sessionId: string; startedAt?: number }

export interface ClaudeLinkerOptions {
  bus: SessionBus;
  sessions: { all(): Session[] };
  scanner: TranscriptScanner;
  paths: { sessions: string; projects: string };
  /** How often to check which conversations are running; default 15 s. */
  intervalMs?: number;
  /** Map(pid → parent pid) for every process; replaceable for tests. */
  listProcesses?: () => Promise<Map<number, number>>;
}

/** Map(pid → ppid) for every process on the machine. */
function systemProcesses(): Promise<Map<number, number>> {
  return new Promise((resolve) => {
    const [cmd, args] = process.platform === "win32"
      ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1}' -f $_.ProcessId,$_.ParentProcessId }"]]
      : ["ps", ["-A", "-o", "pid=,ppid="]];
    execFile(cmd, args, { timeout: 15000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (_err, stdout) => {
      const map = new Map<number, number>();
      for (const line of String(stdout || "").split(/\r?\n/)) {
        const m = line.trim().match(/^(\d+)\s+(\d+)$/);
        if (m) map.set(Number(m[1]), Number(m[2]));
      }
      resolve(map);
    });
  });
}

/**
 * Knows which Claude Code conversation runs in which terminal — whether agenv launched claude or the user typed
 * it. Claude Code registers every running interactive session in ~/.claude/sessions/<pid>.json; walking each
 * registered pid up the process table to a session's shell pid gives the pairing. The link is what lets "Continue
 * Agent" resume that exact conversation and a rename reach Claude too.
 */
export class ClaudeLinker {
  /**
   * registry: running claude processes; parentOf: Map(pid → ppid); roots: Map(shell pid → agenv session id).
   * Returns Map(agenv session id → conversation id); when several conversations run under one terminal the newest wins.
   */
  static resolveLinks(registry: RegistryEntry[], parentOf: Map<number, number>, roots: Map<number, number>): Map<number, string> {
    const best = new Map<number, { sessionId: string; startedAt: number }>();
    for (const e of registry) {
      const seen = new Set<number>();
      for (let pid: number | undefined = e.pid; pid != null && !seen.has(pid); pid = parentOf.get(pid)) {
        seen.add(pid);
        if (!roots.has(pid)) continue;
        const id = roots.get(pid) as number;
        const cur = best.get(id);
        if (!cur || (e.startedAt || 0) >= cur.startedAt) best.set(id, { sessionId: e.sessionId, startedAt: e.startedAt || 0 });
        break;
      }
    }
    return new Map([...best].map(([id, v]) => [id, v.sessionId]));
  }

  /** The conversation id a claude command line resumes or starts, if it names one. */
  static idFromCommand(cmd: string): string | null {
    const m = String(cmd || "").match(/^\s*claude(?:\.exe|\.cmd)?\s.*?(?:--resume|-r|--session-id)(?:=|\s+)([0-9a-f-]{36})(?![0-9a-f-])/i);
    return m && CLAUDE_UUID.test(m[1]) ? m[1].toLowerCase() : null;
  }

  private readonly intervalMs: number;
  private readonly listProcesses: () => Promise<Map<number, number>>;
  // claude pid → agenv session id it runs under (-1: not under any of ours). Tracing a pid needs a full process
  // listing, so each pid is traced once.
  private readonly pidOwner = new Map<number, number>();
  private linking: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly onCommand = (s: Session, cmd: string): void => this.noteCommand(s, cmd);

  constructor(private readonly o: ClaudeLinkerOptions) {
    this.intervalMs = o.intervalMs ?? 15000;
    this.listProcesses = o.listProcesses ?? systemProcesses;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.refresh(); }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    this.o.bus.on("command", this.onCommand);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.o.bus.off("command", this.onCommand);
  }

  private setLink(s: Session, id: string): void {
    if (!id || s.claudeSessionId === id) return;
    s.claudeSessionId = id;
    this.o.bus.emit("changed", s);
  }

  /** A claude command typed or launched in a session: link right away when it names a conversation, otherwise look it up once claude has registered itself. */
  private noteCommand(s: Session, cmd: string): void {
    const id = ClaudeLinker.idFromCommand(cmd);
    if (id) { this.setLink(s, id); return; }
    if (!/^\s*claude(?:\.exe|\.cmd)?(\s|$)/i.test(cmd)) return;
    for (const ms of [3000, 10000]) {
      const t = setTimeout(() => { void this.refresh(); }, ms);
      if (t.unref) t.unref();
    }
  }

  private async readRegistry(): Promise<RegistryEntry[]> {
    let files: string[]; try { files = await fs.promises.readdir(this.o.paths.sessions); } catch { return []; }
    const out: RegistryEntry[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const e = JSON.parse(await fs.promises.readFile(path.join(this.o.paths.sessions, f), "utf8"));
        if (e && Number.isInteger(e.pid) && typeof e.sessionId === "string" && CLAUDE_UUID.test(e.sessionId)) out.push(e);
      } catch {}
    }
    return out;
  }

  /** Refresh every session's link and whether claude is running there. Cheap unless a new claude process appeared. */
  refresh(): Promise<void> {
    if (this.linking) return this.linking;
    this.linking = (async () => {
      const registry = await this.readRegistry();
      const live = new Set(registry.map((e) => e.pid));
      for (const pid of this.pidOwner.keys()) if (!live.has(pid)) this.pidOwner.delete(pid);

      // Known pids only need their current conversation id (it changes on /clear).
      const known = new Map<number, number>();
      const unknown: RegistryEntry[] = [];
      for (const e of registry) {
        const owner = this.pidOwner.get(e.pid);
        if (owner == null) unknown.push(e);
        else if (owner >= 0) known.set(e.pid, owner);
      }
      const sessions = this.o.sessions.all();
      const roots = new Map<number, number>();
      for (const s of sessions) if (s.pty && s.pty.pid) roots.set(s.pty.pid, s.id);

      if (unknown.length && roots.size) {
        const parentOf = await this.listProcesses();
        for (const e of unknown) {
          const [owner] = ClaudeLinker.resolveLinks([e], parentOf, roots).keys();
          this.pidOwner.set(e.pid, owner == null ? -1 : owner);
          if (owner != null) known.set(e.pid, owner);
        }
      }

      // Whether claude is running right now — "Continue" then just opens the tab instead of typing a resume
      // command into claude's own prompt.
      const running = new Set(known.values());
      for (const s of sessions) s.claudeRunning = running.has(s.id);

      // Several conversations in one terminal (nested claude): the newest wins.
      const latest = new Map<number, RegistryEntry>();
      for (const e of registry) {
        const owner = known.get(e.pid);
        if (owner == null) continue;
        const cur = latest.get(owner);
        if (!cur || (e.startedAt || 0) >= (cur.startedAt || 0)) latest.set(owner, e);
      }
      for (const [owner, e] of latest) {
        const s = sessions.find((x) => x.id === owner);
        if (s) this.setLink(s, e.sessionId);
      }
    })().catch(() => {}).finally(() => { this.linking = null; });
    return this.linking;
  }

  /** Name a Claude conversation the way /rename does: a custom-title record appended to its transcript. */
  async renameConversation(id: string, title: string): Promise<boolean> {
    if (!CLAUDE_UUID.test(id)) return false;
    let dirs: string[]; try { dirs = await fs.promises.readdir(this.o.paths.projects); } catch { return false; }
    for (const d of dirs) {
      const p = path.join(this.o.paths.projects, d, id + ".jsonl");
      let st: fs.Stats; try { st = await fs.promises.stat(p); } catch { continue; }
      // Don't glue our record onto a line claude is halfway through writing.
      let lead = "";
      if (st.size > 0) {
        const fh = await fs.promises.open(p, "r");
        try {
          const b = Buffer.alloc(1);
          await fh.read(b, 0, 1, st.size - 1);
          if (b[0] !== 0x0A) lead = "\n";
        } finally { await fh.close(); }
      }
      await fs.promises.appendFile(p, lead + JSON.stringify({ type: "custom-title", customTitle: title, sessionId: id }) + "\n");
      return true;
    }
    return false;
  }

  /** The folder a conversation ran in — `claude --resume <id>` has to start there. */
  async conversationCwd(id: string): Promise<string | null> {
    if (!CLAUDE_UUID.test(id)) return null;
    let dirs: string[]; try { dirs = await fs.promises.readdir(this.o.paths.projects); } catch { return null; }
    for (const d of dirs) {
      const p = path.join(this.o.paths.projects, d, id + ".jsonl");
      try { await fs.promises.access(p); } catch { continue; }
      let cwd: string | null = null;
      await this.o.scanner.scan(p, 0, (e) => { if (e.cwd) { cwd = e.cwd; return "stop"; } });
      return cwd;
    }
    return null;
  }
}
