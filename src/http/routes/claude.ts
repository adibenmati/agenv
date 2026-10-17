import * as path from "path";
import { Router } from "express";
import { isClaudeSessionId } from "../../claude/ClaudeLinker";
import { HttpError } from "../../core/HttpError";
import type { AppDeps } from "../AppDeps";
import { wrap } from "../errors";

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Claude Code integration: usage and cost, past-conversation search, conversation lookup, CLAUDE.md manager. */
export function claudeRouter(d: AppDeps): Router {
  const r = Router();
  const auth = d.auth.apiAuth;

  // The folder a conversation ran in — `claude --resume <id>` has to start there.
  r.get("/api/claude/conversation/:id", auth, wrap(async (req, res) => {
    const id = String(req.params.id || "");
    if (!isClaudeSessionId(id)) throw new HttpError(400, "invalid id");
    const cwd = await d.linker.conversationCwd(id);
    if (!cwd) throw new HttpError(404, "Conversation not found");
    res.json({ id, cwd: cwd.replace(/\//g, path.sep) });
  }));

  // ---- Claude Code usage (reads ~/.claude/projects/*.jsonl) ----
  r.get("/api/claude-usage", auth, wrap(async (req, res) =>
    res.json(await d.usage.query({ from: str(req.query.from), to: str(req.query.to), provider: str(req.query.provider) }))));

  // ---- Claude session index (search & reuse past agent conversations) ----
  r.get("/api/claude/sessions", auth, wrap(async (req, res) => res.json(await d.sessionIndex.build(req.query.refresh === "1"))));
  r.get("/api/claude/search", auth, wrap(async (req, res) => res.json(await d.sessionIndex.search(str(req.query.q) || ""))));
  r.get("/api/claude/sessions/:id", auth, wrap(async (req, res) => {
    const found = await d.sessionIndex.conversation(req.params.id);
    if (!found) throw new HttpError(404, "Not found");
    res.json(found);
  }));
  r.post("/api/claude/reindex", auth, wrap(async (_req, res) => res.json({ ok: true, count: (await d.sessionIndex.build(true)).length })));

  // ---- CLAUDE.md Manager ----
  r.get("/api/claudemd/list", auth, wrap((_req, res) => res.json(d.claudeMd.list())));
  r.get("/api/claudemd/read", auth, wrap((req, res) => res.json(d.claudeMd.read(req.query.path))));
  r.put("/api/claudemd/write", auth, wrap((req, res) => res.json(d.claudeMd.write(req.body && req.body.path, req.body && req.body.content))));
  r.get("/api/claudemd/templates", auth, (_req, res) => res.json(d.claudeMd.templates()));
  r.get("/api/claudemd/memory", auth, wrap((req, res) => res.json(d.claudeMd.memory(req.query.dir))));

  return r;
}
