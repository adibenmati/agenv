import * as nodeFs from "fs";
import { join } from "path";
import { Crypto } from "./Crypto";
import { Fs, isTransientFsError, renameWithRetry, uniqueTmp } from "./atomicFile";

export interface JsonStoreOptions<T> {
  path: string;
  crypto: Crypto;
  /** Value to use when the file is missing or unreadable. Called on every miss so callers never share one object. */
  fallback: () => T;
  /** Pre-encryption plain-JSON file to migrate from (then deleted) when the encrypted file cannot be read. */
  legacyPath?: string;
  /** Only migrate a legacy value this accepts (e.g. a non-empty array); defaults to accepting anything. */
  acceptLegacy?: (v: unknown) => boolean;
  /** The filesystem; injectable so tests can simulate a rename another process blocks. Defaults to node's fs. */
  fs?: Fs;
}

const TMP_PATTERN = /^\.agenv-.+\.enc\..+\.tmp$/;
const TMP_MAX_AGE_MS = 3600_000;

/**
 * Best-effort startup sweep: removes `.agenv-*.enc.*.tmp` files (left by a crash between the temp write and the rename) that are
 * older than an hour. Never throws; call it once, not per save.
 */
export function sweepTempFiles(dir: string, fsImpl: Fs = nodeFs, now: number = Date.now()): void {
  let names: string[];
  try { names = fsImpl.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!TMP_PATTERN.test(name)) continue;
    const f = join(dir, name);
    try {
      const st = fsImpl.statSync(f);
      if (st.isFile() && now - st.mtimeMs > TMP_MAX_AGE_MS) fsImpl.unlinkSync(f);
    } catch {}
  }
}

/** Repository over one encrypted JSON file. */
export class JsonStore<T> {
  private readonly fs: Fs;
  constructor(private readonly o: JsonStoreOptions<T>) { this.fs = o.fs ?? nodeFs; }

  load(): T {
    const { path, crypto, fallback, legacyPath, acceptLegacy } = this.o;
    try {
      return crypto.decryptJSON<T>(this.fs.readFileSync(path, "utf8"));
    } catch {
      if (legacyPath) {
        try {
          const old = JSON.parse(this.fs.readFileSync(legacyPath, "utf8"));
          if (!acceptLegacy || acceptLegacy(old)) {
            this.save(old as T);
            try { this.fs.unlinkSync(legacyPath); } catch {}
            return old as T;
          }
        } catch {}
      }
      return fallback();
    }
  }

  /** Cheap change detector for the file: "<mtimeMs>:<size>:<inode>" (the inode changes with every atomic save), or null when it does not exist. Callers cache a parsed value under it. */
  signature(): string | null {
    try { const st = this.fs.statSync(this.o.path); return `${st.mtimeMs}:${st.size}:${st.ino}`; } catch { return null; }
  }

  /**
   * Atomic: the new content is written to a unique <path>.<pid>.<random>.tmp and renamed over the target, so a crash never
   * leaves a half-written file. A rename that stays blocked by EPERM/EBUSY/EACCES after the retries (a scanner holding the
   * target open) falls back to a direct write: no worse than before saves were atomic. Any other failure is thrown and the
   * old file is untouched.
   */
  save(value: T): void {
    const fs = this.fs, target = this.o.path;
    const data = this.o.crypto.encryptJSON(value);
    const tmp = uniqueTmp(target);
    try {
      fs.writeFileSync(tmp, data, "utf8");
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      throw e;
    }
    try {
      renameWithRetry(tmp, target, fs);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      if (!isTransientFsError(e)) throw e;
      fs.writeFileSync(target, data, "utf8");
    }
  }
}
