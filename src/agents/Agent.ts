import { HttpError } from "../core/HttpError";

export type PermissionMode = "plan" | "acceptEdits" | "dontAsk" | "bypassPermissions";
export const PERMISSION_MODES: PermissionMode[] = ["plan", "acceptEdits", "dontAsk", "bypassPermissions"];

export interface Permission { mode: PermissionMode; allowedTools: string[] }

export type AgentOrigin =
  | { kind: "blank" }
  | { kind: "fork"; sourceConversationId: string; compacted: boolean }
  | { kind: "distilled"; sourceConversationId: string; artifact: "briefing" | "skill" }
  | { kind: "duplicate"; sourceAgentId: string };

export interface Agent {
  id: string;
  name: string;
  specialty: string;
  cwd: string;
  conversationId: string;
  instructions: string;
  briefingFile: string;
  addDirs: string[];
  mcpConfig: string;
  model: string;
  permission: Permission;
  origin: AgentOrigin;
  created: number;
  updated: number;
  lastRunAt: number | null;
}

/** The user-editable part of an Agent, after validation. */
export interface AgentInput {
  name: string;
  specialty: string;
  cwd: string;
  instructions: string;
  briefingFile: string;
  addDirs: string[];
  mcpConfig: string;
  model: string;
  permission: Permission;
}

/** The one rule for a Claude conversation id that may reach a command line or a file name. */
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const isSafeId = (v: unknown): v is string => typeof v === "string" && ID_RE.test(v);

export const NAME_RE = /^[A-Za-z0-9_-]{1,48}$/;

const bad = (msg: string): never => { throw new HttpError(400, msg); };

function str(v: unknown, field: string, fallback = ""): string {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "string") return bad(`${field} must be a string`);
  return v.trim();
}

export function validateName(v: unknown): string {
  const name = str(v, "name");
  if (!NAME_RE.test(name)) bad("name must be 1-48 characters: letters, digits, - and _");
  return name;
}

export function validatePermission(v: unknown): Permission {
  if (v === undefined || v === null) return { mode: "acceptEdits", allowedTools: [] };
  if (typeof v !== "object" || Array.isArray(v)) return bad("permission must be an object");
  const p = v as { mode?: unknown; allowedTools?: unknown };
  const mode = p.mode === undefined ? "acceptEdits" : p.mode;
  if (!PERMISSION_MODES.includes(mode as PermissionMode)) bad("permission.mode is not valid");
  const tools = p.allowedTools === undefined ? [] : p.allowedTools;
  if (!Array.isArray(tools) || tools.some((t) => typeof t !== "string")) bad("permission.allowedTools must be a list of strings");
  return { mode: mode as PermissionMode, allowedTools: (tools as string[]).map((t) => t.trim()).filter(Boolean) };
}

/** Throws HttpError(400) for anything wrong; fills defaults for omitted optional fields. */
export function validateAgentInput(input: unknown, opts: { isDir: (p: string) => boolean }): AgentInput {
  if (!input || typeof input !== "object") return bad("agent must be an object");
  const o = input as Record<string, unknown>;
  const cwd = str(o.cwd, "cwd");
  if (!cwd || !opts.isDir(cwd)) bad("cwd is not an existing folder");
  const addDirs = o.addDirs === undefined || o.addDirs === null ? [] : o.addDirs;
  if (!Array.isArray(addDirs) || addDirs.some((d) => typeof d !== "string")) bad("addDirs must be a list of strings");
  return {
    name: validateName(o.name),
    specialty: str(o.specialty, "specialty"),
    cwd,
    instructions: typeof o.instructions === "string" ? o.instructions : str(o.instructions, "instructions"),
    briefingFile: str(o.briefingFile, "briefingFile"),
    addDirs: (addDirs as string[]).map((d) => d.trim()).filter(Boolean),
    mcpConfig: str(o.mcpConfig, "mcpConfig"),
    model: str(o.model, "model"),
    permission: validatePermission(o.permission),
  };
}

export function validateOrigin(v: unknown): AgentOrigin {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return bad("origin must be an object");
  switch (o.kind) {
    case "blank": return { kind: "blank" };
    case "fork":
      if (typeof o.sourceConversationId === "string" && typeof o.compacted === "boolean") return { kind: "fork", sourceConversationId: o.sourceConversationId, compacted: o.compacted };
      break;
    case "distilled":
      if (typeof o.sourceConversationId === "string" && (o.artifact === "briefing" || o.artifact === "skill")) return { kind: "distilled", sourceConversationId: o.sourceConversationId, artifact: o.artifact };
      break;
    case "duplicate":
      if (typeof o.sourceAgentId === "string") return { kind: "duplicate", sourceAgentId: o.sourceAgentId };
      break;
  }
  return bad("origin is not valid");
}
