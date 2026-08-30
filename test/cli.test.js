// test/cli.test.js — CLI launch/fallback behaviour
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const CLI = path.join(__dirname, "..", "cli.js");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "agenv-cli-"));
const isWin = process.platform === "win32";

// Stand-in Electron binaries. cli.js honours AGENV_ELECTRON_BIN, so every
// launch outcome is reproducible without a real Electron install. The stub is
// a .cmd/shell wrapper so it exercises the same shim path as electron.cmd.
function fakeElectron(name, body) {
  const js = path.join(TMP, name + ".js");
  fs.writeFileSync(js, body);
  if (isWin) {
    const cmd = path.join(TMP, name + ".cmd");
    fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`);
    return cmd;
  }
  const sh = path.join(TMP, name);
  fs.writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`);
  fs.chmodSync(sh, 0o755);
  return sh;
}

// Mimics what a policy-blocked Electron prints before dying.
const BLOCKED = fakeElectron(
  "blocked",
  'console.error("Error: spawn UNKNOWN");\nconsole.error("  errno: -4094");\nprocess.exit(1);\n'
);
const SURVIVES = fakeElectron("survives", "setTimeout(() => process.exit(0), 900);\n");
const MISSING = path.join(TMP, "no-such-electron-binary");

// Runs cli.js with a fake Electron and collects output until it exits or the
// web fallback takes over. HOME is redirected so the real ~/.agenv state is
// never touched.
function runCli(electronBin, { probeMs = 300, timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI], {
      cwd: TMP,
      env: {
        ...process.env,
        AGENV_ELECTRON_BIN: electronBin,
        AGENV_ELECTRON_PROBE_MS: String(probeMs),
        HOME: TMP,
        USERPROFILE: TMP,
        PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out = "";
    let done = false;
    const finish = (exitCode) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {}
      resolve({ out, exitCode });
    };

    const onData = (d) => {
      out += d.toString();
      // The fallback spawns the real server; we have what we need by then.
      if (/Agenv v|Auth mode:|Listening on/.test(out)) finish(null);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => finish(code));

    const timer = setTimeout(() => finish(null), timeoutMs);
  });
}

describe("cli electron launch", () => {
  it("falls back to web mode when Electron dies immediately", async () => {
    const { out } = await runCli(BLOCKED);
    assert.match(out, /web mode/i);
  });

  it("explains a policy-blocked binary instead of dumping a raw stack trace", async () => {
    const { out } = await runCli(BLOCKED);
    assert.match(out, /Smart App Control|Application Control/i);
    assert.doesNotMatch(out, /at ChildProcess\.spawn/);
  });

  it("falls back when the Electron binary cannot be spawned at all", async () => {
    const { out } = await runCli(MISSING);
    assert.match(out, /web mode/i);
  });

  it("does not fall back when Electron stays up and exits cleanly", async () => {
    const { out, exitCode } = await runCli(SURVIVES);
    assert.doesNotMatch(out, /falling back|web mode/i);
    assert.equal(exitCode, 0);
  });
});
