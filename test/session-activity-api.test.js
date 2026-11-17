// test/session-activity-api.test.js — what each session is working on: in the sessions list and in its info endpoint.
"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");

const { startServer, stopProcess, makeTempHome, request } = require("./helpers");

describe("session activity", () => {
  let srv, home;
  const call = (m, p, body) => request(m, p, { body, port: srv.port });

  before(async () => {
    home = makeTempHome();
    srv = await startServer({ home });
  }, { timeout: 30000 });
  after(async () => {
    await stopProcess(srv.proc);
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  });

  it("a new session has no activity yet", async () => {
    const a = (await call("POST", "/api/sessions", { name: "quiet" })).body;
    const s = (await call("GET", "/api/sessions")).body.find((x) => x.id === a.id);
    assert.equal(s.activity, null);
  });

  it("what is typed in a session becomes its activity, newest first in its history", async () => {
    const a = (await call("POST", "/api/sessions", { name: "busy" })).body;
    await call("POST", "/api/history", { command: "npm run build", sessionId: a.id });
    await call("POST", "/api/history", { command: "npm test", sessionId: a.id });
    const s = (await call("GET", "/api/sessions")).body.find((x) => x.id === a.id);
    assert.equal(s.activity.text, "npm test");
    assert.equal(s.activity.source, "input");

    const info = await call("GET", "/api/sessions/" + a.id + "/activity");
    assert.equal(info.status, 200);
    assert.deepEqual(info.body.history.map((h) => h.text), ["npm test", "npm run build"]);
    assert.ok(Array.isArray(info.body.tail));
  });

  it("a line typed in the terminal (typedIn) is shown as activity without changing the session's tool", async () => {
    const a = (await call("POST", "/api/sessions", { name: "typing" })).body;
    await call("POST", "/api/history", { command: "codex, please explain this file", typedIn: a.id });
    const s = (await call("GET", "/api/sessions")).body.find((x) => x.id === a.id);
    assert.equal(s.activity.text, "codex, please explain this file");
    assert.equal(s.tool, "terminal", "a prompt that starts with a tool's name does not change the tool");
  });

  it("an unknown session is a 404", async () => {
    assert.equal((await call("GET", "/api/sessions/99999/activity")).status, 404);
  });
});
