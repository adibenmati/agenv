#!/usr/bin/env node
// scripts/check-agents-real.js — opt-in check of agent conversation forking against the REAL claude CLI.
// Spends real money (haiku, hard cap --max-budget-usd 0.05 per call). Run `npm run build` first (uses dist/).
//   AGENV_REAL_CLAUDE=1 npm run check:agents-real
// Dry mode, no money: `node scripts/check-agents-real.js --against-fake` (or AGENV_CLAUDE_BIN=<fake-claude-cli.js>).
// Exit codes: 0 all checks passed, 1 a check failed, 2 refused to run.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto");
const { ClaudeRunner } = require("../dist/agents/ClaudeRunner");
const { ConversationForker } = require("../dist/agents/ConversationForker");
const { claudePaths } = require("../dist/claude/paths");

const FAKE = path.join(__dirname, "..", "test", "fixtures", "fake-claude-cli.js");
const fake = process.argv.includes("--against-fake") || /fake-claude-cli\.js$/i.test(process.env.AGENV_CLAUDE_BIN || "");
if (!fake && process.env.AGENV_REAL_CLAUDE !== "1") {
  console.error("Refusing to run: this check calls the real claude CLI and spends money (about 5 cents).\n" +
    "Set AGENV_REAL_CLAUDE=1 to run it, or pass --against-fake for a dry run against the fake claude.");
  process.exit(2);
}

const BUDGET = 0.05, TIMEOUT = 3 * 60 * 1000, MODEL = "haiku";
const plan = { mode: "plan", allowedTools: [] };
const results = [];
const check = (ok, name, detail) => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " - " + detail : ""}`); return ok; };
const encode = (p) => p.replace(/[^A-Za-z0-9]/g, "-");
const sha = (f) => { const b = fs.readFileSync(f); return { hash: crypto.createHash("sha256").update(b).digest("hex"), lines: b.toString("utf8").split("\n").filter(Boolean).length }; };

const stateDir = fake ? (process.env.FAKE_CLAUDE_STATE || fs.mkdtempSync(path.join(os.tmpdir(), "agenv-rc-state-"))) : "";
const ownState = fake && !process.env.FAKE_CLAUDE_STATE;
const runner = new ClaudeRunner(fake
  ? { bin: FAKE, env: { FAKE_CLAUDE_STATE: stateDir } }
  : {});
let totalCost = 0;
// Every call is capped and uses haiku, including those made inside ConversationForker (which asks for a larger budget).
const capped = {
  run(spec, hooks) {
    const h = runner.run({ ...spec, model: MODEL, maxBudgetUsd: BUDGET, timeoutMs: TIMEOUT }, hooks);
    return { cancel: h.cancel, done: h.done.then((r) => { totalCost += r.costUsd; return r; }) };
  },
};
const forker = new ConversationForker({ runner: capped });

const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agenv-real-check-")));
const projects = claudePaths(os.homedir()).projects;
const ids = new Set();

function findTranscript(id) {
  if (fake) { const f = path.join(stateDir, "transcripts", id + ".jsonl"); return fs.existsSync(f) ? f : null; }
  const direct = path.join(projects, encode(work), id + ".jsonl");
  if (fs.existsSync(direct)) return direct;
  try {
    for (const d of fs.readdirSync(projects)) {
      const f = path.join(projects, d, id + ".jsonl");
      if (fs.existsSync(f)) return f;
    }
  } catch {}
  return null;
}

async function main() {
  console.log(`Mode: ${fake ? "FAKE claude (no cost)" : "REAL claude, model " + MODEL + ", cap $" + BUDGET + " per call"}`);
  console.log(`Temp folder: ${work}`);
  const word = "PINEAPPLE" + crypto.randomBytes(3).toString("hex").toUpperCase();

  const src = await capped.run({ cwd: work, prompt: `Remember this code word: ${word}. Reply with only the word noted.`, permission: plan }).done;
  if (!check(src.status === "succeeded" && !!src.conversationId, "create source conversation", src.error || src.conversationId)) return;
  const sourceId = src.conversationId; ids.add(sourceId);
  const srcFile = findTranscript(sourceId);
  if (!check(!!srcFile, "source transcript located", srcFile || "not found")) return;
  const before = sha(srcFile);

  // (1) fork in plan mode, no compact
  let forkId = "";
  try {
    const f = await forker.fork({ sourceId, cwd: work, adoptionPrompt: "Reply with only the word ready.", compact: false });
    forkId = f.conversationId; ids.add(forkId);
    check(!!forkId && forkId !== sourceId, "fork under permission mode plan returns a new conversation id", forkId);
  } catch (e) { check(false, "fork under permission mode plan", e.message); }

  // (4)+(5) flag-like prompt after "--" on the fork, and the id the resumed run reports
  if (forkId) {
    const r = await capped.run({ cwd: work, prompt: "--what is the code word I gave you? Reply with only that word.", resume: forkId, permission: plan }).done;
    check(r.status === "succeeded", "flag-like prompt after -- works", r.error || "");
    if (r.conversationId) ids.add(r.conversationId);
    console.log(`INFO  resumed run session_id: ${r.conversationId} (${r.conversationId === forkId ? "same as the resumed fork id" : "NEW id, differs from the resumed fork id " + forkId})`);
    if (!fake) check(r.text.includes(word), "fork remembers the code word", JSON.stringify(r.text.slice(0, 80)));
    else console.log("INFO  code word check skipped against the fake claude");
  }

  // (2) /compact under plan mode, through the real fork+compact path
  try {
    const c = await forker.fork({ sourceId, cwd: work, adoptionPrompt: "Reply with only the word ready.", compact: true });
    ids.add(c.conversationId);
    check(true, "compact fork (/compact under --permission-mode plan)", c.conversationId);
  } catch (e) {
    if (e.orphanConversationId) ids.add(e.orphanConversationId);
    check(false, "compact fork (/compact under --permission-mode plan)", e.message);
    console.log("\n*** FINDING: /compact does NOT work under --permission-mode plan. ***");
    console.log("*** Error: " + e.message + "\n*** The controller must rule on a fallback for ConversationForker (fork+compact).\n");
  }

  // (3) source untouched
  const after = sha(srcFile);
  check(before.hash === after.hash && before.lines === after.lines, "source transcript unchanged (byte-identical)", `${before.lines} lines, sha256 ${before.hash.slice(0, 12)}`);
}

(async () => {
  try { await main(); }
  catch (e) { check(false, "unexpected error", e && e.stack || String(e)); }
  finally {
    let removed = 0;
    for (const id of ids) { const f = findTranscript(id); if (f) { try { fs.rmSync(f, { force: true }); removed++; } catch {} } }
    if (!fake) { try { fs.rmdirSync(path.join(projects, encode(work))); } catch {} }
    try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
    if (ownState) try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch {}
    console.log(`INFO  cleanup: removed ${removed} transcript(s) and the temp folder`);
    console.log(`INFO  total cost: $${totalCost.toFixed(4)}`);
    const ok = results.length > 0 && results.every(Boolean);
    console.log(ok ? "\nALL CHECKS PASSED" : "\nSOME CHECKS FAILED");
    process.exit(ok ? 0 : 1);
  }
})();
