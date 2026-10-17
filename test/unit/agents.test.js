// test/unit/agents.test.js — Agent validation and the encrypted AgentStore
"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { Crypto } = require("../../dist/core/Crypto");
const { JsonStore } = require("../../dist/core/JsonStore");
const { AgentStore } = require("../../dist/agents/AgentStore");
const { validateAgentInput } = require("../../dist/agents/Agent");

const isDir = (p) => p === "/ok" || p === "/ok2";
const blank = { kind: "blank" };
const input = (o = {}) => ({ name: "Foo", specialty: "does foo", cwd: "/ok", ...o });
function mkStore(dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenv-a-"))) {
  const js = new JsonStore({ path: path.join(dir, "agents.enc"), crypto: new Crypto(path.join(dir, "key")), fallback: () => [] });
  return { dir, store: new AgentStore(js, isDir) };
}
const status = (fn) => { try { fn(); } catch (e) { return e.status; } return null; };

describe("AgentStore", () => {
  it("rejects invalid names", () => {
    const { store } = mkStore();
    for (const name of ["", "x".repeat(49), "a b", "a/b", ".."]) {
      assert.equal(status(() => store.add(input({ name }), blank)), 400, JSON.stringify(name));
    }
    assert.equal(store.add(input({ name: "x".repeat(48) }), blank).name.length, 48);
  });
  it("names are unique case-insensitively", () => {
    const { store } = mkStore();
    store.add(input({ name: "Foo" }), blank);
    assert.equal(status(() => store.add(input({ name: "foo" }), blank)), 409);
    assert.equal(store.getByName("FOO").name, "Foo");
  });
  it("defaults permission to acceptEdits with empty allowedTools", () => {
    const { store } = mkStore();
    const a = store.add(input(), blank);
    assert.deepEqual(a.permission, { mode: "acceptEdits", allowedTools: [] });
    assert.equal(a.conversationId, ""); assert.equal(a.lastRunAt, null);
    assert.match(a.id, /^[0-9a-f]{8}$/);
    assert.deepEqual(a.origin, blank);
  });
  it("rejects a cwd that is not a directory", () => {
    const { store } = mkStore();
    assert.equal(status(() => store.add(input({ cwd: "/nope" }), blank)), 400);
    assert.equal(status(() => validateAgentInput(input({ permission: { mode: "bogus" } }), { isDir })), 400);
  });
  it("uniqueName suffixes -copy, -copy-2", () => {
    const { store } = mkStore();
    store.add(input({ name: "x" }), blank);
    assert.equal(store.uniqueName("y"), "y");
    assert.equal(store.uniqueName("x"), "x-copy");
    store.add(input({ name: "x-copy" }), blank);
    assert.equal(store.uniqueName("x"), "x-copy-2");
    assert.equal(store.uniqueName("X"), "X-copy-2");
  });
  it("update cannot rename onto another agent's name", () => {
    const { store } = mkStore();
    store.add(input({ name: "a" }), blank);
    const b = store.add(input({ name: "b" }), blank);
    assert.equal(status(() => store.update(b.id, { name: "A" })), 409);
    assert.equal(store.update(b.id, { name: "B", specialty: "new" }).specialty, "new");
    assert.equal(status(() => store.update(b.id, { cwd: "/nope" })), 400);
    assert.equal(status(() => store.update("missing", {})), 404);
  });
  it("survives reload", () => {
    const { dir, store } = mkStore();
    const a = store.add(input(), { kind: "duplicate", sourceAgentId: "zz" }, "conv-1");
    const again = mkStore(dir).store;
    assert.deepEqual(again.get(a.id), a);
    assert.equal(again.get(a.id).conversationId, "conv-1");
  });
  it("remove deletes only the record", () => {
    const { store } = mkStore();
    const a = store.add(input({ name: "a" }), blank), b = store.add(input({ name: "b" }), blank);
    store.remove(a.id);
    assert.deepEqual(store.list().map((x) => x.id), [b.id]);
    assert.equal(store.get(a.id), undefined);
    assert.equal(status(() => store.remove(a.id)), 404);
  });
});
