// test/unit/activity.test.js — what a session is working on: the task from the terminal title, typed input, history
"use strict";
const { describe, it, mock } = require("node:test");
const assert = require("node:assert/strict");
const { TypedEmitter } = require("../../dist/core/TypedEmitter");
const { OutputAnalyzer } = require("../../dist/sessions/OutputAnalyzer");
const { lastTitle, parseTitle, recordActivity, tailLines, ACTIVITY_LOG_MAX } = require("../../dist/sessions/activity");

const ESC = String.fromCharCode(27), BEL = String.fromCharCode(7);
const osc = (t, n = 0) => ESC + "]" + n + ";" + t + BEL;

describe("terminal title", () => {
  it("finds the last title in a chunk, ended by BEL or ST", () => {
    assert.equal(lastTitle("x" + osc("one") + "y" + osc("two", 2) + "z"), "two");
    assert.equal(lastTitle(ESC + "]0;by st" + ESC + "\\"), "by st");
    assert.equal(lastTitle("no title here"), null);
    assert.equal(lastTitle(ESC + "]7;file://h/c/x" + BEL), null, "OSC 7 is the folder, not a title");
  });

  it("reads Claude Code's task and whether it is working", () => {
    assert.deepEqual(parseTitle("◐ Blog docs and package version"), { text: "Blog docs and package version", busy: true });
    assert.deepEqual(parseTitle("⠂ Fix the login bug"), { text: "Fix the login bug", busy: true });
    assert.deepEqual(parseTitle("✳ Blog docs and package version"), { text: "Blog docs and package version", busy: false });
  });

  it("ignores titles that only name the program or the folder", () => {
    for (const t of ["claude", "✳ Claude Code", "◐ Claude Code", "C:\\WINDOWS\\SYSTEM32\\cmd.exe",
      "C:\\WINDOWS\\SYSTEM32\\cmd.exe - claude  --model haiku", "Windows PowerShell", "MINGW64:/c/dev/agenv",
      "adi@box: ~/proj", "~/proj", "/home/me", "Administrator: Windows PowerShell", "", "   "]) {
      assert.equal(parseTitle(t), null, JSON.stringify(t));
    }
  });

  it("keeps a plain title without a glyph, busy unknown", () => {
    assert.deepEqual(parseTitle("Deploying staging"), { text: "Deploying staging", busy: null });
    assert.deepEqual(parseTitle("◐ סידור קבצים"), { text: "סידור קבצים", busy: true }, "Hebrew task");
  });
});

describe("recordActivity", () => {
  const fresh = () => ({ activity: null, activityLog: [] });

  it("sets the current activity and adds it to the history once", () => {
    const s = fresh();
    assert.equal(recordActivity(s, "npm test", "input", null, 1000), true);
    assert.deepEqual(s.activity, { text: "npm test", source: "input", busy: null, at: 1000 });
    assert.equal(recordActivity(s, "npm test", "input", null, 2000), false, "same text, nothing new");
    assert.equal(s.activityLog.length, 1);
  });

  it("a change of busy only updates the current activity, not the history", () => {
    const s = fresh();
    recordActivity(s, "Fix bug", "task", true, 1);
    assert.equal(recordActivity(s, "Fix bug", "task", false, 2), true);
    assert.equal(s.activity.busy, false);
    assert.equal(s.activityLog.length, 1);
  });

  it("the same task again after a typed line becomes current but is not listed twice", () => {
    const s = fresh();
    recordActivity(s, "Fix bug", "task", true, 1);
    recordActivity(s, "run the tests", "input", null, 2);
    assert.equal(recordActivity(s, "Fix bug", "task", false, 3), true);
    assert.deepEqual([s.activity.text, s.activity.source, s.activity.at], ["Fix bug", "task", 3]);
    assert.deepEqual(s.activityLog.map((x) => x.text), ["Fix bug", "run the tests"]);
  });

  it("flattens whitespace, caps length, keeps only the newest entries", () => {
    const s = fresh();
    recordActivity(s, "  a\n  b\tc ", "input", null);
    assert.equal(s.activity.text, "a b c");
    recordActivity(s, "x".repeat(500), "input", null);
    assert.equal(s.activity.text.length, 200);
    for (let i = 0; i < ACTIVITY_LOG_MAX + 5; i++) recordActivity(s, "step " + i, "input", null);
    assert.equal(s.activityLog.length, ACTIVITY_LOG_MAX);
    assert.equal(s.activityLog[s.activityLog.length - 1].text, "step " + (ACTIVITY_LOG_MAX + 4));
    assert.equal(recordActivity(s, "   ", "input", null), false, "empty text is ignored");
  });
});

describe("tailLines", () => {
  it("strips colour codes, keeps the last redraw of a line, drops empty lines", () => {
    const out = "one\r\n" + ESC + "[32mtwo" + ESC + "[0m\r\n\r\n50%\r100%\r\nlast";
    assert.deepEqual(tailLines(out, 10), ["one", "two", "100%", "last"]);
    assert.deepEqual(tailLines(out, 2), ["100%", "last"]);
  });
});

describe("OutputAnalyzer: activity from the title", () => {
  const mkSession = () => ({ id: 1, cwd: "C:\\x", status: "idle", detectedTool: "claude", title: "", activity: null, activityLog: [],
    analytics: { inputTokens: 0, outputTokens: 0, estimatedCost: 0, commandCount: 0, turnCount: 0, startTime: 0 } });

  it("sets the task while Claude works, marks it done, and stops it when the shell takes the title back", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const bus = new TypedEmitter(); const s = mkSession(); let changed = 0;
      bus.on("changed", () => changed++);
      new OutputAnalyzer(bus, () => true, "linux");
      bus.emit("output", s, osc("◐ Claude Code") + "hi"); mock.timers.tick(250);
      assert.equal(s.activity, null, "the program name alone is not a task");
      bus.emit("output", s, osc("◐ Refactor the parser")); mock.timers.tick(250);
      assert.deepEqual([s.activity.text, s.activity.busy], ["Refactor the parser", true]);
      const n = changed;
      bus.emit("output", s, osc("◑ Refactor the parser")); mock.timers.tick(250);
      assert.equal(changed, n, "a spinner frame changes nothing");
      bus.emit("output", s, osc("✳ Refactor the parser")); mock.timers.tick(250);
      assert.equal(s.activity.busy, false);
      recordActivity(s, "Next task", "task", true);
      bus.emit("output", s, osc("C:\\WINDOWS\\system32\\cmd.exe")); mock.timers.tick(250);
      assert.deepEqual([s.activity.text, s.activity.busy], ["Next task", false]);
      assert.equal(s.activityLog.length, 2);
    } finally { mock.timers.reset(); }
  });
});
