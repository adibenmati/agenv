// test/unit/analyzer.test.js — status/cost detection, OutputAnalyzer, isRealDir
"use strict";
const { describe, it, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { TypedEmitter } = require("../../dist/core/TypedEmitter");
const { OutputAnalyzer, detectSessionStatus, parseTokenInfo } = require("../../dist/sessions/OutputAnalyzer");
const { createRealDirChecker } = require("../../dist/core/fsUtil");

describe("detectSessionStatus", () => {
  it("waiting beats busy beats error beats idle", () => {
    assert.equal(detectSessionStatus("Do you want to proceed? (y/n)"), "waiting");
    assert.equal(detectSessionStatus("Downloading... 40%"), "running");
    assert.equal(detectSessionStatus("fatal: not a git repository"), "error");
    assert.equal(detectSessionStatus("user@host:~$ "), "idle");
    assert.equal(detectSessionStatus("just some text"), null);
  });
  it("recognises Windows prompts as idle", () => {
    assert.equal(detectSessionStatus("PS C:\\Users\\me> "), "idle");
    assert.equal(detectSessionStatus("C:\\Users\\me>"), "idle");
  });
});

describe("parseTokenInfo", () => {
  it("reads cost and token counts", () => {
    assert.deepEqual(parseTokenInfo("Total cost: $1.25"), { cost: 1.25 });
    assert.deepEqual(parseTokenInfo("1,200 input tokens and 300 output tokens"), { inputTokens: 1200, outputTokens: 300 });
    assert.equal(parseTokenInfo("nothing here"), null);
  });
  it("ignores an implausible cost", () => {
    assert.equal(parseTokenInfo("Total cost: $5000.00"), null);
  });
});

describe("OutputAnalyzer", () => {
  const mkSession = () => ({ id: 1, cwd: "C:\\old", status: "idle", detectedTool: "claude", analytics: { inputTokens: 0, outputTokens: 0, estimatedCost: 0, commandCount: 0, turnCount: 0, startTime: 0 } });
  it("detects the cwd from a Windows PowerShell prompt and emits cwd + changed (batched at 250ms)", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const bus = new TypedEmitter(); const s = mkSession(); const ev = [];
      bus.on("cwd", (_s, c) => ev.push(["cwd", c])); bus.on("changed", () => ev.push(["changed"]));
      new OutputAnalyzer(bus, () => true, "win32");
      bus.emit("output", s, "PS C:\\Users\\me\\proj> ");
      assert.deepEqual(ev, []);                                   // nothing until the timer fires
      mock.timers.tick(250);
      assert.equal(s.cwd, "C:\\Users\\me\\proj"); assert.deepEqual(ev, [["changed"], ["cwd", "C:\\Users\\me\\proj"]]);
    } finally { mock.timers.reset(); }
  });
  it("detects the cwd from an OSC 7 sequence on any platform", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const bus = new TypedEmitter(); const s = mkSession(); new OutputAnalyzer(bus, () => true, "linux");
      bus.emit("output", s, "\x1b]7;file://host/home/me/my%20proj\x07$ "); mock.timers.tick(250);
      assert.equal(s.cwd, "/home/me/my proj");
    } finally { mock.timers.reset(); }
  });
  it("ignores a prompt path that is not a real directory", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const bus = new TypedEmitter(); const s = mkSession();
      new OutputAnalyzer(bus, () => false, "win32");
      bus.emit("output", s, "C:\\nope>"); mock.timers.tick(250); assert.equal(s.cwd, "C:\\old");
    } finally { mock.timers.reset(); }
  });
  it("accumulates cost for agent sessions only, and emits status changes", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const bus = new TypedEmitter(); const s = mkSession(); const st = [];
      bus.on("status", (_s, v) => st.push(v)); new OutputAnalyzer(bus, () => true, "linux");
      bus.emit("output", s, "Thinking...\n"); mock.timers.tick(250);
      assert.deepEqual(st, ["running"]); assert.equal(s.status, "running");
      bus.emit("output", s, "Total cost: $0.50\n"); mock.timers.tick(250);
      assert.equal(s.analytics.estimatedCost, 0.5); assert.equal(s.analytics.turnCount, 1);
      const t = { ...mkSession(), detectedTool: "terminal" };
      bus.emit("output", t, "Total cost: $9.99\n"); mock.timers.tick(250); assert.equal(t.analytics.estimatedCost, 0);
    } finally { mock.timers.reset(); }
  });
  it("only keeps the last 8 KiB, so a flood of output cannot grow memory", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const bus = new TypedEmitter(); const s = mkSession(); new OutputAnalyzer(bus, () => true, "linux");
      for (let i = 0; i < 200; i++) bus.emit("output", s, "x".repeat(1000));
      bus.emit("output", s, "\nDo you want to proceed? (y/n)\n"); mock.timers.tick(250);
      assert.equal(s.status, "waiting");
    } finally { mock.timers.reset(); }
  });
  it("forgets a deleted session (its pending timer never fires)", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const bus = new TypedEmitter(); const s = mkSession(); new OutputAnalyzer(bus, () => true, "linux");
      bus.emit("output", s, "Thinking...\n"); bus.emit("deleted", s, 0); mock.timers.tick(250);
      assert.equal(s.status, "idle");
    } finally { mock.timers.reset(); }
  });
});

describe("createRealDirChecker", () => {
  it("accepts directories, rejects files and missing paths, and caches positives", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "agenv-d-")); const f = path.join(d, "f.txt"); fs.writeFileSync(f, "x");
    const isRealDir = createRealDirChecker();
    assert.equal(isRealDir(d), true); assert.equal(isRealDir(f), false); assert.equal(isRealDir(path.join(d, "nope")), false);
    fs.rmSync(d, { recursive: true }); assert.equal(isRealDir(d), true);   // cached, as in the baseline
  });
});
