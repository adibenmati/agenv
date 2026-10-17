import type { SessionStatus } from "../core/types";
import type { TypedEmitter } from "../core/TypedEmitter";
import type { Session } from "./Session";

/**
 * Everything that happens to a session, published on one bus. The WebSocket gateway, output analyzer, Claude
 * linker and state store subscribe; `Session` knows nothing about any of them.
 */
export interface SessionEvents {
  created: (s: Session) => void;
  /** Raw pty output. */
  output: (s: Session, data: string) => void;
  status: (s: Session, status: SessionStatus) => void;
  cwd: (s: Session, cwd: string) => void;
  /** A command was typed or launched in the session. */
  command: (s: Session, cmd: string) => void;
  /** Anything that should be saved changed. */
  changed: (s: Session) => void;
  /** The session ended — shell exited (`exitCode`) or it was deleted (-1). */
  deleted: (s: Session, exitCode: number) => void;
}

export type SessionBus = TypedEmitter<SessionEvents>;
