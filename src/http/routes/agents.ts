import { Router } from "express";
import { HttpError } from "../../core/HttpError";
import { safeId } from "../../core/ids";
import type { AppDeps } from "../AppDeps";
import { wrap } from "../errors";

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Named agents: create (blank, from a session, fork or distill), duplicate, open, run; plus conversation fork and size estimate. */
export function agentsRouter(d: AppDeps): Router {
  const r = Router();
  const auth = d.auth.apiAuth;
  const body = (req: { body?: unknown }): Record<string, unknown> => {
    if (Array.isArray(req.body)) throw new HttpError(400, "body must be a JSON object");
    return req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
  };
  /** Only these fields are editable over HTTP; conversationId, lastRunAt, origin, id and created are server-managed. */
  const PROFILE = ["name", "specialty", "cwd", "instructions", "briefingFile", "addDirs", "mcpConfig", "model", "permission"] as const;
  const profilePatch = (b: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(PROFILE.filter((k) => b[k] !== undefined).map((k) => [k, b[k]]));
  const sessionJson = (s: { id: number; name: string; cwd: string; detectedTool: string; created: number; status: string; group: string }) =>
    ({ id: s.id, name: s.name, cwd: s.cwd, tool: s.detectedTool, created: s.created, status: s.status, group: s.group });

  r.get("/api/agents", auth, (_req, res) => res.json(d.agents.list().map((a) => ({ ...a, running: !!a.conversationId && d.agents.isConversationBusy(a.conversationId) }))));

  r.post("/api/agents", auth, wrap((req, res) => res.json(d.agents.createBlank(profilePatch(body(req))))));

  r.put("/api/agents/:id", auth, wrap((req, res) => res.json(d.agents.update(req.params.id, profilePatch(body(req)) as never))));

  r.delete("/api/agents/:id", auth, wrap((req, res) => { d.agents.get(req.params.id); d.agents.remove(req.params.id); res.json({ ok: true }); }));

  r.post("/api/agents/from-session", auth, wrap((req, res) => {
    const b = body(req);
    if (typeof b.sessionId !== "number" || !Number.isInteger(b.sessionId)) throw new HttpError(400, "sessionId must be an integer");
    res.json(d.agents.createFromSession({ sessionId: b.sessionId, name: str(b.name), specialty: str(b.specialty) }));
  }));

  r.post("/api/agents/from-conversation", auth, wrap(async (req, res) => {
    const b = body(req);
    res.json(await d.agents.createFromConversation({
      name: str(b.name), specialty: str(b.specialty), sourceConversationId: str(b.sourceConversationId),
      mode: b.mode as never, cwd: str(b.cwd), overwrite: b.overwrite === true,
    }));
  }));

  r.post("/api/agents/:id/duplicate", auth, wrap(async (req, res) => res.json(await d.agents.duplicate(req.params.id, { compact: body(req).compact === true }))));

  r.post("/api/agents/:id/open", auth, wrap((req, res) => {
    const s = d.agents.openTerminal(req.params.id);
    d.stateStore.saveNow();
    res.json(sessionJson(s));
  }));

  // A run that fails is still HTTP 200: the RunResult.status field (succeeded, failed, ...) carries the outcome.
  r.post("/api/agents/:id/run", auth, wrap(async (req, res) => res.json(await d.agents.run(req.params.id, str(body(req).prompt)))));

  r.post("/api/claude/conversations/:id/fork", auth, wrap((req, res) => {
    const s = d.agents.forkConversationTerminal(safeId(req.params.id), str(body(req).cwd));
    d.stateStore.saveNow();
    res.json(sessionJson(s));
  }));

  r.get("/api/claude/conversations/:id/estimate", auth, wrap(async (req, res) => {
    const est = await d.sessionIndex.estimate(safeId(req.params.id));
    if (!est) throw new HttpError(404, "Conversation not found");
    res.json({ ...est, basis: "upper-bound: all context priced as fresh input; real runs are cheaper thanks to caching" });
  }));

  return r;
}
