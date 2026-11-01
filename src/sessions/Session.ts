import type { Analytics, PersistedSession, SessionStatus } from "../core/types";
import type { IPty } from "./pty";
import { Scrollback } from "./Scrollback";

export interface SessionInit {
  id: number;
  name?: string;
  cwd: string;
  group?: string;
  note?: string;
  claudeSessionId?: string | null;
  tool?: string;
  lastCommand?: string;
  launchCommand?: string;
  userNamed?: boolean;
  model?: string;
  effort?: string;
  created?: number;
  lastActivity?: number;
  /** Command typed into the shell shortly after it starts; also remembered as the launch command. */
  runCommand?: string | null;
  cols: number;
  rows: number;
  scrollback?: Scrollback;
}

/**
 * One terminal tab: its record, its scrollback and (when awake) its pty. A session can exist without a shell —
 * a restored tab is just a record until it is first attached to. Lifecycle (spawn, restart, delete) is the
 * SessionManager's job; a Session only holds state.
 */
export class Session {
  readonly id: number;
  name: string;
  cwd: string;
  group: string;
  note: string;
  claudeSessionId: string | null;
  /** True while a claude process runs inside this session's shell (set by ClaudeLinker). */
  claudeRunning = false;
  detectedTool: string;
  lastCommand: string;
  launchCommand: string;
  userNamed: boolean;
  /** Model alias and effort level for this session's Claude ("" = default); used when agenv resumes it. */
  model: string;
  effort: string;
  status: SessionStatus = "idle";
  created: number;
  lastActivity: number;
  analytics: Analytics;
  scrollback: Scrollback;
  pendingCommand: string | null;
  cols: number;
  rows: number;
  /** False for a restored tab whose shell has not been started yet. */
  live = false;
  pty: IPty | null = null;

  constructor(o: SessionInit) {
    const now = Date.now();
    this.id = o.id;
    this.name = o.name || "";
    this.cwd = o.cwd;
    this.group = o.group || "";
    this.note = o.note || "";
    this.claudeSessionId = o.claudeSessionId || null;
    this.detectedTool = o.tool || "terminal";
    this.lastCommand = o.lastCommand || "";
    this.launchCommand = o.runCommand || o.launchCommand || "";
    this.userNamed = !!o.userNamed;
    this.model = o.model || "";
    this.effort = o.effort || "";
    this.created = o.created || now;
    this.lastActivity = o.lastActivity || now;
    this.analytics = { inputTokens: 0, outputTokens: 0, estimatedCost: 0, commandCount: 0, turnCount: 0, startTime: now };
    this.scrollback = o.scrollback || new Scrollback();
    this.pendingCommand = o.runCommand || null;
    this.cols = o.cols;
    this.rows = o.rows;
  }

  /** The fields saved to ~/.agenv-state.enc. */
  toPersisted(): PersistedSession {
    return {
      id: this.id, name: this.name || "", cwd: this.cwd,
      tool: this.detectedTool || "terminal",
      lastCommand: this.lastCommand || "",
      launchCommand: this.launchCommand || "",
      userNamed: this.userNamed || false,
      model: this.model || "", effort: this.effort || "",
      group: this.group || "", note: this.note || "",
      claudeSessionId: this.claudeSessionId || null,
      created: this.created || Date.now(),
      lastActivity: this.lastActivity || Date.now(),
    };
  }

  /** One entry of the GET /api/sessions list. */
  toListItem(clients: number): Record<string, unknown> {
    return {
      id: this.id, name: this.name || "", cwd: this.cwd, tool: this.detectedTool || "terminal",
      lastCommand: this.lastCommand || "", launchCommand: this.launchCommand || "",
      created: this.created, lastActivity: this.lastActivity, clients,
      status: this.status || "idle", group: this.group || "",
      note: this.note || "", analytics: this.analytics || {},
      claudeSessionId: this.claudeSessionId || null, claudeRunning: !!this.claudeRunning,
      model: this.model || "", effort: this.effort || "",
      // false = restored tab whose shell hasn't been started yet
      live: !!this.live,
    };
  }
}
