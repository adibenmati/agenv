// test/unit/features.test.js — PromptLibrary, SystemStats, NgrokTunnel, AiService
"use strict";
const { describe, it, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const { PromptLibrary } = require("../../dist/features/PromptLibrary");
const { SystemStats } = require("../../dist/features/SystemStats");
const { NgrokTunnel } = require("../../dist/features/NgrokTunnel");
const { AiService } = require("../../dist/features/AiService");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "agenv-x-"));

describe("PromptLibrary", () => {
  const lib = () => new PromptLibrary(path.join(tmp(), "sub", "agenv-prompts.json"));
  it("creates, lists, updates, uses and removes prompts, persisting each step", () => {
    const file = path.join(tmp(), "p.json"); const l = new PromptLibrary(file);
    assert.deepEqual(l.list(), []);
    const p = l.create({ title: "T", content: "C", tags: ["a"] });
    assert.match(p.id, /^[a-z0-9]{6,}$/); assert.equal(p.category, "general"); assert.deepEqual(p.tags, ["a"]); assert.equal(p.used, 0); assert.ok(p.created > 0);
    assert.equal(new PromptLibrary(file).list().length, 1, "survives a restart");
    assert.equal(l.create({ title: "T2", content: "C2", category: "x" }).category, "x");
    const u = l.update(p.id, { title: "T9", id: "hijack", extra: 1 }); assert.equal(u.title, "T9"); assert.equal(u.id, p.id, "the id cannot be changed"); assert.equal(u.extra, 1);
    assert.equal(l.use(p.id), true); assert.equal(l.use(p.id), true);
    const used = l.list().find((x) => x.id === p.id); assert.equal(used.used, 2); assert.ok(used.lastUsed > 0);
    assert.equal(l.remove(p.id), true); assert.deepEqual(l.list().map((x) => x.title), ["T2"]);
  });
  it("validates, and unknown ids are reported without throwing for use/remove", () => {
    const l = lib();
    assert.throws(() => l.create({ title: "only" }), (e) => e.status === 400 && e.message === "title and content required");
    assert.throws(() => l.create({ content: "only" }), (e) => e.status === 400);
    assert.throws(() => l.update("nope", { title: "x" }), (e) => e.status === 404 && e.message === "Not found");
    assert.equal(l.use("nope"), false); assert.equal(l.remove("nope"), false);
  });
  it("creates the folder when needed and treats a corrupt or non-array file as empty", () => {
    const l = lib(); l.create({ title: "T", content: "C" }); assert.equal(l.list().length, 1);
    const f = path.join(tmp(), "bad.json"); fs.writeFileSync(f, "{not json"); assert.deepEqual(new PromptLibrary(f).list(), []);
    fs.writeFileSync(f, JSON.stringify({ not: "an array" })); assert.deepEqual(new PromptLibrary(f).list(), []);
  });
  it("writes readable JSON", () => {
    const f = path.join(tmp(), "p.json"); new PromptLibrary(f).create({ title: "T", content: "C" });
    assert.match(fs.readFileSync(f, "utf8"), /^\[\n  \{\n    "id"/);
  });
});

describe("SystemStats", () => {
  it("reports cpu, memory and host details", () => {
    const s = new SystemStats().snapshot();
    assert.equal(typeof s.cpu, "number"); assert.ok(s.cpu >= 0 && s.cpu <= 100); assert.ok(s.memTotal > 0 && s.memUsed > 0 && s.memUsed <= s.memTotal);
    assert.ok(s.memPercent >= 0 && s.memPercent <= 100); assert.equal(s.platform, os.platform()); assert.equal(s.hostname, os.hostname());
    assert.ok(s.uptime > 0); assert.ok(s.cores >= 1);
  });
  it("serves a cached snapshot for 3 seconds", () => {
    mock.timers.enable({ apis: ["Date"] });
    try {
      const st = new SystemStats(); const a = st.snapshot(); assert.equal(st.snapshot(), a);
      mock.timers.tick(2999); assert.equal(st.snapshot(), a);
      mock.timers.tick(2); assert.notEqual(st.snapshot(), a);
    } finally { mock.timers.reset(); }
  });
});

/** A stand-in child process. */
function fakeChild(pid = 4321) {
  const c = new EventEmitter(); c.pid = pid; c.killed = false; c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.stdin = new PassThrough(); c.written = "";
  c.stdin.on("data", (d) => (c.written += d)); c.stdin.on("finish", () => (c.stdinEnded = true));
  c.kill = () => { c.killed = true; c.emit("exit", null); };
  return c;
}

describe("NgrokTunnel", () => {
  const rig = (over = {}) => {
    const spawns = []; const children = [];
    const spawn = (cmd, args, opts) => { spawns.push({ cmd, args, opts }); const c = fakeChild(); children.push(c); return c; };
    const t = new NgrokTunnel({ defaultPort: 7681, spawn, startWaitMs: 15, fetchUrl: over.fetchUrl || (async () => "https://abc.ngrok.app"), ...over });
    return { t, spawns, children };
  };
  it("starts ngrok for the given or default port and reports the tunnel URL", async () => {
    const { t, spawns, children } = rig();
    const r = await t.start(); assert.deepEqual(r, { ok: true, url: "https://abc.ngrok.app", pid: 4321 });
    assert.deepEqual([spawns[0].cmd, spawns[0].args], ["ngrok", ["http", "7681"]]);
    const other = rig(); await other.t.start(9000); assert.deepEqual(other.spawns[0].args, ["http", "9000"]);
    assert.ok(children[0].stdout.readableFlowing !== false, "output is drained so ngrok cannot stall on a full pipe");
  });
  it("says so when it is already running", async () => {
    const { t, spawns } = rig(); await t.start();
    assert.deepEqual(await t.start(), { ok: true, url: "https://abc.ngrok.app", pid: 4321, message: "Already running" }); assert.equal(spawns.length, 1);
  });
  it("explains when the URL cannot be determined", async () => {
    assert.match((await rig({ fetchUrl: async () => null }).t.start()).error, /could not determine tunnel URL/);
    const r = await rig({ fetchUrl: async () => { throw new Error("x"); } }).t.start(); assert.equal(r.ok, false); assert.match(r.error, /not available yet/);
  });
  it("explains when ngrok cannot be started", async () => {
    const spawn = () => { const c = fakeChild(); setImmediate(() => c.emit("error", new Error("spawn ngrok ENOENT"))); return c; };
    const t = new NgrokTunnel({ defaultPort: 1, spawn, startWaitMs: 500, fetchUrl: async () => null });
    const r = await t.start(); assert.equal(r.ok, false); assert.match(r.error, /^Failed to start ngrok: spawn ngrok ENOENT\. Is ngrok installed\? \(npm i -g ngrok or https:\/\/ngrok\.com\/download\)$/);
    assert.deepEqual(await t.status(), { running: false });
  });
  it("status looks the URL up once, then caches it; an exited process is no longer running", async () => {
    let lookups = 0; const { t, children } = rig({ fetchUrl: async () => { lookups++; return lookups === 1 ? null : "https://later.ngrok.app"; } });
    await t.start();                                   // first lookup (during start) found nothing
    assert.deepEqual(await t.status(), { running: true, url: "https://later.ngrok.app", pid: 4321 });
    await t.status(); assert.equal(lookups, 2, "cached after it is known");
    children[0].emit("exit", 0); assert.deepEqual(await t.status(), { running: false });
  });
  it("stop kills the process and is safe to call when nothing runs", async () => {
    const { t, children } = rig(); t.stop(); await t.start(); t.stop();
    assert.equal(children[0].killed, true); assert.deepEqual(await t.status(), { running: false });
  });
  it("dispose kills a running tunnel (it used to be left running after agenv stopped)", async () => {
    const { t, children } = rig(); await t.start(); t.dispose(); assert.equal(children[0].killed, true);
  });
  it("is the tunnel policy: allow-list and read-only, with input filtering", () => {
    const { t } = rig(); assert.deepEqual(t.settings(), { allowedIps: [], readOnly: false });
    assert.deepEqual(t.updateSettings({ allowedIps: ["1.1.1.1", "", 5, null, "2.2.2.2"], readOnly: true }), { ok: true, settings: { allowedIps: ["1.1.1.1", "2.2.2.2"], readOnly: true } });
    assert.deepEqual([t.allowedIps, t.readOnly], [["1.1.1.1", "2.2.2.2"], true], "the policy fields AuthService reads");
    t.updateSettings({ allowedIps: "nope", readOnly: "yes" }); assert.deepEqual(t.settings(), { allowedIps: ["1.1.1.1", "2.2.2.2"], readOnly: true }, "wrong types are ignored");
    t.updateSettings({ allowedIps: [], readOnly: false }); assert.deepEqual(t.settings(), { allowedIps: [], readOnly: false });
  });
});

describe("AiService", () => {
  const rig = (platform = "linux") => {
    const calls = []; const children = [];
    const spawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); const c = fakeChild(); children.push(c); return c; };
    return { ai: new AiService({ spawn, platform }), calls, children };
  };
  const finish = (c, { out = "", err = "", code = 0 } = {}) => { if (out) c.stdout.write(out); if (err) c.stderr.write(err); setImmediate(() => c.emit("close", code)); };

  it("runs claude one-shot with the model, sends the prompt on stdin and returns the trimmed answer", async () => {
    const { ai, calls, children } = rig(); const p = ai.ask({ prompt: "hello", model: "opus", cwd: "/work" });
    await new Promise((r) => setImmediate(r)); finish(children[0], { out: "  the answer \n" });
    const r = await p;
    assert.equal(r.response, "the answer"); assert.equal(r.agent, "claude"); assert.equal(r.model, "opus"); assert.equal(typeof r.elapsed, "number");
    assert.deepEqual([calls[0].cmd, calls[0].args], ["claude", ["-p", "--model", "opus", "--output-format", "text"]]);
    assert.equal(children[0].written, "hello"); assert.equal(children[0].stdinEnded, true);
    assert.equal(calls[0].opts.cwd, "/work"); assert.equal(calls[0].opts.shell, true); assert.equal(calls[0].opts.windowsHide, true);
  });
  it("defaults to claude/sonnet in the current folder, and picks the right command for other agents", async () => {
    const a = rig(); const p = a.ai.ask({ prompt: "x" }); await new Promise((r) => setImmediate(r)); finish(a.children[0], { out: "ok" });
    assert.equal((await p).model, "sonnet"); assert.equal(a.calls[0].opts.cwd, process.cwd());
    for (const [agent, cmd, args] of [["gemini", "gemini", ["-p"]], ["codex", "codex", ["-p"]], ["my-agent", "my-agent", ["-p"]]]) {
      const r = rig(); const q = r.ai.ask({ prompt: "x", agent }); await new Promise((x) => setImmediate(x)); finish(r.children[0], { out: "ok" });
      assert.equal((await q).agent, agent); assert.deepEqual([r.calls[0].cmd, r.calls[0].args], [cmd, args]);
    }
  });
  it("uses the Windows command shell on Windows", async () => {
    const r = rig("win32"); const p = r.ai.ask({ prompt: "x" }); await new Promise((x) => setImmediate(x)); finish(r.children[0], { out: "ok" }); await p;
    assert.match(r.calls[0].opts.shell, /cmd\.exe$/i);
  });
  it("requires a prompt", async () => {
    await assert.rejects(rig().ai.ask({}), (e) => e.status === 400 && e.message === "prompt required");
  });
  it("a failure with no output is a 500 carrying stderr and the elapsed time; output wins over a non-zero exit", async () => {
    const a = rig(); const p = a.ai.ask({ prompt: "x" }); await new Promise((r) => setImmediate(r)); finish(a.children[0], { err: "boom\n", code: 2 });
    await assert.rejects(p, (e) => e.status === 500 && e.message === "boom" && typeof e.body.elapsed === "number" && e.body.error === "boom");
    const b = rig(); const q = b.ai.ask({ prompt: "x" }); await new Promise((r) => setImmediate(r)); finish(b.children[0], { code: 3 });
    await assert.rejects(q, (e) => e.message === "Process exited with code 3" && e.body.error === "Process exited with code 3");
    const c = rig(); const s = c.ai.ask({ prompt: "x" }); await new Promise((r) => setImmediate(r)); finish(c.children[0], { out: "partial", code: 1 });
    assert.equal((await s).response, "partial");
  });
  it("reports a command that cannot start, and answers only once if close follows the error", async () => {
    const a = rig(); const p = a.ai.ask({ prompt: "x", agent: "nope" }); await new Promise((r) => setImmediate(r));
    a.children[0].emit("error", new Error("spawn nope ENOENT")); a.children[0].emit("close", 1);
    await assert.rejects(p, (e) => e.status === 500 && e.message === "Failed to spawn nope: spawn nope ENOENT");
  });
  it("survives an agent that exits without reading its prompt (EPIPE on stdin)", async () => {
    const a = rig(); const p = a.ai.ask({ prompt: "x" }); await new Promise((r) => setImmediate(r));
    assert.doesNotThrow(() => a.children[0].stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })));
    finish(a.children[0], { out: "fine" }); assert.equal((await p).response, "fine");
  });
  it("kills the agent after 90 s by default, at most 120 s, and ignores a non-numeric timeout", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      for (const [timeout, killedAt] of [[undefined, 90000], [500000, 120000], [5000, 5000], ["abc", 90000]]) {
        const a = rig(); a.ai.ask({ prompt: "x", timeout }).catch(() => {});
        await Promise.resolve();
        mock.timers.tick(killedAt - 1); assert.equal(a.children[0].killed, false, `timeout ${timeout}: not yet at ${killedAt - 1}`);
        mock.timers.tick(1); assert.equal(a.children[0].killed, true, `timeout ${timeout}: killed at ${killedAt}`);
      }
    } finally { mock.timers.reset(); }
  });
});
