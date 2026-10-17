// test/unit/persistence.test.js — JsonStore repository and the file-backed stores
"use strict";
const { describe, it, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { Crypto } = require("../../dist/core/Crypto");
const { JsonStore } = require("../../dist/core/JsonStore");
const { StateStore } = require("../../dist/persistence/StateStore");
const { HistoryStore } = require("../../dist/persistence/HistoryStore");
const { ArchiveStore } = require("../../dist/persistence/ArchiveStore");
const { FavoritesStore } = require("../../dist/persistence/FavoritesStore");
const { ScrollbackStore } = require("../../dist/persistence/ScrollbackStore");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "agenv-p-"));
const mk = (dir) => new Crypto(path.join(dir, "key"));

describe("JsonStore", () => {
  it("saves encrypted and loads back", () => {
    const d = tmp(); const s = new JsonStore({ path: path.join(d, "a.enc"), crypto: mk(d), fallback: () => [] });
    s.save([1, 2]); assert.deepEqual(s.load(), [1, 2]);
    assert.ok(!fs.readFileSync(path.join(d, "a.enc"), "utf8").includes("[1,2]"));
  });
  it("returns the fallback for a missing or corrupt file, and a fresh fallback each time", () => {
    const d = tmp(); const p = path.join(d, "a.enc");
    const s = new JsonStore({ path: p, crypto: mk(d), fallback: () => ["fb"] });
    assert.deepEqual(s.load(), ["fb"]); fs.writeFileSync(p, "garbage"); assert.deepEqual(s.load(), ["fb"]);
    s.load().push("mutated"); assert.deepEqual(s.load(), ["fb"]);
  });
  it("migrates a legacy plain-JSON file and deletes it", () => {
    const d = tmp(); const legacy = path.join(d, "a.json"); fs.writeFileSync(legacy, JSON.stringify(["old"]));
    const s = new JsonStore({ path: path.join(d, "a.enc"), crypto: mk(d), fallback: () => [], legacyPath: legacy });
    assert.deepEqual(s.load(), ["old"]); assert.ok(!fs.existsSync(legacy)); assert.deepEqual(s.load(), ["old"]);
  });
  it("ignores a legacy file that acceptLegacy rejects and leaves it in place", () => {
    const d = tmp(); const legacy = path.join(d, "a.json"); fs.writeFileSync(legacy, JSON.stringify([]));
    const s = new JsonStore({ path: path.join(d, "a.enc"), crypto: mk(d), fallback: () => ["fb"], legacyPath: legacy, acceptLegacy: (v) => Array.isArray(v) && v.length > 0 });
    assert.deepEqual(s.load(), ["fb"]); assert.ok(fs.existsSync(legacy));
  });
  it("reads files written by the old server (compatibility fixture)", () => {
    const fx = path.join(__dirname, "..", "fixtures", "crypto");
    const dir = tmp(); fs.copyFileSync(path.join(fx, "cipher.json"), path.join(dir, "x.enc")); fs.copyFileSync(path.join(fx, "key"), path.join(dir, "key"));
    assert.equal(new JsonStore({ path: path.join(dir, "x.enc"), crypto: mk(dir), fallback: () => null }).load().hello, "wörld");
  });
});

describe("StateStore", () => {
  it("writes immediately, coalesces for the window, then writes the latest once", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      let writes = 0, n = 0;
      const store = { load: () => null, save: () => { writes++; } };
      const st = new StateStore(store, () => ({ sessions: [], workspaceLayout: n++, sessionGroups: [] }), 1000);
      st.save(); assert.equal(writes, 1);
      st.save(); st.save(); assert.equal(writes, 1);
      mock.timers.tick(1000); assert.equal(writes, 2);
      mock.timers.tick(1000); assert.equal(writes, 2);
    } finally { mock.timers.reset(); }
  });
  it("saveNow writes the current snapshot and a failing write never throws", () => {
    const saved = []; let fail = false;
    const st = new StateStore({ load: () => null, save: (v) => { if (fail) throw new Error("disk full"); saved.push(v); } },
      () => ({ sessions: [], workspaceLayout: "L", sessionGroups: [] }), 1000);
    st.saveNow(); assert.equal(saved[0].workspaceLayout, "L");
    fail = true; assert.doesNotThrow(() => st.saveNow());
  });
});

describe("History/Archive/Favorites", () => {
  const stores = () => { const d = tmp(), c = mk(d); const j = (n, f) => new JsonStore({ path: path.join(d, n), crypto: c, fallback: f }); return { h: new HistoryStore(j("h", () => [])), a: new ArchiveStore(j("a", () => [])), f: new FavoritesStore(j("f", () => [])) }; };
  it("history: trims, skips empty and consecutive duplicates, caps at 1000", () => {
    const { h } = stores(); h.add("  ls "); h.add("ls"); h.add(""); h.add("   "); assert.deepEqual(h.list(), ["ls"]);
    h.add("pwd"); h.add("ls"); assert.deepEqual(h.list(), ["ls", "pwd", "ls"]);
    for (let i = 0; i < 1100; i++) h.add("c" + i); assert.equal(h.list().length, 1000); assert.equal(h.list().at(-1), "c1099");
  });
  it("archive: caps at 100 (dropping the oldest) and removes by closed timestamp", () => {
    const { a } = stores(); const e = (i) => ({ name: "n" + i, cwd: "/", tool: "terminal", lastCommand: "", launchCommand: "", group: "", claudeSessionId: null, created: 1, lastActivity: 1, closed: i });
    for (let i = 1; i <= 120; i++) a.add(e(i));
    assert.equal(a.list().length, 100); assert.equal(a.list()[0].closed, 21);
    a.remove(120); assert.ok(!a.list().some((x) => x.closed === 120));
  });
  it("archive/favorites: a file holding something other than an array reads as empty", () => {
    const d = tmp(), c = mk(d); const j = (n) => new JsonStore({ path: path.join(d, n), crypto: c, fallback: () => [] });
    j("x").save({ not: "an array" });
    assert.deepEqual(new ArchiveStore(j("x")).list(), []); assert.deepEqual(new FavoritesStore(j("x")).list(), []);
  });
  it("favorites: applies defaults, rejects duplicates, removes by index", () => {
    const { f } = stores(); assert.equal(f.add({ name: "a", cwd: "/x", command: "ls" }), true);
    assert.equal(f.list()[0].tool, "terminal"); assert.ok(f.list()[0].created > 0);
    assert.equal(f.add({ name: "b", cwd: "/x", command: "ls", tool: "claude" }), false);
    assert.equal(f.add({ cwd: "/y" }), true); assert.equal(f.list()[1].command, "");
    assert.equal(f.removeAt(5), false); assert.equal(f.removeAt(-1), false); assert.equal(f.removeAt(0), true); assert.equal(f.list().length, 1);
  });
});

describe("ScrollbackStore", () => {
  it("round-trips, returns null for unknown ids, clears", () => {
    const d = tmp(); const s = new ScrollbackStore(path.join(d, "sb"), mk(d));
    assert.equal(s.load(1), null); s.save(1, Buffer.from("héllo")); assert.equal(s.load(1).toString(), "héllo");
    assert.ok(fs.existsSync(path.join(d, "sb", "session-1.enc")));
    s.clear(1); assert.equal(s.load(1), null); assert.doesNotThrow(() => s.clear(1));
  });
});
