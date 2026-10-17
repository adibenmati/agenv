import { Router } from "express";
import type { AppDeps } from "../AppDeps";
import { wrap } from "../errors";

export function searchRouter(d: AppDeps): Router {
  const r = Router();
  const auth = d.auth.apiAuth;
  r.get("/api/search/files", auth, wrap(async (req, res) =>
    res.json(await d.search.files({ dir: req.query.dir, q: req.query.q, limit: req.query.limit }))));
  r.get("/api/search/text", auth, wrap(async (req, res) =>
    res.json(await d.search.text({ dir: req.query.dir, q: req.query.q, limit: req.query.limit }))));
  return r;
}
