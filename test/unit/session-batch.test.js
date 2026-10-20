// test/unit/session-batch.test.js — SessionBatch.resumeAll and MessageService.sendMany
"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { TypedEmitter } = require("../../dist/core/TypedEmitter");
const { MessageService } = require("../../dist/messaging/MessageService");
const { SessionBatch } = require("../../dist/sessions/SessionBatch");

const mk = (id, o = {}) => {
  const written = [];
  const s = { id, name: "s" + id, group: "", live: true, claudeSessionId: null, claudeRunning: false, status: "idle", detectedTool: "terminal", pty: null, ...o };
  s.pty = s.live ? { write: (x) => written.push(x) } : null;
  return { s, written };
};

describe("SessionBatch.resumeAll", () => {
  it("wakes sleeping tabs and resumes their Claude conversations, skipping running or busy ones", async () => {
    const asleep = mk(1, { live: false, claudeSessionId: "abc-123" });
    const asleepPlain = mk(2, { live: false });
    const idle = mk(3, { claudeSessionId: "def-456" });
    const running = mk(4, { claudeSessionId: "ghi", claudeRunning: true });
    const busy = mk(5, { claudeSessionId: "jkl", status: "running" });
    const noConv = mk(6);
    const all = [asleep, asleepPlain, idle, running, busy, noConv].map((x) => x.s);
    const woken = [];
    const batch = new SessionBatch({ sessions: { all: () => all, wake: (s) => { woken.push(s.id); s.live = true; s.pty = s === asleep.s ? { write: (x) => asleep.written.push(x) } : { write() {} }; } }, wakeDelayMs: 5 });
    const res = batch.resumeAll({ extraArgs: ["--model", "opus", "bad arg; rm -rf", "--dangerously-skip-permissions"] });
    assert.deepEqual(res.map((r) => [r.id, r.action]), [[1, "resumed"], [2, "woke"], [3, "resumed"], [4, "skipped"], [5, "skipped"], [6, "skipped"]]);
    assert.deepEqual(woken, [1, 2]);
    assert.deepEqual(idle.written, ["claude --resume def-456 --model opus --dangerously-skip-permissions\r"]);
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(asleep.written, ["claude --resume abc-123 --model opus --dangerously-skip-permissions\r"]);
    assert.deepEqual([running.written, busy.written, noConv.written], [[], [], []]);
  });

  it("a group limits it to that group and its subgroups", () => {
    const a = mk(1, { group: "ops", claudeSessionId: "a1" }), b = mk(2, { group: "ops/db", claudeSessionId: "b1" }), c = mk(3, { group: "opsx", claudeSessionId: "c1" });
    const batch = new SessionBatch({ sessions: { all: () => [a.s, b.s, c.s], wake() {} } });
    assert.deepEqual(batch.resumeAll({ group: "ops" }).map((r) => r.id), [1, 2]);
    assert.deepEqual(c.written, []);
  });
});

describe("MessageService.sendMany", () => {
  it("sends one message to every agent session in the group and reports who could not take it", () => {
    const bus = new TypedEmitter();
    const a = mk(1, { detectedTool: "claude", group: "mkt" }), b = mk(2, { detectedTool: "codex", group: "mkt/seo" }), shell = mk(3, { group: "mkt" }), other = mk(4, { detectedTool: "gemini", group: "dev" });
    const all = [a, b, shell, other].map((x) => x.s);
    const svc = new MessageService({ bus, sessions: { get: (id) => all.find((s) => s.id === id), all: () => all }, tickMs: 0, submitDelayMs: 0 });
    const res = svc.sendMany(null, "status please", { group: "mkt" });
    assert.deepEqual(res.map((r) => [r.id, r.status]), [[1, "sent"], [2, "sent"], [3, "skipped"]]);
    assert.match(res[2].reason, /No agent CLI/);
    assert.equal(a.written[0], "[agenv message from you] status please");
    assert.deepEqual(other.written, []);
    const fromA = svc.sendMany(1, "hello", {});
    assert.ok(!fromA.some((r) => r.id === 1), "never to itself");
  });
});
