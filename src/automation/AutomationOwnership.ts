import * as fs from "fs";

export interface LockInfo { pid: number; port: number; startedAt: number }

export interface AutomationOwnershipOptions {
  /** The lock file, `~/.agenv-automation.lock`. */
  path: string;
  /** This instance's HTTP port; recorded so a refused instance can say who owns the schedules. */
  port: number;
  pid?: number;
  /** Whether a process exists. Defaults to `process.kill(pid, 0)`; injectable for tests. */
  isAlive?: (pid: number) => boolean;
  now?: () => number;
}

/** `kill(pid, 0)` throws ESRCH for a process that does not exist; EPERM means it exists but belongs to someone else. */
export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * Only one agenv instance on a machine may run the routine schedules (two ticks would fire every routine twice). The
 * instance that creates `~/.agenv-automation.lock` owns them; a lock whose recorded process is gone is taken over.
 * A runtime that never calls acquire() counts as the owner, so embedding and tests behave as before.
 */
export class AutomationOwnership {
  private readonly pid: number;
  private readonly startedAt: number;
  private readonly isAlive: (pid: number) => boolean;
  private refusedBy: LockInfo | null = null;

  constructor(private readonly o: AutomationOwnershipOptions) {
    this.pid = o.pid ?? process.pid;
    this.startedAt = (o.now ?? Date.now)();
    this.isAlive = o.isAlive ?? processAlive;
  }

  /** True when this instance owns the schedules (including: acquire() has not been refused). */
  isOwner(): boolean { return this.refusedBy === null; }

  /** The port of the instance that owns the schedules: ours when we do, the lock holder's when we were refused. */
  ownerPort(): number { return this.refusedBy ? this.refusedBy.port : this.o.port; }

  /** Takes the lock if it is free, ours or stale. False (and isOwner() false) when a live process holds it. */
  acquire(): boolean {
    const mine: LockInfo = { pid: this.pid, port: this.o.port, startedAt: this.startedAt };
    for (let attempt = 0; attempt < 3; attempt++) {
      const cur = this.read();
      if (cur && cur.pid === this.pid) {
        try { fs.writeFileSync(this.o.path, JSON.stringify(mine), { encoding: "utf8", mode: 0o600 }); } catch {}
        this.refusedBy = null;
        return true;
      }
      if (cur && this.isAlive(cur.pid)) { this.refusedBy = cur; return false; }
      // stale (its process is gone) or unreadable garbage: clear it, then create exclusively
      if (cur || fs.existsSync(this.o.path)) { try { fs.unlinkSync(this.o.path); } catch {} }
      try {
        fs.writeFileSync(this.o.path, JSON.stringify(mine), { encoding: "utf8", flag: "wx", mode: 0o600 });
        this.refusedBy = null;
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;   // someone created it between our read and write: look again
        this.refusedBy = null;                                          // the lock cannot be written (read-only home): do not lose the schedules
        return true;
      }
    }
    const cur = this.read();
    if (cur && cur.pid !== this.pid) { this.refusedBy = cur; return false; }
    this.refusedBy = null;
    return true;
  }

  /** Removes the lock, but only if it is still ours. */
  release(): void {
    const cur = this.read();
    if (cur && cur.pid === this.pid && cur.startedAt === this.startedAt) { try { fs.unlinkSync(this.o.path); } catch {} }
  }

  private read(): LockInfo | null {
    try {
      const v = JSON.parse(fs.readFileSync(this.o.path, "utf8")) as Partial<LockInfo>;
      if (v && Number.isInteger(v.pid) && (v.pid as number) > 0) {
        return { pid: v.pid as number, port: Number.isInteger(v.port) ? (v.port as number) : 0, startedAt: typeof v.startedAt === "number" ? v.startedAt : 0 };
      }
    } catch {}
    return null;
  }
}
