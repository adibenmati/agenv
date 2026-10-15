// test/groups.test.js — nested session groups (folder tree) and their persistence
"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { startServer, stopProcess, makeTempHome, get, post, put } = require("./helpers");

const findSession = async (id) => (await get("/api/sessions")).body.find((s) => s.id === id);

describe("Session groups", () => {
  const home = makeTempHome();
  let server, a, b, c;

  before(async () => {
    server = await startServer({ home });
    a = (await post("/api/sessions", { name: "a" })).body.id;
    b = (await post("/api/sessions", { name: "b" })).body.id;
    c = (await post("/api/sessions", { name: "c" })).body.id;
  }, { timeout: 30000 });

  after(async () => { await stopProcess(server.proc); });

  it("normalizes a nested group path on a session", async () => {
    const r = await put(`/api/sessions/${a}`, { group: " project1 / marketing//seo " });
    assert.equal(r.status, 200);
    assert.equal((await findSession(a)).group, "project1/marketing/seo");
  });

  it("stores empty folders with their ancestors", async () => {
    const r = await put("/api/session-groups", { groups: [{ path: "project2/backend/api", color: "#58a6ff" }] });
    assert.equal(r.status, 200);
    const list = (await get("/api/session-groups")).body;
    const paths = list.map((g) => g.path);
    for (const p of ["project2", "project2/backend", "project2/backend/api"]) assert.ok(paths.includes(p), p + " in " + paths);
    assert.equal(list.find((g) => g.path === "project2/backend/api").color, "#58a6ff");
  });

  it("includes groups that only exist on sessions", async () => {
    const paths = (await get("/api/session-groups")).body.map((g) => g.path);
    for (const p of ["project1", "project1/marketing", "project1/marketing/seo"]) assert.ok(paths.includes(p), p);
  });

  it("renames a folder and everything under it", async () => {
    await put(`/api/sessions/${b}`, { group: "project1/marketing" });
    await put(`/api/sessions/${c}`, { group: "project1x" }); // shares a prefix, must not move
    const r = await post("/api/session-groups/rename", { from: "project1/marketing", to: "project1/growth" });
    assert.equal(r.status, 200);
    assert.equal((await findSession(a)).group, "project1/growth/seo");
    assert.equal((await findSession(b)).group, "project1/growth");
    assert.equal((await findSession(c)).group, "project1x");
    const paths = (await get("/api/session-groups")).body.map((g) => g.path);
    assert.ok(!paths.some((p) => p.startsWith("project1/marketing")), "old paths gone: " + paths);
  });

  it("refuses to move a folder into itself", async () => {
    const r = await post("/api/session-groups/rename", { from: "project1", to: "project1/growth/inner" });
    assert.equal(r.status, 400);
  });

  it("deleting a folder moves its sessions up to the parent", async () => {
    const r = await post("/api/session-groups/delete", { path: "project1/growth" });
    assert.equal(r.status, 200);
    assert.equal((await findSession(a)).group, "project1");
    assert.equal((await findSession(b)).group, "project1");
    const paths = (await get("/api/session-groups")).body.map((g) => g.path);
    assert.ok(!paths.some((p) => p.startsWith("project1/growth")), "subtree gone: " + paths);
  });

  it("keeps groups, folders and notes across a restart", async () => {
    await put(`/api/sessions/${a}`, { group: "project1/marketing/seo", note: "keep me" });
    await new Promise((r) => setTimeout(r, 1200)); // state saves are debounced by 1s
    await stopProcess(server.proc);
    server = await startServer({ home });
    const s = await findSession(a);
    assert.ok(s, "session restored");
    assert.equal(s.group, "project1/marketing/seo");
    assert.equal(s.note, "keep me");
    const paths = (await get("/api/session-groups")).body.map((g) => g.path);
    assert.ok(paths.includes("project2/backend/api"), "empty folder survives restart: " + paths);
  }, { timeout: 30000 });
});
