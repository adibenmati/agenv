// test/session-model-effort-api.test.js — a model and effort per session: set one by one or for a whole folder,
// refused when invalid, kept through a restart and through backup / restore.
"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");

const { startServer, stopProcess, makeTempHome, request, waitFor } = require("./helpers");

describe("session model and effort", () => {
  let srv, home, other, homeB;
  const call = (m, p, body) => request(m, p, { body, port: srv.port });
  const list = async () => (await call("GET", "/api/sessions")).body;

  before(async () => {
    home = makeTempHome(); homeB = makeTempHome();
    srv = await startServer({ home });
  }, { timeout: 30000 });
  after(async () => {
    await stopProcess(srv.proc); if (other) await stopProcess(other.proc);
    for (const d of [home, homeB]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  });

  it("one session: set, shown in the list, refused when invalid, cleared with an empty value", async () => {
    const a = (await call("POST", "/api/sessions", { name: "solo", group: "Solo" })).body;
    assert.equal((await call("PUT", "/api/sessions/" + a.id, { model: "sonnet", effort: "high" })).status, 200);
    let s = (await list()).find((x) => x.id === a.id);
    assert.deepEqual([s.model, s.effort], ["sonnet", "high"]);
    assert.equal((await call("PUT", "/api/sessions/" + a.id, { effort: "turbo" })).status, 400, "unknown effort");
    assert.equal((await call("PUT", "/api/sessions/" + a.id, { model: "x; rm -rf /" })).status, 400, "model must be a plain name");
    s = (await list()).find((x) => x.id === a.id);
    assert.deepEqual([s.model, s.effort], ["sonnet", "high"], "a refused change leaves it as it was");
    await call("PUT", "/api/sessions/" + a.id, { model: "", effort: "" });
    s = (await list()).find((x) => x.id === a.id);
    assert.deepEqual([s.model, s.effort], ["", ""]);
  });

  it("a folder: every session in it and its subfolders; a field left out stays", async () => {
    const x = (await call("POST", "/api/sessions", { name: "x", group: "Team" })).body;
    const y = (await call("POST", "/api/sessions", { name: "y", group: "Team/Sub" })).body;
    const z = (await call("POST", "/api/sessions", { name: "z", group: "Teammate" })).body;
    await call("PUT", "/api/sessions/" + x.id, { effort: "low" });
    const res = await call("POST", "/api/sessions/model-effort", { group: "Team", model: "opus" });
    assert.deepEqual(res.body.map((r) => r.name).sort(), ["x", "y"]);
    const l = await list();
    assert.deepEqual([l.find((s) => s.id === x.id).model, l.find((s) => s.id === x.id).effort], ["opus", "low"], "effort was left out, so it stays");
    assert.equal(l.find((s) => s.id === y.id).model, "opus");
    assert.equal(l.find((s) => s.id === z.id).model, "", "Teammate is not inside Team");
    assert.equal((await call("POST", "/api/sessions/model-effort", { group: "Team" })).status, 400, "nothing to set");
    assert.equal((await call("POST", "/api/sessions/model-effort", { model: "opus" })).status, 400, "no folder or ids");
    const ids = await call("POST", "/api/sessions/model-effort", { ids: [z.id], effort: "max" });
    assert.deepEqual(ids.body.map((r) => r.name), ["z"]);
  });

  it("kept in the backup file and restored from it; a bad value in a file is dropped", async () => {
    const backup = (await call("GET", "/api/sessions/export")).body;
    assert.ok(backup.sessions.some((s) => s.name === "y" && s.model === "opus"));
    other = await startServer({ home: homeB });
    const call2 = (m, p, body) => request(m, p, { body, port: other.port });
    backup.sessions.push({ name: "bad", cwd: homeB, group: "", model: "no good!", effort: "turbo", claudeSessionId: "bad-1" });
    await call2("POST", "/api/sessions/import", backup);
    const l = (await call2("GET", "/api/sessions")).body;
    assert.equal(l.find((s) => s.name === "y").model, "opus");
    const bad = l.find((s) => s.name === "bad");
    assert.deepEqual([bad.model, bad.effort], ["", ""]);
  });

  it("survives a restart of agenv", async () => {
    await call("POST", "/api/shutdown");
    await waitFor(() => srv.proc.exitCode !== null, { timeout: 10000, message: "exit" });
    srv = await startServer({ home });
    const l = await list();
    assert.equal(l.find((s) => s.name === "y").model, "opus");
  });
});
