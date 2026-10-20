import { Router } from "express";
import type { RequestHandler } from "express";
import { HttpError } from "../../core/HttpError";
import type { AppDeps } from "../AppDeps";
import { wrap } from "../errors";

/**
 * Messages between running sessions. A session calls this with the private token from its environment (so the
 * message is known to come from it); the agenv UI calls it with the normal login and sends as "you".
 */
export function messagesRouter(d: AppDeps): Router {
  const r = Router();

  const who = new WeakMap<object, number | null>();
  const auth: RequestHandler = (req, res, next) => {
    const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ""));
    if (m) {
      const id = d.messages.sessionForToken(m[1]);
      if (id === null) { res.status(401).json({ error: "Unknown session token" }); return; }
      who.set(req, id);
      next();
      return;
    }
    d.auth.apiAuth(req, res, next);
  };

  r.get("/api/messages/peers", auth, (_req, res) => { res.json(d.messages.peers()); });

  r.get("/api/messages", auth, (_req, res) => { res.json(d.messages.messages()); });

  r.post("/api/messages", auth, wrap((req, res) => {
    const b = req.body || {};
    if (typeof b.to !== "string" || typeof b.text !== "string") throw new HttpError(400, "Body needs \"to\" and \"text\"");
    res.json(d.messages.send(who.get(req) ?? null, b.to, b.text));
  }));

  // One message to every agent session, or to one group of them.
  r.post("/api/messages/many", auth, wrap((req, res) => {
    const b = req.body || {};
    if (typeof b.text !== "string") throw new HttpError(400, "Body needs \"text\"");
    res.json(d.messages.sendMany(who.get(req) ?? null, b.text, { group: typeof b.group === "string" ? b.group : undefined }));
  }));

  // Run a command in many sessions. Only the logged-in UI may do this, never a session's own token.
  r.post("/api/messages/broadcast", auth, wrap((req, res) => {
    if (who.has(req)) throw new HttpError(403, "A session cannot run commands in other sessions");
    const b = req.body || {};
    if (typeof b.command !== "string") throw new HttpError(400, "Body needs \"command\"");
    res.json(d.messages.broadcast(b.command, {
      group: typeof b.group === "string" ? b.group : undefined, agentsOnly: b.agentsOnly === true,
    }));
  }));

  return r;
}
