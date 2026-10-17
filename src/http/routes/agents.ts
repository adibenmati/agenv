import { Router } from "express";
import { HttpError } from "../../core/HttpError";
import type { AppDeps } from "../AppDeps";
import { wrap } from "../errors";

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const safeId = (v: unknown): string => {
  if (typeof v !== "string" || !ID_RE.test(v)) throw new HttpError(400, "invalid id");
  return v;
};

/** Named agents: create (blank, from a session, fork or distill), duplicate, open, run; plus conversation fork and size estimate. */
export function agentsRouter(d: AppDeps): Router {
  const r = Router();
  const auth = d.auth.apiAuth;
  const body = (req: { body?: unknown }): Record<string, unknown> => (req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {});
  const sessionJson = (s: { id: number; name: string; cwd: string; detectedTool: string; created: number; status: string; group: string }) =>
    ({ id: s.id, name: s.name, cwd: s.cwd, tool: s.detectedTool, created: s.created, status: s.status, group: s.group });

  r.get("/api/agents", auth, (_req, res) => res.json(d.agents.list()));

  r.post("/api/agents", auth, wrap((req, res) => res.json(d.agents.createBlank(body(req)))));

  r.put("/api/agents/:id", auth, wrap((req, res) => res.json(d.agents.update(req.params.id, body(req) as never))));

  r.delete("/api/agents/:id", auth, wrap((req, res) => { d.agents.get(req.params.id); d.agents.remove(req.params.id); res.json({ ok: true }); }));

  r.post("/api/agents/from-session", auth, wrap((req, res) => {
    const b = body(req);
    res.json(d.agents.createFromSession({ sessionId: Number(b.sessionId), name: str(b.name), specialty: str(b.specialty) }));
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

  r.post("/api/agents/:id/run", auth, wrap(async (req, res) => res.json(await d.agents.run(req.params.id, str(body(req).prompt)))));

  r.post("/api/claude/conversations/:id/fork", auth, wrap((req, res) => {
    const s = d.agents.forkConversationTerminal(safeId(req.params.id), str(body(req).cwd));
    d.stateStore.saveNow();
    res.json(sessionJson(s));
  }));

  r.get("/api/claude/conversations/:id/estimate", auth, wrap(async (req, res) => {
    const est = await d.sessionIndex.estimate(safeId(req.params.id));
    if (!est) throw new HttpError(404, "Conversation not found");
    res.json(est);
  }));

  return r;
}
