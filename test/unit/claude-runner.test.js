// test/unit/claude-runner.test.js — buildArgs and the headless ClaudeRunner against the fake claude
"use strict";
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { buildArgs, ClaudeRunner } = require("../../dist/agents/ClaudeRunner");

const FAKE = path.join(__dirname, "..", "fixtures", "fake-claude-cli.js");
const tmp = [];
const mkdir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "agenv-cr-")); tmp.push(d); return d; };
afterEach(() => { while (tmp.length) fs.rmSync(tmp.pop(), { recursive: true, force: true }); });

const spec = (o = {}) => ({
  cwd: os.tmpdir(), prompt: "hello", permission: { mode: "acceptEdits", allowedTools: [] },
  maxBudgetUsd: 1, timeoutMs: 20000, ...o,
});
const runner = (mode, state) => new ClaudeRunner({ bin: FAKE, env: { FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_STATE: state } });
const calls = (state) => fs.readFileSync(path.join(state, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (fn, ms = 8000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error("timeout waiting"); await new Promise((r) => setTimeout(r, 50)); } };
const childPid = (state) => Number(fs.readFileSync(path.join(state, "child.pid"), "utf8"));

describe("buildArgs", () => {
  it("includes -p, --output-format stream-json, --verbose, --permission-mode, --max-budget-usd", () => {
    const a = buildArgs(spec());
    assert.equal(a[0], "-p");
    assert.deepEqual(a.slice(a.indexOf("--output-format"), a.indexOf("--output-format") + 2), ["--output-format", "stream-json"]);
    assert.ok(a.includes("--verbose"));
    assert.equal(a[a.indexOf("--permission-mode") + 1], "acceptEdits");
    assert.equal(a[a.indexOf("--max-budget-usd") + 1], "1");
  });
  it("adds --resume and --fork-session only when asked", () => {
    assert.ok(!buildArgs(spec()).includes("--resume"));
    assert.ok(!buildArgs(spec({ resume: "abc" })).includes("--fork-session"));
    const a = buildArgs(spec({ resume: "abc", fork: true }));
    assert.equal(a[a.indexOf("--resume") + 1], "abc");
    assert.ok(a.includes("--fork-session"));
    assert.ok(!buildArgs(spec({ fork: true })).includes("--fork-session"));
  });
  it('puts the prompt last and keeps a leading "/" or "-" intact after "--"', () => {
    for (const p of ["/compact", "-hello", "plain"]) {
      const a = buildArgs(spec({ prompt: p, model: "opus", instructions: "be nice" }));
      assert.equal(a[a.length - 1], p);
      assert.equal(a[a.length - 2], "--");
      assert.equal(a.indexOf("--"), a.length - 2);
    }
  });
  it("allowedTools are passed with --allowedTools", () => {
    const a = buildArgs(spec({ permission: { mode: "dontAsk", allowedTools: ["Read", "Bash(git:*)"] } }));
    assert.equal(a[a.indexOf("--allowedTools") + 1], "Read,Bash(git:*)");
    assert.ok(!buildArgs(spec()).includes("--allowedTools"));
  });
  it("passes optional model, instructions, briefing, add-dirs and mcp config", () => {
    const a = buildArgs(spec({ model: "m", instructions: "i", briefingFile: "b.md", addDirs: ["x", "y"], mcpConfig: "c.json" }));
    assert.equal(a[a.indexOf("--model") + 1], "m");
    assert.equal(a[a.indexOf("--append-system-prompt") + 1], "i");
    assert.equal(a[a.indexOf("--append-system-prompt-file") + 1], "b.md");
    assert.deepEqual(a.filter((x, i) => a[i - 1] === "--add-dir"), ["x", "y"]);
    assert.equal(a[a.indexOf("--mcp-config") + 1], "c.json");
  });
});

describe("ClaudeRunner", () => {
  it("run resolves succeeded with session_id, cost, turns from the result event", async () => {
    const state = mkdir(); const events = [];
    const r = await runner("ok", state).run(spec({ prompt: "-hi" }), { onEvent: (e) => events.push(e.type) }).done;
    assert.equal(r.status, "succeeded");
    assert.match(r.conversationId, /^[0-9a-f-]{36}$/);
    assert.equal(r.text, "reply to: -hi");
    assert.equal(r.costUsd, 0.0123);
    assert.equal(r.numTurns, 1);
    assert.equal(r.exitCode, 0);
    assert.deepEqual(events, ["system", "assistant", "result"]);
    assert.equal(calls(state)[0].argv.at(-1), "-hi");
  });
  it("resume with fork yields a new conversation and leaves the source transcript untouched", async () => {
    const state = mkdir();
    fs.mkdirSync(path.join(state, "transcripts"));
    const src = path.join(state, "transcripts", "src-1.jsonl");
    fs.writeFileSync(src, '{"type":"user","message":"old"}\n');
    const r = await runner("ok", state).run(spec({ resume: "src-1", fork: true, prompt: "/compact" })).done;
    assert.equal(r.status, "succeeded");
    assert.notEqual(r.conversationId, "src-1");
    assert.equal(r.text, ""); assert.equal(r.numTurns, 0);
    assert.equal(fs.readFileSync(src, "utf8"), '{"type":"user","message":"old"}\n');
    assert.match(fs.readFileSync(path.join(state, "transcripts", r.conversationId + ".jsonl"), "utf8"), /old/);
  });
  it("run in fail mode resolves failed with the stderr text", async () => {
    const r = await runner("fail", mkdir()).run(spec()).done;
    assert.equal(r.status, "failed");
    assert.equal(r.exitCode, 1);
    assert.match(r.error, /fake claude exploded/);
  });
  it("budget subtype resolves failed with a budget message", async () => {
    const r = await runner("budget", mkdir()).run(spec()).done;
    assert.equal(r.status, "failed");
    assert.match(r.error, /budget/i);
  });
  it("garbage lines are logged to logPath and do not fail the run", async () => {
    const logPath = path.join(mkdir(), "run.log");
    const r = await runner("garbage", mkdir()).run(spec({ logPath })).done;
    assert.equal(r.status, "succeeded");
    const log = fs.readFileSync(logPath, "utf8");
    assert.match(log, /not json at all/); assert.match(log, /\{broken/);
  });
  it("timeout kills the whole tree", async () => {
    const state = mkdir();
    const r = await runner("hang", state).run(spec({ timeoutMs: 1500 })).done;
    assert.equal(r.status, "timed_out");
    await until(() => !alive(childPid(state)));
  });
  it("cancel() resolves cancelled and kills the tree", async () => {
    const state = mkdir();
    const h = runner("hang", state).run(spec());
    await until(() => fs.existsSync(path.join(state, "child.pid")));
    h.cancel();
    const r = await h.done;
    assert.equal(r.status, "cancelled");
    await until(() => !alive(childPid(state)));
  });
  it("log file is capped at 5 MB keeping the tail, starting on a line boundary", async () => {
    const logPath = path.join(mkdir(), "run.log");
    const r = await runner("noisy", mkdir()).run(spec({ logPath })).done;
    assert.equal(r.status, "succeeded");
    const text = fs.readFileSync(logPath, "utf8");
    assert.ok(Buffer.byteLength(text) <= 5 * 1024 * 1024);
    assert.match(text, /LAST-MARKER/);
    assert.doesNotMatch(text, /FIRST-MARKER/);
    const lines = text.split("\n");
    assert.equal(lines[0], "x".repeat(1023));
  });
  it("the log is on disk while the run is still in progress", async () => {
    const logPath = path.join(mkdir(), "sub", "run.log");
    const h = runner("slow", mkdir()).run(spec({ logPath }));
    let finished = false; h.done.then(() => { finished = true; });
    await until(() => fs.existsSync(logPath) && fs.readFileSync(logPath, "utf8").includes("SLOW-FIRST-LINE"));
    assert.equal(finished, false);
    assert.equal((await h.done).status, "succeeded");
  });
  it("a normal success run logs every event line and prefixes stderr", async () => {
    const logPath = path.join(mkdir(), "run.log");
    await runner("ok", mkdir()).run(spec({ logPath })).done;
    const log = fs.readFileSync(logPath, "utf8");
    assert.match(log, /"type":"assistant"/); assert.match(log, /"type":"result"/);
    const failLog = path.join(mkdir(), "f.log");
    await runner("fail", mkdir()).run(spec({ logPath: failLog })).done;
    assert.match(fs.readFileSync(failLog, "utf8"), /\[stderr\] fake claude exploded/);
  });
  it("a result with a non-success subtype is failed even when is_error is false", async () => {
    const r = await runner("maxturns", mkdir()).run(spec()).done;
    assert.equal(r.status, "failed");
    assert.match(r.error, /error_max_turns/);
  });
  it("an endless line without a newline does not grow memory unbounded or break the run", async () => {
    const r = await runner("longline", mkdir()).run(spec()).done;
    assert.equal(r.status, "succeeded");
  });
  it("a .js bin is spawned through process.execPath", async () => {
    const state = mkdir();
    const r = await runner("ok", state).run(spec()).done;
    assert.equal(r.status, "succeeded");
    assert.equal(calls(state).length, 1);
  });
  it("reports failed when the binary cannot start", async () => {
    const r = await new ClaudeRunner({ bin: path.join(os.tmpdir(), "no-such-claude-bin") }).run(spec()).done;
    assert.equal(r.status, "failed");
    assert.ok(r.error);
  });
});
