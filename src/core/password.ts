import * as crypto from "crypto";

/** scrypt password hashing: "<salt hex>:<hash hex>". */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  return salt + ":" + crypto.scryptSync(password, salt, 64).toString("hex");
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = String(stored).split(":");
  if (!salt || !hash) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(crypto.scryptSync(password, salt, 64).toString("hex"), "hex"));
  } catch { return false; }
}
