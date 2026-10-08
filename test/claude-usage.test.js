// test/claude-usage.test.js — Claude transcript scanning (usage, index, CLAUDE.md list)
"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { startServer, makeTempHome, get } = require("./helpers");

function usageLine(id, ts, input, output, model = "claude-sonnet-4") {
  return JSON.stringify({
    type: "assistant", timestamp: ts, cwd: "/tmp/proj",
    message: { id, role: "assistant", model, usage: { input_tokens: input, output_tokens: output }, content: [{ type: "text", text: "ok" }] },
  }) + "\n";
}
function userLine(ts, text) {
  return JSON.stringify({ type: "user", timestamp: ts, cwd: "/tmp/proj", message: { role: "user", content: text } }) + "\n";
}

describe("Claude transcript scanning", () => {
  let server, projDir, transcript;

  before(async () => {
    const home = makeTempHome();
    projDir = path.join(home, ".claude", "projects", "proj");
    fs.mkdirSync(projDir, { recursive: true });
    transcript = path.join(projDir, "abc.jsonl");
    fs.writeFileSync(transcript,
      userLine("2026-01-01T00:00:00Z", "refactor the parser") +
      usageLine("msg_1", "2026-01-01T00:00:01Z", 100, 10) +
      "not json\n");
    server = await startServer({ home, env: { AGENV_USAGE_REFRESH_MS: "0" } });
  });

  after(() => server.stop());

  it("aggregates usage across transcripts", async () => {
    const r = await get("/api/claude-usage", { port: server.port });
    assert.equal(r.status, 200);
    assert.equal(r.body.totals.messages, 1);
    assert.equal(r.body.totals.input, 100);
    assert.equal(r.body.firstSeen, "2026-01-01T00:00:00.000Z");
  });

  it("picks up lines appended to a transcript, including an unterminated last line", async () => {
    fs.appendFileSync(transcript, usageLine("msg_2", "2026-01-02T00:00:00Z", 50, 5).trimEnd());
    let r = await get("/api/claude-usage", { port: server.port });
    assert.equal(r.body.totals.messages, 2);
    assert.equal(r.body.totals.input, 150);

    // The unterminated line must not be counted twice once it gets its newline.
    fs.appendFileSync(transcript, "\n" + usageLine("msg_3", "2026-01-03T00:00:00Z", 1, 1));
    r = await get("/api/claude-usage", { port: server.port });
    assert.equal(r.body.totals.messages, 3);
    assert.equal(r.body.totals.input, 151);
  });

  it("filters by date range", async () => {
    const r = await get("/api/claude-usage?from=2026-01-02&to=2026-01-03", { port: server.port });
    assert.equal(r.body.totals.messages, 1);
    assert.equal(r.body.totals.input, 50);
  });

  it("re-reads a transcript that was rewritten shorter", async () => {
    fs.writeFileSync(transcript, usageLine("msg_9", "2026-02-01T00:00:00Z", 7, 7));
    const r = await get("/api/claude-usage", { port: server.port });
    assert.equal(r.body.totals.messages, 1);
    assert.equal(r.body.totals.input, 7);
  });

  it("indexes sessions and serves concurrent requests from one build", async () => {
    fs.writeFileSync(transcript, userLine("2026-03-01T00:00:00Z", "refactor the parser") + usageLine("msg_a", "2026-03-01T00:00:01Z", 1, 1));
    const rs = await Promise.all([1, 2, 3].map(() => get("/api/claude/sessions?refresh=1", { port: server.port })));
    for (const r of rs) {
      assert.equal(r.status, 200);
      assert.equal(r.body.length, 1);
      assert.equal(r.body[0].id, "abc");
      assert.equal(r.body[0].userMessageCount, 1);
    }
    const s = await get("/api/claude/search?q=parser", { port: server.port });
    assert.equal(s.body.length, 1);
  });

  it("resolves the project path from the first transcript line", async () => {
    const r = await get("/api/claudemd/list", { port: server.port });
    assert.equal(r.status, 200);
    const p = r.body.find((x) => x.dir === "proj" || x.name === "proj");
    assert.ok(p, "project listed: " + JSON.stringify(r.body));
    assert.equal(p.path.replace(/\\/g, "/"), "/tmp/proj");
  });
});
