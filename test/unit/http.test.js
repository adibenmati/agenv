// test/unit/http.test.js — error rendering, read models, page builder, workspace layout, and the wired application
"use strict";
const { describe, it, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const express = require("express");
const { HttpError } = require("../../dist/core/HttpError");
const { wrap, errorMiddleware } = require("../../dist/http/errors");
const { WorkspaceLayout } = require("../../dist/sessions/WorkspaceLayout");
const { recentFolders, sessionAnalytics, legacyGroups, readLiveCwd } = require("../../dist/sessions/queries");
const { PageBuilder } = require("../../dist/http/page");
const { buildRuntime } = require("../../dist/runtime");
const { Config } = require("../../dist/core/Config");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "agenv-h-"));

/** Minimal request helper: JSON in, { status, headers, body } out. */
function call(port, method, p, { body, headers = {}, token = "T", raw } = {}) {
  return new Promise((resolve, reject) => {
    const payload = raw !== undefined ? raw : body === undefined ? null : JSON.stringify(body);
    const url = p + (token ? (p.includes("?") ? "&" : "?") + "token=" + token : "");
    const h = { Connection: "close", ...headers };
    if (payload != null) { h["Content-Type"] = h["Content-Type"] || "application/json"; h["Content-Length"] = Buffer.byteLength(payload); }
    const req = http.request({ host: "127.0.0.1", port, method, path: url, headers: h, agent: false }, (res) => {
      let data = ""; res.on("data", (d) => (data += d));
      res.on("end", () => { let b = data; try { b = JSON.parse(data); } catch {} resolve({ status: res.statusCode, headers: res.headers, body: b }); });
    });
    req.on("error", reject); req.end(payload == null ? undefined : payload);
  });
}

describe("errors", () => {
  const appWith = (route) => { const app = express(); app.use(express.json()); route(app); app.use(errorMiddleware); return app; };
  const serve = async (app, fn) => { const s = app.listen(0, "127.0.0.1"); await new Promise((r) => s.once("listening", r)); try { return await fn(s.address().port); } finally { s.close(); } };

  it("renders an HttpError as { error } with its status", async () => {
    const app = appWith((a) => a.get("/x", wrap(async () => { throw new HttpError(404, "Session not found"); })));
    const r = await serve(app, (port) => call(port, "GET", "/x", { token: null })); assert.equal(r.status, 404); assert.deepEqual(r.body, { error: "Session not found" });
  });
  it("renders an HttpError that carries a body verbatim", async () => {
    const app = appWith((a) => a.get("/x", wrap(async () => { throw new HttpError(400, "Commit message required", { ok: false, output: "Commit message required" }); })));
    const r = await serve(app, (port) => call(port, "GET", "/x", { token: null })); assert.equal(r.status, 400); assert.deepEqual(r.body, { ok: false, output: "Commit message required" });
  });
  it("renders any other error as a 500 { error }, for both sync throws and rejected promises", async () => {
    const app = appWith((a) => { a.get("/sync", wrap(() => { throw new Error("boom"); })); a.get("/async", wrap(async () => { throw new Error("later"); })); });
    await serve(app, async (port) => {
      assert.deepEqual((await call(port, "GET", "/sync", { token: null })).body, { error: "boom" }); assert.equal((await call(port, "GET", "/async", { token: null })).status, 500);
    });
  });
  it("answers a malformed JSON body with a 400 and JSON, not an HTML stack trace", async () => {
    const app = appWith((a) => a.post("/x", (req, res) => res.json({ ok: true })));
    const r = await serve(app, (port) => call(port, "POST", "/x", { raw: "{not json", token: null }));
    assert.equal(r.status, 400); assert.equal(typeof r.body.error, "string"); assert.doesNotMatch(JSON.stringify(r.body), /<html|at Object/i);
  });
  it("wrap passes a handler's successful result through untouched", async () => {
    const app = appWith((a) => a.get("/x", wrap(async (req, res) => { res.json({ fine: true }); })));
    assert.deepEqual((await serve(app, (port) => call(port, "GET", "/x", { token: null }))).body, { fine: true });
  });
});

describe("WorkspaceLayout", () => {
  it("holds the saved layout, defaults to null, and collects the session ids it still shows", () => {
    const l = new WorkspaceLayout(); assert.equal(l.get(), null); assert.deepEqual([...l.sessionIds()], []);
    const layout = [{ id: "w1", rootNode: { type: "split", children: [{ type: "leaf", sessionId: 3 }, { type: "split", children: [{ type: "leaf", sessionId: 7 }, { type: "leaf" }] }] } }, { id: "w2", name: "editor" }, { id: "w3", rootNode: { type: "leaf", sessionId: 0 } }];
    l.set(layout); assert.equal(l.get(), layout); assert.deepEqual([...l.sessionIds()].sort(), [0, 3, 7]);
    l.set(undefined); assert.equal(l.get(), null); l.set("junk"); assert.deepEqual([...l.sessionIds()], []);
  });
});

describe("read models", () => {
  const sess = (cwd, lastActivity) => ({ cwd, lastActivity });
  it("recentFolders merges sessions and archive by latest activity, drops missing folders, sorts newest first and limits", () => {
    const exists = (p) => p !== "/gone";
    const r = recentFolders([sess("/a", 100), sess("/b", 300), sess("/gone", 999), sess("", 5)], [{ cwd: "/a", lastActivity: 500, closed: 1 }, { cwd: "/c", closed: 200 }, { cwd: "/d", lastActivity: 50, closed: 9 }], 3, exists);
    assert.deepEqual(r, [{ cwd: "/a", lastActivity: 500 }, { cwd: "/b", lastActivity: 300 }, { cwd: "/c", lastActivity: 200 }]);
  });
  it("sessionAnalytics reports each session and the totals", () => {
    const now = Date.now(); const a = (o) => ({ inputTokens: 0, outputTokens: 0, estimatedCost: 0, turnCount: 0, commandCount: 0, startTime: now - 1000, ...o });
    const r = sessionAnalytics([{ id: 1, name: "", detectedTool: "claude", status: "running", created: 1, analytics: a({ inputTokens: 10, outputTokens: 5, estimatedCost: 1.5, turnCount: 2 }) }, { id: 2, name: "x", detectedTool: "", status: "idle", created: now - 5000, analytics: undefined }]);
    assert.equal(r.sessions[1].name, "Session 1"); assert.equal(r.sessions[1].tool, "claude"); assert.equal(r.sessions[1].turnCount, 2); assert.ok(r.sessions[1].duration >= 1000);
    assert.equal(r.sessions[2].name, "x"); assert.equal(r.sessions[2].tool, "terminal"); assert.ok(r.sessions[2].duration >= 5000);
    assert.deepEqual(r.totals, { inputTokens: 10, outputTokens: 5, estimatedCost: 1.5, sessionCount: 2 });
  });
  it("legacyGroups lists session ids by flat group name, with 'ungrouped' for none", () => {
    assert.deepEqual(legacyGroups([{ id: 1, group: "a/b" }, { id: 2, group: "" }, { id: 3, group: "a/b" }]), { "a/b": [1, 3], ungrouped: [2] });
  });
  it("readLiveCwd is null for a pid that does not exist and on Windows", async () => {
    assert.equal(await readLiveCwd(999999999), null);
    if (process.platform === "linux") assert.equal(await readLiveCwd(process.pid), fs.realpathSync(process.cwd()));
    if (process.platform === "win32") assert.equal(await readLiveCwd(process.pid), null);
  });
});

describe("PageBuilder", () => {
  const publicDir = () => { const d = tmp(); fs.writeFileSync(path.join(d, "index.html"), "<html><script>/*__RUNTIME_DATA__*/</script><body>app</body></html>"); return d; };
  const mk = (over = {}) => new PageBuilder({ publicDir: publicDir(), sessions: () => [], archive: () => [], favorites: () => [], layout: () => null, watch: false, ...over });
  const runtimeOf = (html) => { const m = html.match(/window\.__RUNTIME__ = ([\s\S]*?);<\/script>/); assert.ok(m, "runtime script present"); return JSON.parse(m[1]); };

  it("injects the token, sessions (by id), newest 30 archive entries, favorites, recent folders and layout", () => {
    const sessions = [{ id: 2, name: "b", cwd: __dirname, lastActivity: 20, group: "g", note: "n", analytics: { a: 1 } }, { id: 1, name: "", cwd: "/gone/xyz", lastActivity: 10 }];
    const archive = Array.from({ length: 40 }, (_, i) => ({ name: "n" + i, cwd: __dirname, lastActivity: i, closed: i }));
    const rt = runtimeOf(mk({ sessions: () => sessions, archive: () => archive, favorites: () => [{ name: "f" }], layout: () => [{ id: "w" }] }).page("TOK"));
    assert.equal(rt.token, "TOK"); assert.deepEqual(rt.sessions.map((s) => s.id), [1, 2]); assert.equal(rt.sessions[0].tool, "terminal"); assert.equal(rt.sessions[1].group, "g");
    assert.equal(rt.archive.length, 30); assert.equal(rt.archive[0].name, "n39", "newest first"); assert.deepEqual(rt.favorites, [{ name: "f" }]); assert.deepEqual(rt.workspaceLayout, [{ id: "w" }]);
    assert.deepEqual(rt.recentFolders.map((f) => f.cwd), [__dirname]); assert.ok(rt.recentFolders.length <= 15);
  });
  it("cannot be broken out of by session data: '</script>' and replacement patterns stay literal", () => {
    const nasty = "</script><script>alert(1)</script> $& $1 $` $'";
    const html = mk({ sessions: () => [{ id: 1, name: nasty, cwd: "/x", lastActivity: 1 }] }).page("T");
    assert.equal((html.match(/<\/script>/g) || []).length, 1, "only the real closing tag");
    assert.equal(runtimeOf(html).sessions[0].name, nasty, "the data round-trips exactly");
  });
  it("serves the login page with an optional error and rereads the template only when it changes", () => {
    const b = mk(); assert.match(b.login(), /Login/); assert.doesNotMatch(b.login(), /class="error"/); assert.match(b.login("Invalid username or password."), /<p class="error">Invalid username or password\.<\/p>/);
    const dir = publicDir(); const w = new PageBuilder({ publicDir: dir, sessions: () => [], archive: () => [], favorites: () => [], layout: () => null, watch: false });
    assert.match(w.page("T"), /body>app/); fs.writeFileSync(path.join(dir, "index.html"), "<html>changed/*__RUNTIME_DATA__*/</html>");
    assert.match(w.page("T"), /body>app/, "cached"); w.invalidate(); assert.match(w.page("T"), /changed/);
  });
});

describe("the wired application", () => {
  let rt, port, home;
  const ptys = [];
  const ptyFactory = (o) => { const h = {}; const p = { pid: 9000 + ptys.length, cols: o.cols, rows: o.rows, written: [], killed: false, opts: o,
    onData: (cb) => (h.data = cb), onExit: (cb) => (h.exit = cb), write: (x) => p.written.push(x), resize() {}, kill: () => { p.killed = true; }, emit: (x) => h.data(x) }; ptys.push(p); return p; };
  beforeEach(async () => {
    ptys.length = 0; home = tmp(); const publicDir = path.join(home, "public"); fs.mkdirSync(publicDir); fs.writeFileSync(path.join(publicDir, "index.html"), "<html>/*__RUNTIME_DATA__*/</html>"); fs.writeFileSync(path.join(publicDir, "x.txt"), "static!");
    rt = buildRuntime({ config: Config.fromArgv(["--token", "T", "--max-sessions", "3"], {}, home), homedir: home, ptyFactory, publicDir, watchPage: false });
    await new Promise((r) => rt.server.listen(0, "127.0.0.1", r)); port = rt.server.address().port;
  });
  afterEach(() => rt.dispose());

  it("rejects requests without a valid token and serves the public folder without one", async () => {
    assert.equal((await call(port, "GET", "/api/sessions", { token: null })).status, 401);
    assert.equal((await call(port, "GET", "/api/sessions", { token: "wrong" })).status, 401);
    assert.equal((await call(port, "GET", "/api/sessions")).status, 200);
    assert.equal((await call(port, "GET", "/public/x.txt", { token: null })).body, "static!");
    const page = await call(port, "GET", "/"); assert.equal(page.status, 200); assert.match(page.body, /window\.__RUNTIME__/);
    assert.equal((await call(port, "GET", "/", { token: null })).status, 401);
  });
  it("sends the security headers", async () => {
    const r = await call(port, "GET", "/api/sessions");
    assert.equal(r.headers["x-content-type-options"], "nosniff"); assert.equal(r.headers["x-frame-options"], "DENY"); assert.equal(r.headers["referrer-policy"], "no-referrer");
    assert.match(r.headers["content-security-policy"], /default-src 'self'/);
  });
  it("creates, lists, renames, groups and deletes sessions; the limit is enforced", async () => {
    const a = (await call(port, "POST", "/api/sessions", { body: { name: "alpha", group: " p / q " } })).body;
    assert.deepEqual(Object.keys(a).sort(), ["created", "cwd", "group", "id", "name", "status", "tool"]); assert.equal(a.group, "p/q"); assert.equal(ptys.length, 1);
    const put = await call(port, "PUT", `/api/sessions/${a.id}`, { body: { name: "beta", note: "hi", group: "p" } }); assert.deepEqual(put.body, { ok: true, claudeRenamed: false });
    const list = (await call(port, "GET", "/api/sessions")).body; assert.equal(list.length, 1); assert.equal(list[0].name, "beta"); assert.equal(list[0].note, "hi"); assert.equal(list[0].group, "p"); assert.equal(list[0].clients, 0); assert.equal(list[0].live, true);
    assert.equal((await call(port, "PUT", "/api/sessions/999", { body: { name: "x" } })).status, 404);
    await call(port, "POST", "/api/sessions", { body: {} }); await call(port, "POST", "/api/sessions", { body: {} });
    const full = await call(port, "POST", "/api/sessions", { body: {} }); assert.equal(full.status, 400); assert.deepEqual(full.body, { error: "Maximum sessions reached (3)" });
    const ql = await call(port, "POST", "/api/quick-launch", { body: { cwd: home } }); assert.deepEqual(ql.body, { error: "Max sessions reached" }, "quick-launch has its own message");
    assert.deepEqual((await call(port, "DELETE", `/api/sessions/${a.id}`)).body, { ok: true }); assert.equal(ptys[0].killed, true);
    assert.equal((await call(port, "DELETE", `/api/sessions/${a.id}`)).status, 404);
    assert.equal((await call(port, "GET", "/api/archive")).body.length, 1);
  });
  it("manages group folders and keeps them across a restart of the app", async () => {
    await call(port, "PUT", "/api/session-groups", { body: { groups: [{ path: "x/y", color: "#fff" }] } });
    assert.equal((await call(port, "PUT", "/api/session-groups", { body: {} })).status, 400);
    assert.deepEqual((await call(port, "POST", "/api/session-groups/rename", { body: { from: "x", to: "z" } })).body.map((g) => g.path), ["z", "z/y"]);
    assert.equal((await call(port, "POST", "/api/session-groups/rename", { body: { from: "z", to: "z/in" } })).status, 400);
    assert.equal((await call(port, "POST", "/api/session-groups/delete", { body: {} })).status, 400);
    rt.stateStore.saveNow(); rt.dispose();
    const rt2 = buildRuntime({ config: Config.fromArgv(["--token", "T"], {}, home), homedir: home, ptyFactory, publicDir: path.join(home, "public"), watchPage: false });
    try { assert.deepEqual(rt2.groups.list().map((g) => g.path), ["z", "z/y"]); } finally { rt2.dispose(); }
    rt = buildRuntime({ config: Config.fromArgv(["--token", "T"], {}, home), homedir: home, ptyFactory, publicDir: path.join(home, "public"), watchPage: false });   // for afterEach
  });
  it("records history (updating the session), archive removal and favorites with the original validation", async () => {
    const s = (await call(port, "POST", "/api/sessions", { body: {} })).body;
    assert.deepEqual((await call(port, "POST", "/api/history", { body: { command: "claude --model x", sessionId: s.id } })).body, { ok: true });
    assert.equal((await call(port, "GET", "/api/sessions")).body[0].tool, "claude");
    assert.equal((await call(port, "POST", "/api/history", { body: {} })).status, 400); assert.deepEqual((await call(port, "POST", "/api/history", { body: { command: "   " } })).body, { ok: true });
    assert.deepEqual((await call(port, "GET", "/api/history")).body, ["claude --model x"]);
    assert.equal((await call(port, "POST", "/api/favorites", { body: {} })).status, 400);
    assert.deepEqual((await call(port, "POST", "/api/favorites", { body: { cwd: "/x" } })).body, { ok: true }); assert.deepEqual((await call(port, "POST", "/api/favorites", { body: { cwd: "/x" } })).body, { ok: true, msg: "Already saved" });
    assert.equal((await call(port, "DELETE", "/api/favorites/5")).status, 404); assert.deepEqual((await call(port, "DELETE", "/api/favorites/0")).body, { ok: true });
    assert.equal((await call(port, "POST", "/api/archive/remove", { body: {} })).status, 400);
  });
  it("saves and returns the workspace layout", async () => {
    assert.deepEqual((await call(port, "GET", "/api/workspace-layout")).body, { layout: null });
    await call(port, "POST", "/api/workspace-layout", { body: { layout: [{ id: "w" }] } }); assert.deepEqual((await call(port, "GET", "/api/workspace-layout")).body, { layout: [{ id: "w" }] });
    await call(port, "POST", "/api/workspace-layout", { body: {} }); assert.deepEqual((await call(port, "GET", "/api/workspace-layout")).body, { layout: null });
  });
  it("answers unknown routes with 404 and applies the tunnel read-only rule to writes", async () => {
    assert.equal((await call(port, "GET", "/api/definitely-not-a-route")).status, 404);
    await call(port, "POST", "/api/ngrok/settings", { body: { readOnly: true } });
    const t = (m, p, body) => call(port, m, p, { body, headers: { "x-forwarded-for": "1.2.3.4" } });
    assert.equal((await t("POST", "/api/sessions", {})).status, 403); assert.equal((await t("GET", "/api/sessions")).status, 200);
  });
  it("rotates the token and the old one stops working", async () => {
    const r = (await call(port, "POST", "/api/token/rotate")).body; assert.equal(r.ok, true); assert.equal(r.token.length, 48);
    assert.equal((await call(port, "GET", "/api/sessions", { token: "T" })).status, 401); assert.equal((await call(port, "GET", "/api/sessions", { token: r.token })).status, 200);
  });
  it("validates the small services' inputs (prompts, ai, git, files, search, claude.md)", async () => {
    assert.equal((await call(port, "POST", "/api/prompts", { body: { title: "x" } })).status, 400);
    const p = (await call(port, "POST", "/api/prompts", { body: { title: "t", content: "c" } })).body; assert.equal((await call(port, "GET", "/api/prompts")).body.length, 1);
    assert.deepEqual((await call(port, "POST", `/api/prompts/${p.id}/use`)).body, { ok: true }); assert.deepEqual((await call(port, "DELETE", `/api/prompts/${p.id}`)).body, { ok: true });
    assert.deepEqual((await call(port, "POST", "/api/ai/ask", { body: {} })).body, { error: "prompt required" });
    assert.deepEqual((await call(port, "GET", "/api/git/bogus")).body, { error: "Unknown action" });
    assert.deepEqual((await call(port, "POST", "/api/git/commit", { body: { message: " " } })).body, { ok: false, output: "Commit message required" });
    assert.deepEqual((await call(port, "GET", "/api/file")).body, { error: "Missing path" }); assert.deepEqual((await call(port, "GET", "/api/search/text")).body, { error: "Missing query" });
    assert.deepEqual((await call(port, "GET", "/api/claudemd/read")).body, { error: "path required" }); assert.deepEqual((await call(port, "GET", "/api/claude/conversation/not-an-id")).body, { error: "invalid id" });
    assert.equal((await call(port, "GET", "/api/claude/conversation/00000000-0000-4000-8000-000000000000")).status, 404);
    assert.deepEqual((await call(port, "GET", "/api/ngrok/status")).body, { running: false });
  });
});
