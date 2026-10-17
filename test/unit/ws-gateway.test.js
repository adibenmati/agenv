// test/unit/ws-gateway.test.js — WsGateway over real WebSockets (protocol) and fake sockets (backpressure, heartbeat)
"use strict";
const { describe, it, mock, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const { EventEmitter } = require("events");
const { WebSocket } = require("ws");
const { TypedEmitter } = require("../../dist/core/TypedEmitter");
const { Crypto } = require("../../dist/core/Crypto");
const { Config } = require("../../dist/core/Config");
const { JsonStore } = require("../../dist/core/JsonStore");
const { ArchiveStore } = require("../../dist/persistence/ArchiveStore");
const { ScrollbackStore } = require("../../dist/persistence/ScrollbackStore");
const { SessionManager } = require("../../dist/sessions/SessionManager");
const { AuthService } = require("../../dist/security/AuthService");
const { WsGateway } = require("../../dist/http/WsGateway");

function rig(gatewayOpts = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "agenv-w-")); const crypto = new Crypto(path.join(d, "key"));
  const bus = new TypedEmitter(); const spawned = [];
  const ptyFactory = (o) => { const h = {}; const p = { pid: 500 + spawned.length, cols: o.cols, rows: o.rows, written: [], killed: false,
    onData: (cb) => (h.data = cb), onExit: (cb) => (h.exit = cb), write: (x) => p.written.push(x), resize: (c, r) => { p.cols = c; p.rows = r; }, kill: () => { p.killed = true; }, emit: (x) => h.data(x) }; spawned.push(p); return p; };
  const sessions = new SessionManager({ bus, ptyFactory, shell: "sh", maxSessions: 5, defaultCols: 100, defaultRows: 30,
    scrollbackStore: new ScrollbackStore(path.join(d, "sb"), crypto), archive: new ArchiveStore(new JsonStore({ path: path.join(d, "a"), crypto, fallback: () => [] })), isRealDir: () => true });
  const config = Config.fromArgv(["--token", "T"], {}, d); const policy = { allowedIps: [], readOnly: false };
  const auth = new AuthService({ config, policy });
  const server = http.createServer();
  const gateway = new WsGateway({ server, sessions, auth, policy, bus, ...gatewayOpts });
  return { bus, spawned, sessions, auth, policy, server, gateway, d, close: () => { gateway.dispose(); auth.dispose(); server.close(); } };
}
const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Opens a socket and records everything it receives and how it closes. */
function client(port, query, opts) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?${query}`, opts);
  const c = { ws, msgs: [], closed: null };
  ws.on("message", (d) => c.msgs.push(JSON.parse(d.toString())));
  c.closedP = new Promise((r) => ws.on("close", (code, reason) => { c.closed = { code, reason: reason.toString() }; r(c.closed); }));
  c.openP = new Promise((r) => ws.on("open", r));
  return c;
}
const until = async (fn, ms = 2000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error("timed out"); await sleep(10); } };

describe("WsGateway protocol (real sockets)", () => {
  let r, port;
  beforeEach(async () => { r = rig(); port = await listen(r.server); });
  afterEach(() => r.close());

  it("closes with 4401 when unauthenticated and 4404 for an unknown session", async () => {
    const s = r.sessions.create({});
    assert.equal((await client(port, `session=${s.id}`).closedP).code, 4401);
    assert.equal((await client(port, "session=99&token=T").closedP).code, 4404);
    assert.equal((await client(port, "session=abc&token=T").closedP).code, 4404);
  });

  it("wakes a sleeping session, sends its size then the scrollback replay", async () => {
    r.sessions.restore([{ id: 4, name: "x", cwd: "/tmp", tool: "terminal", lastCommand: "", launchCommand: "", userNamed: false, group: "", note: "", claudeSessionId: null, created: 1, lastActivity: 1 }]);
    r.sessions.get(4).scrollback.append("history so far");
    assert.equal(r.spawned.length, 0);
    const c = client(port, "session=4&token=T"); await until(() => c.msgs.length >= 2);
    assert.equal(r.spawned.length, 1); assert.equal(r.sessions.get(4).live, true);
    assert.deepEqual(c.msgs[0], { type: "resize", cols: 100, rows: 30 });
    assert.deepEqual(c.msgs[1], { type: "output", data: "history so far", replay: true });
    assert.equal(r.gateway.clientCount(4), 1);
    c.ws.close(); await c.closedP; await until(() => r.gateway.clientCount(4) === 0);
  });

  it("coalesces output that arrives within one flush window into a single message", async () => {
    const s = r.sessions.create({}); const c = client(port, `session=${s.id}&token=T`); await c.openP; await until(() => c.msgs.length >= 1);
    r.spawned[0].emit("a"); r.spawned[0].emit("b"); r.spawned[0].emit("c");
    await until(() => c.msgs.some((m) => m.type === "output"));
    assert.deepEqual(c.msgs.filter((m) => m.type === "output"), [{ type: "output", data: "abc" }]);
    c.ws.close();
  });

  it("writes input to the shell and clamps resize", async () => {
    const s = r.sessions.create({}); const c = client(port, `session=${s.id}&token=T`); await c.openP;
    c.ws.send(JSON.stringify({ type: "input", data: "ls\r" })); await until(() => r.spawned[0].written.length === 1);
    assert.deepEqual(r.spawned[0].written, ["ls\r"]);
    c.ws.send(JSON.stringify({ type: "resize", cols: "x", rows: -5 })); await until(() => s.cols === 80);
    assert.deepEqual([s.cols, s.rows], [80, 1]); c.ws.close();
  });

  it("ignores hostile input and keeps working (non-JSON, null, arrays, wrong types, unknown types)", async () => {
    const s = r.sessions.create({}); const c = client(port, `session=${s.id}&token=T`); await c.openP;
    for (const raw of ["not json", "null", "[1,2]", "42", '"str"', JSON.stringify({ type: "nonsense" }), JSON.stringify({ type: "input", data: 123 }), JSON.stringify({ type: "input" }), JSON.stringify({})]) c.ws.send(raw);
    c.ws.send(JSON.stringify({ type: "input", data: "still alive" }));
    await until(() => r.spawned[0].written.includes("still alive"));
    assert.deepEqual(r.spawned[0].written, ["still alive"]); assert.equal(c.closed, null, "socket must stay open"); c.ws.close();
  });

  it("closes with 4429 when a client sends more than 200 messages in a second", async () => {
    const s = r.sessions.create({}); const c = client(port, `session=${s.id}&token=T`); await c.openP;
    for (let i = 0; i < 260; i++) c.ws.send(JSON.stringify({ type: "input", data: "x" }));
    assert.equal((await c.closedP).code, 4429);
  });

  it("when the session is deleted the client gets an exit message and a normal close", async () => {
    const s = r.sessions.create({}); const c = client(port, `session=${s.id}&token=T`); await c.openP; await until(() => c.msgs.length >= 1);
    r.sessions.delete(s.id);
    const closed = await c.closedP;
    assert.equal(closed.code, 1000); assert.equal(closed.reason, "session closed");
    assert.deepEqual(c.msgs.at(-1), { type: "exit", code: -1 });
  });

  it("forwards status and cwd changes, and app events", async () => {
    const s = r.sessions.create({}); const c = client(port, `session=${s.id}&token=T`); await c.openP; await until(() => c.msgs.length >= 1);
    r.bus.emit("status", s, "running"); r.bus.emit("cwd", s, "/new");
    r.gateway.broadcastEvent("archive-updated");
    await until(() => c.msgs.length >= 4);
    assert.deepEqual(c.msgs.slice(-3), [{ type: "status", status: "running", sessionId: s.id }, { type: "cwd", cwd: "/new" }, { type: "event", event: "archive-updated" }]);
    c.ws.close();
  });

  it("a session with no clients serializes nothing", async () => {
    const s = r.sessions.create({}); let sent = 0; const orig = JSON.stringify;
    JSON.stringify = (...a) => { sent++; return orig(...a); };
    try { r.spawned[0].emit("nobody is listening"); await sleep(40); } finally { JSON.stringify = orig; }
    assert.equal(sent, 0); assert.equal(r.gateway.clientCount(s.id), 0);
  });
});

/** A stand-in for a ws socket the gateway can drive directly. */
function fakeWs() {
  const ws = new EventEmitter(); ws.readyState = 1; ws.bufferedAmount = 0; ws.sent = []; ws.closedWith = null; ws.terminated = false; ws.pings = 0;
  ws.send = (m) => ws.sent.push(JSON.parse(m)); ws.close = (code, reason) => { ws.closedWith = [code, reason]; };
  ws.terminate = () => { ws.terminated = true; ws.readyState = 3; }; ws.ping = () => { ws.pings++; };
  return ws;
}
const fakeReq = (query, headers = {}) => ({ url: "/ws?" + query, headers, socket: { remoteAddress: "7.7.7.7" } });

describe("WsGateway delivery rules (fake sockets)", () => {
  let r;
  beforeEach(() => { r = rig({ pingMs: 1000, maxBuffered: 64 * 1024 }); });
  afterEach(() => r.close());

  it("drops a client whose send buffer has run away instead of buffering forever", async () => {
    const s = r.sessions.create({}); const ws = fakeWs(); r.gateway.handleConnection(ws, fakeReq(`session=${s.id}&token=T`));
    assert.equal(r.gateway.clientCount(s.id), 1);
    ws.bufferedAmount = 5 * 1024 * 1024; r.spawned[0].emit("more output"); await sleep(40);
    assert.equal(ws.terminated, true); assert.equal(r.gateway.clientCount(s.id), 0);
  });

  it("terminates a client that stops answering pings", () => {
    mock.timers.enable({ apis: ["setInterval"] });
    try {
      const r2 = rig({ pingMs: 1000 }); const s = r2.sessions.create({}); const ws = fakeWs();
      r2.gateway.handleConnection(ws, fakeReq(`session=${s.id}&token=T`));
      mock.timers.tick(1000); assert.equal(ws.pings, 1); assert.equal(ws.terminated, false);
      ws.emit("pong"); mock.timers.tick(1000); assert.equal(ws.pings, 2); assert.equal(ws.terminated, false);   // answered → kept
      mock.timers.tick(1000); assert.equal(ws.terminated, true);                                              // no pong this round → dropped
      assert.equal(r2.gateway.clientCount(s.id), 0); r2.close();
    } finally { mock.timers.reset(); }
  });

  it("read-only tunnel clients cannot type, ordinary clients can; oversize input is ignored", () => {
    r.policy.readOnly = true; const s = r.sessions.create({});
    const tunnel = fakeWs(); r.gateway.handleConnection(tunnel, fakeReq(`session=${s.id}&token=T`, { "x-forwarded-for": "1.1.1.1" }));
    tunnel.emit("message", Buffer.from(JSON.stringify({ type: "input", data: "rm -rf" }))); assert.deepEqual(r.spawned[0].written, []);
    const direct = fakeWs(); r.gateway.handleConnection(direct, fakeReq(`session=${s.id}&token=T`));
    direct.emit("message", Buffer.from(JSON.stringify({ type: "input", data: "ok" }))); assert.deepEqual(r.spawned[0].written, ["ok"]);
    direct.emit("message", Buffer.from(JSON.stringify({ type: "input", data: "x".repeat(262145) }))); assert.deepEqual(r.spawned[0].written, ["ok"]);
    direct.emit("message", Buffer.from(JSON.stringify({ type: "input", data: "y".repeat(262144) }))); assert.equal(r.spawned[0].written.length, 2);
  });

  it("a tunnel client outside the allow-list is closed with 4403", () => {
    r.policy.allowedIps = ["1.1.1.1"]; const s = r.sessions.create({}); const ws = fakeWs();
    r.gateway.handleConnection(ws, fakeReq(`session=${s.id}&token=T`, { "x-forwarded-for": "2.2.2.2" }));
    assert.deepEqual(ws.closedWith, [4403, "IP not in allowlist"]); assert.equal(r.gateway.clientCount(s.id), 0);
  });

  it("a shell that cannot start closes with 4500 and leaves no client behind", () => {
    r.sessions.restore([{ id: 8, name: "", cwd: "/tmp", tool: "terminal", lastCommand: "", launchCommand: "", userNamed: false, group: "", note: "", claudeSessionId: null, created: 1, lastActivity: 1 }]);
    const origWake = r.sessions.wake.bind(r.sessions); r.sessions.wake = () => { throw new Error("no such shell"); };
    const ws = fakeWs(); const orig = console.error; console.error = () => {};
    try { r.gateway.handleConnection(ws, fakeReq("session=8&token=T")); } finally { console.error = orig; r.sessions.wake = origWake; }
    assert.deepEqual(ws.closedWith, [4500, "Failed to start session"]); assert.equal(r.gateway.clientCount(8), 0);
  });

  it("broadcast reaches only the named session's clients", () => {
    const a = r.sessions.create({}), b = r.sessions.create({}); const wa = fakeWs(), wb = fakeWs();
    r.gateway.handleConnection(wa, fakeReq(`session=${a.id}&token=T`)); r.gateway.handleConnection(wb, fakeReq(`session=${b.id}&token=T`));
    const before = wb.sent.length; r.gateway.broadcast(a.id, { type: "resize", cols: 9, rows: 9 });
    assert.deepEqual(wa.sent.at(-1), { type: "resize", cols: 9, rows: 9 }); assert.equal(wb.sent.length, before);
  });
});
