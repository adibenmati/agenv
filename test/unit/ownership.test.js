// test/unit/ownership.test.js — AutomationOwnership: one agenv instance per machine runs the routine schedules
"use strict";
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { AutomationOwnership, processAlive } = require("../../dist/automation/AutomationOwnership");

const dirs = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });
const lockPath = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "agenv-own-")); dirs.push(d); return path.join(d, ".agenv-automation.lock"); };
const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const leftovers = (p) => fs.readdirSync(path.dirname(p)).filter((f) => f !== path.basename(p));
const age = (p, ms) => { const t = new Date(Date.now() - ms); fs.utimesSync(p, t, t); };
const code = (c) => Object.assign(new Error(c), { code: c });
/** Two instances on one lock with a shared fake clock; `alive` is the set of live pids. */
function pair(o = {}) {
  const p = lockPath();
  const clock = { t: 1_000_000 };
  const alive = new Set([111, 222]);
  const common = { path: p, now: () => clock.t, isAlive: (pid) => alive.has(pid), ...o.common };
  const a = new AutomationOwnership({ ...common, pid: 111, port: 3000, ...o.a });
  const b = new AutomationOwnership({ ...common, pid: 222, port: 3001, ...o.b });
  return { p, clock, alive, a, b };
}

describe("AutomationOwnership", () => {
  it("the first instance takes the lock and records pid, port, start time and heartbeat", () => {
    const p = lockPath();
    const a = new AutomationOwnership({ path: p, pid: 111, port: 3000, now: () => 42, isAlive: () => true });
    assert.equal(a.isOwner(), true, "owner until refused");
    assert.equal(a.acquire(), true);
    assert.deepEqual(read(p), { pid: 111, port: 3000, startedAt: 42, heartbeatAt: 42 });
    assert.equal(a.ownerPort(), 3000);
    assert.deepEqual(leftovers(p), [], "no temp file is left behind");
  });

  it("a second instance is refused while the first holds a fresh lock with a live pid, and learns its port", () => {
    const { p, a, b } = pair();
    assert.equal(a.acquire(), true);
    assert.equal(b.acquire(), false);
    assert.equal(b.isOwner(), false);
    assert.equal(b.ownerPort(), 3000);
    assert.equal(read(p).pid, 111, "the lock is untouched");
    assert.deepEqual(leftovers(p), []);
  });

  it("a stale lock (its pid is gone) is taken over", () => {
    const { p, alive, a, b } = pair();
    a.acquire();
    alive.delete(111);
    assert.equal(b.acquire(), true);
    assert.equal(b.isOwner(), true);
    assert.deepEqual({ pid: read(p).pid, port: read(p).port }, { pid: 222, port: 3001 });
  });

  it("a stale heartbeat is taken over even though its pid is alive (pid reuse after an Electron quit)", () => {
    const { p, clock, a, b } = pair();
    a.acquire();
    clock.t += 89_000;
    assert.equal(b.acquire(), false, "89 s old is still fresh");
    clock.t += 2_000;                                   // 91 s > 3 x 30 s
    assert.equal(b.acquire(), true);
    assert.equal(read(p).pid, 222);
  });

  it("staleMs is injectable", () => {
    const { clock, a, b } = pair({ common: { staleMs: 5_000 } });
    a.acquire();
    clock.t += 4_000;
    assert.equal(b.acquire(), false);
    clock.t += 2_000;
    assert.equal(b.acquire(), true);
  });

  it("a garbage lock older than 5 s counts as stale; a younger one is a half-written file and is not touched", () => {
    for (const junk of ["", "not json", "{}", '{"pid":"x"}', '{"pid":-3}']) {
      const p = lockPath();
      fs.writeFileSync(p, junk);
      const young = new AutomationOwnership({ path: p, pid: 5, port: 1, isAlive: () => true });
      assert.equal(young.acquire(), false, `young ${JSON.stringify(junk)} blocks`);
      assert.equal(young.isOwner(), false);
      assert.equal(fs.readFileSync(p, "utf8"), junk, "the young file is left alone");
      age(p, 6_000);
      const old = new AutomationOwnership({ path: p, pid: 5, port: 1, isAlive: () => true });
      assert.equal(old.acquire(), true, `old ${JSON.stringify(junk)} is taken over`);
      assert.equal(read(p).pid, 5);
    }
  });

  it("acquiring again with the same pid succeeds (the lock is ours)", () => {
    const p = lockPath();
    const a = new AutomationOwnership({ path: p, pid: 111, port: 3000, isAlive: () => true });
    assert.equal(a.acquire(), true);
    assert.equal(a.acquire(), true);
    assert.deepEqual(leftovers(p), []);
  });

  it("the lock is published with a hard link of a fully written file, and the temp file is always removed", () => {
    const p = lockPath();
    const calls = [];
    const wrapped = { ...fs, linkSync: (from, to) => { calls.push([from, to, fs.readFileSync(from, "utf8")]); return fs.linkSync(from, to); } };
    const a = new AutomationOwnership({ path: p, pid: 111, port: 3000, now: () => 7, fs: wrapped });
    assert.equal(a.acquire(), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], p);
    assert.notEqual(calls[0][0], p);
    assert.equal(path.dirname(calls[0][0]), path.dirname(p), "the temp file sits next to the lock");
    assert.deepEqual(JSON.parse(calls[0][2]), { pid: 111, port: 3000, startedAt: 7, heartbeatAt: 7 }, "complete content before it was visible");
    assert.deepEqual(leftovers(p), []);
  });

  it("when the filesystem has no hard links the lock is created with an exclusive write instead", () => {
    for (const c of ["EPERM", "ENOSYS", "EXDEV"]) {
      const p = lockPath();
      const noLinks = { ...fs, linkSync: () => { throw code(c); } };
      const a = new AutomationOwnership({ path: p, pid: 111, port: 3000, fs: noLinks });
      assert.equal(a.acquire(), true, c);
      assert.equal(read(p).pid, 111);
      assert.deepEqual(leftovers(p), [], c);
      const b = new AutomationOwnership({ path: p, pid: 222, port: 1, isAlive: () => true, fs: noLinks });
      assert.equal(b.acquire(), false, `${c}: the exclusive fallback does not overwrite a live lock`);
      assert.equal(read(p).pid, 111);
    }
  });

  it("two instances racing for one stale lock produce exactly one owner (the rival takes over around the unlink and link)", () => {
    for (const hookAt of ["afterUnlink", "beforeLink"]) {
      const p = lockPath();
      const alive = new Set([111, 222, 999]);
      const common = { path: p, now: () => 5_000_000, isAlive: (pid) => alive.has(pid) };
      fs.writeFileSync(p, JSON.stringify({ pid: 999, port: 1, startedAt: 1, heartbeatAt: 1 }));   // long-stale heartbeat
      let b, ran = false;
      const rival = () => { if (!ran) { ran = true; assert.equal(b.acquire(), true, "the rival wins"); } };
      const hooked = { ...fs };
      if (hookAt === "afterUnlink") hooked.unlinkSync = (f) => { fs.unlinkSync(f); if (f === p) rival(); };
      else hooked.linkSync = (from, to) => { rival(); return fs.linkSync(from, to); };
      const a = new AutomationOwnership({ ...common, pid: 111, port: 3000, fs: hooked });
      b = new AutomationOwnership({ ...common, pid: 222, port: 3001 });
      assert.equal(a.acquire(), false, hookAt);
      assert.equal(a.isOwner(), false);
      assert.equal(b.isOwner(), true);
      assert.equal(a.ownerPort(), 3001);
      assert.equal(read(p).pid, 222, "the winner's lock is intact");
      assert.deepEqual(leftovers(p), []);
    }
  });

  it("both racers running back to back on one stale lock: exactly one owner", () => {
    const { p, clock, a, b } = pair();
    fs.writeFileSync(p, JSON.stringify({ pid: 999, port: 1, startedAt: 1, heartbeatAt: 1 }));
    clock.t = 10_000_000;
    const results = [a.acquire(), b.acquire()];
    assert.equal(results.filter(Boolean).length, 1);
    assert.deepEqual([a.isOwner(), b.isOwner()], results);
  });

  it("heartbeat rewrites the lock atomically with a new heartbeatAt and keeps pid, port and startedAt", () => {
    const { p, clock, a } = pair();
    a.acquire();
    const first = read(p);
    clock.t += 30_000;
    assert.equal(a.heartbeat(), true);
    assert.deepEqual(read(p), { ...first, heartbeatAt: clock.t });
    assert.deepEqual(leftovers(p), []);
  });

  it("heartbeat retries a rename that fails briefly with EPERM (Windows)", () => {
    const p = lockPath();
    let fails = 0, renames = 0;
    const flaky = { ...fs, renameSync: (f, t) => { renames++; if (fails-- > 0) throw code("EPERM"); return fs.renameSync(f, t); } };
    const clock = { t: 1 };
    const a = new AutomationOwnership({ path: p, pid: 111, port: 3000, now: () => clock.t, fs: flaky });
    a.acquire();
    clock.t = 99;
    fails = 2; renames = 0;
    assert.equal(a.heartbeat(), true);
    assert.equal(renames, 3);
    assert.equal(read(p).heartbeatAt, 99);
    assert.deepEqual(leftovers(p), []);
  });

  it("a heartbeat that cannot be written keeps the instance the owner and leaves no temp file", () => {
    const p = lockPath();
    const a = new AutomationOwnership({ path: p, pid: 111, port: 3000, fs: { ...fs, renameSync: () => { throw code("EACCES"); } } });
    a.acquire();
    assert.equal(a.heartbeat(), true);
    assert.equal(a.isOwner(), true);
    assert.deepEqual(leftovers(p), []);
  });

  it("heartbeat reports the loss when the lock now belongs to someone else, and the instance stops being the owner", () => {
    const { p, a } = pair();
    a.acquire();
    fs.writeFileSync(p, JSON.stringify({ pid: 222, port: 3001, startedAt: 5, heartbeatAt: 1_000_000 }));
    assert.equal(a.heartbeat(), false);
    assert.equal(a.isOwner(), false);
    assert.equal(a.ownerPort(), 3001);
    assert.equal(read(p).pid, 222, "the other owner's lock is not overwritten");
    // same pid, different startedAt (a replaced instance) also counts as lost
    const { p: p2, a: a2 } = pair();
    a2.acquire();
    fs.writeFileSync(p2, JSON.stringify({ pid: 111, port: 3000, startedAt: 424242, heartbeatAt: 1_000_000 }));
    assert.equal(a2.heartbeat(), false);
  });

  it("heartbeat recreates the lock if it vanished", () => {
    const { p, a } = pair();
    a.acquire();
    fs.unlinkSync(p);
    assert.equal(a.heartbeat(), true);
    assert.equal(read(p).pid, 111);
  });

  it("tryAcquire: a non-owner takes over once the owner stopped heartbeating; a heartbeating owner keeps it", () => {
    const { p, clock, a, b } = pair();
    a.acquire();
    assert.equal(b.acquire(), false);
    for (let i = 0; i < 5; i++) {                       // 150 s with a live, heartbeating owner
      clock.t += 30_000;
      a.heartbeat();
      assert.equal(b.tryAcquire(), false);
    }
    assert.equal(b.isOwner(), false);
    clock.t += 91_000;                                    // the owner went away without releasing (killed)
    assert.equal(b.tryAcquire(), true);
    assert.equal(b.isOwner(), true);
    assert.equal(read(p).pid, 222);
    assert.equal(a.heartbeat(), false, "the old owner notices it lost the lock");
  });

  it("tryAcquire against a live owner only reads the lock (no write, no link)", () => {
    const writes = [];
    const spy = { ...fs };
    for (const f of ["writeFileSync", "linkSync", "renameSync", "unlinkSync"]) spy[f] = (...x) => { writes.push(f); return fs[f](...x); };
    const { a, b } = pair({ b: { fs: spy } });
    a.acquire();
    assert.equal(b.tryAcquire(), false);
    assert.equal(b.tryAcquire(), false);
    assert.deepEqual(writes, []);
  });

  it("release removes the lock only if it is still ours", () => {
    const { p, alive, a, b } = pair();
    a.acquire();
    alive.delete(111);
    b.acquire();                               // b took over a's stale lock
    a.release();                               // a's late release must not remove b's lock
    assert.equal(fs.existsSync(p), true);
    assert.equal(read(p).pid, 222);
    b.release();
    assert.equal(fs.existsSync(p), false);
    b.release();                               // releasing twice is harmless
  });

  it("a refused instance does not remove the owner's lock on release", () => {
    const { p, a, b } = pair();
    a.acquire(); b.acquire(); b.release();
    assert.equal(fs.existsSync(p), true);
  });

  it("an unwritable lock location never loses the schedules (fail open)", () => {
    const p = path.join(lockPath(), "nope", "deeper.lock");     // parent folder does not exist
    const a = new AutomationOwnership({ path: p, pid: 111, port: 3000 });
    assert.equal(a.acquire(), true);
    assert.equal(a.isOwner(), true);
    assert.equal(a.heartbeat(), true);
  });

  it("processAlive: this process is alive, an unused pid is not", () => {
    assert.equal(processAlive(process.pid), true);
    assert.equal(processAlive(2 ** 22 + 12345), false);
  });
});
