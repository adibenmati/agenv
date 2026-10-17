// test/unit/scrollback.test.js — Scrollback ring buffer and the Session record
"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { Scrollback, MAX_SCROLLBACK } = require("../../dist/sessions/Scrollback");
const { Session } = require("../../dist/sessions/Session");

const RESET = "\x1b[0m\x1b[?25h";

describe("Scrollback", () => {
  it("returns exactly what was appended while under the cap, and starts from an initial buffer", () => {
    const sb = new Scrollback(Buffer.from("abc")); sb.append("def"); sb.append(Buffer.from("ghi"));
    assert.equal(sb.read().toString(), "abcdefghi"); assert.equal(sb.bytes, 9);
    assert.equal(new Scrollback().read().length, 0);
  });
  it("marks itself dirty on append so unchanged buffers are not re-saved", () => {
    const sb = new Scrollback(); assert.equal(sb.dirty, false);
    sb.append("x"); assert.equal(sb.dirty, true); sb.dirty = false; sb.append(""); assert.equal(sb.dirty, false);
  });
  it("after overflow: stays within the cap, is prefixed with a reset sequence, and starts on a line boundary", () => {
    const sb = new Scrollback(); for (let i = 0; i < 2000; i++) sb.append(`line ${i} ` + "y".repeat(200) + "\n");
    const text = sb.read().toString("utf8");
    assert.ok(sb.read().length <= MAX_SCROLLBACK, "within cap");
    assert.ok(text.startsWith(RESET), "reset prefix");
    assert.match(text.slice(RESET.length), /^line \d+ y+\n/, "first line is whole");
    assert.ok(text.endsWith("\n"));
  });
  it("never starts in the middle of a multi-byte character", () => {
    const sb = new Scrollback(); for (let i = 0; i < 400; i++) sb.append("é".repeat(1000));   // no newline anywhere
    const buf = sb.read(); const first = buf[RESET.length];
    assert.ok((first & 0xC0) !== 0x80, "first byte after the reset must not be a continuation byte");
    assert.ok(!buf.toString("utf8").includes("�"), "no replacement characters");
  });
});

describe("Session", () => {
  const mk = (over = {}) => new Session({ id: 4, cwd: "/work", cols: 120, rows: 30, ...over });
  it("starts asleep with the baseline defaults", () => {
    const s = mk();
    assert.equal(s.name, ""); assert.equal(s.group, ""); assert.equal(s.note, ""); assert.equal(s.claudeSessionId, null);
    assert.equal(s.claudeRunning, false); assert.equal(s.detectedTool, "terminal"); assert.equal(s.status, "idle");
    assert.equal(s.live, false); assert.equal(s.pty, null); assert.equal(s.pendingCommand, null); assert.equal(s.launchCommand, "");
    assert.equal(s.analytics.turnCount, 0); assert.ok(s.analytics.startTime > 0); assert.ok(s.created > 0);
    assert.equal(s.cols, 120); assert.equal(s.rows, 30);
  });
  it("a run command becomes the launch command and the pending command", () => {
    const s = mk({ runCommand: "claude --model opus" });
    assert.equal(s.launchCommand, "claude --model opus"); assert.equal(s.pendingCommand, "claude --model opus");
    assert.equal(mk({ launchCommand: "ssh box" }).launchCommand, "ssh box"); assert.equal(mk({ launchCommand: "ssh box" }).pendingCommand, null);
  });
  it("toPersisted has exactly the saved fields", () => {
    const s = mk({ name: "n", group: "a/b", note: "hi", claudeSessionId: "cid", tool: "claude", lastCommand: "ls", userNamed: true, created: 5, lastActivity: 6 });
    assert.deepEqual(s.toPersisted(), { id: 4, name: "n", cwd: "/work", tool: "claude", lastCommand: "ls", launchCommand: "", userNamed: true, group: "a/b", note: "hi", claudeSessionId: "cid", created: 5, lastActivity: 6 });
  });
  it("toListItem has the GET /api/sessions shape", () => {
    const s = mk({ name: "n", group: "g" }); s.claudeRunning = true;
    const item = s.toListItem(2);
    assert.deepEqual(Object.keys(item).sort(), ["analytics", "claudeRunning", "claudeSessionId", "clients", "created", "cwd", "group", "id", "lastActivity", "lastCommand", "launchCommand", "live", "name", "note", "status", "tool"]);
    assert.equal(item.clients, 2); assert.equal(item.claudeRunning, true); assert.equal(item.live, false); assert.equal(item.tool, "terminal");
  });
});
