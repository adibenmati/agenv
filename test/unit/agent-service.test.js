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
  const svc = new AgentService({ store, forker: new ConversationForker({ runner }), runner, sessions, isDir, projectsDir: over.projectsDir || state });   // the fake keeps transcripts in <state>/transcripts, which then looks like a project folder
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

describe("AgentService conversations without a transcript", () => {
  const UUID = "11111111-2222-3333-4444-555555555555";
  const withTranscript = (proj, id) => { fs.mkdirSync(path.join(proj, "p"), { recursive: true }); fs.writeFileSync(path.join(proj, "p", id + ".jsonl"), "{}"); };
  it("openTerminal: stored id without a transcript starts it again with --session-id (same id)", () => {
    const proj = mkdir(); const r = rig("ok", { projectsDir: proj });
    const a = r.svc.createBlank(input(r.cwd)); r.store.update(a.id, { conversationId: UUID });
    r.svc.openTerminal(a.id);
    assert.equal(r.created[0].runCommand, `claude --session-id ${UUID}`);
    assert.equal(r.store.get(a.id).conversationId, UUID);
  });
  it("openTerminal: stored id with a transcript resumes", () => {
    const proj = mkdir(); withTranscript(proj, UUID); const r = rig("ok", { projectsDir: proj });
    const a = r.svc.createBlank(input(r.cwd)); r.store.update(a.id, { conversationId: UUID });
    r.svc.openTerminal(a.id);
    assert.equal(r.created[0].runCommand, `claude --resume ${UUID}`);
  });
  it("run: stored id without a transcript runs fresh (no --resume) and binds the id the run returns", async () => {
    const proj = mkdir(); const r = rig("ok", { projectsDir: proj });
    const a = r.svc.createBlank(input(r.cwd)); r.store.update(a.id, { conversationId: UUID });
    const res = await r.svc.run(a.id, "hi");
    assert.equal(res.status, "succeeded");
    assert.ok(!calls(r.state)[0].argv.includes("--resume"));
    assert.ok(res.conversationId && res.conversationId !== UUID);
    assert.equal(r.store.get(a.id).conversationId, res.conversationId);
  });
  it("run: stored id with a transcript resumes it", async () => {
    const proj = mkdir(); withTranscript(proj, UUID); const r = rig("ok", { projectsDir: proj });
    const a = r.svc.createBlank(input(r.cwd)); r.store.update(a.id, { conversationId: UUID });
    await r.svc.run(a.id, "hi");
    const argv = calls(r.state)[0].argv;
    assert.equal(argv[argv.indexOf("--resume") + 1], UUID);
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
    withSource(r.state, m[1]);   // claude wrote the transcript
    r.svc.openTerminal(a.id);
    assert.equal(r.created[1].runCommand, `claude --resume ${m[1]}`);
  });
  it("openTerminal adds the briefing as a cwd-relative --append-system-prompt-file when it exists inside the folder", () => {
    const r = rig(); const f = path.join(r.cwd, ".claude", "agenv-briefings", "Bob.md");
    fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, "hi");
    const a = r.svc.createBlank(input(r.cwd, { briefingFile: f }));
    r.svc.openTerminal(a.id);
    assert.match(r.created[0].runCommand, /^claude --session-id [0-9a-f-]{36} --append-system-prompt-file \.claude\/agenv-briefings\/Bob\.md$/);
    withSource(r.state, r.store.get(a.id).conversationId);
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

describe("AgentService conversation modes and overrides", () => {
  const argAt = (argv, f) => argv[argv.indexOf(f) + 1];
  const bound = (r, conv = "c-1", o = {}) => { withSource(r.state, conv); const a = r.svc.createBlank(input(r.cwd, o)); r.store.update(a.id, { conversationId: conv }); return a; };

  it("conversation fork resumes with --fork-session and leaves the agent's conversationId unchanged", async () => {
    const r = rig(); const a = bound(r);
    const res = await r.svc.run(a.id, "hi", { conversation: "fork" });
    assert.equal(res.status, "succeeded");
    const argv = calls(r.state)[0].argv;
    assert.equal(argAt(argv, "--resume"), "c-1"); assert.ok(argv.includes("--fork-session"));
    assert.ok(res.conversationId && res.conversationId !== "c-1");
    const cur = r.store.get(a.id);
    assert.equal(cur.conversationId, "c-1"); assert.equal(typeof cur.lastRunAt, "number");
  });
  it("conversation fork on an agent with no conversation, or one without a transcript, runs fresh", async () => {
    const r = rig(); const blank = r.svc.createBlank(input(r.cwd));
    const res = await r.svc.run(blank.id, "hi", { conversation: "fork" });
    assert.equal(res.status, "succeeded");
    assert.ok(!calls(r.state)[0].argv.includes("--resume")); assert.ok(!calls(r.state)[0].argv.includes("--fork-session"));
    assert.equal(r.store.get(blank.id).conversationId, "");
    const ghost = r.svc.createBlank(input(r.cwd, { name: "Ghost" })); r.store.update(ghost.id, { conversationId: "no-transcript" });
    await r.svc.run(ghost.id, "hi", { conversation: "fork" });
    const argv = calls(r.state)[1].argv;
    assert.ok(!argv.includes("--resume")); assert.ok(!argv.includes("--fork-session"));
    assert.equal(r.store.get(ghost.id).conversationId, "no-transcript");
  });
  it("conversation fresh runs without --resume and does not rebind", async () => {
    const r = rig(); const a = bound(r);
    const res = await r.svc.run(a.id, "hi", { conversation: "fresh" });
    assert.equal(res.status, "succeeded");
    assert.ok(!calls(r.state)[0].argv.includes("--resume"));
    assert.ok(res.conversationId && res.conversationId !== "c-1");
    assert.equal(r.store.get(a.id).conversationId, "c-1");
    const blank = r.svc.createBlank(input(r.cwd, { name: "Sue" }));
    await r.svc.run(blank.id, "hi", { conversation: "fresh" });
    assert.equal(r.store.get(blank.id).conversationId, ""); assert.equal(typeof r.store.get(blank.id).lastRunAt, "number");
  });
  it("conversation agent (explicit) still resumes and rebinds", async () => {
    const r = rig(); const a = r.svc.createBlank(input(r.cwd));
    const first = await r.svc.run(a.id, "one", { conversation: "agent" });
    assert.equal(r.store.get(a.id).conversationId, first.conversationId);
  });
  it("permission and model overrides reach argv for that run only", async () => {
    const r = rig(); const a = r.svc.createBlank(input(r.cwd, { model: "opus", permission: { mode: "acceptEdits", allowedTools: [] } }));
    await r.svc.run(a.id, "one", { permission: { mode: "dontAsk", allowedTools: ["Read"] }, model: "haiku" });
    await r.svc.run(a.id, "two");
    const [one, two] = calls(r.state).map((c) => c.argv);
    assert.equal(argAt(one, "--permission-mode"), "dontAsk"); assert.equal(argAt(one, "--allowedTools"), "Read"); assert.equal(argAt(one, "--model"), "haiku");
    assert.equal(argAt(two, "--permission-mode"), "acceptEdits"); assert.ok(!two.includes("--allowedTools")); assert.equal(argAt(two, "--model"), "opus");
    assert.equal(r.store.get(a.id).model, "opus"); assert.equal(r.store.get(a.id).permission.mode, "acceptEdits");
  });
  it("fork run waits for a running agent run (no overlap, ordering from events.jsonl)", async () => {
    const r = rig("slow"); const a = bound(r);
    const pA = r.svc.run(a.id, "A"), pF = r.svc.run(a.id, "F", { conversation: "fork" });
    await Promise.all([pA, pF]);
    assert.deepEqual(events(r.state).map((e) => e.ev + e.prompt), ["startA", "endA", "startF", "endF"]);
    assert.equal(r.svc.pendingRuns(), 0);
  });
  it("fork run also waits for another agent's run on the same conversation", async () => {
    const r = rig("slow"); const a = bound(r);
    const b = r.svc.createBlank(input(r.cwd, { name: "Sue" })); r.store.update(b.id, { conversationId: "c-1" });
    await Promise.all([r.svc.run(a.id, "A"), r.svc.run(b.id, "F", { conversation: "fork" })]);
    assert.deepEqual(events(r.state).map((e) => e.ev + e.prompt), ["startA", "endA", "startF", "endF"]);
  });
  it("fresh run waits for the same agent's other runs", async () => {
    const r = rig("slow"); const a = bound(r);
    await Promise.all([r.svc.run(a.id, "A"), r.svc.run(a.id, "X", { conversation: "fresh" })]);
    assert.deepEqual(events(r.state).map((e) => e.ev + e.prompt), ["startA", "endA", "startX", "endX"]);
  });
  it("fork refuses with 409 while the source conversation is open in a running terminal; fresh does not", async () => {
    const r = rig("ok", { sessions: [{ id: 1, claudeSessionId: "c-1", claudeRunning: true }] }); const a = bound(r);
    await assert.rejects(r.svc.run(a.id, "hi", { conversation: "fork" }), (e) => e instanceof HttpError && e.status === 409 && /terminal/.test(e.message));
    assert.equal(calls(r.state).length, 0);
    assert.equal((await r.svc.run(a.id, "hi", { conversation: "fresh" })).status, "succeeded");
  });
  it("a failed fork never reports the source conversation as its own", async () => {
    const r = rig("fail"); const a = bound(r);
    const res = await r.svc.run(a.id, "hi", { conversation: "fork" });
    assert.equal(res.status, "failed"); assert.equal(res.conversationId, "");
    assert.equal(r.store.get(a.id).conversationId, "c-1");
  });
  it("fork and fresh runs queued before cancelAll do not spawn", async () => {
    const r = rig("hang"); const a = bound(r);
    const p = r.svc.run(a.id, "x", { conversation: "fork" }), q = r.svc.run(a.id, "y", { conversation: "fresh" });
    await until(() => events(r.state).length > 0);
    r.svc.cancelAll();
    assert.equal((await p).status, "cancelled"); assert.equal((await q).status, "cancelled");
    assert.equal(calls(r.state).length, 1);
  });
});

describe("AgentService.runInFolder", () => {
  const spec = (o = {}) => ({ permission: { mode: "plan", allowedTools: [] }, maxBudgetUsd: 1.5, timeoutMs: 60000, ...o });
  const argAt = (argv, f) => argv[argv.indexOf(f) + 1];
  it("runs in that cwd with the spec's permission, model and budget, without resume", async () => {
    const r = rig(); const log = path.join(mkdir(), "run.log");
    const res = await r.svc.runInFolder(r.cwd, "-x go", spec({ model: "haiku", logPath: log }));
    assert.equal(res.status, "succeeded"); assert.ok(res.conversationId);
    const c = calls(r.state)[0];
    assert.equal(c.cwd, fs.realpathSync(r.cwd));
    assert.equal(argAt(c.argv, "--permission-mode"), "plan"); assert.equal(argAt(c.argv, "--model"), "haiku");
    assert.equal(argAt(c.argv, "--max-budget-usd"), "1.5"); assert.ok(!c.argv.includes("--resume")); assert.equal(c.argv.at(-1), "-x go");
    assert.ok(fs.existsSync(log));
  });
  it("rejects a missing folder with 409 and an empty prompt with 400, spawning nothing", async () => {
    const r = rig();
    await assert.rejects(r.svc.runInFolder(path.join(r.cwd, "gone"), "hi", spec()), (e) => e instanceof HttpError && e.status === 409);
    await assert.rejects(r.svc.runInFolder(r.cwd, "  ", spec()), (e) => e instanceof HttpError && e.status === 400);
    assert.equal(calls(r.state).length, 0);
  });
  it("a relative folder is a 400 (it would resolve against the server's working directory)", async () => {
    const r = rig();
    for (const rel of ["sub", ".", "./x", "../x"]) {
      await assert.rejects(r.svc.runInFolder(rel, "hi", spec()), (e) => e instanceof HttpError && e.status === 400 && /absolute/.test(e.message), rel);
    }
    assert.equal(calls(r.state).length, 0);
  });
  it("serialises runs of one folder (ordering from events.jsonl) and drains the chain", async () => {
    const r = rig("slow");
    await Promise.all([r.svc.runInFolder(r.cwd, "A", spec()), r.svc.runInFolder(path.join(r.cwd, "."), "B", spec())]);
    assert.deepEqual(events(r.state).map((e) => e.ev + e.prompt), ["startA", "endA", "startB", "endB"]);
    await until(() => r.svc.pendingRuns() === 0);
  });
  it("runs in different folders do not wait for each other", async () => {
    const r = rig("slow"); const other = mkdir();
    await Promise.all([r.svc.runInFolder(r.cwd, "A", spec()), r.svc.runInFolder(other, "B", spec())]);
    assert.deepEqual(events(r.state).map((e) => e.ev), ["start", "start", "end", "end"]);
  });
  it("a failed folder run does not block the next", async () => {
    const r = rig("fail");
    const p = r.svc.runInFolder(r.cwd, "one", spec()), q = r.svc.runInFolder(r.cwd, "two", spec());
    assert.equal((await p).status, "failed"); assert.equal((await q).status, "failed");
    assert.equal(calls(r.state).length, 2);
  });
  it("cancelAll cancels a folder run and queued folder runs do not spawn", async () => {
    const r = rig("hang");
    const p = r.svc.runInFolder(r.cwd, "x", spec()), q = r.svc.runInFolder(r.cwd, "y", spec());
    await until(() => events(r.state).length > 0);
    r.svc.cancelAll();
    assert.equal((await p).status, "cancelled"); assert.equal((await q).status, "cancelled");
    assert.equal(calls(r.state).length, 1);
  });
});

describe("AgentService.openConversation and isConversationBusy", () => {
  it('openConversation builds "claude --resume <id>" in the folder and rejects an unsafe id (400)', () => {
    const r = rig();
    r.svc.openConversation("c-3", r.cwd);
    assert.deepEqual(r.created, [{ cwd: r.cwd, name: "", runCommand: "claude --resume c-3" }]);
    for (const bad of ["--foo", "x & calc", ""]) assert.throws(() => r.svc.openConversation(bad, r.cwd), (e) => e instanceof HttpError && e.status === 400, bad);
    assert.throws(() => r.svc.openConversation("c-3", path.join(r.cwd, "gone")), (e) => e.status === 400);
    assert.equal(r.created.length, 1);
  });
  it("isConversationBusy reflects a running terminal session", () => {
    const r = rig("ok", { sessions: [{ id: 1, claudeSessionId: "c-1", claudeRunning: true }] });
    assert.equal(r.svc.isConversationBusy("c-1"), true); assert.equal(r.svc.isConversationBusy("c-2"), false);
    r.list[0].claudeRunning = false; assert.equal(r.svc.isConversationBusy("c-1"), false);
  });
});

describe("AgentService per-run cancellation (cancelToken and onHandle)", () => {
  const spec = (o = {}) => ({ permission: { mode: "plan", allowedTools: [] }, maxBudgetUsd: 1.5, timeoutMs: 60000, ...o });
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  it("onHandle gets a cancel function as the process starts; calling it cancels only that run", async () => {
    const r = rig("hang"); const a = r.svc.createBlank(input(r.cwd));
    let cancel = null;
    const p = r.svc.run(a.id, "x", { onHandle: (c) => { cancel = c; } });
    await until(() => cancel !== null && events(r.state).length > 0);
    assert.equal(typeof cancel, "function");
    cancel();
    assert.equal((await p).status, "cancelled");
    assert.equal(calls(r.state).length, 1);
  });
  it("cancelling one run leaves a concurrent run of another agent alone", async () => {
    const r = rig("slow"); const a = r.svc.createBlank(input(r.cwd)); const b = r.svc.createBlank(input(mkdir(), { name: "Sue" }));
    let cancelA = null;
    const pa = r.svc.run(a.id, "A", { onHandle: (c) => { cancelA = c; } });
    const pb = r.svc.run(b.id, "B");
    await until(() => cancelA !== null && events(r.state).length >= 2);
    cancelA();
    assert.equal((await pa).status, "cancelled");
    assert.equal((await pb).status, "succeeded");
  });
  it("a run whose cancelToken is set while it waits in the queue resolves cancelled without spawning", async () => {
    const r = rig("slow"); const a = r.svc.createBlank(input(r.cwd));
    const token = { cancelled: false };
    const p = r.svc.run(a.id, "first"), q = r.svc.run(a.id, "second", { cancelToken: token });
    token.cancelled = true;
    assert.equal((await p).status, "succeeded");
    const res = await q;
    assert.equal(res.status, "cancelled");
    assert.equal(calls(r.state).length, 1);
  });
  it("a token already cancelled never spawns, for agent and folder runs", async () => {
    const r = rig(); const a = r.svc.createBlank(input(r.cwd));
    assert.equal((await r.svc.run(a.id, "x", { cancelToken: { cancelled: true } })).status, "cancelled");
    assert.equal((await r.svc.runInFolder(r.cwd, "x", spec({ cancelToken: { cancelled: true } }))).status, "cancelled");
    assert.equal(calls(r.state).length, 0);
  });
  it("runInFolder reports a cancel handle and cancelling it kills the process tree", async () => {
    const r = rig("hang"); let cancel = null;
    const p = r.svc.runInFolder(r.cwd, "x", spec({ onHandle: (c) => { cancel = c; } }));
    await until(() => cancel !== null && fs.existsSync(path.join(r.state, "child.pid")));
    const child = Number(fs.readFileSync(path.join(r.state, "child.pid"), "utf8"));
    assert.ok(alive(child));
    cancel();
    assert.equal((await p).status, "cancelled");
    await until(() => !alive(child));
  });
  it("an onHandle that throws does not break the run", async () => {
    const r = rig(); const a = r.svc.createBlank(input(r.cwd));
    const res = await r.svc.run(a.id, "x", { onHandle: () => { throw new Error("boom"); } });
    assert.equal(res.status, "succeeded");
  });
});
