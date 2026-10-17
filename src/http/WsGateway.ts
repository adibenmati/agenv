import type * as http from "http";
import { WebSocket, WebSocketServer } from "ws";
import type { AuthRequest, AuthService } from "../security/AuthService";
import type { NgrokPolicy } from "../security/NgrokPolicy";
import type { SessionBus } from "../sessions/events";
import type { Session } from "../sessions/Session";
import type { SessionManager } from "../sessions/SessionManager";

// Coalescing window. A repainting TUI emits dozens of tiny chunks per frame; sending each as its own message
// makes the browser parse thousands of messages a second and starves its main thread.
const OUTPUT_FLUSH_MS = 16;
const OUTPUT_FLUSH_BYTES = 64 * 1024;
const MAX_INPUT_CHARS = 262144;
const MAX_MESSAGES_PER_SECOND = 200;

interface Client extends WebSocket { isAlive?: boolean }
interface Room { clients: Set<Client>; queue: string[]; bytes: number; timer: NodeJS.Timeout | null }

export interface WsGatewayOptions {
  server: http.Server;
  sessions: SessionManager;
  auth: AuthService;
  policy: NgrokPolicy;
  bus: SessionBus;
  /** Heartbeat interval; default 20 s (env AGENV_WS_PING_MS), minimum 1 s. */
  pingMs?: number;
  /** A client with more than this queued is cut loose; default 4 MiB (env AGENV_WS_MAX_BUFFERED), minimum 64 KiB. */
  maxBuffered?: number;
}

/** A client that exceeds `limit` messages in a one-second window is told to slow down. */
function makeRateLimiter(limit = MAX_MESSAGES_PER_SECOND): () => boolean {
  let count = 0, windowStart = Date.now();
  return () => {
    const now = Date.now();
    if (now - windowStart >= 1000) { count = 0; windowStart = now; }
    return ++count <= limit;
  };
}

/**
 * The browser side of the terminals: one WebSocket per open pane. It turns session events into messages
 * (batched output, status, cwd, exit), writes client input to the shell, and keeps misbehaving clients from
 * holding memory — slow readers are cut loose and silent ones are dropped by a heartbeat. Every send goes through
 * one place so three rules hold: serialize once per message, serialize nothing for a session with no clients,
 * and never buffer indefinitely for a client that stopped reading.
 */
export class WsGateway {
  private readonly wss: WebSocketServer;
  private readonly rooms = new Map<number, Room>();
  private readonly heartbeat: NodeJS.Timeout;
  private readonly maxBuffered: number;
  private readonly onOutput = (s: Session, data: string): void => this.queueOutput(s, data);
  private readonly onStatus = (s: Session, status: string): void => this.broadcast(s.id, { type: "status", status, sessionId: s.id });
  private readonly onCwd = (s: Session, cwd: string): void => this.broadcast(s.id, { type: "cwd", cwd });
  private readonly onDeleted = (s: Session, code: number): void => this.closeRoom(s, code);

  constructor(private readonly o: WsGatewayOptions) {
    const pingMs = Math.max(1000, o.pingMs ?? parseInt(process.env.AGENV_WS_PING_MS || "20000", 10));
    this.maxBuffered = Math.max(64 * 1024, o.maxBuffered ?? (parseInt(process.env.AGENV_WS_MAX_BUFFERED || "", 10) || 4 * 1024 * 1024));

    this.wss = new WebSocketServer({ server: o.server, path: "/ws", maxPayload: 16 * 1024 * 1024 });
    this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));

    o.bus.on("output", this.onOutput);
    o.bus.on("status", this.onStatus);
    o.bus.on("cwd", this.onCwd);
    o.bus.on("deleted", this.onDeleted);

    // Drop clients that have stopped answering. Without this a half-open socket (laptop lid closed, network
    // switched, renderer killed) stays in the client set forever and keeps its buffer alive with it.
    this.heartbeat = setInterval(() => {
      for (const [id, room] of this.rooms) {
        for (const ws of [...room.clients]) {
          if (ws.isAlive === false) { this.drop(id, ws, "no pong"); continue; }
          ws.isAlive = false;
          try { ws.ping(); } catch { this.drop(id, ws, "ping failed"); }
        }
      }
    }, pingMs);
    if (this.heartbeat.unref) this.heartbeat.unref();
  }

  clientCount(sessionId: number): number { return this.rooms.get(sessionId)?.clients.size ?? 0; }

  /** Send a message to every client of one session. */
  broadcast(sessionId: number, obj: unknown): void {
    const room = this.rooms.get(sessionId);
    if (!room || room.clients.size === 0) return;   // nobody listening — don't even serialize
    const msg = typeof obj === "string" ? obj : JSON.stringify(obj);
    for (const ws of [...room.clients]) this.sendTo(sessionId, room, ws, msg);
  }

  /** `{type:"event", event}` to every client of every session (e.g. "archive-updated"). */
  broadcastEvent(event: string): void {
    const msg = JSON.stringify({ type: "event", event });
    for (const id of this.rooms.keys()) this.broadcast(id, msg);
  }

  dispose(): void {
    clearInterval(this.heartbeat);
    this.o.bus.off("output", this.onOutput);
    this.o.bus.off("status", this.onStatus);
    this.o.bus.off("cwd", this.onCwd);
    this.o.bus.off("deleted", this.onDeleted);
    for (const room of this.rooms.values()) {
      if (room.timer) clearTimeout(room.timer);
      for (const ws of room.clients) { try { ws.terminate(); } catch {} }
    }
    this.rooms.clear();
    this.wss.close();
  }

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  /** Public so tests can drive it with a stand-in socket; the real server calls it for each upgrade. */
  handleConnection(ws: WebSocket, req: AuthRequest): void {
    const { auth, policy, sessions } = this.o;
    if (!auth.isAuthenticated(req)) { ws.close(4401, "Unauthorized"); return; }

    // ngrok IP allowlist check for WebSocket
    if (auth.isTunnelRequest(req) && policy.allowedIps.length > 0) {
      const xff = req.headers["x-forwarded-for"];
      const clientIp = String((Array.isArray(xff) ? xff[0] : xff) || "").split(",")[0].trim();
      if (!policy.allowedIps.includes(clientIp)) { ws.close(4403, "IP not in allowlist"); return; }
    }
    const readOnly = auth.isReadOnlyTunnel(req);

    let sessionId = NaN;
    try { sessionId = parseInt(new URL(req.url || "/", "http://localhost").searchParams.get("session") || "0", 10); } catch {}
    const session = sessions.get(sessionId);
    if (!session) { ws.close(4404, "Session not found"); return; }

    // Opening a restored tab is what starts its shell.
    if (!session.live) {
      try {
        sessions.wake(session);
        this.o.bus.emit("changed", session);
        console.log(`[agenv] Session ${sessionId} woken on attach`);
      } catch (e: any) {
        console.error(`[agenv] Failed to start session ${sessionId}: ${e.message}`);
        ws.close(4500, "Failed to start session");
        return;
      }
    }
    if (!session.pty) { ws.close(4500, "Session has no shell"); return; }

    // Anything still queued belongs to the clients that were already attached;
    // this one is about to receive it as part of the scrollback instead.
    const room = this.room(sessionId);
    this.flush(sessionId, room);

    const client = ws as Client;
    room.clients.add(client);
    client.isAlive = true;
    client.on("pong", () => { client.isAlive = true; });

    const allowed = makeRateLimiter();
    console.log(`[agenv] Browser connected to session ${sessionId} (${room.clients.size} client(s))${readOnly ? " [read-only]" : ""}`);

    this.sendTo(sessionId, room, client, JSON.stringify({ type: "resize", cols: session.pty.cols, rows: session.pty.rows }));
    const backlog = session.scrollback.read();
    // `replay` lets a reconnecting client clear its screen first instead of appending the whole backlog on top of what it shows.
    if (backlog.length > 0) this.sendTo(sessionId, room, client, JSON.stringify({ type: "output", data: backlog.toString("utf8"), replay: true }));

    client.on("message", (raw) => {
      if (!allowed()) { client.close(4429, "Too Many Requests"); return; }
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (!msg || typeof msg !== "object") return;   // "null", numbers and strings are valid JSON but not messages
      if (!session.pty) return;
      if (msg.type === "input" && typeof msg.data === "string") {
        if (readOnly) return;
        if (msg.data.length <= MAX_INPUT_CHARS) sessions.write(session, msg.data);
      } else if (msg.type === "resize") {
        sessions.resize(session, msg.cols, msg.rows);
      }
    });
    client.on("error", () => this.drop(sessionId, client, "socket error"));
    client.on("close", () => {
      room.clients.delete(client);
      console.log(`[agenv] Browser disconnected from session ${sessionId} (${room.clients.size} client(s))`);
    });
  }

  // -------------------------------------------------------------------------
  // Delivery
  // -------------------------------------------------------------------------

  private room(id: number): Room {
    let r = this.rooms.get(id);
    if (!r) { r = { clients: new Set(), queue: [], bytes: 0, timer: null }; this.rooms.set(id, r); }
    return r;
  }

  private drop(sessionId: number, ws: Client, reason: string): void {
    this.rooms.get(sessionId)?.clients.delete(ws);
    try { ws.terminate(); } catch {}
    console.log(`[agenv] Dropped client from session ${sessionId} (${reason})`);
  }

  private sendTo(sessionId: number, room: Room, ws: Client, msg: string): void {
    if (ws.readyState !== 1) { room.clients.delete(ws); return; }
    if (ws.bufferedAmount > this.maxBuffered) { this.drop(sessionId, ws, "not reading"); return; }
    try { ws.send(msg); } catch { this.drop(sessionId, ws, "send failed"); }
  }

  private queueOutput(s: Session, data: string): void {
    const room = this.rooms.get(s.id);
    if (!room || room.clients.size === 0) return;   // nobody listening — don't even serialize
    room.queue.push(data);
    room.bytes += data.length;
    if (room.bytes >= OUTPUT_FLUSH_BYTES) { this.flush(s.id, room); return; }
    if (!room.timer) room.timer = setTimeout(() => this.flush(s.id, room), OUTPUT_FLUSH_MS);
  }

  private flush(sessionId: number, room: Room): void {
    if (room.timer) { clearTimeout(room.timer); room.timer = null; }
    if (room.queue.length === 0) return;
    const data = room.queue.length === 1 ? room.queue[0] : room.queue.join("");
    room.queue.length = 0;
    room.bytes = 0;
    this.broadcast(sessionId, { type: "output", data });
  }

  /** The session ended: deliver what was pending, tell the clients, and close them. */
  private closeRoom(s: Session, exitCode: number): void {
    const room = this.rooms.get(s.id);
    if (!room) return;
    this.flush(s.id, room);
    const msg = JSON.stringify({ type: "exit", code: exitCode });
    for (const ws of room.clients) {
      try { if (ws.readyState === 1) ws.send(msg); } catch {}
      try { ws.close(1000, "session closed"); } catch {}
      // A client that never replies to the close frame would otherwise hold the socket (and its buffer) open
      // until the protocol timeout.
      const t = setTimeout(() => { try { ws.terminate(); } catch {} }, 500);
      if (t.unref) t.unref();
    }
    room.clients.clear();
    if (room.timer) clearTimeout(room.timer);
    this.rooms.delete(s.id);
  }
}
