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

describe("AutomationOwnership", () => {
  it("the first instance takes the lock and records pid, port and start time", () => {
    const p = lockPath();
    const a = new AutomationOwnership({ path: p, pid: 111, port: 3000, now: () => 42, isAlive: () => true });
    assert.equal(a.isOwner(), true, "owner until refused");
    assert.equal(a.acquire(), true);
    assert.deepEqual(read(p), { pid: 111, port: 3000, startedAt: 42 });
    assert.equal(a.ownerPort(), 3000);
  });

  it("a second instance is refused while the first's process is alive, and learns its port", () => {
    const p = lockPath();
    const alive = new Set([111]);
    const isAlive = (pid) => alive.has(pid);
    const a = new AutomationOwnership({ path: p, pid: 111, port: 3000, isAlive });
    const b = new AutomationOwnership({ path: p, pid: 222, port: 3001, isAlive });
    assert.equal(a.acquire(), true);
    assert.equal(b.acquire(), false);
    assert.equal(b.isOwner(), false);
    assert.equal(b.ownerPort(), 3000);
    assert.equal(read(p).pid, 111, "the lock is untouched");
  });

  it("a stale lock (its pid is gone) is taken over", () => {
    const p = lockPath();
    const alive = new Set([111, 222]);
    const isAlive = (pid) => alive.has(pid);
    const a = new AutomationOwnership({ path: p, pid: 111, port: 3000, isAlive });
    const b = new AutomationOwnership({ path: p, pid: 222, port: 3001, isAlive });
    a.acquire();
    alive.delete(111);
    assert.equal(b.acquire(), true);
    assert.equal(b.isOwner(), true);
    assert.deepEqual({ pid: read(p).pid, port: read(p).port }, { pid: 222, port: 3001 });
  });

  it("an unreadable or garbage lock counts as stale", () => {
    const p = lockPath();
    for (const junk of ["", "not json", "{}", '{"pid":"x"}', '{"pid":-3}']) {
      fs.writeFileSync(p, junk);
      const a = new AutomationOwnership({ path: p, pid: 5, port: 1, isAlive: () => true });
      assert.equal(a.acquire(), true, junk);
      assert.equal(read(p).pid, 5);
    }
  });

  it("acquiring again with the same pid succeeds (the lock is ours)", () => {
    const p = lockPath();
    const a = new AutomationOwnership({ path: p, pid: 111, port: 3000, isAlive: () => true });
    assert.equal(a.acquire(), true);
    assert.equal(a.acquire(), true);
  });

  it("release removes the lock only if it is still ours", () => {
    const p = lockPath();
    const alive = new Set([111, 222]);
    const isAlive = (pid) => alive.has(pid);
    const a = new AutomationOwnership({ path: p, pid: 111, port: 3000, isAlive });
    const b = new AutomationOwnership({ path: p, pid: 222, port: 3001, isAlive });
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
    const p = lockPath();
    const a = new AutomationOwnership({ path: p, pid: 111, port: 3000, isAlive: () => true });
    const b = new AutomationOwnership({ path: p, pid: 222, port: 3001, isAlive: () => true });
    a.acquire(); b.acquire(); b.release();
    assert.equal(fs.existsSync(p), true);
  });

  it("an unwritable lock location never loses the schedules (fail open)", () => {
    const p = path.join(lockPath(), "nope", "deeper.lock");     // parent folder does not exist
    const a = new AutomationOwnership({ path: p, pid: 111, port: 3000 });
    assert.equal(a.acquire(), true);
    assert.equal(a.isOwner(), true);
  });

  it("processAlive: this process is alive, an unused pid is not", () => {
    assert.equal(processAlive(process.pid), true);
    assert.equal(processAlive(2 ** 22 + 12345), false);
  });
});
