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
    const s = { id, name, group: "", scrollback: { read: () => Buffer.alloc(0) }, detectedTool: tool, claudeRunning: false, live, pty: live ? { write: (x) => written.push(x) } : null };
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

describe("MessageService.broadcast", () => {
  it("types the command and Enter into every open session, skipping closed ones and (when asked) plain shells", () => {
    const r = rig();
    const a = r.add(1, "a"); const b = r.add(2, "b", "codex"); const shell = r.add(3, "shell", "terminal"); r.add(4, "gone", "claude", false);
    const all = r.svc.broadcast("/remote-control", { agentsOnly: true });
    assert.deepEqual(all.map((x) => [x.id, x.status, x.reason]), [[1, "sent", undefined], [2, "sent", undefined], [3, "skipped", "no agent CLI running"], [4, "skipped", "closed"]]);
    assert.deepEqual(a.written, ["/remote-control", "\r"]);
    assert.deepEqual(b.written, ["/remote-control", "\r"]);
    assert.deepEqual(shell.written, []);
    const plain = r.svc.broadcast("echo hi", {});
    assert.equal(plain.find((x) => x.id === 3).status, "sent");
    assert.deepEqual(shell.written, ["echo hi", "\r"]);
  });

  it("a group limits it to that group and its subgroups, and an empty or multi-line command is flattened or refused", () => {
    const r = rig();
    const a = r.add(1, "a"); a.s.group = "mkt";
    const b = r.add(2, "b"); b.s.group = "mkt/seo";
    const c = r.add(3, "c"); c.s.group = "marketing";
    const d = r.add(4, "d"); d.s.group = "";
    const res = r.svc.broadcast("go\nnow", { group: "mkt" });
    assert.deepEqual(res.map((x) => x.id), [1, 2]);
    assert.deepEqual(a.written, ["go now", "\r"]);
    assert.deepEqual(c.written.concat(d.written), []);
    reject(() => r.svc.broadcast("  "), 400, /empty/);
  });
});

describe("recognising an agent CLI that was not typed as a plain command", () => {
  const { detectToolFromOutput } = require("../../dist/sessions/tools");
  it("finds codex and friends behind paths, extensions, runners and command chains", () => {
    for (const [cmd, tool] of [
      ["npx @openai/codex", "codex"], ["codex.cmd --yolo", "codex"], ["C:/Users/me/AppData/Roaming/npm/codex.ps1", "codex"],
      ["cd ../app && codex", "codex"], ["FOO=1 gemini -m x", "gemini"], ["pnpm dlx @google/gemini-cli", "gemini"],
      ["npx -y @anthropic-ai/claude-code", "claude"], ["\"C:/Program Files/nodejs/claude.exe\" --resume x", "claude"],
    ]) assert.equal(detectTool(cmd), tool, cmd);
  });
  it("reads the start-up banners, Claude before Gemini (both print 'Tips for getting started')", () => {
    assert.equal(detectToolFromOutput(">_ OpenAI Codex (v0.50.0)"), "codex");
    assert.equal(detectToolFromOutput("Claude Code v2.1.301\nTips for getting started:"), "claude");
    assert.equal(detectToolFromOutput("Tips for getting started:\n1. Ask questions"), "gemini");
    assert.equal(detectToolFromOutput("just some Gemini and Codex words"), null);
  });
  it("a send to a session whose tool is unknown looks at its output; --force overrides; several recipients at once", () => {
    const r = rig(); r.add(1, "a");
    const hidden = r.add(2, "intelis-commercial-codex", "terminal");
    hidden.s.scrollback = { read: () => Buffer.from("\x1b[1m>_ OpenAI Codex (v0.50.0)\x1b[0m\nready") };
    const plain = r.add(3, "plain", "terminal");
    plain.s.scrollback = { read: () => Buffer.from("C:\work>") };
    const third = r.add(4, "gem", "gemini");
    assert.equal(r.svc.send(1, "intelis-commercial-codex", "hi").status, "delivered");
    assert.equal(hidden.s.detectedTool, "codex");
    assert.throws(() => r.svc.send(1, "plain", "hi"), (e) => e.status === 409 && e.body && e.body.code === "no-agent-cli");
    assert.equal(r.svc.send(null, "plain", "hi", { force: true }).status, "delivered");
    const res = r.svc.sendTo(1, ["gem", "ghost", "plain", "#4"], "all of you");
    assert.deepEqual(res.map((x) => [x.name, x.status]), [["gem", "sent"], ["ghost", "skipped"], ["plain", "skipped"]]);
    assert.equal(res[2].code, "no-agent-cli");
    assert.match(third.written[0], /all of you/);
  });
});
