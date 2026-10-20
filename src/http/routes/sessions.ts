import { Router } from "express";
import { HttpError } from "../../core/HttpError";
import { GroupRegistry } from "../../sessions/GroupRegistry";
import { legacyGroups, readLiveCwd, recentFolders, sessionAnalytics } from "../../sessions/queries";
import type { AppDeps } from "../AppDeps";
import { wrap } from "../errors";

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Sessions and everything that hangs off them: group folders, layout, history, archive, favorites, quick-launch. */
export function sessionsRouter(d: AppDeps): Router {
  const r = Router();
  const auth = d.auth.apiAuth;
  const sessionOr404 = (idParam: string) => {
    const s = d.sessions.get(parseInt(idParam, 10));
    if (!s) throw new HttpError(404, "Session not found");
    return s;
  };

  // ---- Session APIs ----
  r.get("/api/sessions", auth, (_req, res) => {
    res.json(d.sessions.all().map((s) => s.toListItem(d.gateway.clientCount(s.id))));
  });

  r.post("/api/sessions", auth, wrap((req, res) => {
    const b = req.body || {};
    const s = d.sessions.create({
      cwd: str(b.cwd), name: b.name || "", group: GroupRegistry.normalize(b.group),
      runCommand: b.command || null, restoreScrollback: false,
    });
    d.stateStore.saveNow();
    console.log(`[agenv] Session ${s.id} created from browser in ${s.cwd} (${d.sessions.size} total)`);
    res.json({ id: s.id, name: s.name, cwd: s.cwd, tool: s.detectedTool, created: s.created, status: s.status, group: s.group });
  }));

  r.put("/api/sessions/:id", auth, wrap(async (req, res) => {
    const s = sessionOr404(req.params.id);
    const b = req.body || {};
    let renamed: string | null = null;
    if (b.name != null) {
      const name = String(b.name).slice(0, 64);
      if (name !== s.name) renamed = name;
      s.name = name; s.userNamed = true;
    }
    if (b.tool) { s.detectedTool = String(b.tool); s.lastCommand = b.lastCommand || s.lastCommand; }
    if (b.note != null) s.note = String(b.note).slice(0, 2000);
    if (b.group != null) s.group = GroupRegistry.normalize(b.group);
    d.stateStore.save();

    // Carry a rename over to the Claude conversation running in this session, so /resume and "Continue Agent"
    // show the same name.
    let claudeRenamed = false;
    if (renamed && renamed.trim()) {
      if (!s.claudeSessionId && s.detectedTool === "claude") await d.linker.refresh();
      if (s.claudeSessionId) {
        try { claudeRenamed = await d.linker.renameConversation(s.claudeSessionId, renamed.trim()); } catch {}
      }
    }
    res.json({ ok: true, claudeRenamed });
  }));

  // ---- Session group folders ----
  r.get("/api/session-groups", auth, (_req, res) => res.json(d.groups.list()));

  r.put("/api/session-groups", auth, wrap((req, res) => {
    const list = Array.isArray(req.body && req.body.groups) ? req.body.groups : null;
    if (!list) throw new HttpError(400, "groups array required");
    res.json(d.groups.replace(list));
  }));

  r.post("/api/session-groups/rename", auth, wrap((req, res) => {
    res.json(d.groups.rename(req.body && req.body.from, req.body && req.body.to));
  }));

  r.post("/api/session-groups/delete", auth, wrap((req, res) => {
    res.json(d.groups.remove(req.body && req.body.path));
  }));

  r.delete("/api/sessions/:id", auth, wrap((req, res) => {
    const id = parseInt(req.params.id, 10);
    d.sessions.delete(id);     // 404 when unknown; archives the session and announces "archive-updated"
    console.log(`[agenv] Session ${id} closed from browser`);
    d.stateStore.saveNow();
    res.json({ ok: true });
  }));

  r.post("/api/sessions/resume-all", auth, wrap((req, res) => {
    const b = req.body || {};
    const results = d.batch.resumeAll({ group: typeof b.group === "string" ? b.group : undefined, extraArgs: b.extraArgs });
    d.stateStore.save();
    res.json(results);
  }));

  r.post("/api/sessions/:id/restart", auth, wrap((req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!d.sessions.get(id)) throw new HttpError(404, "Session not found");
    try { d.sessions.restart(id); }
    catch (e: any) { throw new HttpError(500, "Failed to restart: " + e.message); }
    res.json({ ok: true, id });
  }));

  r.get("/api/sessions/:id/cwd", auth, wrap(async (req, res) => {
    const s = sessionOr404(req.params.id);
    // Try to get the real CWD from the shell process (where the OS exposes it)
    if (s.pty && s.pty.pid) {
      const cwd = await readLiveCwd(s.pty.pid);
      if (cwd && cwd !== s.cwd) { s.cwd = cwd; d.gateway.broadcast(s.id, { type: "cwd", cwd }); }
    }
    res.json({ cwd: s.cwd, sessionId: s.id });
  }));

  // ---- Workspace layout persistence ----
  r.get("/api/workspace-layout", auth, (_req, res) => res.json({ layout: d.layout.get() }));

  r.post("/api/workspace-layout", auth, (req, res) => {
    d.layout.set(req.body && req.body.layout);
    d.stateStore.saveNow();
    res.json({ ok: true });
  });

  // ---- History & suggestions APIs ----
  r.get("/api/history", auth, (_req, res) => res.json(d.history.list()));

  r.post("/api/history", auth, wrap((req, res) => {
    const { command, sessionId } = req.body || {};
    if (!command || typeof command !== "string") throw new HttpError(400, "Invalid");
    const trimmed = command.trim();
    if (!trimmed) { res.json({ ok: true }); return; }
    d.history.add(trimmed);
    // Update session tool detection
    if (sessionId != null) {
      const s = d.sessions.get(parseInt(sessionId, 10));
      if (s) { d.sessions.noteCommand(s, trimmed); d.stateStore.save(); }
    }
    res.json({ ok: true });
  }));

  // ---- Archive API ----
  r.get("/api/archive", auth, (_req, res) => res.json(d.archive.list()));

  // Drop one closed session from the list (after resuming it, or by hand).
  r.post("/api/archive/remove", auth, wrap((req, res) => {
    const closed = Number(req.body && req.body.closed);
    if (!closed) throw new HttpError(400, "closed timestamp required");
    d.archive.remove(closed);
    res.json({ ok: true });
  }));

  // ---- Favorites API ----
  r.get("/api/favorites", auth, (_req, res) => res.json(d.favorites.list()));

  r.post("/api/favorites", auth, wrap((req, res) => {
    const b = req.body || {};
    if (!b.cwd && !b.command) throw new HttpError(400, "Need cwd or command");
    if (!d.favorites.add(b)) { res.json({ ok: true, msg: "Already saved" }); return; }   // Prevent duplicates
    res.json({ ok: true });
  }));

  r.delete("/api/favorites/:index", auth, wrap((req, res) => {
    if (!d.favorites.removeAt(parseInt(req.params.index, 10))) throw new HttpError(404, "Not found");
    res.json({ ok: true });
  }));

  // ---- Quick-launch API ----
  r.post("/api/quick-launch", auth, wrap((req, res) => {
    if (d.sessions.isFull) throw new HttpError(400, "Max sessions reached");
    const b = req.body || {};
    const s = d.sessions.create({ cwd: str(b.cwd) || process.cwd(), name: b.name || "", runCommand: b.command || "", restoreScrollback: false });
    d.stateStore.save();
    res.json({ id: s.id, name: s.name, cwd: s.cwd, tool: s.detectedTool, created: s.created });
  }));

  // ---- Recent folders, analytics, legacy groups ----
  r.get("/api/recent-folders", auth, (_req, res) => res.json(recentFolders(d.sessions.all(), d.archive.list(), 20)));
  r.get("/api/analytics", auth, (_req, res) => res.json(sessionAnalytics(d.sessions.all())));
  r.get("/api/groups", auth, (_req, res) => res.json(legacyGroups(d.sessions.all())));

  return r;
}
