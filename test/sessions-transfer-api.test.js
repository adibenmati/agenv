// test/sessions-transfer-api.test.js — back up the Sessions tree to a JSON file and add it back in another agenv.
"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");

const { startServer, stopProcess, makeTempHome, request } = require("./helpers");

describe("sessions export / import", () => {
  let a, b, homeA, homeB, backup;
  const callA = (m, p, body) => request(m, p, { body, port: a.port });
  const callB = (m, p, body) => request(m, p, { body, port: b.port });

  before(async () => {
    homeA = makeTempHome(); homeB = makeTempHome();
    a = await startServer({ home: homeA }); b = await startServer({ home: homeB });
  }, { timeout: 30000 });
  after(async () => {
    await stopProcess(a.proc); await stopProcess(b.proc);
    for (const d of [homeA, homeB]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  });

  it("exports sessions, folders with colours and the closed list as one file", async () => {
    const s1 = (await callA("POST", "/api/sessions", { name: "alpha", group: "Proj/Dev" })).body;
    const s2 = (await callA("POST", "/api/sessions", { name: "beta", group: "Proj/Marketing" })).body;
    await callA("PUT", "/api/session-groups", { groups: [{ path: "Proj", color: "#3fb950" }, { path: "Proj/Dev", color: "" }, { path: "Proj/Empty", color: "#bc8cff" }] });
    await callA("DELETE", "/api/sessions/" + s2.id);
    const res = await callA("GET", "/api/sessions/export");
    assert.equal(res.status, 200);
    backup = res.body;
    assert.equal(backup.format, "agenv-sessions"); assert.equal(backup.version, 1);
    assert.ok(backup.sessions.some((x) => x.name === "alpha" && x.group === "Proj/Dev"));
    assert.ok(backup.sessions.every((x) => x.id === undefined), "ids are not exported: the new agenv gives its own");
    assert.ok(backup.groups.some((g) => g.path === "Proj/Empty" && g.color === "#bc8cff"), "an empty folder and its colour are kept");
    assert.ok(backup.archive.some((x) => x.name === "beta"), "closed sessions are kept");
    assert.ok(s1.id >= 0);
  });

  it("importing adds the sessions asleep, with their folders, colours and closed list", async () => {
    const res = await callB("POST", "/api/sessions/import", backup);
    assert.equal(res.status, 200);
    assert.equal(res.body.sessions + res.body.skipped, backup.sessions.length, "the blank starting terminal both agenvs have counts as already there");
    assert.ok(res.body.sessions >= 1);
    const list = (await callB("GET", "/api/sessions")).body;
    const alpha = list.find((x) => x.name === "alpha");
    assert.ok(alpha && alpha.group === "Proj/Dev" && alpha.live === false, "restored as a sleeping session in its folder");
    const groups = (await callB("GET", "/api/session-groups")).body;
    assert.equal(groups.find((g) => g.path === "Proj/Empty").color, "#bc8cff");
    assert.ok((await callB("GET", "/api/archive")).body.some((x) => x.name === "beta"));
  });

  it("importing the same file again adds nothing twice", async () => {
    const before = (await callB("GET", "/api/sessions")).body.length;
    const res = await callB("POST", "/api/sessions/import", backup);
    assert.equal(res.body.sessions, 0); assert.equal(res.body.skipped, backup.sessions.length); assert.equal(res.body.archive, 0);
    assert.equal((await callB("GET", "/api/sessions")).body.length, before);
  });

  it("a conversation that is already open is not added a second time under another name", async () => {
    const file = { ...backup, sessions: [{ ...backup.sessions[0], name: "renamed", claudeSessionId: "conv-1" }, { ...backup.sessions[0], name: "other", claudeSessionId: "conv-1" }] };
    const res = await callB("POST", "/api/sessions/import", file);
    assert.equal(res.body.sessions, 1, "the second record has the same conversation");
  });

  it("refuses a file that is not an agenv backup", async () => {
    for (const body of [{ hello: 1 }, { format: "agenv-sessions" }, []]) {
      const res = await callB("POST", "/api/sessions/import", body);
      assert.equal(res.status, 400);
    }
  });
});
