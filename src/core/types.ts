// Shared data shapes. These are the on-disk and over-the-wire formats, so changing a field here changes a file format.

export type SessionStatus = "idle" | "running" | "waiting" | "error";

export interface Analytics {
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  commandCount: number;
  turnCount: number;
  startTime: number;
}

/** A group folder that exists independently of sessions (empty folders, colors). */
export interface GroupDef {
  path: string;
  color: string;
}

/** What is saved for each session in ~/.agenv-state.enc. */
export interface PersistedSession {
  id: number;
  name: string;
  cwd: string;
  tool: string;
  lastCommand: string;
  launchCommand: string;
  userNamed: boolean;
  group: string;
  note: string;
  claudeSessionId: string | null;
  created: number;
  lastActivity: number;
}

export interface PersistedState {
  sessions: PersistedSession[];
  workspaceLayout: unknown | null;
  sessionGroups: GroupDef[];
}

/** A closed session, kept in ~/.agenv-archive.enc so it can be resumed. */
export interface ArchiveEntry {
  name: string;
  cwd: string;
  tool: string;
  lastCommand: string;
  launchCommand: string;
  group: string;
  claudeSessionId: string | null;
  created: number;
  lastActivity: number;
  closed: number;
}

export interface Favorite {
  name: string;
  cwd: string;
  command: string;
  tool: string;
  created: number;
}
