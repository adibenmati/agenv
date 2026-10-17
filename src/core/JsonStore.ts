import * as fs from "fs";
import { Crypto } from "./Crypto";

export interface JsonStoreOptions<T> {
  path: string;
  crypto: Crypto;
  /** Value to use when the file is missing or unreadable. Called on every miss so callers never share one object. */
  fallback: () => T;
  /** Pre-encryption plain-JSON file to migrate from (then deleted) when the encrypted file cannot be read. */
  legacyPath?: string;
  /** Only migrate a legacy value this accepts (e.g. a non-empty array); defaults to accepting anything. */
  acceptLegacy?: (v: unknown) => boolean;
}

/** On Windows a rename over a file another process (a virus scanner, an indexer) has open fails briefly with EPERM/EBUSY/EACCES. */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(from, to); return; } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 4 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}

/** Repository over one encrypted JSON file. */
export class JsonStore<T> {
  constructor(private readonly o: JsonStoreOptions<T>) {}

  load(): T {
    const { path, crypto, fallback, legacyPath, acceptLegacy } = this.o;
    try {
      return crypto.decryptJSON<T>(fs.readFileSync(path, "utf8"));
    } catch {
      if (legacyPath) {
        try {
          const old = JSON.parse(fs.readFileSync(legacyPath, "utf8"));
          if (!acceptLegacy || acceptLegacy(old)) {
            this.save(old as T);
            try { fs.unlinkSync(legacyPath); } catch {}
            return old as T;
          }
        } catch {}
      }
      return fallback();
    }
  }

  /** Cheap change detector for the file: "<mtimeMs>:<size>:<inode>" (the inode changes with every atomic save), or null when it does not exist. Callers cache a parsed value under it. */
  signature(): string | null {
    try { const st = fs.statSync(this.o.path); return `${st.mtimeMs}:${st.size}:${st.ino}`; } catch { return null; }
  }

  /** Atomic: the new content is written to <path>.tmp and renamed over the target, so a crash never leaves a half-written file. */
  save(value: T): void {
    const tmp = this.o.path + ".tmp";
    try {
      fs.writeFileSync(tmp, this.o.crypto.encryptJSON(value), "utf8");
      renameWithRetry(tmp, this.o.path);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      throw e;
    }
  }
}
