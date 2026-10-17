import { HttpError } from "../core/HttpError";
import { Permission, validatePermission } from "../agents/Agent";
import { isValidTimeZone, minGapMinutes, nextCronTime, PRESETS } from "./cron";

export type RoutineTarget = { kind: "agent"; agentId: string } | { kind: "folder"; cwd: string };
export type RoutineConversation = "agent" | "fork" | "fresh";
export type RoutineConcurrency = "coalesce_if_active" | "skip_if_active" | "always_enqueue";
export type RoutineCatchUp = "skip_missed" | "enqueue_missed_with_cap";

export const CONVERSATIONS: RoutineConversation[] = ["agent", "fork", "fresh"];
export const CONCURRENCIES: RoutineConcurrency[] = ["coalesce_if_active", "skip_if_active", "always_enqueue"];
export const CATCH_UPS: RoutineCatchUp[] = ["skip_missed", "enqueue_missed_with_cap"];

export const MAX_NAME = 64;
export const MAX_PROMPT = 20_000;
export const MAX_MODEL = 100;
export const MAX_ALLOWED_TOOLS = 200;
export const MAX_TOOL_LEN = 200;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
export const DEFAULT_BUDGET_USD = 2;
export const MAX_BUDGET_USD = 100;
export const DEFAULT_TIMEOUT_MIN = 20;
export const MAX_TIMEOUT_MIN = 120;
export const MAX_RUNS_PER_DAY = 1000;
/** `enqueue_missed_with_cap` needs a schedule that fires at most hourly. */
export const MIN_CATCH_UP_GAP_MIN = 60;

export interface Routine {
  id: string;
  name: string;
  enabled: boolean;
  cron: string;
  timezone: string;
  prompt: string;
  target: RoutineTarget;
  conversation: RoutineConversation;
  permission: Permission;
  /** The client explicitly acknowledged `bypassPermissions`; never set implicitly. */
  allowBypass: boolean;
  model: string;
  maxBudgetUsd: number;
  timeoutMin: number;
  concurrency: RoutineConcurrency;
  catchUp: RoutineCatchUp;
  maxRunsPerDay: number | null;
  nextRunAt: number | null;
  lastRunAt: number | null;
  created: number;
  updated: number;
}

/** The user-editable part of a Routine, after validation. */
export type RoutineInput = Omit<Routine, "id" | "nextRunAt" | "lastRunAt" | "created" | "updated">;

export interface RoutineValidationOptions {
  isDir: (p: string) => boolean;
  agentExists: (id: string) => boolean;
  /** Epoch ms used to check that the schedule fires at all. */
  now: number;
}

const bad = (msg: string): never => { throw new HttpError(400, msg); };

const isMissing = (v: unknown): boolean => v === undefined || v === null;

function text(v: unknown, field: string, min: number, max: number): string {
  if (typeof v !== "string") return bad(`${field} is required and must be a string`);
  const s = v.trim();
  if (s.length < min) return bad(`${field} must not be empty`);
  if (s.length > max) return bad(`${field} must be at most ${max} characters`);
  return s;
}

function oneOf<T extends string>(v: unknown, field: string, allowed: readonly T[], fallback: T): T {
  if (isMissing(v)) return fallback;
  if (!allowed.includes(v as T)) return bad(`${field} is not valid`);
  return v as T;
}

function bool(v: unknown, field: string, fallback: boolean): boolean {
  if (isMissing(v)) return fallback;
  if (typeof v !== "boolean") return bad(`${field} must be true or false`);
  return v;
}

function int(v: unknown, field: string, min: number, max: number, fallback: number): number {
  if (isMissing(v)) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) return bad(`${field} must be a whole number from ${min} to ${max}`);
  return v;
}

export function resolveCron(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) return bad("cron is required");
  const src = v.trim();
  if (!src.startsWith("preset:")) return src;
  const key = src.slice("preset:".length);
  if (!Object.prototype.hasOwnProperty.call(PRESETS, key)) return bad(`unknown cron preset "${key}"`);
  return PRESETS[key as keyof typeof PRESETS];
}

function validateTarget(v: unknown, o: RoutineValidationOptions): RoutineTarget {
  if (!v || typeof v !== "object" || Array.isArray(v)) return bad("target must be an object");
  const t = v as Record<string, unknown>;
  if (t.kind === "agent") {
    if (Object.keys(t).some((k) => k !== "kind" && k !== "agentId")) bad("an agent target takes only agentId");
    if (typeof t.agentId !== "string" || !t.agentId) bad("target.agentId is required");
    if (!o.agentExists(t.agentId as string)) bad("target agent does not exist");
    return { kind: "agent", agentId: t.agentId as string };
  }
  if (t.kind === "folder") {
    if (Object.keys(t).some((k) => k !== "kind" && k !== "cwd")) bad("a folder target takes only cwd");
    const cwd = typeof t.cwd === "string" ? t.cwd.trim() : "";
    if (!cwd || !o.isDir(cwd)) bad("target.cwd is not an existing folder");
    return { kind: "folder", cwd };
  }
  return bad('target.kind must be "agent" or "folder"');
}

/** Throws HttpError(400) for anything wrong; fills defaults for omitted optional fields. */
export function validateRoutineInput(input: unknown, o: RoutineValidationOptions): RoutineInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) return bad("routine must be an object");
  const r = input as Record<string, unknown>;

  const name = text(r.name, "name", 1, MAX_NAME);
  if (CONTROL_CHARS.test(name)) bad("name must not contain control characters");
  const prompt = text(r.prompt, "prompt", 1, MAX_PROMPT);
  const cron = resolveCron(r.cron);
  const timezone = isMissing(r.timezone) ? Intl.DateTimeFormat().resolvedOptions().timeZone : r.timezone;
  if (typeof timezone !== "string" || !isValidTimeZone(timezone)) bad("timezone is not a valid IANA timezone");
  const tz = timezone as string;
  if (nextCronTime(cron, tz, o.now) === null) bad("cron never fires");

  const target = validateTarget(r.target, o);
  const conversation = oneOf(r.conversation, "conversation", CONVERSATIONS, target.kind === "folder" ? "fresh" : "agent");
  if (target.kind === "folder" && conversation !== "fresh") bad('a folder target always runs in a "fresh" conversation');

  const catchUp = oneOf(r.catchUp, "catchUp", CATCH_UPS, "skip_missed");
  if (catchUp === "enqueue_missed_with_cap" && minGapMinutes(cron) < MIN_CATCH_UP_GAP_MIN) {
    bad("catchUp enqueue_missed_with_cap is not allowed for schedules that fire more often than hourly");
  }

  const permission = validatePermission(r.permission);
  if (permission.allowedTools.length > MAX_ALLOWED_TOOLS || permission.allowedTools.some((t) => t.length > MAX_TOOL_LEN)) {
    bad(`permission.allowedTools allows at most ${MAX_ALLOWED_TOOLS} entries of ${MAX_TOOL_LEN} characters`);
  }
  const ack = bool(r.allowBypass, "allowBypass", false);
  if (permission.mode === "bypassPermissions" && !ack) bad("bypassPermissions requires allowBypass: true");
  // The acknowledgement only means something together with bypassPermissions; it is never stored on its own.
  const allowBypass = permission.mode === "bypassPermissions" && ack;

  let maxBudgetUsd = DEFAULT_BUDGET_USD;
  if (!isMissing(r.maxBudgetUsd)) {
    const b = r.maxBudgetUsd;
    if (typeof b !== "number" || !Number.isFinite(b) || b <= 0 || b > MAX_BUDGET_USD) bad(`maxBudgetUsd must be more than 0 and at most ${MAX_BUDGET_USD}`);
    maxBudgetUsd = b as number;
  }

  const maxRunsPerDay = isMissing(r.maxRunsPerDay) ? null : int(r.maxRunsPerDay, "maxRunsPerDay", 1, MAX_RUNS_PER_DAY, 0);
  if (!isMissing(r.model) && (typeof r.model !== "string" || r.model.trim().length > MAX_MODEL)) bad(`model must be a string of at most ${MAX_MODEL} characters`);

  return {
    name,
    enabled: bool(r.enabled, "enabled", true),
    cron,
    timezone: tz,
    prompt,
    target,
    conversation,
    permission,
    allowBypass,
    model: isMissing(r.model) ? "" : (r.model as string).trim(),
    maxBudgetUsd,
    timeoutMin: int(r.timeoutMin, "timeoutMin", 1, MAX_TIMEOUT_MIN, DEFAULT_TIMEOUT_MIN),
    concurrency: oneOf(r.concurrency, "concurrency", CONCURRENCIES, "coalesce_if_active"),
    catchUp,
    maxRunsPerDay,
  };
}
