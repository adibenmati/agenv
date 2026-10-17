import { Router } from "express";
import { HttpError } from "../../core/HttpError";
import { safeId } from "../../core/ids";
import type { AppDeps } from "../AppDeps";
import { wrap } from "../errors";

const DEFAULT_RUN_LIMIT = 50;
const MAX_RUN_LIMIT = 500;
const DEFAULT_LOG_TAIL = 64 * 1024;
const MAX_LOG_TAIL = 1024 * 1024;

/** Routines, their runs and the global automation switches. */
export function routinesRouter(d: AppDeps): Router {
  const r = Router();
  const auth = d.auth.apiAuth;
  const body = (req: { body?: unknown }): Record<string, unknown> => {
    if (Array.isArray(req.body)) throw new HttpError(400, "body must be a JSON object");
    return req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
  };
  /** Only these fields are editable over HTTP; id, nextRunAt, lastRunAt, created and updated are server-managed. */
  const ROUTINE = [
    "name", "enabled", "cron", "timezone", "prompt", "target", "conversation", "permission", "allowBypass", "model",
    "maxBudgetUsd", "timeoutMin", "concurrency", "catchUp", "maxRunsPerDay",
  ] as const;
  const routinePatch = (b: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(ROUTINE.filter((k) => b[k] !== undefined).map((k) => [k, b[k]]));
  const SETTINGS = ["paused", "maxDailyCostUsd"] as const;
  const settingsPatch = (b: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(SETTINGS.filter((k) => b[k] !== undefined).map((k) => [k, b[k]]));
  const sessionJson = (s: { id: number; name: string; cwd: string; detectedTool: string; created: number; status: string; group: string }) =>
    ({ id: s.id, name: s.name, cwd: s.cwd, tool: s.detectedTool, created: s.created, status: s.status, group: s.group });
  const routineId = (v: string): string => safeId(v, "invalid routine id");
  const runId = (v: string): string => safeId(v, "invalid run id");
  /** A query value that is absent (fallback), or a plain decimal integer within [min, max]; anything else is a 400, never clamped. */
  const intParam = (v: unknown, name: string, min: number, max: number, fallback: number): number => {
    if (v === undefined) return fallback;
    if (typeof v !== "string" || !/^[0-9]{1,15}$/.test(v)) throw new HttpError(400, `${name} must be a whole number from ${min} to ${max}`);
    const n = Number(v);
    if (n < min || n > max) throw new HttpError(400, `${name} must be a whole number from ${min} to ${max}`);
    return n;
  };

  r.get("/api/routines", auth, (_req, res) => res.json(d.automation.listRoutines()));

  r.post("/api/routines", auth, wrap((req, res) => res.json(d.automation.createRoutine(routinePatch(body(req))))));

  r.put("/api/routines/:id", auth, wrap((req, res) => res.json(d.automation.updateRoutine(routineId(req.params.id), routinePatch(body(req))))));

  r.delete("/api/routines/:id", auth, wrap(async (req, res) => {
    await d.automation.deleteRoutine(routineId(req.params.id));
    res.json({ ok: true });
  }));

  // Refused with a 409 and the reason when automation is paused or a daily limit is reached.
  r.post("/api/routines/:id/run", auth, wrap((req, res) => res.json(d.automation.runNow(routineId(req.params.id)))));

  r.get("/api/routines/:id/runs", auth, wrap((req, res) => {
    const id = routineId(req.params.id);
    res.json(d.automation.listRuns(id, intParam(req.query.limit, "limit", 1, MAX_RUN_LIMIT, DEFAULT_RUN_LIMIT)));
  }));

  r.get("/api/runs/:id", auth, wrap((req, res) => res.json(d.automation.getRun(runId(req.params.id)))));

  r.get("/api/runs/:id/log", auth, wrap((req, res) => {
    const id = runId(req.params.id);
    const tail = intParam(req.query.tail, "tail", 1, MAX_LOG_TAIL, DEFAULT_LOG_TAIL);
    res.type("text/plain").send(d.automation.readLog(id, tail));
  }));

  r.post("/api/runs/:id/cancel", auth, wrap(async (req, res) => {
    res.json(await d.automation.cancelRun(runId(req.params.id)));
  }));

  r.post("/api/runs/:id/open", auth, wrap((req, res) => {
    const s = d.automation.openRun(runId(req.params.id));
    d.stateStore.saveNow();
    res.json(sessionJson(s));
  }));

  // GET: the global switches plus which agenv instance runs the schedules: { paused, maxDailyCostUsd, owner, ownerPort }.
  const automationState = (settings: object): object => ({ ...settings, ...d.automation.ownerInfo() });
  r.get("/api/automation", auth, (_req, res) => res.json(automationState(d.automation.getSettings())));

  r.put("/api/automation", auth, wrap((req, res) => res.json(d.automation.setSettings(settingsPatch(body(req)) as never))));

  return r;
}
