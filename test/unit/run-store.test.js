// test/unit/run-store.test.js — run history store and capped logs
"use strict";
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { Crypto } = require("../../dist/core/Crypto");
const { JsonStore } = require("../../dist/core/JsonStore");
const { RunStore } = require("../../dist/automation/RunStore");

const tmpDirs = [];
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

function mkJson(dir) {
  return new JsonStore({ path: path.join(dir, "runs.enc"), crypto: new Crypto(path.join(dir, "key")), fallback: () => [] });
}
function mk(dir = tmp("agenv-runs-")) {
  const store = mkJson(dir);
  const logDir = path.join(dir, "logs");
  return { dir, logDir, store, runs: new RunStore({ store, logDir }) };
}
const status = (fn) => { try { fn(); } catch (e) { return e.status; } return null; };
const writeLog = (runs, id, text) => { const p = runs.logPath(id); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };

describe("RunStore", () => {
  it("creates queued runs with defaults and a 12-hex id", () => {
    const { runs } = mk();
    const r = runs.create("r1", "manual");
    assert.match(r.id, /^[0-9a-f]{12}$/);
    assert.equal(r.routineId, "r1");
    assert.equal(r.trigger, "manual");
    assert.equal(r.status, "queued");
    assert.equal(r.reason, "");
    assert.equal(r.startedAt, null);
    assert.equal(r.finishedAt, null);
    assert.equal(r.exitCode, null);
    assert.equal(r.costUsd, 0);
    assert.equal(typeof r.queuedAt, "number");
    assert.deepEqual(runs.get(r.id), r);
  });

  it("skipped/coalesced runs are born finished with a reason and never started", () => {
    const { runs } = mk();
    const s = runs.create("r1", "schedule", "skipped", "paused");
    assert.equal(s.status, "skipped");
    assert.equal(s.reason, "paused");
    assert.equal(s.startedAt, null);
    assert.equal(s.finishedAt, s.queuedAt);
  });

  it("rejects bad trigger, status, routine id and reason", () => {
    const { runs } = mk();
    assert.equal(status(() => runs.create("r1", "cron")), 400);
    assert.equal(status(() => runs.create("r1", "manual", "weird")), 400);
    assert.equal(status(() => runs.create("", "manual")), 400);
    assert.equal(status(() => runs.create(5, "manual")), 400);
    assert.equal(status(() => runs.create("r1", "manual", "queued", 7)), 400);
  });

  it("update merges validated fields and persists", () => {
    const { runs, store } = mk();
    const r = runs.create("r1", "manual");
    const u = runs.update(r.id, { status: "running", startedAt: 1000 });
    assert.equal(u.status, "running");
    const f = runs.update(r.id, { status: "succeeded", finishedAt: 2500, durationMs: 1500, costUsd: 0.25, numTurns: 3, conversationId: "abc-123", exitCode: 0, summary: "ok" });
    assert.equal(f.costUsd, 0.25);
    assert.equal(store.load()[0].exitCode, 0);
    assert.equal(runs.get(r.id).summary, "ok");
    assert.equal(runs.get(r.id).startedAt, 1000);
  });

  it("update ignores identity fields and unknown keys", () => {
    const { runs } = mk();
    const r = runs.create("r1", "manual");
    const u = runs.update(r.id, { id: "evil", routineId: "other", queuedAt: 1, trigger: "schedule", bogus: 1 });
    assert.equal(u.id, r.id);
    assert.equal(u.routineId, "r1");
    assert.equal(u.queuedAt, r.queuedAt);
    assert.equal(u.trigger, "manual");
    assert.equal("bogus" in u, false);
  });

  it("update validates the patch (400) and unknown ids (404)", () => {
    const { runs } = mk();
    const r = runs.create("r1", "manual");
    for (const bad of [{ status: "nope" }, { costUsd: NaN }, { costUsd: Infinity }, { costUsd: "1" }, { costUsd: -1 }, { numTurns: 1.5 },
      { durationMs: -5 }, { startedAt: "x" }, { finishedAt: NaN }, { exitCode: "0" }, { reason: 5 }, { error: {} }, { summary: 7 }, { conversationId: "../x" }]) {
      assert.equal(status(() => runs.update(r.id, bad)), 400, JSON.stringify(bad));
    }
    assert.equal(status(() => runs.update(r.id, null)), 400);
    assert.equal(status(() => runs.update(r.id, [])), 400);
    assert.equal(status(() => runs.update("ffffffffffff", { status: "failed" })), 404);
    assert.equal(runs.get(r.id).status, "queued");
  });

  it("over-long reason/error are truncated to 500 chars ending in an ellipsis, never rejected", () => {
    const { runs } = mk();
    const r = runs.create("r1", "manual");
    assert.equal(runs.update(r.id, { error: "x".repeat(500) }).error, "x".repeat(500));
    const u = runs.update(r.id, { reason: "r".repeat(5000), error: "e".repeat(5000) });
    assert.equal(u.reason, "r".repeat(499) + "…");
    assert.equal(u.error, "e".repeat(499) + "…");
    assert.equal(runs.get(r.id).error.length, 500);
    assert.equal(status(() => runs.update(r.id, { error: 5 })), 400);
  });

  it("a 5000-char reason/error on create and update does not break the lifecycle", () => {
    const { runs } = mk();
    const s = runs.create("r1", "schedule", "skipped", "p".repeat(5000));
    assert.equal(s.reason.length, 500);
    assert.ok(s.reason.endsWith("…"));
    const r = runs.create("r1", "manual");
    runs.update(r.id, { status: "running", startedAt: Date.now() });
    assert.equal(runs.active("r1").id, r.id);
    const f = runs.update(r.id, { status: "failed", finishedAt: Date.now(), exitCode: 1, error: "stderr ".repeat(1000), reason: "why ".repeat(1000) });
    assert.equal(f.status, "failed");
    assert.equal(f.error.length, 500);
    assert.equal(f.reason.length, 500);
    assert.equal(runs.active("r1"), undefined);
  });

  it("summary is truncated to 2000 chars", () => {
    const { runs } = mk();
    const r = runs.create("r1", "manual");
    assert.equal(runs.update(r.id, { summary: "s".repeat(5000) }).summary.length, 2000);
    assert.equal(runs.get(r.id).summary.length, 2000);
  });

  it("keeps only the newest 500 runs and deletes pruned runs' log files", () => {
    const { runs, logDir } = mk();
    const first = runs.create("r1", "schedule");
    const second = runs.create("r1", "schedule");
    const p1 = writeLog(runs, first.id, "old\n"), p2 = writeLog(runs, second.id, "old2\n");
    for (let i = 0; i < 498; i++) runs.create("r1", "schedule");
    assert.equal(runs.list("r1", 500).length, 500);
    assert.ok(fs.existsSync(p1), "500 runs still fit");
    const third = runs.create("r1", "schedule"); // 501st: the oldest goes
    assert.equal(runs.get(first.id), undefined);
    assert.ok(runs.get(second.id));
    assert.ok(runs.get(third.id));
    assert.equal(fs.existsSync(p1), false);
    assert.ok(fs.existsSync(p2));
    runs.create("r1", "schedule");
    assert.equal(fs.existsSync(p2), false);
    assert.equal(runs.list(undefined, 500).length, 500);
    assert.equal(fs.readdirSync(logDir).length, 0);
  });

  it("pruning tolerates a missing log file", () => {
    const { runs } = mk();
    for (let i = 0; i < 502; i++) runs.create("r1", "schedule");
    assert.equal(runs.list(undefined, 500).length, 500);
  });

  it("list is newest first, filtered by routine, default limit 50, max 500", () => {
    const { runs } = mk();
    const ids = [];
    for (let i = 0; i < 60; i++) ids.push(runs.create(i % 2 ? "a" : "b", "schedule").id);
    const all = runs.list();
    assert.equal(all.length, 50);
    assert.equal(all[0].id, ids[59]);
    assert.equal(all[1].id, ids[58]);
    const a = runs.list("a", 10);
    assert.equal(a.length, 10);
    assert.ok(a.every((r) => r.routineId === "a"));
    assert.equal(a[0].id, ids[59]);
    assert.equal(runs.list(undefined, 3).length, 3);
    assert.equal(runs.list(undefined, 100000).length, 60);
    assert.equal(runs.list(undefined, 0).length, 50);
    assert.equal(runs.list(undefined, -4).length, 50);
    assert.equal(runs.list(undefined, NaN).length, 50);
    assert.equal(runs.list("none").length, 0);
  });

  it("costSince sums costUsd of runs started since", () => {
    const { runs } = mk();
    const mkRun = (cost, startedAt) => {
      const r = runs.create("r1", "schedule");
      runs.update(r.id, { costUsd: cost, startedAt, status: "succeeded" });
    };
    mkRun(0.5, 1000);
    mkRun(1.25, 2000);
    mkRun(4, 500);
    runs.create("r1", "schedule", "skipped", "x"); // never started, no cost
    assert.equal(runs.costSince(1000), 1.75);
    assert.equal(runs.costSince(2001), 0);
    assert.equal(runs.costSince(0), 5.75);
  });

  it("countSince counts started (not skipped/coalesced) runs of that routine", () => {
    const { runs } = mk();
    const started = (rid, t) => { const r = runs.create(rid, "schedule"); runs.update(r.id, { startedAt: t, status: "running" }); };
    started("r1", 1000);
    started("r1", 3000);
    started("r1", 100);
    started("r2", 3000);
    runs.create("r1", "schedule", "skipped", "paused");
    runs.create("r1", "schedule", "coalesced", "already running");
    runs.create("r1", "schedule"); // queued, not started
    assert.equal(runs.countSince("r1", 1000), 2);
    assert.equal(runs.countSince("r1", 0), 3);
    assert.equal(runs.countSince("r2", 0), 1);
    assert.equal(runs.countSince("r1", 5000), 0);
  });

  it("logPath is <logDir>/<id>.log and nothing is created until the runner writes", () => {
    const { runs, logDir } = mk();
    const r = runs.create("r1", "manual");
    assert.equal(runs.logPath(r.id), path.join(logDir, `${r.id}.log`));
    assert.equal(fs.existsSync(logDir), false);
    assert.equal(runs.readLog(r.id, 1000), "");
    assert.equal(fs.existsSync(logDir), false);
  });

  it("readLog returns only the last N bytes, cut at a line boundary", () => {
    const { runs } = mk();
    const r = runs.create("r1", "manual");
    writeLog(runs, r.id, "line one\nline two\nline three\n");
    assert.equal(runs.readLog(r.id, 1000), "line one\nline two\nline three\n");
    assert.equal(runs.readLog(r.id, 14), "line three\n"); // starts mid "line two": cut forward to next line
    assert.equal(runs.readLog(r.id, 11), "line three\n"); // starts exactly on a line
    assert.equal(runs.readLog(r.id, 12), "line three\n"); // starts at the newline ending line two
    assert.equal(runs.readLog(r.id, 5), "hree\n"); // only a partial line fits: better than nothing
    assert.equal(runs.readLog(r.id, 17), "line three\n"); // partial line two is dropped when a complete line follows
    assert.equal(runs.readLog(r.id, 0), "");
    assert.equal(runs.readLog(r.id, -3), "");
    assert.equal(status(() => runs.readLog(r.id, NaN)), 400);
    assert.equal(status(() => runs.readLog(r.id, "5")), 400);
  });

  it("readLog never returns more than 1 MB", () => {
    const { runs } = mk();
    const r = runs.create("r1", "manual");
    const line = "x".repeat(99) + "\n";
    writeLog(runs, r.id, line.repeat(30000)); // 3 MB
    const out = runs.readLog(r.id, 50 * 1024 * 1024);
    assert.ok(Buffer.byteLength(out) <= 1024 * 1024);
    assert.ok(Buffer.byteLength(out) > 1024 * 1024 - 200);
    assert.ok(out.startsWith("x") && out.endsWith("\n"));
    assert.equal(out.length % 100, 0);
  });

  it("readLog keeps multi-byte characters intact", () => {
    const { runs } = mk();
    const r = runs.create("r1", "manual");
    writeLog(runs, r.id, "héllo wörld\nsecond ✓ line\n");
    assert.equal(runs.readLog(r.id, 9), "✓ line\n");
    assert.equal(runs.readLog(r.id, 8), " line\n"); // starts inside the check mark: continuation bytes skipped
    assert.equal(runs.readLog(r.id, 14), "cond ✓ line\n"); // no complete line fits: the partial one is returned
    assert.equal(runs.readLog(r.id, 18), "second ✓ line\n");
  });

  it("readLog returns the tail of a single line longer than the window", () => {
    const { runs } = mk();
    const r = runs.create("r1", "manual");
    writeLog(runs, r.id, "a".repeat(100 * 1024) + "b".repeat(100 * 1024)); // one 200 KB line, no newline
    const out = runs.readLog(r.id, 64 * 1024);
    assert.equal(out.length, 64 * 1024);
    assert.ok(out.endsWith("b"));
    assert.ok(!out.includes("�"));
    // a finished long line (newline is the last byte of the window): cutting would leave nothing, so keep its tail
    writeLog(runs, r.id, "z".repeat(200 * 1024) + "\n");
    const out2 = runs.readLog(r.id, 64 * 1024);
    assert.equal(out2.length, 64 * 1024);
    assert.ok(out2.endsWith("z\n"));
  });

  it("readLog skips UTF-8 continuation bytes when the window starts inside a multibyte char", () => {
    const { runs } = mk();
    const r = runs.create("r1", "manual");
    writeLog(runs, r.id, "✓".repeat(1000)); // 3000 bytes, one line, no newline
    for (const n of [1000, 1001, 1002]) { // each start offset lands on a different byte of a check mark
      const out = runs.readLog(r.id, n);
      assert.ok(out.length > 0);
      assert.ok(!out.includes("�"), `window ${n}`);
      assert.ok(out.startsWith("✓"), `window ${n}`);
      assert.ok(Buffer.byteLength(out) <= n);
    }
  });

  it("removeForRoutine deletes that routine's runs and logs, only when none is queued/running", () => {
    const { runs } = mk();
    const a1 = runs.create("a", "manual"); runs.update(a1.id, { status: "succeeded", finishedAt: 1 });
    const a2 = runs.create("a", "schedule", "skipped", "x");
    const b1 = runs.create("b", "manual"); runs.update(b1.id, { status: "succeeded", finishedAt: 1 });
    const pa1 = writeLog(runs, a1.id, "log\n"), pb1 = writeLog(runs, b1.id, "log\n");
    const a3 = runs.create("a", "manual");
    assert.deepEqual(runs.removeForRoutine("a"), { removed: 0 }, "active run blocks removal");
    assert.ok(runs.get(a1.id));
    assert.ok(fs.existsSync(pa1));
    runs.update(a3.id, { status: "cancelled", finishedAt: 2 });
    assert.deepEqual(runs.removeForRoutine("a"), { removed: 3 });
    assert.equal(runs.get(a1.id), undefined);
    assert.equal(runs.get(a2.id), undefined);
    assert.equal(fs.existsSync(pa1), false);
    assert.ok(runs.get(b1.id));
    assert.ok(fs.existsSync(pb1));
    assert.deepEqual(runs.removeForRoutine("a"), { removed: 0 });
  });

  it("readLog/logPath reject ids that are not safe ids (no traversal)", () => {
    const { runs, dir } = mk();
    fs.writeFileSync(path.join(dir, "secret.log"), "secret\n");
    for (const bad of ["../secret", "..\\secret", "a/b", "", ".", "..", "x".repeat(200), "a\0b", null, undefined, 5, "a b"]) {
      assert.equal(status(() => runs.readLog(bad, 100)), 400, String(bad));
      assert.equal(status(() => runs.logPath(bad)), 400, String(bad));
    }
  });

  it("markInterrupted turns queued/running runs into failed with reason \"interrupted by restart\" and returns the count", () => {
    const { runs } = mk();
    const q = runs.create("r1", "manual");
    const run = runs.create("r1", "manual");
    runs.update(run.id, { status: "running", startedAt: Date.now() - 5000 });
    const ok = runs.create("r1", "manual");
    runs.update(ok.id, { status: "succeeded", finishedAt: 5 });
    const sk = runs.create("r1", "manual", "skipped", "paused");
    assert.equal(runs.markInterrupted(), 2);
    for (const id of [q.id, run.id]) {
      const r = runs.get(id);
      assert.equal(r.status, "failed");
      assert.equal(r.reason, "interrupted by restart");
      assert.equal(r.error, "interrupted by restart");
      assert.equal(typeof r.finishedAt, "number");
    }
    assert.ok(runs.get(run.id).durationMs >= 5000);
    assert.equal(runs.get(q.id).durationMs, 0);
    assert.equal(runs.get(ok.id).status, "succeeded");
    assert.equal(runs.get(ok.id).finishedAt, 5);
    assert.equal(runs.get(sk.id).reason, "paused");
    assert.equal(runs.markInterrupted(), 0);
  });

  it("active returns the queued/running run of a routine", () => {
    const { runs } = mk();
    assert.equal(runs.active("r1"), undefined);
    const a = runs.create("r1", "manual");
    assert.equal(runs.active("r1").id, a.id);
    assert.equal(runs.active("r2"), undefined);
    runs.update(a.id, { status: "running", startedAt: 1 });
    assert.equal(runs.active("r1").id, a.id);
    runs.update(a.id, { status: "succeeded", finishedAt: 2 });
    assert.equal(runs.active("r1"), undefined);
    runs.create("r1", "schedule", "coalesced", "x");
    assert.equal(runs.active("r1"), undefined);
  });

  it("survives reload", () => {
    const { dir, logDir, runs } = mk();
    const r = runs.create("r1", "catch_up");
    runs.update(r.id, { status: "failed", error: "boom", finishedAt: 9 });
    const again = new RunStore({ store: mkJson(dir), logDir });
    assert.equal(again.get(r.id).error, "boom");
    assert.equal(again.get(r.id).trigger, "catch_up");
    assert.equal(again.list().length, 1);
  });
});
