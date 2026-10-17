// test/unit/agents-real-check.test.js — the opt-in real-CLI check script, exercised without spending money
"use strict";
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { spawnSync } = require("child_process");

const SCRIPT = path.join(__dirname, "..", "..", "scripts", "check-agents-real.js");
const FAKE = path.join(__dirname, "..", "fixtures", "fake-claude-cli.js");
const tmp = [];
const mkdir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "agenv-rc-")); tmp.push(d); return d; };
afterEach(() => { while (tmp.length) fs.rmSync(tmp.pop(), { recursive: true, force: true }); });

const run = (args, env) => {
  const home = mkdir();
  const e = { ...process.env, HOME: home, USERPROFILE: home, ...env };
  delete e.AGENV_CLAUDE_BIN; if (!("AGENV_REAL_CLAUDE" in (env || {}))) delete e.AGENV_REAL_CLAUDE;
  Object.assign(e, env || {});
  return spawnSync(process.execPath, [SCRIPT, ...args], { env: e, encoding: "utf8", timeout: 60000 });
};

describe("check-agents-real script", () => {
  it("refuses to run without AGENV_REAL_CLAUDE=1 (exit 2)", () => {
    const r = run([], {});
    assert.equal(r.status, 2);
    assert.match(r.stderr, /AGENV_REAL_CLAUDE=1/);
  });

  it("refuses when AGENV_REAL_CLAUDE=0", () => {
    const r = run([], { AGENV_REAL_CLAUDE: "0" });
    assert.equal(r.status, 2);
  });

  it("--against-fake runs every check end to end and cleans up", () => {
    const state = mkdir();
    const r = run(["--against-fake"], { FAKE_CLAUDE_STATE: state });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    for (const s of [/PASS.*fork/i, /PASS.*source transcript unchanged/i, /PASS.*compact/i, /PASS.*flag-like prompt/i, /resumed run session_id/i, /total cost/i, /cleanup/i]) assert.match(r.stdout, s);
    const left = fs.existsSync(path.join(state, "transcripts")) ? fs.readdirSync(path.join(state, "transcripts")) : [];
    assert.deepEqual(left, []);
  });

  it("reports compact FAIL prominently and exits 1", () => {
    const r = run(["--against-fake"], { FAKE_CLAUDE_MODE: "fail-compact" });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL.*compact/i);
    assert.match(r.stdout, /FINDING/);
  });
});
