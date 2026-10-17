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

  save(value: T): void {
    fs.writeFileSync(this.o.path, this.o.crypto.encryptJSON(value), "utf8");
  }
}
