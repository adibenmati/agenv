import * as fs from "fs";
import * as path from "path";
import type { Crypto } from "../core/Crypto";

/** One encrypted file per session under ~/.agenv-scrollback/ so terminal history survives a restart. */
export class ScrollbackStore {
  constructor(private readonly dir: string, private readonly crypto: Crypto) {}

  private file(id: number): string { return path.join(this.dir, `session-${id}.enc`); }

  load(id: number): Buffer | null {
    try { return Buffer.from(this.crypto.decryptJSON<string>(fs.readFileSync(this.file(id), "utf8"))); } catch { return null; }
  }

  save(id: number, data: Buffer): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file(id), this.crypto.encryptJSON(data.toString("utf8")), "utf8");
    } catch {}
  }

  clear(id: number): void {
    try { fs.unlinkSync(this.file(id)); } catch {}
  }
}
