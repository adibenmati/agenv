// test/unit/messages.test.js — MessageService: addressing, refusing closed/plain sessions, waiting for quiet, loop cap
"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { TypedEmitter } = require("../../dist/core/TypedEmitter");
const { MessageService } = require("../../dist/messaging/MessageService");
const { detectTool } = require("../../dist/sessions/tools");

function rig(over = {}) {
  const bus = new TypedEmitter();
  const sessions = new Map();
  let t = 1_000_000;
  const changes = [];
  const add = (id, name, tool = "claude", live = true) => {
    const written = [];
    const s = { id, name, detectedTool: tool, claudeRunning: false, live, pty: live ? { write: (x) => written.push(x) } : null };
    sessions.set(id, s);
    return { s, written };
  };
  const svc = new MessageService({
    bus, sessions: { get: (id) => sessions.get(id), all: () => [...sessions.values()] },
    now: () => t, quietMs: 1500, maxWaitMs: 60_000, submitDelayMs: 0, tickMs: 0, onChange: () => changes.push(t), ...over,
  });
  return { bus, sessions, svc, add, advance: (ms) => { t += ms; }, changes };
}
const reject = (fn, status, re) => assert.throws(fn, (e) => e.status === status && re.test(e.message), `expected ${status} ${re}`);

describe("MessageService", () => {
  it("types the message into an idle agent session and presses Enter, with a reply hint", () => {
    const r = rig(); const a = r.add(1, "backend"); const b = r.add(2, "codex-reviewer", "codex");
    const m = r.svc.send(1, "codex-reviewer", "please review\nthe diff");
    assert.equal(m.status, "delivered");
    assert.deepEqual(b.written, ['[agenv message from backend] please review the diff (reply with: agenv send backend "<your answer>")', "\r"]);
    assert.deepEqual(a.written, []);
  });

  it("names are matched case-insensitively and a numeric id also works; a name with spaces is quoted in the reply hint", () => {
    const r = rig(); r.add(1, "Front End"); const b = r.add(2, "Gemini-1", "gemini");
    r.svc.send(1, "GEMINI-1", "hi");
    r.svc.send(1, "#2", "again");
    assert.match(b.written[0], /reply with: agenv send "Front End" /);
    assert.equal(b.written.length, 2, "the second message waits for the terminal to be quiet again");
  });

  it("a message typed in the UI comes from \"you\" and carries no reply hint", () => {
    const r = rig(); const b = r.add(2, "agent");
    r.svc.send(null, "agent", "status?");
    assert.equal(b.written[0], "[agenv message from you] status?");
  });

  it("refuses a closed session, a plain terminal, itself, an unknown or ambiguous name and an empty or huge message", () => {
    const r = rig(); r.add(1, "a"); r.add(2, "closed", "claude", false); r.add(3, "shell", "terminal"); r.add(4, "dup"); r.add(5, "DUP");
    reject(() => r.svc.send(1, "closed", "x"), 409, /closed/);
    reject(() => r.svc.send(1, "shell", "x"), 409, /No agent CLI is running/);
    reject(() => r.svc.send(1, "a", "x"), 400, /itself/);
    reject(() => r.svc.send(1, "nobody", "x"), 404, /No session named/);
    reject(() => r.svc.send(1, "dup", "x"), 409, /More than one session/);
    reject(() => r.svc.send(1, "a ", "   "), 400, /empty/);
    reject(() => r.svc.send(null, "dup", "x".repeat(4001)), 400, /too long/);
  });

  it("a plain terminal that has claude running (linked conversation) counts as an agent", () => {
    const r = rig(); r.add(1, "a"); const { s, written } = r.add(2, "wrapped", "terminal"); s.claudeRunning = true;
    assert.equal(r.svc.send(1, "wrapped", "hi").status, "delivered");
    assert.equal(written.length, 2);
  });

  it("waits while the target is printing and delivers once it has been quiet, one message per quiet moment", () => {
    const r = rig(); r.add(1, "a"); const b = r.add(2, "busy-one");
    r.bus.emit("output", r.sessions.get(2), "thinking...");
    const m1 = r.svc.send(1, "busy-one", "first");
    const m2 = r.svc.send(1, "busy-one", "second");
    assert.deepEqual([m1.status, m2.status], ["queued", "queued"]);
    assert.equal(r.svc.peers().find((p) => p.id === 2).state, "busy");
    r.advance(1000); r.svc.pump();
    assert.equal(m1.status, "queued");
    r.advance(600); r.svc.pump();
    assert.deepEqual([m1.status, m2.status], ["delivered", "queued"], "typing the first message makes the terminal busy again");
    r.advance(1600); r.svc.pump();
    assert.equal(m2.status, "delivered");
    assert.match(b.written[0], /first/);
    assert.match(b.written[2], /second/);
  });

  it("a queued message fails when the session closes or stays busy for too long", () => {
    const r = rig(); r.add(1, "a"); r.add(2, "b"); r.add(3, "c");
    r.bus.emit("output", r.sessions.get(2), "x"); r.bus.emit("output", r.sessions.get(3), "x");
    const toB = r.svc.send(1, "b", "hi"); const toC = r.svc.send(1, "c", "hi");
    r.sessions.get(2).pty = null; r.sessions.get(2).live = false;
    r.bus.emit("deleted", r.sessions.get(2), -1);
    assert.deepEqual([toB.status, toB.error], ["failed", "the session was closed"]);
    for (let i = 0; i < 70; i++) { r.bus.emit("output", r.sessions.get(3), "x"); r.advance(1000); r.svc.pump(); }
    assert.deepEqual([toC.status, toC.error], ["failed", "the session stayed busy"]);
  });

  it("stops a loop: more than 30 messages from one session to another in 10 minutes are refused", () => {
    const r = rig(); r.add(1, "a"); r.add(2, "b");
    for (let i = 0; i < 30; i++) r.svc.send(1, "b", "ping " + i);
    reject(() => r.svc.send(1, "b", "one more"), 429, /loop/);
    r.svc.send(2, "a", "the other direction is counted separately");
    r.advance(10 * 60 * 1000 + 1);
    assert.ok(r.svc.send(1, "b", "after the window"));
  });

  it("session tokens identify only their own session and die with it", () => {
    const r = rig(); r.add(1, "a"); r.add(2, "b");
    const t1 = r.svc.tokenFor(1);
    assert.equal(r.svc.tokenFor(1), t1);
    assert.notEqual(r.svc.tokenFor(2), t1);
    assert.equal(r.svc.sessionForToken(t1), 1);
    assert.equal(r.svc.sessionForToken("nope"), null);
    r.sessions.delete(1);
    assert.equal(r.svc.sessionForToken(t1), null);
  });

  it("keeps the newest 200 messages and tells listeners when the log changes", () => {
    const r = rig({ tickMs: 0 }); r.add(1, "a"); r.add(2, "b");
    for (let i = 0; i < 205; i++) { r.advance(11 * 60 * 1000); r.svc.send(1, "b", "m" + i); r.bus.emit("output", r.sessions.get(2), "x"); }
    assert.equal(r.svc.messages().length, 200);
    assert.equal(r.svc.messages()[199].text, "m204");
    assert.ok(r.changes.length > 0);
  });
});

describe("tool detection for agent CLIs", () => {
  it("recognises codex, gemini and other agent CLIs", () => {
    assert.equal(detectTool("codex --yolo"), "codex");
    assert.equal(detectTool("gemini"), "gemini");
    assert.equal(detectTool("aider --model x"), "agent-cli");
    assert.equal(detectTool("claude"), "claude");
  });
});
