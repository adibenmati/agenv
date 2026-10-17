#!/usr/bin/env node
// Fake `claude` for tests. Driven by env FAKE_CLAUDE_MODE (ok|fail|hang|budget|garbage|noisy|slow|maxturns|longline) and FAKE_CLAUDE_STATE (dir).
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { spawn } = require("child_process");

const argv = process.argv.slice(2);
const mode = process.env.FAKE_CLAUDE_MODE || "ok";
const state = process.env.FAKE_CLAUDE_STATE;
const tdir = state && path.join(state, "transcripts");
if (state) {
  fs.mkdirSync(tdir, { recursive: true });
  fs.appendFileSync(path.join(state, "calls.jsonl"), JSON.stringify({ argv, cwd: process.cwd() }) + "\n");
}

const dd = argv.indexOf("--");
const prompt = dd >= 0 ? argv[dd + 1] : argv[argv.length - 1];
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 && i < (dd < 0 ? argv.length : dd) ? argv[i + 1] : undefined; };
const resume = opt("--resume");
const fork = argv.includes("--fork-session");
const out = (o) => process.stdout.write((typeof o === "string" ? o : JSON.stringify(o)) + "\n");

if (mode === "fail") { process.stderr.write("fake claude exploded\n"); process.exit(1); }

const sessionId =resume && !fork ? resume : crypto.randomUUID();
if (tdir) {
  const target = path.join(tdir, sessionId + ".jsonl");
  const src = resume ? path.join(tdir, resume + ".jsonl") : null;
  if (fork && src && fs.existsSync(src)) fs.writeFileSync(target, fs.readFileSync(src));
  else if (!fs.existsSync(target)) fs.writeFileSync(target, "");
  if (prompt !== "/compact") fs.appendFileSync(target, JSON.stringify({ type: "user", message: prompt }) + "\n");
}

out({ type: "system", subtype: "init", session_id: sessionId });
out({ type: "assistant", message: { content: [{ type: "text", text: "working" }] }, session_id: sessionId });

if (mode === "hang") {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  if (state) fs.writeFileSync(path.join(state, "child.pid"), String(child.pid));
  setInterval(() => {}, 1000);
} else if (mode === "slow") {
  out("SLOW-FIRST-LINE");
  setTimeout(finishOk, 1500);
} else {
  finishOk();
}

function finishOk() {
  if (mode === "garbage") { out("not json at all"); out("{broken"); }
  if (mode === "noisy") {
    out("FIRST-MARKER");
    const line = "x".repeat(1023);
    for (let i = 0; i < 6 * 1024; i++) out(line);
    out("LAST-MARKER");
  }
  if (mode === "longline") process.stdout.write("y".repeat(2 * 1024 * 1024) + "\n");
  const compact = prompt === "/compact";
  const budget = mode === "budget";
  out({
    type: "result",
    subtype: budget ? "error_max_budget_usd" : mode === "maxturns" ? "error_max_turns" : "success",
    result: compact || budget ? "" : "reply to: " + prompt,
    session_id: sessionId,
    total_cost_usd: budget ? 1.02 : 0.0123,
    num_turns: compact ? 0 : 1,
    duration_ms: 5,
    is_error: budget,
  });
}
