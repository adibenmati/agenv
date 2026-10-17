import * as nodeCrypto from "crypto";
import * as fs from "fs";

/**
 * AES-256-GCM JSON encryption with a 32-byte key kept in a file (~/.agenv.key, hex). Files written by the
 * pre-TypeScript server decrypt unchanged; a payload without a `v` field is legacy plain JSON and is returned as-is.
 */
export class Crypto {
  constructor(private readonly keyPath: string) {}

  private key(): Buffer {
    try {
      const hex = fs.readFileSync(this.keyPath, "utf8").trim();
      if (hex.length !== 64) throw new Error("bad key");
      return Buffer.from(hex, "hex");
    } catch {
      const key = nodeCrypto.randomBytes(32);
      fs.writeFileSync(this.keyPath, key.toString("hex"), { mode: 0o600 });
      return key;
    }
  }

  encryptJSON(obj: unknown): string {
    const key = this.key();
    const iv = nodeCrypto.randomBytes(12);
    const cipher = nodeCrypto.createCipheriv("aes-256-gcm", key, iv);
    let enc = cipher.update(JSON.stringify(obj), "utf8", "base64");
    enc += cipher.final("base64");
    return JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: enc });
  }

  decryptJSON<T = unknown>(raw: string): T {
    const parsed = JSON.parse(raw);
    if (!parsed.v) return parsed as T;
    const d = nodeCrypto.createDecipheriv("aes-256-gcm", this.key(), Buffer.from(parsed.iv, "base64"));
    d.setAuthTag(Buffer.from(parsed.tag, "base64"));
    let dec = d.update(parsed.data, "base64", "utf8");
    dec += d.final("utf8");
    return JSON.parse(dec) as T;
  }
}
