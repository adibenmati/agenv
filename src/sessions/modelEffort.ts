import { HttpError } from "../core/HttpError";

/** Effort levels `claude --effort` accepts. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

const MODEL = /^[A-Za-z0-9._:\/-]{1,64}$/;

/** A model alias (sonnet, opus, fable, haiku) or full name; "" means "use Claude's default". Anything else is refused. */
export function parseModel(v: unknown): string {
  if (v == null || v === "") return "";
  if (typeof v !== "string" || !MODEL.test(v.trim())) throw new HttpError(400, "Model must be an alias such as sonnet or a full model name");
  return v.trim();
}

/** One of EFFORTS, or "" for Claude's default. */
export function parseEffort(v: unknown): string {
  if (v == null || v === "") return "";
  const e = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (!(EFFORTS as readonly string[]).includes(e)) throw new HttpError(400, "Effort must be one of " + EFFORTS.join(", "));
  return e;
}

/** Like parseModel/parseEffort for data from a file: a bad value is dropped instead of refused. */
export const lenientModel = (v: unknown): string => { try { return parseModel(v); } catch { return ""; } };
export const lenientEffort = (v: unknown): string => { try { return parseEffort(v); } catch { return ""; } };

/** The `claude` command-line flags for a session's settings. */
export function claudeFlags(s: { model?: string; effort?: string }): string[] {
  return [...(s.model ? ["--model", s.model] : []), ...(s.effort ? ["--effort", s.effort] : [])];
}
