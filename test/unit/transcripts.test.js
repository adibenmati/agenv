// test/unit/transcripts.test.js — TranscriptScanner, UsageService, SessionIndex
"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { TranscriptScanner } = require("../../dist/claude/TranscriptScanner");
const { UsageService } = require("../../dist/claude/UsageService");
const { SessionIndex } = require("../../dist/claude/SessionIndex");
const { claudePaths, decodeClaudeProjectPath } = require("../../dist/claude/paths");

const line = (o) => JSON.stringify(o) + "\n";
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "agenv-t-"));
const user = (ts, text, extra = {}) => line({ type: "user", timestamp: ts, message: { role: "user", content: text }, ...extra });
const asst = (ts, id, model, usage, extra = {}) => line({ type: "assistant", timestamp: ts, message: { id, role: "assistant", model, usage, content: [{ type: "text", text: "ok" }] }, ...extra });

function setup(files) {
  const home = tmpHome(); const paths = claudePaths(home);
  for (const [rel, content] of Object.entries(files)) { const p = path.join(paths.projects, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); }
  const scanner = new TranscriptScanner(paths.projects);
  let scans = 0; const orig = scanner.scan.bind(scanner); scanner.scan = (...a) => { scans++; return orig(...a); };
  return { home, paths, scanner, scans: () => scans, file: (rel) => path.join(paths.projects, rel) };
}

describe("paths", () => {
  it("derives the Claude folders from the home directory", () => {
    const p = claudePaths("/h"); assert.equal(p.projects, path.join("/h", ".claude", "projects")); assert.equal(p.sessions, path.join("/h", ".claude", "sessions"));
    assert.equal(p.indexFile, path.join("/h", ".claude", "agenv-session-index.json"));
  });
  it("decodes an encoded project directory name", () => {
    assert.equal(decodeClaudeProjectPath("C--Projects-remotecontrol"), "C:\\Projects\\remotecontrol");
  });
});

describe("TranscriptScanner", () => {
  it("returns the offset after the last newline and reads only appended lines on a rescan", async () => {
    const { scanner, file } = setup({ "p/a.jsonl": line({ n: 1 }) + line({ n: 2 }) });
    const seen = []; const off = await scanner.scan(file("p/a.jsonl"), 0, (e) => seen.push(e.n));
    assert.deepEqual(seen, [1, 2]); assert.equal(off, fs.statSync(file("p/a.jsonl")).size);
    fs.appendFileSync(file("p/a.jsonl"), line({ n: 3 }));
    const more = []; const off2 = await scanner.scan(file("p/a.jsonl"), off, (e) => more.push(e.n));
    assert.deepEqual(more, [3]); assert.equal(off2, fs.statSync(file("p/a.jsonl")).size);
  });
  it("consumes an unterminated tail only when it is valid JSON", async () => {
    const { scanner, file } = setup({ "p/a.jsonl": line({ n: 1 }) + '{"n":2}' });
    const seen = []; const off = await scanner.scan(file("p/a.jsonl"), 0, (e) => seen.push(e.n));
    assert.deepEqual(seen, [1, 2]); assert.equal(off, fs.statSync(file("p/a.jsonl")).size);
    const half = setup({ "p/b.jsonl": line({ n: 1 }) + '{"n":2,"tru' });
    const s2 = []; const o2 = await half.scanner.scan(half.file("p/b.jsonl"), 0, (e) => s2.push(e.n));
    assert.deepEqual(s2, [1]); assert.equal(o2, Buffer.byteLength(line({ n: 1 })), "offset stops before the half-written line");
  });
  it("skips malformed and blank lines", async () => {
    const { scanner, file } = setup({ "p/a.jsonl": line({ n: 1 }) + "not json\n\n   \n" + line({ n: 2 }) });
    const seen = []; await scanner.scan(file("p/a.jsonl"), 0, (e) => seen.push(e.n)); assert.deepEqual(seen, [1, 2]);
  });
  it("stops early when the callback returns 'stop'", async () => {
    const { scanner, file } = setup({ "p/a.jsonl": line({ n: 1 }) + line({ n: 2 }) + line({ n: 3 }) });
    const seen = []; await scanner.scan(file("p/a.jsonl"), 0, (e) => { seen.push(e.n); if (e.n === 2) return "stop"; });
    assert.deepEqual(seen, [1, 2]);
  });
  it("handles lines that straddle read chunks and multi-byte characters", async () => {
    const big = "é".repeat(700000);   // 1.4 MB single line > the 1 MiB read size
    const { scanner, file } = setup({ "p/a.jsonl": line({ n: 1, big }) + line({ n: 2 }) });
    const seen = []; await scanner.scan(file("p/a.jsonl"), 0, (e) => seen.push([e.n, e.big ? e.big.length : 0])); assert.deepEqual(seen, [[1, 700000], [2, 0]]);
  });
  it("lists .jsonl files up to depth 5 and nothing else", async () => {
    const { scanner, file } = setup({ "a/x.jsonl": "{}\n", "a/b/c/d/e/f/deep.jsonl": "{}\n", "a/b/y.jsonl": "{}\n", "a/notes.txt": "x" });
    const found = (await scanner.listFiles()).map((f) => path.relative(path.dirname(file("a/x.jsonl")), f).replace(/\\/g, "/")).sort();
    assert.deepEqual(found, ["b/y.jsonl", "x.jsonl"], "a/b/c/d/e/f is depth 6 → excluded");
    assert.deepEqual(await new TranscriptScanner(path.join(tmpHome(), "missing")).listFiles(), []);
  });
  it("reads just the first line, with or without a trailing newline", () => {
    const { scanner, file } = setup({ "p/a.jsonl": line({ first: true }) + "x".repeat(200000) + "\n", "p/b.jsonl": '{"only":1}' });
    assert.equal(scanner.firstLine(file("p/a.jsonl")), '{"first":true}'); assert.equal(scanner.firstLine(file("p/b.jsonl")), '{"only":1}');
  });
});

describe("UsageService", () => {
  const T0 = "2026-01-01T00:00:00Z";
  it("aggregates totals, models, days, sessions, providers and first/last seen", async () => {
    const { scanner } = setup({ "p/a.jsonl":
      user(T0, "hi") + asst("2026-01-01T00:00:01Z", "msg_1", "claude-sonnet-4", { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 1000 }) +
      asst("2026-01-02T00:00:00Z", "msg_2", "claude-opus-4", { input_tokens: 5, output_tokens: 1 }),
      "q/b.jsonl": asst("2026-01-03T00:00:00Z", "msg_bdrk_3", "claude-haiku-4", { input_tokens: 1000000, output_tokens: 1000000 }) });
    const r = await new UsageService(scanner, 0).query({});
    assert.equal(r.totals.messages, 3); assert.equal(r.totals.input, 1000105); assert.equal(r.totals.cacheRead, 1000);
    assert.deepEqual(Object.keys(r.models).sort(), ["claude-haiku-4", "claude-opus-4", "claude-sonnet-4"]);
    assert.deepEqual(Object.keys(r.daily).sort(), ["2026-01-01", "2026-01-02", "2026-01-03"]);
    assert.deepEqual(r.providers, { anthropic: 2, bedrock: 1 });
    assert.equal(r.firstSeen, "2026-01-01T00:00:00.000Z"); assert.equal(r.lastSeen, "2026-01-03T00:00:00.000Z");
    assert.deepEqual(r.sessions.map((s) => s.file), ["b.jsonl", "a.jsonl"], "sorted by cost, most expensive first");
  });
  it("prices a Bedrock message id from the bedrock table and honors a provider override", async () => {
    const { scanner } = setup({ "p/a.jsonl": asst(T0, "msg_bdrk_1", "claude-haiku-4", { input_tokens: 1000000, output_tokens: 1000000 }) });
    const svc = new UsageService(scanner, 0);
    assert.ok(Math.abs((await svc.query({})).totals.cost - (0.80 + 4)) < 1e-9, "bedrock haiku: $0.80 in + $4 out per M");
    assert.ok(Math.abs((await svc.query({ provider: "anthropic" })).totals.cost - (0.25 + 0.65)) < 1e-9, "override → anthropic haiku rates");
  });
  it("filters by date with an exclusive end, and never drops entries without a timestamp", async () => {
    const { scanner } = setup({ "p/a.jsonl":
      asst("2026-01-01T00:00:00Z", "m1", "claude-sonnet-4", { input_tokens: 1, output_tokens: 0 }) + asst("2026-01-02T00:00:00Z", "m2", "claude-sonnet-4", { input_tokens: 10, output_tokens: 0 }) +
      line({ message: { id: "m3", model: "claude-sonnet-4", usage: { input_tokens: 100, output_tokens: 0 } } }) });
    const svc = new UsageService(scanner, 0);
    assert.equal((await svc.query({ from: "2026-01-02T00:00:00Z" })).totals.input, 110);
    assert.equal((await svc.query({ to: "2026-01-02T00:00:00Z" })).totals.input, 101, "the end instant itself is excluded");
    assert.equal((await svc.query({ from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z" })).totals.input, 101);
  });
  it("picks up appended lines and re-reads a transcript that was rewritten shorter", async () => {
    const { scanner, file } = setup({ "p/a.jsonl": asst(T0, "m1", "claude-sonnet-4", { input_tokens: 100, output_tokens: 0 }) });
    const svc = new UsageService(scanner, 0);
    assert.equal((await svc.query({})).totals.input, 100);
    fs.appendFileSync(file("p/a.jsonl"), asst(T0, "m2", "claude-sonnet-4", { input_tokens: 50, output_tokens: 0 }));
    assert.equal((await svc.query({})).totals.input, 150);
    fs.writeFileSync(file("p/a.jsonl"), asst(T0, "m3", "claude-sonnet-4", { input_tokens: 7, output_tokens: 0 }));
    assert.equal((await svc.query({})).totals.input, 7);
  });
  it("forgets a transcript that was deleted", async () => {
    const { scanner, file } = setup({ "p/a.jsonl": asst(T0, "m1", "claude-sonnet-4", { input_tokens: 100, output_tokens: 0 }), "p/b.jsonl": asst(T0, "m2", "claude-sonnet-4", { input_tokens: 1, output_tokens: 0 }) });
    const svc = new UsageService(scanner, 0); assert.equal((await svc.query({})).totals.input, 101);
    fs.unlinkSync(file("p/a.jsonl")); assert.equal((await svc.query({})).totals.input, 1);
  });
  it("concurrent queries share one scan, and an unchanged transcript is not re-read", async () => {
    const { scanner, scans } = setup({ "p/a.jsonl": asst(T0, "m1", "claude-sonnet-4", { input_tokens: 1, output_tokens: 0 }) });
    const svc = new UsageService(scanner, 0);
    await Promise.all([svc.query({}), svc.query({}), svc.query({})]); assert.equal(scans(), 1);
    await svc.query({}); assert.equal(scans(), 1, "unchanged file → not scanned again");
  });
  it("an empty or missing projects folder gives an empty result", async () => {
    const r = await new UsageService(new TranscriptScanner(path.join(tmpHome(), "none")), 0).query({});
    assert.equal(r.totals.messages, 0); assert.equal(r.firstSeen, null); assert.equal(r.lastSeen, null); assert.deepEqual(r.sessions, []);
  });
});

describe("SessionIndex", () => {
  const convo = () =>
    user("2026-01-01T00:00:00Z", "refactor the parser", { cwd: "C:\\proj", gitBranch: "feat/x", slug: "parser-work", sessionId: "abc" }) +
    asst("2026-01-01T00:00:05Z", "msg_1", "claude-sonnet-4", { input_tokens: 100, output_tokens: 10 }) +
    line({ type: "assistant", timestamp: "2026-01-01T00:00:06Z", message: { role: "assistant", model: "claude-sonnet-4", content: [{ type: "tool_use", name: "Bash", input: { command: "npm test\nsecond line" } }, { type: "text", text: "Running the parser tests now" }] } });
  const mkIndex = (s, extra = {}) => new SessionIndex(s.scanner, { projects: s.paths.projects, indexFile: s.paths.indexFile, ...extra });

  it("indexes a conversation: counts, model, tokens, branch, commands, keywords, summary", async () => {
    const s = setup({ "C--proj/abc.jsonl": convo() }); const [c] = await mkIndex(s).build(true);
    assert.equal(c.id, "abc"); assert.equal(c.project, "C--proj"); assert.equal(c.projectPath, "C:\\proj");
    assert.equal(c.userMessageCount, 1); assert.equal(c.messageCount, 3); assert.equal(c.model, "claude-sonnet-4");
    assert.equal(c.branch, "feat/x"); assert.equal(c.slug, "parser-work"); assert.equal(c.cwd, "C:\\proj"); assert.equal(c.entrypoint, "cli");
    assert.equal(c.totalInputTokens, 100); assert.equal(c.totalOutputTokens, 10);
    assert.deepEqual(c.commands, ["npm test"]); assert.ok(c.keywords.includes("parser")); assert.equal(c.summary, "refactor the parser");
    assert.equal(c.firstMessage, "2026-01-01T00:00:00Z"); assert.equal(c.lastMessage, "2026-01-01T00:00:06Z");
  });
  it("skips conversations without a user message", async () => {
    const s = setup({ "p/none.jsonl": asst("2026-01-01T00:00:00Z", "m", "claude-sonnet-4", { input_tokens: 1, output_tokens: 1 }) });
    assert.deepEqual(await mkIndex(s).build(true), []);
  });
  it("concurrent builds share one pass, unchanged files are not re-indexed, changed ones are", async () => {
    const s = setup({ "C--proj/abc.jsonl": convo(), "C--proj/def.jsonl": convo() });
    const idx = mkIndex(s);
    await Promise.all([idx.build(true), idx.build(true), idx.build(true)]); assert.equal(s.scans(), 2, "one scan per file, not per caller");
    await idx.build(true); assert.equal(s.scans(), 2, "forced rebuild still reuses unchanged files");
    fs.appendFileSync(s.file("C--proj/abc.jsonl"), user("2026-01-02T00:00:00Z", "one more thing"));
    const list = await idx.build(true); assert.equal(s.scans(), 3);
    assert.equal(list.find((c) => c.id === "abc").userMessageCount, 2);
  });
  it("persists the index so a new instance does not re-read unchanged transcripts", async () => {
    const s = setup({ "C--proj/abc.jsonl": convo() }); await mkIndex(s).build(true); const before = s.scans();
    const second = mkIndex(s); const list = await second.build(true);
    assert.equal(s.scans(), before); assert.equal(list.length, 1); assert.equal(list[0].id, "abc");
  });
  it("sorts newest conversation first and drops a deleted transcript", async () => {
    const s = setup({ "p/old.jsonl": user("2026-01-01T00:00:00Z", "old one"), "p/new.jsonl": user("2026-02-01T00:00:00Z", "new one") });
    const idx = mkIndex(s); assert.deepEqual((await idx.build(true)).map((c) => c.id), ["new", "old"]);
    fs.unlinkSync(s.file("p/new.jsonl")); assert.deepEqual((await idx.build(true)).map((c) => c.id), ["old"]);
  });
  it("search ranks by keyword, summary, files, commands, project, branch and slug", async () => {
    const s = setup({ "C--proj/abc.jsonl": convo(), "C--other/zzz.jsonl": user("2026-03-01T00:00:00Z", "unrelated topic entirely") });
    const idx = mkIndex(s);
    const hits = await idx.search("parser"); assert.equal(hits.length, 1); assert.equal(hits[0].id, "abc");
    assert.equal(hits[0].score, 10 + 5 + 1, "keyword 10 + summary 5 + slug 1");
    assert.deepEqual(await idx.search("   "), []); assert.deepEqual(await idx.search("nomatchatall"), []);
    assert.equal((await idx.search("feat")).find((h) => h.id === "abc").score, 2, "branch only");
  });
  it("conversation() returns user and assistant text, capped at 100 entries; unknown ids give null", async () => {
    let body = ""; for (let i = 0; i < 150; i++) body += user(`2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`, "msg " + i);
    const s = setup({ "C--proj/abc.jsonl": body, "C--proj/def.jsonl": convo() }); const idx = mkIndex(s);
    const big = await idx.conversation("abc"); assert.equal(big.entries.length, 100); assert.equal(big.entries[0].text, "msg 0");
    const small = await idx.conversation("def"); assert.deepEqual(small.entries.map((e) => e.type), ["user", "assistant", "assistant"]);
    assert.deepEqual(small.entries.map((e) => e.text), ["refactor the parser", "ok", "Running the parser tests now"], "tool_use blocks carry no text and are not listed");
    assert.equal(await idx.conversation("nope"), null);
  });
});
