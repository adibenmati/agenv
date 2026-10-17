import * as nodeFs from "fs";
import { Fs, renameWithRetry, uniqueTmp } from "../core/atomicFile";

export interface LockInfo { pid: number; port: number; startedAt: number; heartbeatAt: number }

/** How often the owner rewrites the lock (and a non-owner looks at it): the scheduler's tick interval. */
export const OWNERSHIP_TICK_MS = 30_000;
/** A lock whose heartbeat is older than this many ticks is stale, whether or not its pid is alive. */
const STALE_TICKS = 3;
/** An unreadable lock younger than this may be somebody's half-written file; it is not taken over yet. */
const GARBAGE_GRACE_MS = 5_000;

export interface AutomationOwnershipOptions {
  /** The lock file, `~/.agenv-automation.lock`. */
  path: string;
  /** This instance's HTTP port; recorded so a refused instance can say who owns the schedules. */
  port: number;
  pid?: number;
  /** Whether a process exists. Defaults to `process.kill(pid, 0)`; injectable for tests. */
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  /** A heartbeat older than this is stale even if its pid is alive. Default 3 x 30 s = 90 s. */
  staleMs?: number;
  /** The filesystem; injectable so tests can interleave two instances or simulate Windows lock errors. */
  fs?: Fs;
}

/** `kill(pid, 0)` throws ESRCH for a process that does not exist; EPERM means it exists but belongs to someone else. */
export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

type Seen = { kind: "none" } | { kind: "lock"; info: LockInfo } | { kind: "garbage"; ageMs: number };
type Verdict = "free" | "ours" | "stale" | "blocked";
type Published = "ok" | "exists" | "error";

/**
 * Only one agenv instance on a machine may run the routine schedules (two ticks would fire every routine twice). The
 * instance that creates `~/.agenv-automation.lock` owns them and rewrites it every tick (`heartbeatAt`). A lock is stale,
 * and taken over, when its heartbeat is older than 90 s (a process killed without running its exit hook, whose pid may even
 * be reused by an unrelated process), when its pid is gone, or when it is unreadable and older than 5 s.
 * A runtime that never calls acquire() counts as the owner, so embedding and tests behave as before.
 */
export class AutomationOwnership {
  private readonly pid: number;
  private readonly startedAt: number;
  private readonly isAlive: (pid: number) => boolean;
  private readonly now: () => number;
  private readonly staleMs: number;
  private readonly fs: Fs;
  private refusedBy: LockInfo | null = null;

  constructor(private readonly o: AutomationOwnershipOptions) {
    this.pid = o.pid ?? process.pid;
    this.now = o.now ?? Date.now;
    this.startedAt = this.now();
    this.isAlive = o.isAlive ?? processAlive;
    this.staleMs = o.staleMs ?? STALE_TICKS * OWNERSHIP_TICK_MS;
    this.fs = o.fs ?? nodeFs;
  }

  /** True when this instance owns the schedules (including: acquire() has not been refused). */
  isOwner(): boolean { return this.refusedBy === null; }

  /** The port of the instance that owns the schedules: ours when we do, the lock holder's when we were refused. */
  ownerPort(): number { return this.refusedBy ? this.refusedBy.port : this.o.port; }

  /**
   * Takes the lock if it is free, ours or stale. False (and isOwner() false) when a live process holds a fresh one.
   * The lock appears all at once: the full content goes to a temp file that is hard-linked into place, and the link fails
   * with EEXIST if anyone got there first. Taking over a stale lock is unlink + one more link, so of two takers one loses.
   */
  acquire(): boolean {
    let unlinked = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const seen = this.inspect();
      const verdict = this.verdict(seen);
      if (verdict === "ours") { this.writeAtomic(); this.refusedBy = null; return true; }
      if (verdict === "blocked") return this.refuse(seen);
      if (verdict === "stale") {
        if (unlinked) return this.refuse(seen);                   // we already cleared one stale lock and somebody else re-created it
        try { this.fs.unlinkSync(this.o.path); } catch {}
        unlinked = true;
      }
      const r = this.publish();
      if (r !== "exists") { this.refusedBy = null; return true; }   // "error": the lock cannot be written (read-only home): do not lose the schedules
    }
    return this.refuse(this.inspect());
  }

  /** What a non-owner calls every tick: one small read while another instance is live; the full acquire() once the lock is free or stale. */
  tryAcquire(): boolean { return this.acquire(); }

  /**
   * The owner's per-tick refresh: rewrites the lock with `heartbeatAt: now`. False (and isOwner() false) when the lock on
   * disk is no longer ours, in which case it is left alone. A lock that cannot be written does not cost the schedules.
   */
  heartbeat(): boolean {
    const seen = this.inspect();
    if (seen.kind === "lock" && !(seen.info.pid === this.pid && seen.info.startedAt === this.startedAt)) {
      this.refusedBy = seen.info;
      return false;
    }
    this.writeAtomic();
    this.refusedBy = null;
    return true;
  }

  /** Removes the lock, but only if it is still ours. */
  release(): void {
    const seen = this.inspect();
    if (seen.kind === "lock" && seen.info.pid === this.pid && seen.info.startedAt === this.startedAt) { try { this.fs.unlinkSync(this.o.path); } catch {} }
  }

  private mine(): LockInfo { return { pid: this.pid, port: this.o.port, startedAt: this.startedAt, heartbeatAt: this.now() }; }

  private refuse(seen: Seen): false {
    this.refusedBy = seen.kind === "lock" ? seen.info : { pid: 0, port: 0, startedAt: 0, heartbeatAt: 0 };
    return false;
  }

  private verdict(seen: Seen): Verdict {
    if (seen.kind === "none") return "free";
    if (seen.kind === "garbage") return seen.ageMs > GARBAGE_GRACE_MS ? "stale" : "blocked";
    const { info } = seen;
    if (info.pid === this.pid) return "ours";
    if (Math.abs(this.now() - info.heartbeatAt) > this.staleMs) return "stale";
    return this.isAlive(info.pid) ? "blocked" : "stale";
  }

  private inspect(): Seen {
    let text: string;
    try { text = this.fs.readFileSync(this.o.path, "utf8"); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "none" };
      return { kind: "garbage", ageMs: 0 };                       // present but unreadable right now: do not touch it yet
    }
    try {
      const v = JSON.parse(text) as Partial<LockInfo>;
      if (v && Number.isInteger(v.pid) && (v.pid as number) > 0) {
        return { kind: "lock", info: {
          pid: v.pid as number,
          port: Number.isInteger(v.port) ? (v.port as number) : 0,
          startedAt: typeof v.startedAt === "number" ? v.startedAt : 0,
          heartbeatAt: typeof v.heartbeatAt === "number" ? v.heartbeatAt : this.mtime(),   // a lock without a heartbeat: its mtime is the best guess
        } };
      }
    } catch {}
    try { return { kind: "garbage", ageMs: this.now() - this.fs.statSync(this.o.path).mtimeMs }; } catch { return { kind: "none" }; }
  }

  private mtime(): number { try { return this.fs.statSync(this.o.path).mtimeMs; } catch { return 0; } }

  /** Creates the lock with its full content, or reports that it exists. Falls back to an exclusive write where hard links are unsupported. */
  private publish(): Published {
    const body = JSON.stringify(this.mine());
    const tmp = uniqueTmp(this.o.path);
    try {
      try { this.fs.writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 }); } catch { return "error"; }
      try { this.fs.linkSync(tmp, this.o.path); return "ok"; } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "EEXIST") return "exists";
        if (code !== "EPERM" && code !== "ENOSYS" && code !== "EXDEV" && code !== "ENOTSUP") return "error";
      }
      try { this.fs.writeFileSync(this.o.path, body, { encoding: "utf8", flag: "wx", mode: 0o600 }); return "ok"; } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EEXIST" ? "exists" : "error";
      }
    } finally {
      try { this.fs.unlinkSync(tmp); } catch {}
    }
  }

  /** Replaces the lock with a fresh copy of ours: full content in a unique temp file, then a rename over it (retried on Windows). */
  private writeAtomic(): void {
    const tmp = uniqueTmp(this.o.path);
    try {
      this.fs.writeFileSync(tmp, JSON.stringify(this.mine()), { encoding: "utf8", mode: 0o600 });
      renameWithRetry(tmp, this.o.path, this.fs);
    } catch {
      try { this.fs.unlinkSync(tmp); } catch {}                // an unwritable home never costs the schedules
    }
  }
}
