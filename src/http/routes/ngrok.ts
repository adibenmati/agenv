import { Router } from "express";
import type { AppDeps } from "../AppDeps";
import { wrap } from "../errors";

export function ngrokRouter(d: AppDeps): Router {
  const r = Router();
  const auth = d.auth.apiAuth;
  r.post("/api/ngrok/start", auth, wrap(async (req, res) => res.json(await d.ngrok.start(req.body && req.body.port))));
  r.post("/api/ngrok/stop", auth, (_req, res) => { d.ngrok.stop(); res.json({ ok: true }); });
  r.get("/api/ngrok/status", auth, wrap(async (_req, res) => res.json(await d.ngrok.status())));
  r.post("/api/ngrok/settings", auth, (req, res) => res.json(d.ngrok.updateSettings(req.body || {})));
  r.get("/api/ngrok/settings", auth, (_req, res) => res.json(d.ngrok.settings()));
  return r;
}
