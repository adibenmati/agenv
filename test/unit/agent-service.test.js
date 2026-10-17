// test/unit/agent-service.test.js — AgentService against the fake claude and a fake session manager
"use strict";
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { Crypto } = require("../../dist/core/Crypto");
const { JsonStore } = require("../../dist/core/JsonStore");
const { HttpError } = require("../../dist/core/HttpError");
const { AgentStore } = require("../../dist/agents/AgentStore");
const { ClaudeRunner } = require("../../dist/agents/ClaudeRunner");
const { ConversationForker } = require("../../dist/agents/ConversationForker");
const { AgentService } = require("../../dist/agents/AgentService");
const { TrackedRunner } = require("../../dist/agents/TrackedRunner");

const FAKE = path.join(__dirname, "..", "fixtures", "fake-claude-cli.js");
const tmp = [];
const mkdir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "agenv-as-")); tmp.push(d); return d; };
afterEach(() => { while (tmp.length) fs.rmSync(tmp.pop(), { recursive: true, force: true }); });

function rig(mode = "ok", over = {}) {
  const dir = mkdir(), state = mkdir(), cwd = mkdir();
  const isDir = over.isDir || ((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
  const js = new JsonStore({ path: path.join(dir, "agents.enc"), crypto: new Crypto(path.join(dir, "key")), fallback: () => [] });
  const store = new AgentStore(js, isDir);
  const runner = new TrackedRunner(new ClaudeRunner({ bin: FAKE, env: { FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_STATE: state } }));
  const created = [];
  const list = over.sessions || [];
  const sessions = { create: (o) => { created.push(o); return { id: created.length, ...o }; }, get: (id) => list.find((s) => s.id === id), all: () => list };
  const svc = new AgentService({ store, forker: new ConversationForker({ runner }), runner, sessions, isDir });
  return { svc, store, state, cwd, created, list, runner };
}
const calls = (state) => { const f = path.join(state, "calls.jsonl"); return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []; };
const withSource = (state, id = "src-1") => {
  fs.mkdirSync(path.join(state, "transcripts"), { recursive: true });
  fs.writeFileSync(path.join(state, "transcripts", id + ".jsonl"), '{"type":"user","message":"old"}\n');
};
const input = (cwd, o = {}) => ({ name: "Bob", specialty: "reviews code", cwd, ...o });
const conv = (r, o = {}) => ({ name: "Bob", specialty: "reviews code", sourceConversationId: "src-1", cwd: r.cwd, mode: "fork", ...o });
const events = (state) => { const f = path.join(state, "events.jsonl"); return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []; };
const until = async (fn) => { for (let i = 0; i < 400; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 25)); } assert.fail("timed out waiting"); };

describe("AgentService creation", () => {
  it("createBlank stores origin blank with empty conversationId", () => {
    const r = rig(); const a = r.svc.createBlank(input(r.cwd));
    assert.deepEqual(a.origin, { kind: "blank" }); assert.equal(a.conversationId, "");
  });
  it("createFromSession binds the session's claudeSessionId and folder and makes no claude call", () => {
    const r = rig("ok", { sessions: [{ id: 3, cwd: undefined, claudeSessionId: "conv-9" }] });
    r.list[0].cwd = r.cwd;
    const a = r.svc.createFromSession({ sessionId: 3, name: "Bob", specialty: "x" });
    assert.equal(a.conversationId, "conv-9"); assert.equal(a.cwd, r.cwd);
    assert.equal(calls(r.state).length, 0);
  });
  it("createFromSession rejects a session with no linked conversation (409) and an unknown one (404)", () => {
    const r = rig("ok", { sessions: [{ id: 3, cwd: "x", claudeSessionId: null }] });
    assert.throws(() => r.svc.createFromSession({ sessionId: 3, name: "Bob", specialty: "x" }), (e) => e instanceof HttpError && e.status === 409);
    assert.throws(() => r.svc.createFromSession({ sessionId: 99, name: "Bob", specialty: "x" }), (e) => e instanceof HttpError && e.status === 404);
    assert.equal(r.store.list().length, 0);
  });
  it("createFromConversation fork stores the new id and origin fork", async () => {
    const r = rig(); withSource(r.state);
    const a = await r.svc.createFromConversation(conv(r));
    assert.match(a.conversationId, /^[0-9a-f-]{36}$/); assert.notEqual(a.conversationId, "src-1");
    assert.deepEqual(a.origin, { kind: "fork", sourceConversationId: "src-1", compacted: false });
    const argv = calls(r.state)[0].argv;
    assert.equal(argv.at(-1), "From now on you are the Bob agent: reviews code. Reply only OK.");
  });
  it("fork-compact marks compacted true", async () => {
    const r = rig(); withSource(r.state);
    const a = await r.svc.createFromConversation(conv(r, { mode: "fork-compact" }));
    assert.equal(a.origin.compacted, true); assert.equal(calls(r.state).length, 2);
  });
  it("distill modes store briefingFile / leave conversationId empty and origin distilled", async () => {
    const r = rig(); withSource(r.state);
    const b = await r.svc.createFromConversation(conv(r, { mode: "distill-briefing" }));
    assert.equal(b.briefingFile, path.join(r.cwd, ".claude", "agenv-briefings", "Bob.md"));
    assert.ok(fs.existsSync(b.briefingFile)); assert.equal(b.conversationId, "");
    assert.deepEqual(b.origin, { kind: "distilled", sourceConversationId: "src-1", artifact: "briefing" });
    const s = await r.svc.createFromConversation(conv(r, { mode: "distill-skill", name: "Sue" }));
    assert.equal(s.briefingFile, ""); assert.equal(s.conversationId, "");
    assert.equal(s.origin.artifact, "skill");
    assert.ok(fs.existsSync(path.join(r.cwd, ".claude", "skills", "Sue", "SKILL.md")));
  });
  it("failed creation leaves the store empty", async () => {
    for (const mode of ["fork", "fork-compact", "distill-briefing"]) {
      const r = rig("fail"); withSource(r.state);
      await assert.rejects(r.svc.createFromConversation(conv(r, { mode })), HttpError);
      assert.equal(r.store.list().length, 0, mode);
    }
    const r = rig(); withSource(r.state); r.svc.createBlank(input(r.cwd));
    await assert.rejects(r.svc.createFromConversation(conv(r)), (e) => e.status === 409);
    assert.equal(r.store.list().length, 1); assert.equal(calls(r.state).length, 0);
  });
  it("duplicate copies the profile as name-copy, forks the conversation, origin duplicate", async () => {
    const r = rig(); withSource(r.state);
    const src = r.svc.createBlank(input(r.cwd, { instructions: "be terse", model: "opus" }));
    r.store.update(src.id, { conversationId: "src-1" });
    const d = await r.svc.duplicate(src.id);
    assert.equal(d.name, "Bob-copy"); assert.equal(d.instructions, "be terse"); assert.equal(d.model, "opus");
    assert.deepEqual(d.origin, { kind: "duplicate", sourceAgentId: src.id });
    assert.notEqual(d.conversationId, "src-1"); assert.ok(d.conversationId);
    const argv = calls(r.state)[0].argv;
    assert.equal(argv[argv.indexOf("--resume") + 1], "src-1"); assert.ok(argv.includes("--fork-session"));
    assert.equal((await r.svc.duplicate(src.id)).name, "Bob-copy-2");
  });
});

describe("AgentService source id validation", () => {
  it("createFromConversation refuses a source id that looks like a flag (400) before any claude call", async () => {
    for (const mode of ["fork", "fork-compact", "distill-briefing", "distill-skill"]) {
      const r = rig();
      await assert.rejects(r.svc.createFromConversation(conv(r, { mode, sourceConversationId: '--settings={"hooks":1}' })), (e) => e instanceof HttpError && e.status === 400, mode);
      assert.equal(calls(r.state).length, 0); assert.equal(r.store.list().length, 0);
    }
  });
  it("AgentStore.add refuses a conversation id that is not plain", () => {
    const r = rig();
    assert.throws(() => r.store.add(input(r.cwd), { kind: "blank" }, "--settings=x"), (e) => e.status === 400);
    assert.equal(r.store.list().length, 0);
  });
});

describe("AgentService.cancelAll reaches creation runs", () => {
  it("cancelAll during a slow fork cancels it", async () => {
    const r = rig("hang"); withSource(r.state);
    const p = r.svc.createFromConversation(conv(r));
    await until(() => events(r.state).length > 0);
    r.svc.cancelAll();
    await assert.rejects(p, (e) => e instanceof HttpError && /ancel/.test(e.message));
    assert.equal(r.store.list().length, 0);
  });
});

describe("AgentService terminals", () => {
  it('openTerminal creates a session in agent.cwd that runs "claude --resume <id>"', () => {
    const r = rig(); const a = r.svc.createBlank(input(r.cwd)); r.store.update(a.id, { conversationId: "c-1" });
    r.svc.openTerminal(a.id);
    assert.deepEqual(r.created, [{ cwd: r.cwd, name: "Bob", runCommand: "claude --resume c-1" }]);
  });
  it("openTerminal on a blank agent binds a fresh conversation: --session-id <uuid>, stored, then --resume", () => {
    const r = rig(); const a = r.svc.createBlank(input(r.cwd));
    r.svc.openTerminal(a.id);
    const m = /^claude --session-id ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(r.created[0].runCommand);
    assert.ok(m, r.created[0].runCommand);
    assert.equal(r.store.get(a.id).conversationId, m[1]);
    r.svc.openTerminal(a.id);
    assert.equal(r.created[1].runCommand, `claude --resume ${m[1]}`);
  });
  it("openTerminal adds the briefing as a cwd-relative --append-system-prompt-file when it exists inside the folder", () => {
    const r = rig(); const f = path.join(r.cwd, ".claude", "agenv-briefings", "Bob.md");
    fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, "hi");
    const a = r.svc.createBlank(input(r.cwd, { briefingFile: f }));
    r.svc.openTerminal(a.id);
    assert.match(r.created[0].runCommand, /^claude --session-id [0-9a-f-]{36} --append-system-prompt-file \.claude\/agenv-briefings\/Bob\.md$/);
    r.svc.openTerminal(a.id);
    assert.match(r.created[1].runCommand, /^claude --resume [0-9a-f-]{36} --append-system-prompt-file \.claude\/agenv-briefings\/Bob\.md$/);
  });
  it("openTerminal omits a briefing that is missing, outside the folder or has an unsafe path (and does not fail)", () => {
    const r = rig();
    const missing = r.svc.createBlank(input(r.cwd, { name: "m1", briefingFile: path.join(r.cwd, "nope.md") }));
    const outside = path.join(mkdir(), "o.md"); fs.writeFileSync(outside, "x");
    const out = r.svc.createBlank(input(r.cwd, { name: "m2", briefingFile: outside }));
    const odd = path.join(r.cwd, "has space & more.md"); fs.writeFileSync(odd, "x");
    const unsafe = r.svc.createBlank(input(r.cwd, { name: "m3", briefingFile: odd }));
    for (const a of [missing, out, unsafe]) r.svc.openTerminal(a.id);
    for (const c of r.created) assert.match(c.runCommand, /^claude --session-id [0-9a-f-]{36}$/);
  });
  it("openTerminal refuses a conversation id that is not plain", () => {
    const r = rig(); const a = r.svc.createBlank(input(r.cwd)); r.store.get = () => ({ ...a, conversationId: "x & calc" });   // a corrupt stored value; the store itself now refuses to write one
    assert.throws(() => r.svc.openTerminal(a.id), (e) => e.status === 400); assert.equal(r.created.length, 0);
  });
  it("forkConversationTerminal refuses ids that look like flags", () => {
    const r = rig(); assert.throws(() => r.svc.forkConversationTerminal("--foo", r.cwd), (e) => e.status === 400); assert.equal(r.created.length, 0);
  });
  it('forkConversationTerminal runs "claude --resume <id> --fork-session"', () => {
    const r = rig(); r.svc.forkConversationTerminal("c-2", r.cwd);
    assert.equal(r.created[0].runCommand, "claude --resume c-2 --fork-session"); assert.equal(r.created[0].cwd, r.cwd);
  });
});

describe("AgentService.run", () => {
  it("refuses when cwd is gone and spawns nothing", async () => {
    let ok = true; const r = rig("ok", { isDir: () => ok });
    const a = r.svc.createBlank(input(r.cwd)); ok = false;
    await assert.rejects(r.svc.run(a.id, "hi"), (e) => e.status === 409);
    assert.equal(calls(r.state).length, 0);
  });
  it("refuses with a reason while a session linked to the conversation has claudeRunning", async () => {
    const r = rig("ok", { sessions: [{ id: 1, claudeSessionId: "c-1", claudeRunning: true }] });
    const a = r.svc.createBlank(input(r.cwd)); r.store.update(a.id, { conversationId: "c-1" });
    await assert.rejects(r.svc.run(a.id, "hi"), (e) => e.status === 409 && /terminal/.test(e.message));
    assert.equal(calls(r.state).length, 0);
    r.list[0].claudeRunning = false;
    assert.equal((await r.svc.run(a.id, "hi")).status, "succeeded");
  });
  it("first run stores session_id as conversationId and lastRunAt", async () => {
    const r = rig(); const a = r.svc.createBlank(input(r.cwd));
    const res = await r.svc.run(a.id, "hello");
    assert.equal(res.status, "succeeded");
    const cur = r.store.get(a.id);
    assert.equal(cur.conversationId, res.conversationId); assert.ok(res.conversationId);
    assert.equal(typeof cur.lastRunAt, "number");
    await r.svc.run(a.id, "again");
    const argv = calls(r.state)[1].argv;
    assert.equal(argv[argv.indexOf("--resume") + 1], res.conversationId);
  });
  it("run builds args from instructions, briefingFile, addDirs, mcpConfig, model, permission", async () => {
    const r = rig(); const extra = mkdir();
    const a = r.svc.createBlank(input(r.cwd, {
      instructions: "be terse", briefingFile: path.join(r.cwd, "b.md"), addDirs: [extra], mcpConfig: "m.json", model: "opus",
      permission: { mode: "dontAsk", allowedTools: ["Read", "Bash(ls)"] },
    }));
    await r.svc.run(a.id, "-x go", { maxBudgetUsd: 3 });
    const c = calls(r.state)[0], v = c.argv, at = (f) => v[v.indexOf(f) + 1];
    assert.equal(c.cwd, fs.realpathSync(r.cwd));
    assert.equal(at("--append-system-prompt"), "be terse"); assert.equal(at("--append-system-prompt-file"), path.join(r.cwd, "b.md"));
    assert.equal(at("--add-dir"), extra); assert.equal(at("--mcp-config"), "m.json"); assert.equal(at("--model"), "opus");
    assert.equal(at("--permission-mode"), "dontAsk"); assert.equal(at("--allowedTools"), "Read,Bash(ls)");
    assert.equal(at("--max-budget-usd"), "3"); assert.equal(v.at(-1), "-x go");
  });
  it("runs of one agent never overlap, even when the first run binds the conversation", async () => {
    const r = rig("slow"); const a = r.svc.createBlank(input(r.cwd));
    const pA = r.svc.run(a.id, "A"), pB = r.svc.run(a.id, "B");
    await pA;                                     // B is now running
    await until(() => events(r.state).some((e) => e.prompt === "B"));
    const pC = r.svc.run(a.id, "C");              // conversation id is bound now
    await Promise.all([pB, pC]);
    const ev = events(r.state);
    assert.deepEqual(ev.map((e) => e.ev + e.prompt), ["startA", "endA", "startB", "endB", "startC", "endC"]);
    assert.equal(r.svc.pendingRuns(), 0);
  });
  it("two agents sharing one conversation do not overlap", async () => {
    const r = rig("slow");
    const a = r.svc.createBlank(input(r.cwd)), b = r.svc.createBlank(input(r.cwd, { name: "Sue" }));
    r.store.update(a.id, { conversationId: "c-1" }); r.store.update(b.id, { conversationId: "c-1" });
    await Promise.all([r.svc.run(a.id, "A"), r.svc.run(b.id, "B")]);
    assert.deepEqual(events(r.state).map((e) => e.ev + e.prompt), ["startA", "endA", "startB", "endB"]);
  });
  it("a failed earlier run does not block the next, and the queue drains", async () => {
    const r = rig("fail"); const a = r.svc.createBlank(input(r.cwd));
    const p1 = r.svc.run(a.id, "one"), p2 = r.svc.run(a.id, "two");
    assert.equal((await p1).status, "failed"); assert.equal((await p2).status, "failed");
    assert.equal(calls(r.state).length, 2);
    await until(() => r.svc.pendingRuns() === 0);
  });
  it("a failed first run does not bind a conversation but still records lastRunAt", async () => {
    const r = rig("fail"); const a = r.svc.createBlank(input(r.cwd));
    await r.svc.run(a.id, "x");
    const cur = r.store.get(a.id); assert.equal(cur.conversationId, ""); assert.equal(typeof cur.lastRunAt, "number");
  });
  it("a later successful run returning a different session_id rebinds the agent; a failed run never changes it", async () => {
    const r = rig(); const a = r.svc.createBlank(input(r.cwd));
    const first = await r.svc.run(a.id, "one");
    const mk = (mode, env = {}) => { const rn = new ClaudeRunner({ bin: FAKE, env: { FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_STATE: r.state, ...env } });
      return new AgentService({ store: r.store, forker: new ConversationForker({ runner: rn }), runner: rn, sessions: { create() {}, get() {}, all: () => [] }, isDir: () => true }); };
    const second = await mk("ok", { FAKE_CLAUDE_NEWID: "1" }).run(a.id, "two");
    assert.notEqual(second.conversationId, first.conversationId);
    assert.equal(r.store.get(a.id).conversationId, second.conversationId);
    const failed = await mk("fail", { FAKE_CLAUDE_NEWID: "1" }).run(a.id, "three");
    assert.equal(failed.status, "failed");
    assert.equal(r.store.get(a.id).conversationId, second.conversationId);
  });
  it("cancelAll cancels a running run and stops queued ones from spawning", async () => {
    const r = rig("hang"); const a = r.svc.createBlank(input(r.cwd));
    const p = r.svc.run(a.id, "x"), q = r.svc.run(a.id, "y");
    await until(() => events(r.state).length > 0);
    r.svc.cancelAll();
    assert.equal((await p).status, "cancelled");
    assert.equal((await q).status, "cancelled");
    assert.equal(calls(r.state).length, 1);
  });
});

describe("AgentService.remove", () => {
  it("remove does not touch the conversation", async () => {
    const r = rig(); withSource(r.state);
    const a = await r.svc.createFromConversation(conv(r));
    const t = path.join(r.state, "transcripts", a.conversationId + ".jsonl");
    r.svc.remove(a.id);
    assert.equal(r.store.list().length, 0); assert.ok(fs.existsSync(t));
    assert.equal(calls(r.state).length, 1);
  });
});
