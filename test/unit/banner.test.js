// test/unit/banner.test.js — the startup banner
"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { printBanner } = require("../../dist/banner");

const capture = (o) => { const lines = []; printBanner({ version: "9.9.9", accessUrl: "http://127.0.0.1:7681/?token=abc", shell: "cmd.exe", sessions: 2, restored: true, showQr: false, ...o }, (s) => lines.push(s)); return lines; };

describe("printBanner", () => {
  it("shows version, sessions, shell and URL in a box, framed to a consistent width", () => {
    const lines = capture({});
    const text = lines.join("\n");
    assert.match(text, /Agenv v9\.9\.9/); assert.match(text, /Sessions: 2 \(restored\)/); assert.match(text, /Shell:    cmd\.exe/);
    assert.match(text, /URL:      http:\/\/127\.0\.0\.1:7681\/\?token=abc/); assert.match(text, /Press Ctrl\+C twice to exit\./);
    const framed = lines.filter((l) => /^[┌├│└]/.test(l)); assert.ok(framed.length >= 8);
    assert.equal(new Set(framed.map((l) => l.length)).size, 1, "every framed line is the same width");
  });
  it("says 'new' for a first run and shows the command and folder instead of sessions in run mode", () => {
    assert.match(capture({ restored: false }).join("\n"), /Sessions: 2 \(new\)/);
    const run = capture({ runCommand: "claude --model opus" }).join("\n");
    assert.match(run, /Command:  claude --model opus/); assert.match(run, new RegExp("Folder:   " + process.cwd().replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"))); assert.doesNotMatch(run, /Sessions:/);
  });
  it("widens for a long URL but never beyond 100 columns", () => {
    const long = capture({ accessUrl: "http://127.0.0.1:7681/?token=" + "x".repeat(300) });
    assert.ok(long.find((l) => l.startsWith("┌")).length <= 102);
  });
  it("prints a QR code only when asked and available", () => {
    const withQr = [];
    printBanner({ version: "1", accessUrl: "http://x/", shell: "sh", sessions: 1, restored: false, showQr: true, qr: { generate: (_t, _o, cb) => cb("QR-ART") } }, (s) => withQr.push(s));
    assert.ok(withQr.includes("QR-ART"));
    const without = []; printBanner({ version: "1", accessUrl: "http://x/", shell: "sh", sessions: 1, restored: false, showQr: false, qr: { generate: (_t, _o, cb) => cb("QR-ART") } }, (s) => without.push(s));
    assert.ok(!without.includes("QR-ART"));
  });
});
