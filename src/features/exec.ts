import { ChildProcess, spawn } from "child_process";

export interface RunOptions {
  cwd: string;
  /** Kill the child after this long (status null, error.code "ETIMEDOUT"). Default: no limit. */
  timeoutMs?: number;
  /** Bytes of output kept per stream before the child is killed (error.code "ENOBUFS"). Default 1 MiB. */
  maxBuffer?: number;
}

export interface RunResult {
  /** Exit code, or null if the child could not start, was killed or timed out. */
  status: number | null;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException;
}

/**
 * Runs a program without a shell and without blocking the event loop. Arguments are passed verbatim, so spaces
 * and shell metacharacters in them are just text. Never rejects: failures come back in `error`, with whatever
 * output was produced so far (the same shape callers got from spawnSync).
 */
export function run(cmd: string, args: string[], o: RunOptions): Promise<RunResult> {
  const maxBuffer = o.maxBuffer ?? 1024 * 1024;
  return new Promise((resolve) => {
    const out: Buffer[] = [], err: Buffer[] = [];
    let outSize = 0, errSize = 0;
    let error: NodeJS.ErrnoException | undefined;
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let force: NodeJS.Timeout | null = null;

    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { cwd: o.cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ status: null, stdout: "", stderr: "", error: e as NodeJS.ErrnoException });
      return;
    }

    const settle = (status: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (force) clearTimeout(force);
      resolve({ status, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), error });
    };
    const fail = (code: string): void => {
      if (error) return;
      error = Object.assign(new Error(`${cmd} ${code}`), { code }) as NodeJS.ErrnoException;
      try { child.kill(); } catch {}
      force = setTimeout(() => settle(null), 2000);   // a child that ignores the signal must not hang the caller
    };

    const collect = (chunks: Buffer[], size: number, buf: Buffer): number => {
      if (error) return size;                          // already over the limit / timed out — drop the rest
      const room = maxBuffer - size;
      if (buf.length > room) { chunks.push(buf.subarray(0, Math.max(0, room))); fail("ENOBUFS"); return maxBuffer; }
      chunks.push(buf);
      return size + buf.length;
    };
    child.stdout!.on("data", (b: Buffer) => { outSize = collect(out, outSize, b); });
    child.stderr!.on("data", (b: Buffer) => { errSize = collect(err, errSize, b); });

    if (o.timeoutMs) timer = setTimeout(() => fail("ETIMEDOUT"), o.timeoutMs);

    child.on("error", (e: NodeJS.ErrnoException) => { error = error || e; settle(null); });   // could not start (ENOENT, bad cwd, ...)
    child.on("close", (code) => settle(code));
  });
}
