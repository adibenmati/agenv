// test/unit/forker.test.js — ConversationForker (fork, compact, distill) against the fake claude
"use strict";
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { ClaudeRunner } = require("../../dist/agents/ClaudeRunner");
const { ConversationForker } = require("../../dist/agents/ConversationForker");
const { HttpError } = require("../../dist/core/HttpError");

const FAKE = path.join(__dirname, "..", "fixtures", "fake-claude-cli.js");
const tmp = [];
const mkdir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "agenv-fk-")); tmp.push(d); return d; };
afterEach(() => { while (tmp.length) fs.rmSync(tmp.pop(), { recursive: true, force: true }); });

const forker = (mode, state) => new ConversationForker({ runner: new ClaudeRunner({ bin: FAKE, env: { FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_STATE: state } }) });
const calls = (state) => fs.readFileSync(path.join(state, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const transcripts = (state) => { const d = path.join(state, "transcripts"); return fs.existsSync(d) ? fs.readdirSync(d).sort() : []; };
const withSource = (state, id = "src-1", body = '{"type":"user","message":"old"}\n') => {
  fs.mkdirSync(path.join(state, "transcripts"), { recursive: true });
  const p = path.join(state, "transcripts", id + ".jsonl"); fs.writeFileSync(p, body); return p;
};
const rejects = async (p, status) => {
  await assert.rejects(p, (e) => e instanceof HttpError && (status === undefined || e.status === status));
};
const dist = (o = {}) => ({ sourceId: "src-1", name: "helper", specialty: "Reviews pull requests", artifact: "briefing", overwrite: false, ...o });

describe("ConversationForker.fork", () => {
  it("fork returns a new conversation id and leaves the source transcript byte-identical", async () => {
    const state = mkdir(), cwd = mkdir(); const src = withSource(state);
    const before = fs.readFileSync(src);
    const r = await forker("ok", state).fork({ sourceId: "src-1", cwd, adoptionPrompt: "You are now Bob", compact: false });
    assert.notEqual(r.conversationId, "src-1");
    assert.match(r.conversationId, /^[0-9a-f-]{36}$/);
    assert.equal(r.costUsd, 0.0123);
    assert.ok(fs.readFileSync(src).equals(before));
    assert.ok(fs.existsSync(path.join(state, "transcripts", r.conversationId + ".jsonl")));
    const c = calls(state); assert.equal(c.length, 1);
    assert.ok(c[0].argv.includes("--fork-session"));
    assert.equal(c[0].argv[c[0].argv.indexOf("--max-budget-usd") + 1], "1");
    assert.equal(c[0].cwd, fs.realpathSync(cwd));
  });
  it("fork+compact issues the compact run on the forked id, not the source", async () => {
    const state = mkdir(), cwd = mkdir(); withSource(state);
    const r = await forker("ok", state).fork({ sourceId: "src-1", cwd, adoptionPrompt: "adopt", compact: true });
    const c = calls(state); assert.equal(c.length, 2);
    const a2 = c[1].argv;
    assert.equal(a2.at(-1), "/compact");
    assert.equal(a2[a2.indexOf("--resume") + 1], r.conversationId);
    assert.ok(!a2.includes("--fork-session"));
    assert.equal(r.costUsd, 0.0246);
  });
  it("fork failure rejects and creates no transcript for a new id", async () => {
    const state = mkdir(), cwd = mkdir(); withSource(state);
    await rejects(forker("fail", state).fork({ sourceId: "src-1", cwd, adoptionPrompt: "x", compact: false }));
    assert.deepEqual(transcripts(state), ["src-1.jsonl"]);
  });
  it("the HttpError carries the runner's error text", async () => {
    const state = mkdir(); withSource(state);
    await assert.rejects(forker("fail", state).fork({ sourceId: "src-1", cwd: mkdir(), adoptionPrompt: "x", compact: false }), /fake claude exploded/);
  });
  it('adoption prompt starting with "/" is not treated as a command', async () => {
    const state = mkdir(); withSource(state);
    await forker("ok", state).fork({ sourceId: "src-1", cwd: mkdir(), adoptionPrompt: "/compact me", compact: false });
    const a = calls(state)[0].argv;
    assert.equal(a[a.length - 2], "--"); assert.equal(a.at(-1), "/compact me");
    assert.equal(a.indexOf("--"), a.length - 2);
  });
});

describe("ConversationForker.distill", () => {
  it("distill briefing writes <cwd>/.claude/agenv-briefings/<name>.md with the answer text", async () => {
    const state = mkdir(), cwd = mkdir(); withSource(state);
    const r = await forker("ok", state).distill({ ...dist(), cwd });
    const file = path.join(cwd, ".claude", "agenv-briefings", "helper.md");
    assert.equal(r.artifactPath, file);
    assert.match(fs.readFileSync(file, "utf8"), /^reply to: /);
    assert.equal(r.costUsd, 0.0123);
    const a = calls(state)[0].argv;
    assert.equal(a[a.indexOf("--permission-mode") + 1], "plan");
    assert.ok(a.includes("--fork-session"));
    assert.equal(a[a.indexOf("--max-budget-usd") + 1], "1");
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["helper.md"]);
  });
  it("distill skill writes SKILL.md with name and description front-matter", async () => {
    const state = mkdir(), cwd = mkdir(); withSource(state);
    const r = await forker("ok", state).distill({ ...dist({ specialty: "Reviews: pull\nrequests" }), cwd, artifact: "skill" });
    const file = path.join(cwd, ".claude", "skills", "helper", "SKILL.md");
    assert.equal(r.artifactPath, file);
    const t = fs.readFileSync(file, "utf8");
    assert.match(t, /^---\r?\nname: helper\r?\ndescription: .*\r?\n---\r?\n/);
    assert.match(t, /Reviews/);
    const fm = t.split(/\r?\n---\r?\n/)[0];
    assert.equal(fm.split(/\r?\n/).length, 3);   // newline in specialty cannot break the front-matter
    assert.match(t, /reply to: /);
  });
  it("distill refuses to overwrite an existing file unless overwrite is true", async () => {
    const state = mkdir(), cwd = mkdir(); withSource(state);
    const file = path.join(cwd, ".claude", "agenv-briefings", "helper.md");
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "MINE");
    await rejects(forker("ok", state).distill({ ...dist(), cwd }), 409);
    assert.equal(fs.readFileSync(file, "utf8"), "MINE");
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["helper.md"]);
    await forker("ok", state).distill({ ...dist({ overwrite: true }), cwd });
    assert.match(fs.readFileSync(file, "utf8"), /^reply to: /);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["helper.md"]);
  });
  it("distill rejects a name that would leave cwd", async () => {
    const state = mkdir(), cwd = mkdir(); withSource(state);
    for (const name of ["..", "../evil", "a/b", "a\\b", ".", "", "a b", "x".repeat(49), "C:evil"]) {
      await rejects(forker("ok", state).distill({ ...dist({ name }), cwd }), 400);
    }
    assert.ok(!fs.existsSync(path.join(state, "calls.jsonl")));   // rejected before any run
    assert.deepEqual(fs.readdirSync(cwd), []);
  });
  it("distill failure or budget exhaustion leaves no file and no empty directory", async () => {
    for (const mode of ["fail", "budget", "maxturns"]) {
      for (const artifact of ["briefing", "skill"]) {
        const state = mkdir(), cwd = mkdir(); withSource(state);
        await rejects(forker(mode, state).distill({ ...dist(), cwd, artifact }), mode === "budget" ? 502 : undefined);
        assert.deepEqual(fs.readdirSync(cwd), [], mode + "/" + artifact);
      }
    }
    const state = mkdir(), cwd = mkdir(); withSource(state);
    await assert.rejects(forker("budget", state).distill({ ...dist(), cwd }), /budget/i);
  });
  it("an empty answer is a failure and leaves nothing behind", async () => {
    const state = mkdir(), cwd = mkdir(); withSource(state);
    // fake claude answers "" to /compact; use it as the empty-answer source via a fork+compact style prompt is not possible,
    // so exercise the guard through the source id path instead: a blank-only reply
    const f = new ConversationForker({ runner: { run: () => ({ done: Promise.resolve({ status: "succeeded", conversationId: "n", text: "  \n", costUsd: 0, numTurns: 1, durationMs: 1, exitCode: 0 }), cancel() {} }) } });
    await rejects(f.distill({ ...dist(), cwd }), 502);
    assert.deepEqual(fs.readdirSync(cwd), []);
  });
});

describe("ConversationForker hardening", () => {
  const spy = (mode, state) => {
    const real = new ClaudeRunner({ bin: FAKE, env: { FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_STATE: state } });
    const specs = [];
    return { specs, f: new ConversationForker({ runner: { run: (spec, h) => { specs.push(spec); return real.run(spec, h); } } }) };
  };
  const mode = (c) => c.argv[c.argv.indexOf("--permission-mode") + 1];

  it("fork and compact runs are read-only (plan mode, no allowed tools)", async () => {
    const state = mkdir(), cwd = mkdir(); withSource(state);
    await forker("ok", state).fork({ sourceId: "src-1", cwd, adoptionPrompt: "adopt", compact: true });
    const c = calls(state); assert.equal(c.length, 2);
    for (const x of c) { assert.equal(mode(x), "plan"); assert.ok(!x.argv.includes("--allowedTools")); }
  });
  it("the fork run carries a 5-minute timeout and the 1 USD budget", async () => {
    const state = mkdir(); withSource(state);
    const { specs, f } = spy("ok", state);
    await f.fork({ sourceId: "src-1", cwd: mkdir(), adoptionPrompt: "a", compact: true });
    assert.equal(specs.length, 2);
    for (const s of specs) { assert.equal(s.timeoutMs, 300000); assert.equal(s.maxBudgetUsd, 1); }
  });
  it("rejects Windows reserved device names before any run, accepts names that merely contain them", async () => {
    const state = mkdir(), cwd = mkdir(); withSource(state);
    for (const name of ["CON", "nul", "com1", "Lpt9.md", "aux", "PRN", "COM9", "con.md"]) {
      await rejects(forker("ok", state).distill({ ...dist({ name }), cwd }), 400);
    }
    assert.ok(!fs.existsSync(path.join(state, "calls.jsonl")));
    for (const name of ["connector", "console", "com10", "lpt0", "auxiliary"]) {
      await forker("ok", state).distill({ ...dist({ name }), cwd });
      assert.ok(fs.existsSync(path.join(cwd, ".claude", "agenv-briefings", name + ".md")));
    }
  });
  it("refuses a .claude link that leaves cwd, before any run", async (t) => {
    const state = mkdir(), cwd = mkdir(), outside = mkdir(); withSource(state);
    try { fs.symlinkSync(outside, path.join(cwd, ".claude"), "junction"); } catch (e) { return t.skip("cannot create a link here: " + e.code); }
    for (const artifact of ["briefing", "skill"]) await rejects(forker("ok", state).distill({ ...dist(), cwd, artifact }), 400);
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.ok(!fs.existsSync(path.join(state, "calls.jsonl")));
  });
  it("a link swapped in during the run is caught before writing", async (t) => {
    const state = mkdir(), cwd = mkdir(), outside = mkdir(); withSource(state);
    const real = new ClaudeRunner({ bin: FAKE, env: { FAKE_CLAUDE_MODE: "ok", FAKE_CLAUDE_STATE: state } });
    let swapped = true;
    const f = new ConversationForker({ runner: { run: (spec, h) => {
      const handle = real.run(spec, h);
      return { cancel: handle.cancel, done: handle.done.then((r) => {
        try { fs.symlinkSync(outside, path.join(cwd, ".claude"), "junction"); } catch { swapped = false; }
        return r;
      }) };
    } } });
    const p = f.distill({ ...dist(), cwd });
    await rejects(p, 400);
    if (!swapped) return t.skip("cannot create a link here");
    assert.deepEqual(fs.readdirSync(outside), []);
  });
  it("without overwrite, a file appearing during the run is not replaced (409)", async () => {
    const state = mkdir(), cwd = mkdir(); withSource(state);
    const file = path.join(cwd, ".claude", "agenv-briefings", "helper.md");
    const real = new ClaudeRunner({ bin: FAKE, env: { FAKE_CLAUDE_MODE: "ok", FAKE_CLAUDE_STATE: state } });
    const f = new ConversationForker({ runner: { run: (spec, h) => {
      const handle = real.run(spec, h);
      return { cancel: handle.cancel, done: handle.done.then((r) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "MINE"); return r; }) };
    } } });
    await rejects(f.distill({ ...dist(), cwd }), 409);
    assert.equal(fs.readFileSync(file, "utf8"), "MINE");
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["helper.md"]);
  });
  it("a late failure (transcript written, then exit 1) rejects", async () => {
    const state = mkdir(); withSource(state);
    await assert.rejects(forker("fail-late", state).fork({ sourceId: "src-1", cwd: mkdir(), adoptionPrompt: "x", compact: false }), (e) => e instanceof HttpError && /died late/.test(e.message) && e.orphanConversationId === undefined);
  });
  it("compact failing after a successful fork rejects with orphanConversationId", async () => {
    const state = mkdir(); withSource(state);
    await assert.rejects(forker("fail-compact", state).fork({ sourceId: "src-1", cwd: mkdir(), adoptionPrompt: "x", compact: true }), (e) => {
      assert.ok(e instanceof HttpError);
      assert.match(e.orphanConversationId, /^[0-9a-f-]{36}$/);
      assert.ok(fs.existsSync(path.join(state, "transcripts", e.orphanConversationId + ".jsonl")));
      return true;
    });
  });
});
