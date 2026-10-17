// test/agents-api.test.js — black-box API for named agents, conversation fork and estimate
"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const { startServer, stopProcess, makeTempHome, get, post, put, del } = require("./helpers");

const FAKE = path.join(__dirname, "fixtures", "fake-claude-cli.js");
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const calls = (state) => fs.readFileSync(path.join(state, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

/** A claude on PATH that does nothing, so opening an agent's terminal can never start the real CLI. */
function stubClaudeDir() {
  const dir = tmp("agenv-stub-claude-");
  fs.writeFileSync(path.join(dir, "claude.cmd"), "@echo off\r\n");
  fs.writeFileSync(path.join(dir, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return dir;
}

async function boot(mode = "ok") {
  const home = makeTempHome(), state = tmp("agenv-fake-state-"), work = tmp("agenv-work-"), stub = stubClaudeDir();
  const server = await startServer({
    home,
    env: {
      AGENV_CLAUDE_BIN: FAKE, FAKE_CLAUDE_STATE: state, FAKE_CLAUDE_MODE: mode,
      PATH: stub + path.delimiter + process.env.PATH,
    },
  });
  return { server, home, state, work };
}

describe("agents API", () => {
  let ctx;
  before(async () => { ctx = await boot(); }, { timeout: 30000 });
  after(async () => { await stopProcess(ctx.server.proc); });

  const agent = (name, extra = {}) => ({ name, specialty: "tests", cwd: ctx.work, ...extra });

  it("401 without a token", async () => {
    const status = await new Promise((resolve, reject) => {
      http.get(`${ctx.server.baseUrl}/api/agents`, (res) => { res.resume(); resolve(res.statusCode); }).on("error", reject);
    });
    assert.equal(status, 401);
  });

  it("create / list / update / delete round trip", async () => {
    const c = await post("/api/agents", agent("alpha"));
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(c.body.name, "alpha");
    assert.ok((await get("/api/agents")).body.some((a) => a.id === c.body.id));
    const u = await put(`/api/agents/${c.body.id}`, { specialty: "changed" });
    assert.equal(u.status, 200, JSON.stringify(u.body));
    assert.equal(u.body.specialty, "changed");
    assert.equal((await del(`/api/agents/${c.body.id}`)).status, 200);
    assert.ok(!(await get("/api/agents")).body.some((a) => a.id === c.body.id));
  });

  it("invalid name is a 400 with a message", async () => {
    const r = await post("/api/agents", agent("bad name!"));
    assert.equal(r.status, 400);
    assert.match(r.body.error, /name/);
    assert.ok(!JSON.stringify(r.body).includes("    at "));
  });

  it("duplicate name is a 409", async () => {
    assert.equal((await post("/api/agents", agent("twin"))).status, 200);
    assert.equal((await post("/api/agents", agent("twin"))).status, 409);
  });

  it("unknown agent id is a 404", async () => {
    assert.equal((await put("/api/agents/nope", { specialty: "x" })).status, 404);
    assert.equal((await del("/api/agents/nope")).status, 404);
    assert.equal((await post("/api/agents/nope/open", {})).status, 404);
    assert.equal((await post("/api/agents/nope/run", { prompt: "hi" })).status, 404);
    assert.equal((await post("/api/agents/nope/duplicate", {})).status, 404);
  });

  it("from-conversation fork returns an agent on a different conversation", async () => {
    const src = (await post("/api/agents", agent("source"))).body;
    const run = await post(`/api/agents/${src.id}/run`, { prompt: "remember 42" });
    assert.equal(run.status, 200, JSON.stringify(run.body));
    assert.equal(run.body.status, "succeeded");
    const sourceId = run.body.conversationId;
    assert.ok(sourceId);
    const f = await post("/api/agents/from-conversation", { name: "forked", specialty: "f", sourceConversationId: sourceId, mode: "fork", cwd: ctx.work });
    assert.equal(f.status, 200, JSON.stringify(f.body));
    assert.ok(f.body.conversationId);
    assert.notEqual(f.body.conversationId, sourceId);
    assert.equal(f.body.origin.kind, "fork");
    const dup = await post(`/api/agents/${f.body.id}/duplicate`, { compact: true });
    assert.equal(dup.status, 200, JSON.stringify(dup.body));
    assert.notEqual(dup.body.conversationId, f.body.conversationId);
  });

  it("distill overwrite conflict is a 409 and the file is untouched", async () => {
    const file = path.join(ctx.work, ".claude", "agenv-briefings", "brief.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "mine");
    const src = (await post("/api/agents", agent("distsrc"))).body;
    const sourceId = (await post(`/api/agents/${src.id}/run`, { prompt: "hello" })).body.conversationId;
    const body = { name: "brief", specialty: "b", sourceConversationId: sourceId, mode: "distill-briefing", cwd: ctx.work };
    const r = await post("/api/agents/from-conversation", body);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(fs.readFileSync(file, "utf8"), "mine");
    const ok = await post("/api/agents/from-conversation", { ...body, overwrite: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.briefingFile, file);
  });

  it("open returns a session whose name and cwd match", async () => {
    const a = (await post("/api/agents", agent("opener"))).body;
    const r = await post(`/api/agents/${a.id}/open`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.name, "opener");
    assert.equal(path.resolve(r.body.cwd).toLowerCase(), path.resolve(ctx.work).toLowerCase());
    await del(`/api/sessions/${r.body.id}`);
  });

  it("fork-to-terminal validates the id and cwd", async () => {
    assert.equal((await post("/api/claude/conversations/bad$id/fork", { cwd: ctx.work })).status, 400);
    assert.equal((await post("/api/claude/conversations/abc-123/fork", { cwd: path.join(ctx.work, "missing") })).status, 400);
    const r = await post("/api/claude/conversations/abc-123/fork", { cwd: ctx.work });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await del(`/api/sessions/${r.body.id}`);
  });

  it('a prompt starting with "/compact" is passed after "--"', async () => {
    const a = (await post("/api/agents", agent("slash"))).body;
    const r = await post(`/api/agents/${a.id}/run`, { prompt: "/compact now" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const last = calls(ctx.state).pop().argv;
    const dd = last.indexOf("--");
    assert.ok(dd >= 0, "argv: " + JSON.stringify(last));
    assert.equal(last[dd + 1], "/compact now");
    assert.equal(last.length, dd + 2);
  });

  it("a run without a prompt is a 400", async () => {
    const a = (await post("/api/agents", agent("quiet"))).body;
    assert.equal((await post(`/api/agents/${a.id}/run`, {})).status, 400);
  });
});

describe("conversation estimate", () => {
  let ctx;
  const BIG = "11111111-2222-4333-8444-555555555555", SMALL = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  before(async () => {
    const home = makeTempHome();
    const dir = path.join(home, ".claude", "projects", "C--proj");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, BIG + ".jsonl"), "x".repeat(500 * 1024));
    fs.writeFileSync(path.join(dir, SMALL + ".jsonl"), "x".repeat(10 * 1024));
    ctx = { home, server: await startServer({ home }) };
  }, { timeout: 30000 });
  after(async () => { await stopProcess(ctx.server.proc); });

  it("suggests compacting a 500 KB transcript but not a 10 KB one", async () => {
    const big = await get(`/api/claude/conversations/${BIG}/estimate`);
    assert.equal(big.status, 200, JSON.stringify(big.body));
    assert.equal(big.body.sizeBytes, 500 * 1024);
    assert.equal(big.body.approxTokens, Math.round(500 * 1024 / 4));
    assert.equal(big.body.suggestCompact, true);
    assert.ok(big.body.estimatedCostUsd > 0);
    const small = await get(`/api/claude/conversations/${SMALL}/estimate`);
    assert.equal(small.body.suggestCompact, false);
    assert.equal(small.body.sizeBytes, 10 * 1024);
  });

  it("404 for an unknown id and 400 for an id that is not a plain name", async () => {
    assert.equal((await get("/api/claude/conversations/cccccccc-0000-4000-8000-000000000000/estimate")).status, 404);
    assert.equal((await get("/api/claude/conversations/..%2F..%2Fsecret/estimate")).status, 400);
    assert.equal((await get("/api/claude/conversations/.hidden/estimate")).status, 400);
  });
});

describe("agents API with a failing claude", () => {
  let ctx;
  before(async () => { ctx = await boot("fail"); }, { timeout: 30000 });
  after(async () => { await stopProcess(ctx.server.proc); });

  it("from-conversation gives a JSON error and leaves no agent behind", async () => {
    const r = await post("/api/agents/from-conversation", {
      name: "doomed", specialty: "x", sourceConversationId: "abc-123", mode: "fork", cwd: ctx.work,
    });
    assert.ok(r.status >= 400, "status " + r.status);
    assert.equal(typeof r.body.error, "string");
    assert.ok(!r.body.error.includes("    at "));
    assert.deepEqual((await get("/api/agents")).body, []);
  });
});

describe("agents over a read-only tunnel", () => {
  let ctx;
  before(async () => { ctx = await boot(); }, { timeout: 30000 });
  after(async () => { await stopProcess(ctx.server.proc); });

  it("blocks writes under /api/agents and /api/claude/conversations but allows reads", async () => {
    const a = (await post("/api/agents", { name: "kept", specialty: "x", cwd: ctx.work })).body;
    assert.equal((await post("/api/ngrok/settings", { readOnly: true })).status, 200);
    const tunnel = { headers: { "x-forwarded-for": "1.2.3.4" } };
    for (const [fn, p, b] of [
      [post, "/api/agents", { name: "x", specialty: "", cwd: ctx.work }],
      [put, `/api/agents/${a.id}`, { specialty: "y" }],
      [del, `/api/agents/${a.id}`],
      [post, `/api/agents/${a.id}/run`, { prompt: "hi" }],
      [post, `/api/agents/${a.id}/open`, {}],
      [post, "/api/claude/conversations/abc/fork", { cwd: ctx.work }],
    ]) {
      const r = await (b === undefined ? fn(p, tunnel) : fn(p, b, tunnel));
      assert.equal(r.status, 403, p + " -> " + r.status);
    }
    assert.equal((await get("/api/agents", tunnel)).status, 200);
    assert.equal((await get("/api/agents")).body.length, 1);
  });
});
