// test/unit/shutdown.test.js — process lifecycle of dist/index.js: start, save, shut down cleanly, restore
"use strict";
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http"), net = require("net");
const { spawn } = require("child_process");

const ENTRY = path.join(__dirname, "..", "..", "dist", "index.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

function request(port, method, p, body) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : JSON.stringify(body); const h = { Connection: "close" };
    if (payload) { h["Content-Type"] = "application/json"; h["Content-Length"] = Buffer.byteLength(payload); }
    const r = http.request({ host: "127.0.0.1", port, method, path: p + "?token=T", headers: h, agent: false }, (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => { let b = d; try { b = JSON.parse(d); } catch {} resolve({ status: res.statusCode, body: b }); }); });
    r.on("error", () => resolve({ status: 0, body: null })); r.end(payload || undefined);
  });
}

const children = [];
afterEach(() => { for (const c of children.splice(0)) { try { c.kill("SIGKILL"); } catch {} } });

async function start(home, extra = []) {
  const port = await freePort();
  const flags = ["--port", String(port), "--host", "127.0.0.1", "--token", "T", "--no-qr"];
  const args = extra[0] === "run" ? [...extra, ...flags] : [...flags, ...extra];   // the command word comes first: agenv run <cmd> [flags]
  const proc = spawn(process.execPath, [ENTRY, ...args],
    { cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home, NODE_ENV: "test" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let out = ""; proc.stdout.on("data", (d) => (out += d)); proc.stderr.on("data", (d) => (out += d));
  const exited = new Promise((r) => proc.on("exit", (code, signal) => r({ code, signal })));
  children.push(proc);
  for (let i = 0; i < 80; i++) { if ((await request(port, "GET", "/api/stats")).status === 200) break; await sleep(150); }
  return { proc, port, exited, home, output: () => out, pidFile: path.join(home, ".agenv.pid") };
}
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timed out: " + what)), ms))]);

describe("dist/index.js lifecycle", () => {
  const mkHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "agenv-life-"));

  it("writes a PID file while running, and POST /api/shutdown saves state, exits 0 and removes it", async () => {
    const home = mkHome(); const s = await start(home);
    assert.ok(fs.existsSync(s.pidFile), "pid file exists while running"); const pid = JSON.parse(fs.readFileSync(s.pidFile, "utf8")); assert.equal(pid.pid, s.proc.pid); assert.equal(pid.port, s.port); assert.equal(pid.host, "127.0.0.1");
    const made = (await request(s.port, "POST", "/api/sessions", { name: "keepme", group: "a/b" })).body;
    await request(s.port, "PUT", "/api/sessions/" + made.id, { note: "n" });
    await request(s.port, "PUT", "/api/session-groups", { groups: [{ path: "empty/folder", color: "#abc" }] });
    assert.deepEqual((await request(s.port, "POST", "/api/shutdown")).body.ok, true);
    const exit = await withTimeout(s.exited, 8000, "exit after shutdown"); assert.equal(exit.code, 0);
    assert.ok(!fs.existsSync(s.pidFile), "pid file removed");
    assert.match(s.output(), /Shutdown via API — saving state/);

    // the next run restores the tab (asleep), its group, note and the empty folder
    const again = await start(home);
    const list = (await request(again.port, "GET", "/api/sessions")).body; const tab = list.find((x) => x.name === "keepme");
    assert.ok(tab, "session restored: " + JSON.stringify(list.map((x) => x.name))); assert.equal(tab.group, "a/b"); assert.equal(tab.note, "n"); assert.equal(tab.live, false);
    assert.ok((await request(again.port, "GET", "/api/session-groups")).body.some((g) => g.path === "empty/folder" && g.color === "#abc"));
    await request(again.port, "POST", "/api/shutdown"); await withTimeout(again.exited, 8000, "second exit");
  });

  it("SIGTERM shuts down the same way (POSIX; Windows has no catchable SIGTERM)", { skip: process.platform === "win32" }, async () => {
    const home = mkHome(); const s = await start(home);
    await request(s.port, "POST", "/api/sessions", { name: "sig" });
    s.proc.kill("SIGTERM");
    const exit = await withTimeout(s.exited, 8000, "exit after SIGTERM"); assert.equal(exit.code, 0); assert.ok(!fs.existsSync(s.pidFile));
    assert.match(s.output(), /SIGTERM — saving state/);
  });

  it("keeps the new session id sequence and restores layout-listed tabs without spawning shells", async () => {
    const home = mkHome(); const s = await start(home);
    const a = (await request(s.port, "POST", "/api/sessions", { name: "one" })).body.id, b = (await request(s.port, "POST", "/api/sessions", { name: "two" })).body.id;
    await request(s.port, "POST", "/api/workspace-layout", { layout: [{ id: "w", rootNode: { type: "leaf", sessionId: b } }] });
    await request(s.port, "POST", "/api/shutdown"); await withTimeout(s.exited, 8000, "exit");
    const again = await start(home);
    const list = (await request(again.port, "GET", "/api/sessions")).body;
    assert.deepEqual(list.map((x) => x.id), [b], "only the tab the layout still shows comes back");
    assert.equal(list[0].live, false);
    const created = (await request(again.port, "POST", "/api/sessions", { name: "new" })).body.id; assert.ok(created > b, `ids are never reused (${created} > ${b})`);
    await request(again.port, "POST", "/api/shutdown"); await withTimeout(again.exited, 8000, "exit 2");
  });

  it("agenv run starts exactly one session running the command", async () => {
    const home = mkHome(); const s = await start(home, ["run", "echo", "hello"]);
    const list = (await request(s.port, "GET", "/api/sessions")).body;
    assert.equal(list.length, 1); assert.equal(list[0].launchCommand, "echo hello"); assert.equal(list[0].name, "echo");
    await request(s.port, "POST", "/api/shutdown"); await withTimeout(s.exited, 8000, "exit");
  });

  it("--mirror: closing tab 0 from the browser does not stop the server (only the mirrored shell ending does)", async () => {
    const home = mkHome(); const s = await start(home, ["--mirror"]);
    const first = (await request(s.port, "GET", "/api/sessions")).body[0]; assert.equal(first.id, 0);
    assert.equal((await request(s.port, "DELETE", "/api/sessions/0")).status, 200);
    await sleep(1200);
    assert.equal((await request(s.port, "GET", "/api/stats")).status, 200, "the server is still serving");
    assert.equal(s.proc.exitCode, null, "and the process is still running");
    await request(s.port, "POST", "/api/shutdown"); await withTimeout(s.exited, 8000, "exit");
  });

  it("a port that is already taken ends with a clear message and exit code 1", async () => {
    const home = mkHome(); const s = await start(home);
    await request(s.port, "POST", "/api/sessions", { name: "first-only" });
    const stateBefore = fs.readFileSync(path.join(home, ".agenv-state.enc"), "utf8");
    // the same home on purpose: a failed second launch must not delete the first one's PID file or overwrite its state
    const other = spawn(process.execPath, [ENTRY, "--port", String(s.port), "--host", "127.0.0.1", "--token", "T", "--no-qr"], { cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home, NODE_ENV: "test" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    children.push(other); let out = ""; other.stdout.on("data", (d) => (out += d)); other.stderr.on("data", (d) => (out += d));
    const code = await withTimeout(new Promise((r) => other.on("exit", r)), 8000, "second server exit");
    assert.equal(code, 1); assert.match(out, /already in use/i); assert.doesNotMatch(out, /at Server\.setupListenHandle/);
    assert.ok(fs.existsSync(s.pidFile), "the running server's PID file is still there");
    assert.equal(JSON.parse(fs.readFileSync(s.pidFile, "utf8")).pid, s.proc.pid);
    assert.equal(fs.readFileSync(path.join(home, ".agenv-state.enc"), "utf8"), stateBefore, "its saved state was not touched");
    assert.equal((await request(s.port, "GET", "/api/stats")).status, 200, "and it keeps serving");
  });

  it("CLI subcommands run without starting a server", async () => {
    const home = mkHome();
    const run = (args) => new Promise((res) => { const p = spawn(process.execPath, [ENTRY, ...args], { env: { ...process.env, HOME: home, USERPROFILE: home }, windowsHide: true }); let o = ""; p.stdout.on("data", (d) => (o += d)); p.stderr.on("data", (d) => (o += d)); p.on("exit", (code) => res({ code, o })); });
    const v = await run(["version"]); assert.equal(v.code, 0); assert.match(v.o, /^agenv v\d+\.\d+\.\d+/);
    assert.equal((await run(["get", "nope"])).code, 1); assert.equal((await run(["run"])).code, 1);
  });
});
