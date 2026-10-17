// test/unit/claude-linker.test.js — linking sessions to Claude conversations; renaming them; finding their folder
"use strict";
const { describe, it, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { TypedEmitter } = require("../../dist/core/TypedEmitter");
const { ClaudeLinker } = require("../../dist/claude/ClaudeLinker");
const { TranscriptScanner } = require("../../dist/claude/TranscriptScanner");
const { claudePaths } = require("../../dist/claude/paths");

const UUID_A = "11111111-2222-4333-8444-555555555555";
const UUID_B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("ClaudeLinker.resolveLinks", () => {
  it("maps a claude process to the session whose shell it runs under", () => {
    // shell 100 (session 1) -> cmd 200 -> claude 300 ; shell 400 (session 2) -> claude 500
    const parentOf = new Map([[200, 100], [300, 200], [500, 400], [100, 1], [400, 1]]);
    const registry = [{ pid: 300, sessionId: UUID_A, startedAt: 10 }, { pid: 500, sessionId: UUID_B, startedAt: 20 }, { pid: 999, sessionId: "unrelated", startedAt: 30 }];
    const links = ClaudeLinker.resolveLinks(registry, parentOf, new Map([[100, 1], [400, 2]]));
    assert.deepEqual([...links.entries()].sort(), [[1, UUID_A], [2, UUID_B]]);
  });
  it("prefers the most recently started conversation in one terminal", () => {
    const parentOf = new Map([[300, 100], [301, 100]]);
    const registry = [{ pid: 300, sessionId: UUID_A, startedAt: 10 }, { pid: 301, sessionId: UUID_B, startedAt: 50 }];
    assert.equal(ClaudeLinker.resolveLinks(registry, parentOf, new Map([[100, 7]])).get(7), UUID_B);
  });
  it("survives a cycle in the process table", () => {
    assert.equal(ClaudeLinker.resolveLinks([{ pid: 300, sessionId: UUID_A }], new Map([[300, 301], [301, 300]]), new Map([[100, 1]])).size, 0);
  });
});

describe("ClaudeLinker.idFromCommand", () => {
  it("reads session ids from claude command lines", () => {
    assert.equal(ClaudeLinker.idFromCommand(`claude --resume ${UUID_A}`), UUID_A);
    assert.equal(ClaudeLinker.idFromCommand(`claude -r ${UUID_A} --model opus`), UUID_A);
    assert.equal(ClaudeLinker.idFromCommand(`claude --session-id=${UUID_A}`), UUID_A);
    assert.equal(ClaudeLinker.idFromCommand(`claude.exe --resume ${UUID_A.toUpperCase()}`), UUID_A, "ids are lower-cased");
    assert.equal(ClaudeLinker.idFromCommand("claude --continue"), null);
    assert.equal(ClaudeLinker.idFromCommand(`git log ${UUID_A}`), null);
    assert.equal(ClaudeLinker.idFromCommand(`claude --resume not-a-uuid-at-all-xxxxxxxxxxxxxxxxxxxx`), null);
  });
});

function rig({ processes = new Map(), sessions } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenv-l-")); const paths = claudePaths(home);
  fs.mkdirSync(paths.sessions, { recursive: true }); fs.mkdirSync(paths.projects, { recursive: true });
  const bus = new TypedEmitter(); const changed = [];
  bus.on("changed", (s) => changed.push(s.id));
  const list = sessions || [{ id: 1, pty: { pid: 100 }, claudeSessionId: null, claudeRunning: false }];
  const calls = { listProcesses: 0 };
  const linker = new ClaudeLinker({ bus, sessions: { all: () => list }, scanner: new TranscriptScanner(paths.projects), paths, intervalMs: 60000,
    listProcesses: async () => { calls.listProcesses++; return processes; } });
  const register = (pid, sessionId, startedAt = 1) => fs.writeFileSync(path.join(paths.sessions, pid + ".json"), JSON.stringify({ pid, sessionId, startedAt }));
  const transcript = (id, content, dir = "proj") => { const p = path.join(paths.projects, dir, id + ".jsonl"); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); return p; };
  return { bus, linker, list, changed, calls, paths, register, transcript, bus };
}

describe("ClaudeLinker.refresh", () => {
  it("links the session whose shell is an ancestor of the claude process, and reports it running", async () => {
    const r = rig({ processes: new Map([[300, 200], [200, 100]]) }); r.register(300, UUID_A);
    await r.linker.refresh();
    assert.equal(r.list[0].claudeSessionId, UUID_A); assert.equal(r.list[0].claudeRunning, true); assert.deepEqual(r.changed, [1]);
  });
  it("stops reporting running once claude exits, but keeps the link", async () => {
    const r = rig({ processes: new Map([[300, 100]]) }); r.register(300, UUID_A); await r.linker.refresh();
    fs.unlinkSync(path.join(r.paths.sessions, "300.json")); await r.linker.refresh();
    assert.equal(r.list[0].claudeRunning, false); assert.equal(r.list[0].claudeSessionId, UUID_A);
  });
  it("follows a /clear — the same claude process now has a new conversation id", async () => {
    const r = rig({ processes: new Map([[300, 100]]) }); r.register(300, UUID_A); await r.linker.refresh();
    r.register(300, UUID_B); await r.linker.refresh(); assert.equal(r.list[0].claudeSessionId, UUID_B);
  });
  it("looks up the process tree once per claude process, including ones that belong to no session", async () => {
    const r = rig({ processes: new Map([[300, 100]]) }); r.register(300, UUID_A); r.register(999, UUID_B);
    await r.linker.refresh(); await r.linker.refresh(); await r.linker.refresh();
    assert.equal(r.calls.listProcesses, 1);
  });
  it("picks the newest conversation when two run under one terminal", async () => {
    const r = rig({ processes: new Map([[300, 100], [301, 100]]) }); r.register(300, UUID_A, 10); r.register(301, UUID_B, 50);
    await r.linker.refresh(); assert.equal(r.list[0].claudeSessionId, UUID_B);
  });
  it("ignores malformed registry files and a sleeping session (no shell, so never a root)", async () => {
    const r = rig({ processes: new Map([[300, 100]]), sessions: [{ id: 1, pty: null, claudeSessionId: null, claudeRunning: false }] });
    r.register(300, UUID_A); fs.writeFileSync(path.join(r.paths.sessions, "bad.json"), "{nope"); r.register(5, "not-a-uuid"); fs.writeFileSync(path.join(r.paths.sessions, "x.json"), JSON.stringify({ pid: "no", sessionId: UUID_A }));
    await r.linker.refresh(); assert.equal(r.list[0].claudeSessionId, null); assert.equal(r.calls.listProcesses, 0, "no shells → no process listing");
  });
  it("concurrent refreshes share one pass", async () => {
    const r = rig({ processes: new Map([[300, 100]]) }); r.register(300, UUID_A);
    await Promise.all([r.linker.refresh(), r.linker.refresh(), r.linker.refresh()]); assert.equal(r.calls.listProcesses, 1);
  });
  it("works when ~/.claude/sessions does not exist", async () => {
    const r = rig(); fs.rmSync(r.paths.sessions, { recursive: true }); await r.linker.refresh(); assert.equal(r.list[0].claudeSessionId, null);
  });
});

describe("ClaudeLinker command events", () => {
  it("a typed `claude --resume <id>` links immediately, without listing processes", () => {
    const r = rig(); r.linker.start();
    try { r.bus.emit("command", r.list[0], `claude --resume ${UUID_A}`); assert.equal(r.list[0].claudeSessionId, UUID_A); assert.equal(r.calls.listProcesses, 0); }
    finally { r.linker.stop(); }
  });
  it("a plain `claude` checks the registry 3 s and 10 s later; other commands schedule nothing", () => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    try {
      const r = rig(); let refreshes = 0; const orig = r.linker.refresh.bind(r.linker);
      r.linker.refresh = () => { refreshes++; return orig(); };
      r.linker.start();
      r.bus.emit("command", r.list[0], "ls -la"); mock.timers.tick(15000); assert.equal(refreshes, 0);
      r.bus.emit("command", r.list[0], "claude --model opus");
      mock.timers.tick(2999); assert.equal(refreshes, 0);
      mock.timers.tick(1); assert.equal(refreshes, 1, "first check at 3 s");
      mock.timers.tick(6999); assert.equal(refreshes, 1);
      mock.timers.tick(1); assert.equal(refreshes, 2, "second check at 10 s");
      r.linker.stop();
    } finally { mock.timers.reset(); }
  });
  it("stop() unsubscribes", () => {
    const r = rig(); r.linker.start(); r.linker.stop();
    r.bus.emit("command", r.list[0], `claude --resume ${UUID_A}`); assert.equal(r.list[0].claudeSessionId, null);
  });
});

describe("ClaudeLinker conversation files", () => {
  it("renameConversation appends exactly one custom-title record", async () => {
    const r = rig(); const p = r.transcript(UUID_A, JSON.stringify({ type: "user", sessionId: UUID_A }) + "\n");
    assert.equal(await r.linker.renameConversation(UUID_A, "seo audit"), true);
    const lines = fs.readFileSync(p, "utf8").trim().split("\n"); assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[1]), { type: "custom-title", customTitle: "seo audit", sessionId: UUID_A });
  });
  it("starts a new line when the transcript does not end with one, so claude's last line is not corrupted", async () => {
    const r = rig(); const p = r.transcript(UUID_A, JSON.stringify({ type: "user" }));
    await r.linker.renameConversation(UUID_A, "x");
    const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean); assert.equal(lines.length, 2); assert.equal(JSON.parse(lines[0]).type, "user");
  });
  it("finds the transcript in any project folder, and returns false when there is none", async () => {
    const r = rig(); const p = r.transcript(UUID_B, "{}\n", "other-proj");
    assert.equal(await r.linker.renameConversation(UUID_B, "t"), true); assert.ok(fs.readFileSync(p, "utf8").includes("custom-title"));
    assert.equal(await r.linker.renameConversation(UUID_A, "t"), false);
  });
  it("conversationCwd returns the first folder recorded, or null", async () => {
    const r = rig(); r.transcript(UUID_A, JSON.stringify({ type: "x" }) + "\n" + JSON.stringify({ cwd: "C:\\proj" }) + "\n" + JSON.stringify({ cwd: "D:\\later" }) + "\n");
    r.transcript(UUID_B, JSON.stringify({ type: "x" }) + "\n");
    assert.equal(await r.linker.conversationCwd(UUID_A), "C:\\proj"); assert.equal(await r.linker.conversationCwd(UUID_B), null);
    assert.equal(await r.linker.conversationCwd("00000000-0000-4000-8000-000000000000"), null);
  });
});
