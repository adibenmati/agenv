import * as path from "path";
import { HttpError } from "../core/HttpError";
import type { PersistedSession } from "../core/types";
import type { ArchiveStore } from "../persistence/ArchiveStore";
import type { ScrollbackStore } from "../persistence/ScrollbackStore";
import type { SessionBus } from "./events";
import type { PtyFactory } from "./pty";
import { Scrollback } from "./Scrollback";
import { Session } from "./Session";
import { parseShell } from "./shell";
import { detectTool } from "./tools";

/** Sent to clients when a shell is restarted so they start from a clean screen. */
const CLEAR_SCREEN = "\x1b[2J\x1b[H";

export interface SessionManagerOptions {
  bus: SessionBus;
  ptyFactory: PtyFactory;
  shell: string;
  maxSessions: number;
  defaultCols: number;
  defaultRows: number;
  scrollbackStore: ScrollbackStore;
  archive: ArchiveStore;
  isRealDir: (p: string) => boolean;
  env?: NodeJS.ProcessEnv;
}

export interface CreateOptions {
  cwd?: string;
  name?: string;
  group?: string;
  runCommand?: string | null;
  restoreScrollback?: boolean;
}

/**
 * Owns the set of sessions: creating, waking, restarting and deleting them, restoring saved tabs, and shutting
 * down. Everything that happens to a session is published on the bus; nothing here knows about WebSockets or disk
 * state beyond the scrollback and archive stores it is given.
 */
export class SessionManager {
  private readonly sessions = new Map<number, Session>();
  private readonly shell: { file: string; args: string[] };
  private shuttingDown = false;
  /** Id handed to the next created session; ids are never reused. */
  nextId = 0;

  constructor(private readonly o: SessionManagerOptions) {
    this.shell = parseShell(o.shell);
  }

  get(id: number): Session | undefined { return this.sessions.get(id); }
  all(): Session[] { return [...this.sessions.values()]; }
  get size(): number { return this.sessions.size; }
  get isFull(): boolean { return this.sessions.size >= this.o.maxSessions; }

  // -------------------------------------------------------------------------
  // Creating and waking
  // -------------------------------------------------------------------------

  /** Create a session and start its shell. Startup passes `enforceLimit: false` for the initial tabs. */
  create(opts: CreateOptions, { enforceLimit = true }: { enforceLimit?: boolean } = {}): Session {
    if (enforceLimit && this.isFull) throw new HttpError(400, "Maximum sessions reached (" + this.o.maxSessions + ")");
    const id = this.nextId++;
    const s = this.makeSession(id, {
      cwd: opts.cwd, name: opts.name, group: opts.group, runCommand: opts.runCommand,
      loadScrollback: opts.restoreScrollback === true,
    });
    this.sessions.set(id, s);
    this.wake(s);
    this.o.bus.emit("created", s);
    this.o.bus.emit("changed", s);
    return s;
  }

  /**
   * Bring saved tabs back as sleeping records (no shell until first attached). `neededIds` are the tabs the saved
   * layout still shows; without them the most recently used tabs are kept, up to the session limit.
   * Returns how many tabs were restored.
   */
  restore(records: PersistedSession[], neededIds?: Set<number>): number {
    const toRestore = neededIds && neededIds.size > 0
      ? records.filter((r) => neededIds.has(r.id))
      : [...records].sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0)).slice(0, this.o.maxSessions);
    for (const r of toRestore) {
      const id = r.id != null ? r.id : this.nextId;
      if (id >= this.nextId) this.nextId = id + 1;
      const s = this.makeSession(id, {
        cwd: r.cwd && this.o.isRealDir(r.cwd) ? r.cwd : process.cwd(),
        name: r.name || "", tool: r.tool || "terminal", lastCommand: r.lastCommand || "",
        launchCommand: r.launchCommand || "", userNamed: r.userNamed || false,
        group: r.group || "", note: r.note || "", claudeSessionId: r.claudeSessionId || null,
        created: r.created, lastActivity: r.lastActivity, loadScrollback: true,
      });
      this.sessions.set(id, s);
    }
    return toRestore.length;
  }

  private makeSession(id: number, o: {
    cwd?: string; name?: string; group?: string; note?: string; claudeSessionId?: string | null; tool?: string;
    lastCommand?: string; launchCommand?: string; userNamed?: boolean; created?: number; lastActivity?: number;
    runCommand?: string | null; loadScrollback: boolean;
  }): Session {
    const saved = o.loadScrollback ? this.o.scrollbackStore.load(id) : null;
    return new Session({
      id, name: o.name, cwd: o.cwd || process.cwd(), group: o.group, note: o.note,
      claudeSessionId: o.claudeSessionId, tool: o.tool, lastCommand: o.lastCommand, launchCommand: o.launchCommand,
      userNamed: o.userNamed, created: o.created, lastActivity: o.lastActivity, runCommand: o.runCommand,
      cols: this.o.defaultCols, rows: this.o.defaultRows,
      scrollback: saved ? new Scrollback(saved) : undefined,
    });
  }

  /** Spawn the shell for a session record. Idempotent. Opening a restored tab is what wakes it. */
  wake(s: Session): void {
    if (s.live && s.pty) return;
    const { bus, ptyFactory, isRealDir } = this.o;

    const cwd = s.cwd && isRealDir(s.cwd) ? s.cwd : process.cwd();
    const pty = ptyFactory({
      file: this.shell.file, args: this.shell.args, cols: s.cols, rows: s.rows, cwd,
      env: Object.assign({}, this.o.env || process.env, { TERM: "xterm-256color" }),
    });
    s.pty = pty;
    s.live = true;
    s.cwd = cwd;
    s.lastActivity = Date.now();

    // Send the pending command once the shell is ready (small delay for shell init)
    if (s.pendingCommand) {
      const t = setTimeout(() => {
        if (s.pty && s.pendingCommand) {
          const cmd = s.pendingCommand;
          s.pty.write(cmd + "\r");
          s.lastCommand = cmd;
          const tool = detectTool(cmd);
          if (tool) s.detectedTool = tool;
          s.pendingCommand = null;
          bus.emit("command", s, cmd);
          bus.emit("changed", s);
        }
      }, 500);
      if (t.unref) t.unref();
    }

    pty.onData((data) => {
      if (s.pty !== pty) return; // stale handler from a previous shell
      s.lastActivity = Date.now();
      s.scrollback.append(data);
      bus.emit("output", s, data);
    });

    pty.onExit(({ exitCode }) => {
      if (s.pty !== pty) return; // superseded by a restart
      if (this.shuttingDown) return;
      console.log(`[agenv] Session ${s.id} exited (code ${exitCode})`);
      this.destroy(s, exitCode);
    });
  }

  // -------------------------------------------------------------------------
  // Restart, delete
  // -------------------------------------------------------------------------

  /** Replace the shell with a fresh one, re-running whatever launched this session. */
  restart(id: number): Session {
    const s = this.require(id);
    const old = s.pty;
    s.pty = null; // the old pty's handlers bail out once this no longer matches
    try { if (old) old.kill(); } catch {}

    s.live = false;
    s.status = "idle";
    s.scrollback = new Scrollback();
    this.o.scrollbackStore.clear(id); // don't resurrect the pre-restart buffer later
    // Re-run whatever launched this session (claude, a dev server, ...) in a fresh shell
    // rather than replacing the shell with it.
    s.pendingCommand = s.launchCommand || null;
    this.wake(s);
    this.o.bus.emit("output", s, CLEAR_SCREEN);   // clients start from a clean screen
    console.log(`[agenv] Session ${id} restarted`);
    return s;
  }

  /** Close a session from the API: kill its shell, archive it, forget it. */
  delete(id: number, exitCode = -1): void {
    const s = this.require(id);
    const p = s.pty;
    s.pty = null; // stops the exit handler from archiving this twice
    try { if (p) p.kill(); } catch {} // safe even if already exited
    this.destroy(s, exitCode);
  }

  private destroy(s: Session, exitCode: number): void {
    this.o.archive.add({
      name: s.name || "", cwd: s.cwd, tool: s.detectedTool || "terminal",
      lastCommand: s.lastCommand || "", launchCommand: s.launchCommand || "",
      group: s.group || "", claudeSessionId: s.claudeSessionId || null,
      created: s.created, lastActivity: s.lastActivity, closed: Date.now(),
    });
    s.pty = null;
    s.live = false;
    this.sessions.delete(s.id);
    this.o.scrollbackStore.clear(s.id);
    this.o.bus.emit("deleted", s, exitCode);
    this.o.bus.emit("changed", s);
  }

  private require(id: number): Session {
    const s = this.sessions.get(id);
    if (!s) throw new HttpError(404, "Session not found");
    return s;
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  write(s: Session, data: string): void {
    if (s.pty) s.pty.write(data);
  }

  /** Clamp to a sane terminal size (1–500 columns, 1–200 rows) and resize the shell. */
  resize(s: Session, cols: unknown, rows: unknown): void {
    s.cols = Math.max(1, Math.min(Math.floor(Number(cols)) || 80, 500));
    s.rows = Math.max(1, Math.min(Math.floor(Number(rows)) || 24, 200));
    try { if (s.pty) s.pty.resize(s.cols, s.rows); } catch {}
  }

  /**
   * A command typed in the terminal. Records it, detects the tool, and — because `cd` is invisible to the shell
   * prompt detection on Windows — follows folder changes.
   */
  noteCommand(s: Session, command: string): void {
    const trimmed = command.trim();
    if (!trimmed) return;
    s.lastCommand = trimmed;
    const tool = detectTool(trimmed);
    if (tool) {
      s.detectedTool = tool;
      if (!s.name) s.name = tool;
      if (!s.launchCommand) s.launchCommand = trimmed;
    }
    this.o.bus.emit("command", s, trimmed);

    const cd = trimmed.match(/^cd\s+(.+)/i);
    if (cd) {
      const target = cd[1].replace(/^["']|["']$/g, "").trim();
      if (target) {
        try {
          const resolved = path.resolve(s.cwd, target);
          if (this.o.isRealDir(resolved)) {
            s.cwd = resolved;
            // Auto-rename plain terminal sessions to folder name
            if (!s.userNamed && s.detectedTool === "terminal") s.name = path.basename(resolved);
            this.o.bus.emit("cwd", s, s.cwd);
          }
        } catch {}
      }
    }
    this.o.bus.emit("changed", s);
  }

  // -------------------------------------------------------------------------
  // Persistence and shutdown
  // -------------------------------------------------------------------------

  /** Save every session's scrollback; unchanged buffers are skipped unless `force`. */
  saveAllScrollback(force = false): void {
    for (const s of this.sessions.values()) {
      const sb = s.scrollback;
      if (sb.bytes === 0) continue;
      if (!force && !sb.dirty) continue; // nothing new since the last save — don't re-encrypt 100KB for nothing
      if (this.o.scrollbackStore.save(s.id, sb.read())) sb.dirty = false;
    }
  }

  /** Save scrollback and kill every shell. Their exits are not archived. */
  shutdown(): void {
    this.shuttingDown = true;
    this.saveAllScrollback(true);
    for (const s of this.sessions.values()) { try { if (s.pty) s.pty.kill(); } catch {} }
  }
}
