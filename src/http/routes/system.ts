import { Router } from "express";
import type { AppDeps } from "../AppDeps";

export function systemRouter(d: AppDeps): Router {
  const r = Router();
  const auth = d.auth.apiAuth;

  // ---- System stats API (cached) ----
  r.get("/api/stats", auth, (_req, res) => res.json(d.stats.snapshot()));

  // ---- Shutdown API ----
  r.post("/api/shutdown", auth, (_req, res) => {
    res.json({ ok: true, message: "Server shutting down..." });
    setTimeout(() => d.shutdown("Shutdown via API"), 500);
  });

  // ---- Token rotation API ----
  r.post("/api/token/rotate", auth, (_req, res) => {
    try { res.json({ ok: true, token: d.auth.rotateToken() }); }
    catch (e: any) { res.json({ ok: false, error: e.message }); }
  });

  return r;
}
