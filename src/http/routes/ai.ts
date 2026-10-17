import { Router } from "express";
import type { AppDeps } from "../AppDeps";
import { wrap } from "../errors";

/** AI Assistant — rides on the user's configured CLI agent. */
export function aiRouter(d: AppDeps): Router {
  const r = Router();
  r.post("/api/ai/ask", d.auth.apiAuth, wrap(async (req, res) => res.json(await d.ai.ask(req.body || {}))));
  return r;
}
