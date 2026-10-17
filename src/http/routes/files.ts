import { Router } from "express";
import type { AppDeps } from "../AppDeps";
import { wrap } from "../errors";

export function filesRouter(d: AppDeps): Router {
  const r = Router();
  const auth = d.auth.apiAuth;

  // ---- File explorer APIs ----
  r.get("/api/files", auth, wrap(async (req, res) => res.json(await d.files.list(req.query.dir, !!req.query.hidden))));
  r.get("/api/file", auth, wrap(async (req, res) => res.json(await d.files.read(req.query.path))));

  // ---- File save API ----
  r.put("/api/file", auth, wrap(async (req, res) => res.json(await d.files.write(req.body && req.body.path, req.body && req.body.content))));

  // ---- File/image upload API (for drag-drop and clipboard paste), Smart Paste / Clip API ----
  r.post("/api/upload", auth, wrap(async (req, res) => res.json(await d.files.upload(req.body || {}))));
  r.post("/api/clip", auth, wrap(async (req, res) => res.json(await d.files.clip(req.body || {}))));

  return r;
}
