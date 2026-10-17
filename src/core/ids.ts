import { HttpError } from "./HttpError";

/** The one rule for a Claude conversation id that may reach a command line or a file name. */
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const isSafeId = (v: unknown): v is string => typeof v === "string" && ID_RE.test(v);

/** Agent and artifact names. */
export const NAME_RE = /^[A-Za-z0-9_-]{1,48}$/;

/** Returns the id, or throws HttpError(400). */
export function safeId(v: unknown, message = "invalid id"): string {
  if (!isSafeId(v)) throw new HttpError(400, message);
  return v;
}
