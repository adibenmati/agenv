// test/messages-api.test.js — one session messages another through the real server: `agenv send` run inside a
// session reaches a (fake) codex running in another one, and the API refuses what it must.
"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { startServer, stopProcess, makeTempHome, get, post, request, waitFor } = require("./helpers");

const SERVER_JS = path.join(__dirname, "..", "server.js");

/** A `codex` on PATH that records every line typed into it, so nothing real ever starts. */
function fakeCodexDir(out) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenv-fake-codex-"));
  fs.writeFileSync(path.join(dir, "codex.js"),
    `const fs = require("fs");\nprocess.stdin.setEncoding("utf8");\nlet buf = "";\n` +
    `process.stdin.on("data", (d) => { buf += d; let i; while ((i = buf.search(/[\\r\\n]/)) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line) fs.appendFileSync(${JSON.stringify(out)}, line + "\\n"); } });\n` +
    `setInterval(() => {}, 1000);\n`);
  fs.writeFileSync(path.join(dir, "codex.cmd"), `@echo off\r\nnode "%~dp0codex.js"\r\n`);
  fs.writeFileSync(path.join(dir, "codex"), `#!/bin/sh\nexec node "$(dirname "$0")/codex.js"\n`, { mode: 0o755 });
  return dir;
}

describe("messages API", () => {
  let server, home, dir, out;
  before(async () => {
    home = makeTempHome();
    out = path.join(home, "codex-input.txt");
    dir = fakeCodexDir(out);
    server = await startServer({ home, env: { PATH: dir + path.delimiter + process.env.PATH } });
  }, { timeout: 30000 });
  after(async () => {
    await stopProcess(server.proc);
    for (const d of [home, dir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  });

  it("agenv send, run inside one session, is typed into the codex running in another", async () => {
    const tgt = (await post("/api/sessions", { name: "reviewer", command: "codex" })).body;
    await waitFor(async () => (await get("/api/sessions")).body.find((s) => s.id === tgt.id && s.tool === "codex"), { message: "codex to be detected" });
    await new Promise((r) => setTimeout(r, 3000));   // let the fake codex start and the terminal go quiet

    await post("/api/sessions", { name: "builder", command: `node "${SERVER_JS}" send reviewer "please check the diff"` });
    await waitFor(() => fs.existsSync(out) && fs.readFileSync(out, "utf8").includes("please check the diff"),
      { timeout: 25000, message: "the message to reach codex" });
    const line = fs.readFileSync(out, "utf8").trim().split("\n")[0];
    assert.match(line, /^\[agenv message from builder\] please check the diff \(reply with: agenv send builder "<your answer>"\)$/);

    const log = (await get("/api/messages")).body;
    assert.equal(log.length, 1);
    assert.deepEqual([log[0].from, log[0].to, log[0].status], ["builder", "reviewer", "delivered"]);
  }, { timeout: 60000 });

  it("lists peers, and refuses a plain terminal, an unknown name, a bad token and no login", async () => {
    await post("/api/sessions", { name: "plain" });
    const peers = (await get("/api/messages/peers")).body;
    assert.ok(peers.some((p) => p.name === "reviewer" && p.tool === "codex" && p.live));

    const toPlain = await post("/api/messages", { to: "plain", text: "hi" });
    assert.equal(toPlain.status, 409);
    assert.match(toPlain.body.error, /No agent CLI is running/);
    assert.equal((await post("/api/messages", { to: "ghost", text: "hi" })).status, 404);
    assert.equal((await post("/api/messages", { to: "reviewer" })).status, 400);

    const badToken = await request("POST", "/api/messages", { body: { to: "reviewer", text: "x" }, headers: { Authorization: "Bearer nope" } });
    assert.equal(badToken.status, 401);
    const anon = await new Promise((resolve, reject) => {
      require("http").request({ host: "127.0.0.1", port: server.port, method: "GET", path: "/api/messages" }, (r) => { r.resume(); resolve(r.statusCode); }).on("error", reject).end();
    });
    assert.equal(anon, 401);
  }, { timeout: 30000 });
});

describe("broadcast API", () => {
  let server, home;
  before(async () => { home = makeTempHome(); server = await startServer({ home }); }, { timeout: 30000 });
  after(async () => { await stopProcess(server.proc); try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });

  it("runs a command in a session group's open terminals, honours agentsOnly and refuses an empty command", async () => {
    await post("/api/sessions", { name: "shell-a", group: "ops" });
    await post("/api/sessions", { name: "shell-b" });
    const res = await post("/api/messages/broadcast", { command: "echo hi", group: "ops" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map((r) => [r.name, r.status]), [["shell-a", "sent"]]);
    const agentsOnly = await post("/api/messages/broadcast", { command: "/remote-control", agentsOnly: true });
    assert.ok(agentsOnly.body.every((r) => r.status === "skipped"));
    assert.equal((await post("/api/messages/broadcast", { command: "" })).status, 400);
    assert.equal((await post("/api/messages/broadcast", {})).status, 400);
  }, { timeout: 30000 });
});
