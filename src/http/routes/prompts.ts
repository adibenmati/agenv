import { Router } from "express";
import type { AppDeps } from "../AppDeps";
import { wrap } from "../errors";

export function promptsRouter(d: AppDeps): Router {
  const r = Router();
  const auth = d.auth.apiAuth;
  r.get("/api/prompts", auth, (_req, res) => res.json(d.prompts.list()));
  r.post("/api/prompts", auth, wrap((req, res) => res.json(d.prompts.create(req.body || {}))));
  r.put("/api/prompts/:id", auth, wrap((req, res) => res.json(d.prompts.update(req.params.id, req.body || {}))));
  r.delete("/api/prompts/:id", auth, (req, res) => { d.prompts.remove(req.params.id); res.json({ ok: true }); });
  r.post("/api/prompts/:id/use", auth, (req, res) => { d.prompts.use(req.params.id); res.json({ ok: true }); });
  return r;
}
