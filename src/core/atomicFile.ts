import * as fs from "fs";
import { randomBytes } from "crypto";

/** The filesystem surface the atomic helpers use; tests inject a wrapper to simulate Windows lock errors. */
export type Fs = typeof fs;

/** `<path>.<pid>.<random>.tmp`: unique per call, so two writers (or two saves) never share a temp file. */
export function uniqueTmp(path: string): string {
  return `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
}

/** On Windows a rename over a file another process (a virus scanner, an indexer) has open fails briefly with EPERM/EBUSY/EACCES. */
export function isTransientFsError(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException)?.code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

/** Renames, retrying those transient errors (4 retries, 20 ms apart); the last error is thrown. */
export function renameWithRetry(from: string, to: string, fsImpl: Fs = fs): void {
  for (let attempt = 0; ; attempt++) {
    try { fsImpl.renameSync(from, to); return; } catch (e) {
      if (attempt >= 4 || !isTransientFsError(e)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}
