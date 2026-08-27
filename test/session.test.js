// test/session.test.js — session lifecycle, scrollback, and websocket fan-out
"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const net = require("net");
const path = require("path");
const crypto = require("crypto");

const {
  startServer, stopProcess, makeTempHome,
  get, post, del, waitFor, loadInternals, TOKEN,
} = require("./helpers");

// ---------------------------------------------------------------------------
// Raw websocket client — deliberately low level so a test can choose *not* to
// read, or *not* to answer a ping, the way a throttled browser tab does.
// ---------------------------------------------------------------------------
function wsHandshake(port, query) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString("base64");
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(
        `GET /ws?${query} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf("\r\n\r\n");
      if (i < 0) return;
      const head = buf.slice(0, i).toString();
      sock.removeListener("data", onData);
      if (!/^HTTP\/1\.1 101/.test(head)) { sock.destroy(); return reject(new Error("handshake failed: " + head.split("\r\n")[0])); }
      resolve(sock);
    };
    sock.on("data", onData);
    sock.on("error", reject);
  });
}

/** Resolves when the peer closes/resets the connection. */
function closed(sock) {
  return new Promise((resolve) => {
    sock.on("close", () => resolve("close"));
    sock.on("error", () => resolve("error"));
    sock.on("end", () => resolve("end"));
  });
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout waiting for ${label}`)), ms).unref?.()),
  ]);
}

/** Minimal client->server text frame (masked, as the protocol requires). */
function wsSendText(sock, text) {
  const payload = Buffer.from(text, "utf8");
  const mask = crypto.randomBytes(4);
  const head = payload.length < 126
    ? Buffer.from([0x81, 0x80 | payload.length])
    : Buffer.concat([Buffer.from([0x81, 0xfe]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(payload.length); return b; })()]);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
  sock.write(Buffer.concat([head, mask, masked]));
}

/** Writes a script that floods stdout, so a session can be made to firehose. */
function writeFirehose(home) {
  const p = path.join(home, "firehose.js");
  fs.writeFileSync(p, "setInterval(()=>{for(let i=0;i<400;i++)process.stdout.write('x'.repeat(1024)+'\\r\\n')},5);");
  return p;
}

// ---------------------------------------------------------------------------
// Scrollback ring buffer
// ---------------------------------------------------------------------------
describe("Scrollback ring buffer", () => {
  const rb = loadInternals(
    "const MAX_SCROLLBACK",
    "// PTY session management",
    ["MAX_SCROLLBACK", "appendScrollback", "getScrollback"]
  );

  function fill(session, chunk, n) {
    for (let i = 0; i < n; i++) rb.appendScrollback(session, chunk);
  }

  it("keeps the buffer within the cap", () => {
    const session = { scrollback: null };
    fill(session, "y".repeat(200) + "\n", 5000);
    assert.ok(
      rb.getScrollback(session).length <= rb.MAX_SCROLLBACK,
      `expected <= ${rb.MAX_SCROLLBACK}, got ${rb.getScrollback(session).length}`
    );
  });

  it("preserves the most recent output after overflow", () => {
    const session = { scrollback: null };
    fill(session, "old line\n", 20000);
    rb.appendScrollback(session, "NEWEST_MARKER\n");
    const text = rb.getScrollback(session).toString("utf8");
    assert.ok(text.endsWith("NEWEST_MARKER\n"), "tail should be the newest chunk");
    assert.ok(!text.includes("NEWEST_MARKERNEWEST"), "should not duplicate");
  });

  it("does not recopy the whole buffer on every append", () => {
    const session = { scrollback: null };
    const chunk = "z".repeat(200) + "\n";
    fill(session, chunk, 2000); // reach steady state: ring is full

    const t0 = process.hrtime.bigint();
    fill(session, chunk, 100000);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;

    // O(cap) per append copies ~100KB each time: ~5s for 100k appends.
    // O(chunk) per append lands well under a second.
    assert.ok(ms < 1000, `100k appends into a full ring took ${ms.toFixed(0)}ms — buffer is being recopied per chunk`);
  });
});

// ---------------------------------------------------------------------------
// Websocket fan-out and client health
// ---------------------------------------------------------------------------
describe("Websocket backpressure", () => {
  let server;

  // Heartbeat effectively disabled, so only backpressure can drop the client.
  before(async () => { server = await startServer({ env: { AGENV_WS_PING_MS: "600000" } }); }, { timeout: 20000 });
  after(async () => { await stopProcess(server.proc); });

  // A stalled peer never observes the disconnect (it isn't reading), so the
  // observable contract is server-side: the session stops counting it as a
  // client, which is what stops output being buffered for it.
  async function clientCount(id) {
    return (await get("/api/sessions")).body.find((s) => s.id === id)?.clients;
  }

  it("stops sending to a client that stops reading", async () => {
    const firehose = writeFirehose(server.home);
    const created = await post("/api/sessions", { command: `node "${firehose}"` });
    assert.equal(created.status, 200);

    const sock = await wsHandshake(server.port, `session=${created.body.id}&token=${encodeURIComponent(TOKEN)}`);
    sock.pause(); // never drain — the socket stays ESTABLISHED and readyState stays OPEN
    await waitFor(async () => await clientCount(created.body.id) === 1, { message: "client to register" });

    await waitFor(async () => await clientCount(created.body.id) === 0,
      { timeout: 25000, message: "server to stop buffering into the stalled client" });

    sock.destroy();
    await del(`/api/sessions/${created.body.id}`);
  }, { timeout: 40000 });

  it("keeps a stalled client while its buffer is under the limit", async () => {
    // Same stall, but with a cap it cannot reach — proves the drop above comes
    // from the buffer limit and not from something else in the attach path.
    const roomy = await startServer({ env: { AGENV_WS_PING_MS: "600000", AGENV_WS_MAX_BUFFERED: String(512 * 1024 * 1024) } });
    try {
      const firehose = writeFirehose(roomy.home);
      const created = await post("/api/sessions", { command: `node "${firehose}"` }, { port: roomy.port });

      const sock = await wsHandshake(roomy.port, `session=${created.body.id}&token=${encodeURIComponent(TOKEN)}`);
      sock.pause();
      await new Promise((r) => setTimeout(r, 8000));

      const list = (await get("/api/sessions", { port: roomy.port })).body;
      assert.equal(list.find((s) => s.id === created.body.id)?.clients, 1);
      sock.destroy();
    } finally {
      await stopProcess(roomy.proc);
    }
  }, { timeout: 40000 });
});

describe("Websocket client health", () => {
  let server;

  before(async () => { server = await startServer({ env: { AGENV_WS_PING_MS: "700" } }); }, { timeout: 20000 });
  after(async () => { await stopProcess(server.proc); });

  it("disconnects a client that stops answering pings", async () => {
    const created = await post("/api/sessions", {});
    const sock = await wsHandshake(server.port, `session=${created.body.id}&token=${encodeURIComponent(TOKEN)}`);
    sock.resume();        // keep reading, so this is not backpressure...
    sock.on("data", () => {}); // ...but never send a pong

    await withTimeout(closed(sock), 15000, "server to drop the unresponsive client");
    await del(`/api/sessions/${created.body.id}`);
  }, { timeout: 30000 });

  it("closes attached sockets when the session is deleted", async () => {
    const created = await post("/api/sessions", {});
    const sock = await wsHandshake(server.port, `session=${created.body.id}&token=${encodeURIComponent(TOKEN)}`);
    sock.resume();

    await del(`/api/sessions/${created.body.id}`);
    await withTimeout(closed(sock), 8000, "socket to close after session delete");
  }, { timeout: 20000 });

  it("reports zero clients after a socket goes away", async () => {
    const created = await post("/api/sessions", {});
    const sock = await wsHandshake(server.port, `session=${created.body.id}&token=${encodeURIComponent(TOKEN)}`);
    sock.resume();
    await waitFor(async () => (await get("/api/sessions")).body.find(s => s.id === created.body.id)?.clients === 1,
      { message: "client to register" });

    sock.destroy();
    await waitFor(async () => (await get("/api/sessions")).body.find(s => s.id === created.body.id)?.clients === 0,
      { message: "client count to drop to 0" });
    await del(`/api/sessions/${created.body.id}`);
  }, { timeout: 20000 });
});

// ---------------------------------------------------------------------------
// The parent terminal should stay quiet
// ---------------------------------------------------------------------------
describe("Parent terminal output", () => {
  let server;

  before(async () => { server = await startServer(); }, { timeout: 20000 });
  after(async () => { await stopProcess(server.proc); });

  it("does not mirror session output onto the server's own stdout", async () => {
    const sessions = (await get("/api/sessions")).body;
    const id = sessions[0].id;

    const sock = await wsHandshake(server.port, `session=${id}&token=${encodeURIComponent(TOKEN)}`);
    sock.resume();
    wsSendText(sock, JSON.stringify({ type: "input", data: "echo AGENV_MIRROR_CANARY\r" }));

    await new Promise((r) => setTimeout(r, 3000));
    sock.destroy();

    assert.ok(
      !server.getStdout().includes("AGENV_MIRROR_CANARY"),
      "session output leaked into the parent terminal:\n" + server.getStdout().slice(-500)
    );
  }, { timeout: 20000 });
});

// ---------------------------------------------------------------------------
// Restoring tabs across a restart
// ---------------------------------------------------------------------------
describe("Session restore", () => {
  const home = makeTempHome();
  let first, second;
  let ids = [];

  before(async () => {
    first = await startServer({ home });
    const a = await post("/api/sessions", { name: "alpha" });
    const b = await post("/api/sessions", { name: "beta" });
    const c = await post("/api/sessions", { name: "gamma" });
    ids = [a.body.id, b.body.id, c.body.id];

    // A layout with all three as open tabs, `beta` focused.
    await post("/api/workspace-layout", {
      layout: [{
        id: "w1", name: "Workspace 1", activeSessionId: ids[1],
        rootNode: {
          type: "split", direction: "row",
          children: ids.map((sessionId) => ({ type: "leaf", sessionId })),
        },
      }],
    });

    await stopProcess(first.proc);
    second = await startServer({ home });
  }, { timeout: 40000 });

  after(async () => { await stopProcess(second.proc); });

  it("restores every tab in the saved layout", async () => {
    const list = (await get("/api/sessions")).body;
    for (const id of ids) {
      assert.ok(list.some((s) => s.id === id), `session ${id} should be restored`);
    }
  });

  it("restores tabs without spawning a shell for each one", async () => {
    const list = (await get("/api/sessions")).body;
    const live = list.filter((s) => s.live !== false);
    assert.ok(live.length <= 1, `expected at most the focused tab live, got ${live.length} live shells`);
  });

  it("keeps saved metadata on a hibernated tab", async () => {
    const list = (await get("/api/sessions")).body;
    const alpha = list.find((s) => s.id === ids[0]);
    assert.equal(alpha.name, "alpha");
    assert.ok(alpha.cwd, "cwd should survive the restart");
  });

  it("spawns the shell when a hibernated tab is attached to", async () => {
    const hibernated = (await get("/api/sessions")).body.find((s) => s.live === false);
    assert.ok(hibernated, "expected at least one hibernated tab");

    const sock = await wsHandshake(second.port, `session=${hibernated.id}&token=${encodeURIComponent(TOKEN)}`);
    sock.resume();

    await waitFor(async () => (await get("/api/sessions")).body.find((s) => s.id === hibernated.id)?.live === true,
      { message: "hibernated session to wake on attach" });
    sock.destroy();
  }, { timeout: 20000 });
});
