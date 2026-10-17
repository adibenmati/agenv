// test/claude-link.test.js — linking agenv sessions to Claude Code conversations
"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { startServer, stopProcess, makeTempHome, get, post, put, del } = require("./helpers");
const { ClaudeLinker } = require("../dist/claude/ClaudeLinker");

const UUID_A = "11111111-2222-4333-8444-555555555555";
const UUID_B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const findSession = async (id) => (await get("/api/sessions")).body.find((s) => s.id === id);

describe("resolveClaudeLinks", () => {
  const resolveClaudeLinks = ClaudeLinker.resolveLinks, claudeIdFromCommand = ClaudeLinker.idFromCommand;

  it("maps a claude process to the agenv session whose shell it runs under", () => {
    // shell 100 (session 1) -> cmd 200 -> claude 300 ; shell 400 (session 2) -> claude 500
    const parentOf = new Map([[200, 100], [300, 200], [500, 400], [100, 1], [400, 1]]);
    const registry = [
      { pid: 300, sessionId: UUID_A, startedAt: 10 },
      { pid: 500, sessionId: UUID_B, startedAt: 20 },
      { pid: 999, sessionId: "unrelated", startedAt: 30 },
    ];
    const links = resolveClaudeLinks(registry, parentOf, new Map([[100, 1], [400, 2]]));
    assert.deepEqual([...links.entries()].sort(), [[1, UUID_A], [2, UUID_B]]);
  });

  it("prefers the most recently started conversation in one terminal", () => {
    const parentOf = new Map([[300, 100], [301, 100]]);
    const registry = [{ pid: 300, sessionId: UUID_A, startedAt: 10 }, { pid: 301, sessionId: UUID_B, startedAt: 50 }];
    assert.equal(resolveClaudeLinks(registry, parentOf, new Map([[100, 7]])).get(7), UUID_B);
  });

  it("survives a cycle in the process table", () => {
    const parentOf = new Map([[300, 301], [301, 300]]);
    assert.equal(resolveClaudeLinks([{ pid: 300, sessionId: UUID_A }], parentOf, new Map([[100, 1]])).size, 0);
  });

  it("reads session ids from claude command lines", () => {
    assert.equal(claudeIdFromCommand(`claude --resume ${UUID_A}`), UUID_A);
    assert.equal(claudeIdFromCommand(`claude -r ${UUID_A} --model opus`), UUID_A);
    assert.equal(claudeIdFromCommand(`claude --session-id=${UUID_A}`), UUID_A);
    assert.equal(claudeIdFromCommand("claude --continue"), null);
    assert.equal(claudeIdFromCommand(`git log ${UUID_A}`), null);
  });
});

describe("Claude session linking", () => {
  const home = makeTempHome();
  let server, sid;
  const transcript = path.join(home, ".claude", "projects", "C--proj", UUID_A + ".jsonl");

  before(async () => {
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, JSON.stringify({ type: "user", sessionId: UUID_A, message: { role: "user", content: "hi" } }) + "\n");
    server = await startServer({ home });
    sid = (await post("/api/sessions", { name: "alpha", group: "proj/dev" })).body.id;
  }, { timeout: 30000 });

  after(async () => { await stopProcess(server.proc); });

  it("links from a typed claude --resume command", async () => {
    await post("/api/history", { command: `claude --resume ${UUID_A}`, sessionId: sid });
    assert.equal((await findSession(sid)).claudeSessionId, UUID_A);
  });

  it("renaming a linked session renames the Claude conversation", async () => {
    const r = await put(`/api/sessions/${sid}`, { name: "seo audit" });
    assert.equal(r.status, 200);
    assert.equal(r.body.claudeRenamed, true);
    const last = fs.readFileSync(transcript, "utf8").trim().split("\n").pop();
    assert.deepEqual(JSON.parse(last), { type: "custom-title", customTitle: "seo audit", sessionId: UUID_A });
  });

  it("keeps the link across a restart", async () => {
    await new Promise((r) => setTimeout(r, 1200)); // debounced state save
    await stopProcess(server.proc);
    server = await startServer({ home });
    assert.equal((await findSession(sid)).claudeSessionId, UUID_A);
  }, { timeout: 30000 });

  it("archives a deleted session with its Claude link and group", async () => {
    assert.equal((await del(`/api/sessions/${sid}`)).status, 200);
    const archive = (await get("/api/archive")).body;
    const entry = archive.find((a) => a.claudeSessionId === UUID_A);
    assert.ok(entry, "archived: " + JSON.stringify(archive));
    assert.equal(entry.name, "seo audit");
    assert.equal(entry.group, "proj/dev");
  });

  it("finds the folder a conversation ran in", async () => {
    fs.appendFileSync(transcript, JSON.stringify({ type: "user", cwd: "C:\\proj", sessionId: UUID_A }) + "\n");
    const r = await get(`/api/claude/conversation/${UUID_A}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.cwd.replace(/\//g, "\\"), "C:\\proj");
    assert.equal((await get(`/api/claude/conversation/${UUID_B}`)).status, 404);
  });

  it("removes an entry from the closed list", async () => {
    const entry = (await get("/api/archive")).body.find((a) => a.claudeSessionId === UUID_A);
    assert.equal((await post("/api/archive/remove", { closed: entry.closed })).status, 200);
    assert.ok(!(await get("/api/archive")).body.some((a) => a.claudeSessionId === UUID_A));
  });
});
