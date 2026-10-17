// test/unit/sessions.test.js — SessionManager (with a fake pty), shell parsing, tool detection, GroupRegistry
"use strict";
const { describe, it, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { TypedEmitter } = require("../../dist/core/TypedEmitter");
const { Crypto } = require("../../dist/core/Crypto");
const { JsonStore } = require("../../dist/core/JsonStore");
const { ArchiveStore } = require("../../dist/persistence/ArchiveStore");
const { ScrollbackStore } = require("../../dist/persistence/ScrollbackStore");
const { SessionManager } = require("../../dist/sessions/SessionManager");
const { GroupRegistry } = require("../../dist/sessions/GroupRegistry");
const { parseShell } = require("../../dist/sessions/shell");
const { detectTool } = require("../../dist/sessions/tools");

const CLEAR = "\x1b[2J\x1b[H";

function rig(over = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "agenv-s-")); const crypto = new Crypto(path.join(d, "key"));
  const bus = new TypedEmitter(); const spawned = []; const events = [];
  for (const ev of ["created", "output", "changed", "deleted", "command", "cwd", "status"]) bus.on(ev, (...a) => events.push([ev, ...a.slice(1)]));
  const ptyFactory = (o) => {
    const handlers = {};
    const p = { pid: 1000 + spawned.length, cols: o.cols, rows: o.rows, written: [], killed: false, opts: o,
      onData: (cb) => (handlers.data = cb), onExit: (cb) => (handlers.exit = cb),
      write: (x) => p.written.push(x), resize: (c, r) => { p.cols = c; p.rows = r; }, kill: () => { p.killed = true; },
      emit: (x) => handlers.data(x), exit: (c) => handlers.exit({ exitCode: c }) };
    spawned.push(p); return p;
  };
  const archive = new ArchiveStore(new JsonStore({ path: path.join(d, "arch"), crypto, fallback: () => [] }));
  const scrollbackStore = new ScrollbackStore(path.join(d, "sb"), crypto);
  const m = new SessionManager({ bus, ptyFactory, shell: over.shell || "cmd.exe", maxSessions: over.max || 3, defaultCols: 120, defaultRows: 30,
    scrollbackStore, archive, isRealDir: over.isRealDir || (() => true), env: { PATH: "x" } });
  return { m, bus, spawned, events, archive, scrollbackStore, d };
}
const rec = (id, extra = {}) => ({ id, name: "n" + id, cwd: "/tmp", tool: "terminal", lastCommand: "", launchCommand: "", userNamed: false, group: "", note: "", claudeSessionId: null, created: 1, lastActivity: 1, ...extra });

describe("parseShell", () => {
  it("keeps quoted segments whole and strips the quotes, including on the executable", () => {
    assert.deepEqual(parseShell('"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo -NoProfile'), { file: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", args: ["-NoLogo", "-NoProfile"] });
    assert.deepEqual(parseShell("bash"), { file: "bash", args: [] });
    assert.deepEqual(parseShell('bash -c "echo hi there"'), { file: "bash", args: ["-c", "echo hi there"] });
  });
  it("an empty string falls back to itself", () => { assert.deepEqual(parseShell(""), { file: "", args: [] }); });
});

describe("detectTool", () => {
  it("recognises agent and tool commands", () => {
    assert.equal(detectTool("claude --model opus"), "claude"); assert.equal(detectTool("  Claude"), "claude");
    assert.equal(detectTool("gcloud ai models list"), "vertex"); assert.equal(detectTool("gcloud auth login"), "gcloud");
    assert.equal(detectTool("python3 app.py"), "python"); assert.equal(detectTool("kubectl get pods"), "k8s");
    assert.equal(detectTool("ls -la"), null); assert.equal(detectTool("claudette"), null);
  });
});

describe("SessionManager", () => {
  it("restore keeps ids, allocates the next id after the max, and spawns no shells", () => {
    const { m, spawned } = rig(); assert.equal(m.restore([rec(3), rec(7)]), 2, "reports how many tabs it restored");
    assert.deepEqual(m.all().map((s) => s.id).sort(), [3, 7]); assert.equal(m.nextId, 8); assert.equal(spawned.length, 0);
    assert.equal(m.get(3).live, false);
  });
  it("restore keeps group, note and the Claude link, and loads saved scrollback", () => {
    const { m, scrollbackStore } = rig(); scrollbackStore.save(4, Buffer.from("old output"));
    m.restore([rec(4, { group: "a/b", note: "n", claudeSessionId: "cid" })]);
    const s = m.get(4); assert.equal(s.group, "a/b"); assert.equal(s.note, "n"); assert.equal(s.claudeSessionId, "cid");
    assert.equal(s.scrollback.read().toString(), "old output");
  });
  it("restore: layout ids win; without them the most recent tabs up to the limit are kept", () => {
    const a = rig({ max: 2 }); a.m.restore([rec(1, { lastActivity: 10 }), rec(2, { lastActivity: 30 }), rec(3, { lastActivity: 20 })]);
    assert.deepEqual(a.m.all().map((s) => s.id).sort(), [2, 3]);
    const b = rig({ max: 2 }); b.m.restore([rec(1), rec(2), rec(3)], new Set([1]));
    assert.deepEqual(b.m.all().map((s) => s.id), [1]);
  });
  it("restore falls back to the process folder when the saved one is gone", () => {
    const { m } = rig({ isRealDir: () => false }); m.restore([rec(1, { cwd: "/gone" })]);
    assert.equal(m.get(1).cwd, process.cwd());
  });
  it("wake spawns once (idempotent) with the right shell, size and env", () => {
    const { m, spawned } = rig({ shell: '"C:\\Program Files\\sh.exe" -l' }); m.restore([rec(1)]); const s = m.get(1);
    m.wake(s); m.wake(s); assert.equal(spawned.length, 1); assert.equal(s.live, true);
    const o = spawned[0].opts; assert.equal(o.file, "C:\\Program Files\\sh.exe"); assert.deepEqual(o.args, ["-l"]);
    assert.equal(o.cols, 120); assert.equal(o.rows, 30); assert.equal(o.env.TERM, "xterm-256color"); assert.equal(o.env.PATH, "x");
  });
  it("a stale pty's output is ignored after restart; restart clears scrollback and re-runs the launch command", () => {
    const { m, spawned, events, scrollbackStore } = rig(); const s = m.create({ runCommand: "node app.js" });
    spawned[0].emit("before"); scrollbackStore.save(s.id, Buffer.from("saved"));
    const first = spawned[0]; m.restart(s.id);
    assert.ok(first.killed); assert.equal(spawned.length, 2); assert.equal(s.scrollback.bytes, 0); assert.equal(scrollbackStore.load(s.id), null);
    assert.equal(s.pendingCommand, "node app.js"); assert.equal(s.status, "idle");
    first.emit("stale"); spawned[1].emit("fresh");
    assert.deepEqual(events.filter((e) => e[0] === "output").map((e) => e[1]).slice(-2), [CLEAR, "fresh"]);
    assert.equal(s.scrollback.read().toString(), "fresh");
  });
  it("types the pending command into a new shell after 500 ms and announces it", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const { m, spawned, events } = rig(); const s = m.create({ runCommand: "claude --model opus" });
      assert.deepEqual(spawned[0].written, []); mock.timers.tick(500);
      assert.deepEqual(spawned[0].written, ["claude --model opus\r"]);
      assert.equal(s.lastCommand, "claude --model opus"); assert.equal(s.detectedTool, "claude"); assert.equal(s.pendingCommand, null);
      assert.ok(events.some((e) => e[0] === "command" && e[1] === "claude --model opus"));
    } finally { mock.timers.reset(); }
  });
  it("enforces the session limit with a 400, and startup can bypass it", () => {
    const { m } = rig({ max: 1 }); m.create({});
    assert.equal(m.isFull, true);
    assert.throws(() => m.create({}), (e) => e.status === 400 && /Maximum sessions reached \(1\)/.test(e.message));
    assert.doesNotThrow(() => m.create({}, { enforceLimit: false })); assert.equal(m.size, 2);
  });
  it("ids keep increasing after deletes (never reused)", () => {
    const { m } = rig({ max: 10 }); const a = m.create({}), b = m.create({}); m.delete(b.id); const c = m.create({});
    assert.deepEqual([a.id, b.id, c.id], [0, 1, 2]);
  });
  it("delete archives with group + claude link, kills the shell, clears saved scrollback, emits deleted(-1)", () => {
    const { m, spawned, events, archive, scrollbackStore } = rig(); const s = m.create({ name: "x", group: "p/q" }); s.claudeSessionId = "cid";
    scrollbackStore.save(s.id, Buffer.from("x")); m.delete(s.id);
    assert.ok(spawned[0].killed); assert.equal(m.get(s.id), undefined); assert.equal(scrollbackStore.load(s.id), null);
    const a = archive.list().at(-1); assert.equal(a.group, "p/q"); assert.equal(a.claudeSessionId, "cid"); assert.equal(a.name, "x");
    assert.deepEqual(events.find((e) => e[0] === "deleted"), ["deleted", -1]);
  });
  it("deleting an unknown session is a 404", () => {
    assert.throws(() => rig().m.delete(99), (e) => e.status === 404 && e.message === "Session not found");
  });
  it("a shell that exits by itself is archived and deleted with its exit code", () => {
    const { m, spawned, events, archive } = rig(); m.create({ name: "y" }); spawned[0].exit(7);
    assert.equal(m.size, 0); assert.equal(archive.list().length, 1); assert.deepEqual(events.find((e) => e[0] === "deleted"), ["deleted", 7]);
  });
  it("an exit during shutdown is not archived", () => {
    const { m, spawned, archive } = rig(); m.create({}); m.shutdown(); spawned[0].exit(0);
    assert.equal(archive.list().length, 0);
  });
  it("a throwing subscriber does not stop pty output reaching other subscribers", () => {
    const { m, bus, spawned } = rig(); const seen = []; const orig = console.error; console.error = () => {};
    try { bus.on("output", () => { throw new Error("bad"); }); bus.on("output", (_s, d) => seen.push(d)); m.create({}); spawned[0].emit("hi"); }
    finally { console.error = orig; }
    assert.deepEqual(seen, ["hi"]);
  });
  it("output is appended to scrollback and marks the session active", () => {
    const { m, spawned } = rig(); const s = m.create({}); s.lastActivity = 0; spawned[0].emit("abc");
    assert.equal(s.scrollback.read().toString(), "abc"); assert.ok(s.lastActivity > 0);
  });
  it("noteCommand records the command, detects the tool, names an unnamed session and emits command + changed", () => {
    const { m, events } = rig(); const s = m.create({}); m.noteCommand(s, "claude --model opus");
    assert.equal(s.lastCommand, "claude --model opus"); assert.equal(s.detectedTool, "claude"); assert.equal(s.name, "claude"); assert.equal(s.launchCommand, "claude --model opus");
    assert.ok(events.some((e) => e[0] === "command" && e[1] === "claude --model opus")); assert.ok(events.some((e) => e[0] === "changed"));
    m.noteCommand(s, "git status"); assert.equal(s.name, "claude"); assert.equal(s.launchCommand, "claude --model opus");   // existing name/launch kept
  });
  it("noteCommand follows cd into a real folder, renames an unnamed terminal after it, never a user-named one", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "agenv-cd-")); fs.mkdirSync(path.join(base, "proj dir"));
    const { m, events } = rig({ isRealDir: (p) => fs.existsSync(p) && fs.statSync(p).isDirectory() });
    const s = m.create({ cwd: base }); m.noteCommand(s, 'cd "proj dir"');
    assert.equal(s.cwd, path.join(base, "proj dir")); assert.equal(s.name, "proj dir"); assert.ok(events.some((e) => e[0] === "cwd"));
    s.userNamed = true; s.name = "mine"; m.noteCommand(s, "cd ..");
    assert.equal(s.cwd, base); assert.equal(s.name, "mine");
    m.noteCommand(s, "cd nowhere"); assert.equal(s.cwd, base);
  });
  it("resize clamps to 1..500 columns and 1..200 rows and updates the pty", () => {
    const { m, spawned } = rig(); const s = m.create({});
    m.resize(s, 9999, 9999); assert.deepEqual([s.cols, s.rows], [500, 200]); assert.deepEqual([spawned[0].cols, spawned[0].rows], [500, 200]);
    m.resize(s, "x", -5); assert.deepEqual([s.cols, s.rows], [80, 1]);
  });
  it("write goes to the pty, and is ignored on a sleeping session", () => {
    const { m, spawned } = rig(); const s = m.create({}); m.write(s, "ls\r"); assert.deepEqual(spawned[0].written, ["ls\r"]);
    m.restore([rec(9)]); assert.doesNotThrow(() => m.write(m.get(9), "x"));
  });
  it("saveAllScrollback writes only changed buffers unless forced; shutdown saves and kills every shell", () => {
    const { m, spawned, scrollbackStore } = rig(); const a = m.create({}), b = m.create({});
    spawned[0].emit("A1"); m.saveAllScrollback(); assert.equal(scrollbackStore.load(a.id).toString(), "A1"); assert.equal(scrollbackStore.load(b.id), null);
    scrollbackStore.clear(a.id); m.saveAllScrollback(); assert.equal(scrollbackStore.load(a.id), null);   // clean → not rewritten
    m.saveAllScrollback(true); assert.equal(scrollbackStore.load(a.id).toString(), "A1");
    spawned[1].emit("B1"); m.shutdown(); assert.equal(scrollbackStore.load(b.id).toString(), "B1"); assert.ok(spawned.every((p) => p.killed));
  });
  it("create emits created and changed", () => {
    const { m, events } = rig(); m.create({}); assert.ok(events.some((e) => e[0] === "created")); assert.ok(events.some((e) => e[0] === "changed"));
  });
});

describe("GroupRegistry", () => {
  const mk = (sessions = [], defs) => { let changed = 0; const r = new GroupRegistry({ sessions: () => sessions, emitChanged: () => changed++, defs }); return { r, sessions, changed: () => changed }; };
  it("normalizes paths", () => {
    assert.equal(GroupRegistry.normalize(" a / b//c "), "a/b/c"); assert.equal(GroupRegistry.normalize(null), "");
    assert.equal(GroupRegistry.normalize("x/".repeat(20)).split("/").length, 8); assert.equal(GroupRegistry.normalize("y".repeat(100)).length, 64);
  });
  it("lists stored folders, session folders and all ancestors, sorted", () => {
    const { r } = mk([{ group: "p/q/r" }]); r.replace([{ path: "z/y", color: "#fff" }]);
    const paths = r.list().map((g) => g.path); assert.deepEqual(paths, ["p", "p/q", "p/q/r", "z", "z/y"]);
    assert.equal(r.list().find((g) => g.path === "z/y").color, "#fff");
  });
  it("replace de-duplicates, drops empty paths and ignores junk entries; starts from saved defs", () => {
    const { r } = mk([], [{ path: "saved", color: "" }]); assert.deepEqual(r.list().map((g) => g.path), ["saved"]);
    r.replace([{ path: "a", color: "x" }, { path: "a", color: "y" }, { path: "  " }, null, 5]); assert.deepEqual(r.defs, [{ path: "a", color: "y" }]);
  });
  it("rename moves sessions and stored folders; a shared prefix stays put; self-move and bad input are 400", () => {
    const a = { group: "p/dev" }, b = { group: "px" }; const { r, changed } = mk([a, b]); r.replace([{ path: "p/dev/x", color: "" }]);
    r.rename("p/dev", "p/ops"); assert.equal(a.group, "p/ops"); assert.equal(b.group, "px");
    assert.ok(r.list().some((g) => g.path === "p/ops/x")); assert.ok(changed() >= 1);
    assert.throws(() => r.rename("p", "p/ops/in"), (e) => e.status === 400 && /into itself/.test(e.message));
    assert.throws(() => r.rename("", "x"), (e) => e.status === 400);
  });
  it("remove moves sessions to the parent and drops the subtree", () => {
    const a = { group: "p/q/r" }; const { r } = mk([a]); r.replace([{ path: "p/q/r/s", color: "" }]);
    r.remove("p/q"); assert.equal(a.group, "p"); assert.ok(!r.list().some((g) => g.path.startsWith("p/q")));
    assert.throws(() => r.remove(""), (e) => e.status === 400);
  });
});
