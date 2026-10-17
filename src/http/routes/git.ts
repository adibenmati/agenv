import { Router } from "express";
import type { AppDeps } from "../AppDeps";
import { wrap } from "../errors";

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export function gitRouter(d: AppDeps): Router {
  const r = Router();
  const auth = d.auth.apiAuth;

  // Discover git repos in/around a directory (supports monorepos)
  r.get("/api/git/repos", auth, wrap(async (req, res) => res.json(await d.git.repos(str(req.query.dir)))));
  r.get("/api/git/diff-file", auth, wrap(async (req, res) => res.json(await d.git.diffFile(req.query.path, str(req.query.cwd)))));
  // Combined diff endpoint for AI features — returns staged diff, full diff, and recent commits
  r.get("/api/git/diff-for-ai", auth, wrap(async (req, res) => res.json(await d.git.diffForAi(str(req.query.dir)))));

  // Must come after the fixed GET routes above: it matches any single segment.
  r.get("/api/git/:action", auth, wrap(async (req, res) => {
    const session = d.sessions.get(parseInt(String(req.query.session || "0"), 10));
    const cwd = str(req.query.dir) || (session ? session.cwd : process.cwd());
    res.json(await d.git.action(req.params.action, cwd));
  }));

  // ---- Git commit/push APIs ----
  const post = (p: string, run: (b: any) => Promise<unknown>): void => {
    r.post(p, auth, wrap(async (req, res) => res.json(await run(req.body || {}))));
  };
  post("/api/git/stage", (b) => d.git.stage(str(b.dir), b.files));
  post("/api/git/commit", (b) => d.git.commit(str(b.dir), b.message));
  post("/api/git/push", (b) => d.git.push(str(b.dir), b.remote, b.branch));
  post("/api/git/checkout", (b) => d.git.checkout(str(b.dir), b.branch));
  post("/api/git/unstage", (b) => d.git.unstage(str(b.dir), b.files));
  post("/api/git/discard", (b) => d.git.discard(str(b.dir), b.files));
  post("/api/git/stash", (b) => d.git.stash(str(b.dir), b.message));
  post("/api/git/stash-pop", (b) => d.git.stashPop(str(b.dir)));
  post("/api/git/worktree-add", (b) => d.git.worktreeAdd(str(b.dir), b.branch));

  return r;
}
