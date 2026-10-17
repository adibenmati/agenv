// test/unit/automation-core.test.js — guards, run queue and agent run executor
"use strict";
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { Crypto } = require("../../dist/core/Crypto");
const { JsonStore } = require("../../dist/core/JsonStore");
const { HttpError } = require("../../dist/core/HttpError");
const { RunStore } = require("../../dist/automation/RunStore");
const { AutomationSettings } = require("../../dist/automation/AutomationSettings");
const { AutomationGuards, localDayStart } = require("../../dist/automation/AutomationGuards");
const { RunQueue } = require("../../dist/automation/RunQueue");
const { AgentRunExecutor, applyResult, finishRun } = require("../../dist/automation/RunExecutor");
const { AgentStore } = require("../../dist/agents/AgentStore");
const { ClaudeRunner } = require("../../dist/agents/ClaudeRunner");
const { ConversationForker } = require("../../dist/agents/ConversationForker");
const { AgentService } = require("../../dist/agents/AgentService");
const { TrackedRunner } = require("../../dist/agents/TrackedRunner");

const FAKE = path.join(__dirname, "..", "fixtures", "fake-claude-cli.js");
const tmpDirs = [];
const tmp = (p = "agenv-core-") => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmpDirs.push(d); return d; };
afterEach(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); });
const until = async (fn) => { for (let i = 0; i < 400; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 25)); } assert.fail("timed out waiting"); };
const tick = () => new Promise((r) => setImmediate(r));

const jsonStore = (dir, name, fallback) => new JsonStore({ path: path.join(dir, name), crypto: new Crypto(path.join(dir, "key")), fallback });
function runStore(dir = tmp()) { return new RunStore({ store: jsonStore(dir, "runs.enc", () => []), logDir: path.join(dir, "logs") }); }
function settings(dir = tmp()) { return new AutomationSettings(jsonStore(dir, "auto.enc", () => ({}))); }

const routine = (o = {}) => ({
  id: "rt1", name: "R", enabled: true, cron: "0 9 * * *", timezone: "UTC", prompt: "do the thing",
  target: { kind: "agent", agentId: "ag1" }, conversation: "agent", permission: { mode: "acceptEdits", allowedTools: [] },
  allowBypass: false, model: "", maxBudgetUsd: 2, timeoutMin: 20, concurrency: "coalesce_if_active", catchUp: "skip_missed",
  maxRunsPerDay: null, nextRunAt: null, lastRunAt: null, created: 0, updated: 0, ...o,
});
/** A run in the store that started at `at` and cost `cost`. */
function started(runs, routineId, at, cost = 0) {
  const r = runs.create(routineId, "schedule");
  return runs.update(r.id, { status: "succeeded", startedAt: at, finishedAt: at + 1, costUsd: cost });
}

describe("AutomationGuards", () => {
  const NOW = Date.UTC(2026, 5, 10, 12, 0, 0);
  const DAY = 24 * 3600 * 1000;
  // A fixed "today" that starts 6 hours before NOW, independent of the machine's timezone.
  const dayStart = () => NOW - 6 * 3600 * 1000;
  const guards = (runs, st, over = {}) => new AutomationGuards({ settings: st, runs, now: () => NOW, dayStart, ...over });

  it("paused blocks schedule, manual and catch-up triggers", () => {
    const runs = runStore(), st = settings(); st.set({ paused: true });
    const g = guards(runs, st);
    for (const t of ["schedule", "manual", "catch_up"]) assert.deepEqual(g.check(routine(), t), { ok: false, reason: "automation paused" });
  });
  it("no caps and nothing run: ok", () => {
    assert.deepEqual(guards(runStore(), settings()).check(routine(), "manual"), { ok: true });
  });
  it("maxRunsPerDay counts today's started runs only", () => {
    const runs = runStore(), st = settings();
    started(runs, "rt1", NOW - 7 * 3600 * 1000);          // yesterday-ish: before the day start
    started(runs, "rt1", NOW - 3 * 3600 * 1000);          // today
    started(runs, "other", NOW - 2 * 3600 * 1000);        // today, another routine
    runs.create("rt1", "schedule", "skipped", "x");        // never started
    runs.create("rt1", "schedule");                        // queued, not started
    const g = guards(runs, st);
    assert.deepEqual(g.check(routine({ maxRunsPerDay: 2 }), "schedule"), { ok: true });
    assert.deepEqual(g.check(routine({ maxRunsPerDay: 1 }), "schedule"), { ok: false, reason: "daily run limit reached (1)" });
    assert.deepEqual(g.check(routine({ maxRunsPerDay: 1 }), "manual"), { ok: false, reason: "daily run limit reached (1)" });
    assert.deepEqual(g.check(routine({ maxRunsPerDay: null }), "schedule"), { ok: true });
  });
  it("the daily cost cap sums today's cost across routines", () => {
    const runs = runStore(), st = settings();
    started(runs, "rt1", NOW - 7 * 3600 * 1000, 50);       // before today: ignored
    started(runs, "rt1", NOW - 3 * 3600 * 1000, 1.25);
    started(runs, "other", NOW - 1 * 3600 * 1000, 0.75);
    const g = guards(runs, st);
    st.set({ maxDailyCostUsd: 2.01 });
    assert.deepEqual(g.check(routine(), "schedule"), { ok: true });
    st.set({ maxDailyCostUsd: 2 });
    assert.deepEqual(g.check(routine(), "schedule"), { ok: false, reason: "daily cost cap reached ($2)" });   // >= blocks
    st.set({ maxDailyCostUsd: 1.5 });
    assert.deepEqual(g.check(routine(), "manual"), { ok: false, reason: "daily cost cap reached ($1.5)" });
  });
  it("a cap of 0 blocks every run and null means no cap", () => {
    const runs = runStore(), st = settings();
    const g = guards(runs, st);
    st.set({ maxDailyCostUsd: 0 });
    assert.deepEqual(g.check(routine(), "manual"), { ok: false, reason: "daily cost cap reached ($0)" });
    st.set({ maxDailyCostUsd: null });
    assert.deepEqual(g.check(routine(), "manual"), { ok: true });
  });
  it("paused wins over the other reasons", () => {
    const runs = runStore(), st = settings(); st.set({ paused: true, maxDailyCostUsd: 0 });
    started(runs, "rt1", NOW - 1000);
    assert.equal(guards(runs, st).check(routine({ maxRunsPerDay: 1 }), "manual").reason, "automation paused");
  });
  it("the local-day boundary comes from dayStart(now): a run just before it does not count, just after it does", () => {
    const runs = runStore(), st = settings();
    const boundary = Date.UTC(2026, 5, 10, 0, 0, 0);
    const g = new AutomationGuards({ settings: st, runs, now: () => boundary + 5 * 60 * 1000, dayStart: () => boundary });
    started(runs, "rt1", boundary - 1);
    assert.deepEqual(g.check(routine({ maxRunsPerDay: 1 }), "schedule"), { ok: true });
    started(runs, "rt1", boundary);
    assert.equal(g.check(routine({ maxRunsPerDay: 1 }), "schedule").ok, false);
    // the next calendar day starts counting from zero again
    const g2 = new AutomationGuards({ settings: st, runs, now: () => boundary + DAY + 1000, dayStart: () => boundary + DAY });
    assert.deepEqual(g2.check(routine({ maxRunsPerDay: 1 }), "schedule"), { ok: true });
  });
  it("reservedUsd is added to today's spend before comparing with the cap", () => {
    const runs = runStore(), st = settings();
    started(runs, "rt1", NOW - 3 * 3600 * 1000, 1.5);
    const g = guards(runs, st);
    st.set({ maxDailyCostUsd: 2 });
    assert.deepEqual(g.check(routine(), "schedule", { reservedUsd: 0.4 }), { ok: true });
    assert.deepEqual(g.check(routine(), "schedule"), { ok: true });
    assert.deepEqual(g.check(routine(), "schedule", { reservedUsd: 0.6 }), { ok: false, reason: "daily cost cap reached ($2)" });   // 1.5 + 0.6 >= 2
    st.set({ maxDailyCostUsd: 0 });
    assert.equal(g.check(routine(), "manual", { reservedUsd: 0 }).ok, false);
    st.set({ maxDailyCostUsd: null });
    assert.deepEqual(g.check(routine(), "manual", { reservedUsd: 1000 }), { ok: true });
  });
  it("a 23-hour DST day: the run in the last half hour of the short day does not count toward the next day", () => {
    const runs = runStore(), st = settings();
    const H = 3600 * 1000;
    const springForward = Date.UTC(2026, 2, 8, 5, 0, 0);          // local midnight that begins a 23-hour day
    const nextDay = springForward + 23 * H;
    started(runs, "rt1", nextDay - 30 * 60 * 1000);               // the last half hour of the short day
    const g = new AutomationGuards({ settings: st, runs, now: () => nextDay + 30 * 60 * 1000, dayStart: () => nextDay });
    assert.deepEqual(g.check(routine({ maxRunsPerDay: 1 }), "schedule"), { ok: true });
    const wrong = new AutomationGuards({ settings: st, runs, now: () => nextDay + 30 * 60 * 1000, dayStart: () => nextDay - 24 * H });
    assert.equal(wrong.check(routine({ maxRunsPerDay: 1 }), "schedule").ok, false);   // fixed 24 h arithmetic would have blocked it
  });
  it("localDayStart is machine-local midnight", () => {
    const t = new Date(2026, 5, 10, 15, 30, 45, 123).getTime();
    const s = new Date(localDayStart(t));
    assert.deepEqual([s.getFullYear(), s.getMonth(), s.getDate(), s.getHours(), s.getMinutes(), s.getSeconds(), s.getMilliseconds()], [2026, 5, 10, 0, 0, 0, 0]);
  });
  it("by default 'today' is the local day of the injected now", () => {
    const runs = runStore(), st = settings();
    const now = new Date(2026, 5, 10, 15, 0, 0).getTime();
    started(runs, "rt1", new Date(2026, 5, 9, 23, 59, 0).getTime());
    started(runs, "rt1", new Date(2026, 5, 10, 0, 1, 0).getTime());
    const g = new AutomationGuards({ settings: st, runs, now: () => now });
    assert.equal(g.check(routine({ maxRunsPerDay: 2 }), "schedule").ok, true);
    assert.equal(g.check(routine({ maxRunsPerDay: 1 }), "schedule").ok, false);
  });
});

describe("RunQueue", () => {
  const mkRun = (id) => ({ id });
  /** execute() whose jobs finish when the test says so. */
  function rig(limit = 2, over = {}) {
    const started = [], jobs = new Map(), errors = [];
    const queue = new RunQueue({
      limit,
      onError: (run, err) => errors.push([run.id, err]),
      execute: (run, register) => new Promise((resolve, reject) => {
        started.push(run.id);
        jobs.set(run.id, { resolve, reject });
        if (over.handle) register(() => over.handle(run.id, jobs.get(run.id)));
      }),
    });
    return { queue, started, jobs, errors };
  }

  it("runs at most 2 at once and starts the next in FIFO order when one finishes", async () => {
    const { queue, started, jobs } = rig(2);
    for (const id of ["a", "b", "c", "d"]) queue.enqueue(mkRun(id));
    assert.deepEqual(started, ["a", "b"]);
    assert.equal(queue.running(), 2); assert.equal(queue.size(), 2);
    jobs.get("b").resolve();
    await tick(); await tick();
    assert.deepEqual(started, ["a", "b", "c"]);
    assert.equal(queue.running(), 2); assert.equal(queue.size(), 1);
    jobs.get("a").resolve(); jobs.get("c").resolve();
    await tick(); await tick();
    assert.deepEqual(started, ["a", "b", "c", "d"]);
    jobs.get("d").resolve();
    await queue.idle();
    assert.equal(queue.running(), 0); assert.equal(queue.size(), 0);
  });
  it("a failing job frees its slot, calls onError and never throws from enqueue", async () => {
    const { queue, started, jobs, errors } = rig(1);
    queue.enqueue(mkRun("a")); queue.enqueue(mkRun("b"));
    const boom = new Error("boom");
    jobs.get("a").reject(boom);
    await tick(); await tick();
    assert.deepEqual(started, ["a", "b"]);
    assert.deepEqual(errors, [["a", boom]]);
    jobs.get("b").resolve();
    await queue.idle();
  });
  it("an execute that throws synchronously also frees the slot", async () => {
    const errs = [], seen = [];
    const queue = new RunQueue({ limit: 1, onError: (r, e) => errs.push([r.id, e.message]), execute: (run) => { seen.push(run.id); if (run.id === "a") throw new Error("sync"); return Promise.resolve(); } });
    assert.doesNotThrow(() => { queue.enqueue(mkRun("a")); queue.enqueue(mkRun("b")); });
    await queue.idle();
    assert.deepEqual(seen, ["a", "b"]); assert.deepEqual(errs, [["a", "sync"]]);
  });
  it("an onError that throws does not wedge the queue", async () => {
    const queue = new RunQueue({ limit: 1, onError: () => { throw new Error("handler"); }, execute: (run) => (run.id === "a" ? Promise.reject(new Error("x")) : Promise.resolve()) });
    queue.enqueue(mkRun("a")); queue.enqueue(mkRun("b"));
    await queue.idle();
    assert.equal(queue.running(), 0);
  });
  it("cancel removes a queued run (true) and an unknown id is false", async () => {
    const { queue, started, jobs } = rig(1);
    queue.enqueue(mkRun("a")); queue.enqueue(mkRun("b")); queue.enqueue(mkRun("c"));
    assert.equal(queue.cancel("b"), true);
    assert.equal(queue.cancel("nope"), false);
    assert.equal(queue.size(), 1);
    jobs.get("a").resolve();
    await tick(); await tick();
    assert.deepEqual(started, ["a", "c"]);
    jobs.get("c").resolve();
    await queue.idle();
  });
  it("cancel of a running run invokes its handle; the slot frees when the job settles", async () => {
    const calls = [];
    const { queue, started, jobs } = rig(1, { handle: (id, job) => { calls.push(id); job.resolve(); } });
    queue.enqueue(mkRun("a")); queue.enqueue(mkRun("b"));
    assert.equal(queue.cancel("a"), true);
    assert.deepEqual(calls, ["a"]);
    await tick(); await tick();
    assert.deepEqual(started, ["a", "b"]);
    assert.equal(queue.cancel("a"), false);   // finished: no longer known
    jobs.get("b").resolve();
    await queue.idle();
  });
  it("a cancel requested before the job registers its handle fires on registration", async () => {
    let registerFn = null, cancelled = 0;
    const queue = new RunQueue({ limit: 1, execute: (run, register) => new Promise((resolve) => { registerFn = (fn) => register(fn); setTimeout(resolve, 20); }) });
    queue.enqueue(mkRun("a"));
    assert.equal(queue.cancel("a"), true);
    registerFn(() => { cancelled++; });
    assert.equal(cancelled, 1);
    await queue.idle();
  });
  it("drain drops queued runs (returned) and cancels running ones", async () => {
    const calls = [];
    const { queue, jobs } = rig(2, { handle: (id, job) => { calls.push(id); job.resolve(); } });
    for (const id of ["a", "b", "c", "d"]) queue.enqueue(mkRun(id));
    const dropped = queue.drain();
    assert.deepEqual(dropped.map((r) => r.id), ["c", "d"]);
    assert.deepEqual(calls.sort(), ["a", "b"]);
    assert.equal(queue.size(), 0);
    await queue.idle();
    assert.equal(jobs.has("c"), false);
  });
  it("enqueue after drain is ignored and nothing starts", async () => {
    const { queue, started } = rig(2);
    queue.drain();
    queue.enqueue(mkRun("late"));
    assert.deepEqual(started, []);
    assert.equal(queue.size(), 0); assert.equal(queue.running(), 0);
    await queue.idle();
  });
  it("idle resolves immediately when empty", async () => {
    await new RunQueue({ limit: 2, execute: () => Promise.resolve() }).idle();
  });
});

describe("AgentRunExecutor with a fake agent service", () => {
  const okResult = (o = {}) => ({ status: "succeeded", conversationId: "conv-1", text: "all done", costUsd: 0.42, numTurns: 3, durationMs: 1234, exitCode: 0, ...o });
  function rig(agents, preflight) {
    const dir = tmp(), runs = runStore(dir);
    const run = runs.create("rt1", "schedule");
    const exec = new AgentRunExecutor({ agents, runs, now: () => 777, preflight });
    return { runs, run, exec };
  }
  const noop = { onStart: () => {} };

  it("agent target passes conversation mode, permission, model, budget, timeout in minutes and the run's logPath", async () => {
    const seen = [];
    const agents = { run: async (id, prompt, o) => { seen.push([id, prompt, o]); return okResult(); }, runInFolder: async () => { throw new Error("no"); } };
    const { runs, run, exec } = rig(agents);
    const rt = routine({ conversation: "fork", permission: { mode: "plan", allowedTools: ["Read"] }, model: "haiku", maxBudgetUsd: 3.5, timeoutMin: 7 });
    await exec.execute(run, rt, noop).done;
    assert.equal(seen.length, 1);
    const [id, prompt, o] = seen[0];
    assert.equal(id, "ag1"); assert.equal(prompt, "do the thing");
    assert.equal(o.conversation, "fork");
    assert.deepEqual(o.permission, { mode: "plan", allowedTools: ["Read"] });
    assert.equal(o.model, "haiku");
    assert.equal(o.maxBudgetUsd, 3.5);
    assert.equal(o.timeoutMs, 7 * 60000);
    assert.equal(o.logPath, runs.logPath(run.id));
    assert.equal(typeof o.onHandle, "function");
    assert.equal(o.cancelToken.cancelled, false);
  });
  it("an empty model is passed as undefined", async () => {
    let o2;
    const agents = { run: async (id, p, o) => { o2 = o; return okResult(); } };
    const { run, exec } = rig(agents);
    await exec.execute(run, routine({ model: "" }), noop).done;
    assert.equal(o2.model, undefined);
  });
  it("folder target uses runInFolder with permission, model, budget, timeout and logPath", async () => {
    const seen = [];
    const agents = { run: async () => { throw new Error("no"); }, runInFolder: async (cwd, prompt, spec) => { seen.push([cwd, prompt, spec]); return okResult(); } };
    const { runs, run, exec } = rig(agents);
    const rt = routine({ target: { kind: "folder", cwd: "C:\\work" }, conversation: "fresh", model: "opus", maxBudgetUsd: 1, timeoutMin: 2 });
    const res = await exec.execute(run, rt, noop).done;
    assert.equal(res.status, "succeeded");
    const [cwd, prompt, spec] = seen[0];
    assert.equal(cwd, "C:\\work"); assert.equal(prompt, "do the thing");
    assert.deepEqual(spec.permission, { mode: "acceptEdits", allowedTools: [] });
    assert.equal(spec.model, "opus"); assert.equal(spec.maxBudgetUsd, 1); assert.equal(spec.timeoutMs, 120000);
    assert.equal(spec.logPath, runs.logPath(run.id));
    assert.equal(spec.conversation, undefined);
  });
  it("onHandle marks the run running with startedAt and calls hooks.onStart exactly once", async () => {
    let handleCalls = 0, starts = 0;
    const agents = { run: async (id, p, o) => { o.onHandle(() => { handleCalls++; }); o.onHandle(() => {}); return okResult(); } };
    const { runs, run, exec } = rig(agents);
    await exec.execute(run, routine(), { onStart: () => { starts++; assert.equal(runs.get(run.id).status, "running"); } }).done;
    assert.equal(starts, 1);
    const cur = runs.get(run.id);
    assert.equal(cur.startedAt, 777);
    assert.equal(handleCalls, 0);
  });
  it("a run that never reported a handle (skipped) never gets a startedAt", async () => {
    const agents = { run: async () => { throw new HttpError(409, "busy"); } };
    const { runs, run, exec } = rig(agents);
    await exec.execute(run, routine(), noop).done;
    assert.equal(runs.get(run.id).startedAt, null);
  });
  it("cancel() sets the token and calls the reported handle", async () => {
    let tok, cancelCalls = 0, release;
    const agents = { run: (id, p, o) => new Promise((resolve) => { tok = o.cancelToken; o.onHandle(() => { cancelCalls++; resolve(okResult({ status: "cancelled" })); }); release = resolve; }) };
    const { run, exec } = rig(agents);
    const h = exec.execute(run, routine(), noop);
    h.cancel();
    assert.equal(tok.cancelled, true); assert.equal(cancelCalls, 1);
    assert.equal((await h.done).status, "cancelled");
    h.cancel();   // harmless after the end
  });
  it("preflight runs first with the run and routine; a reason skips the run: no call, no startedAt", async () => {
    let called = 0, seen;
    const agents = { run: async () => { called++; return okResult(); }, runInFolder: async () => { called++; return okResult(); } };
    const { runs, run, exec } = rig(agents, (r, rt) => { seen = [r.id, rt.id]; return "automation paused"; });
    assert.deepEqual(await exec.execute(run, routine(), noop).done, { status: "skipped", reason: "automation paused" });
    assert.deepEqual(seen, [run.id, "rt1"]);
    const f = await exec.execute(run, routine({ target: { kind: "folder", cwd: "x" } }), noop).done;
    assert.equal(f.status, "skipped");
    assert.equal(called, 0); assert.equal(runs.get(run.id).startedAt, null);
  });
  it("preflight returning null lets the run proceed; a throwing preflight skips instead of spawning", async () => {
    let called = 0;
    const agents = { run: async () => { called++; return okResult(); } };
    const ok = rig(agents, () => null);
    assert.equal((await ok.exec.execute(ok.run, routine(), noop).done).status, "succeeded");
    assert.equal(called, 1);
    const bad = rig(agents, () => { throw new Error("guard exploded"); });
    const res = await bad.exec.execute(bad.run, routine(), noop).done;
    assert.equal(res.status, "skipped"); assert.match(res.reason, /guard exploded/);
    assert.equal(called, 1);
  });
  it("cancel() before the process starts settles done immediately, even if the agent layer is still waiting", async () => {
    let tok;
    const agents = { run: (id, p, o) => { tok = o.cancelToken; return new Promise(() => {}); } };   // never settles: stuck behind a predecessor
    const { run, exec } = rig(agents);
    const h = exec.execute(run, routine(), noop);
    h.cancel();
    const res = await Promise.race([h.done, new Promise((r) => setTimeout(() => r("TIMEOUT"), 500))]);
    assert.equal(res.status, "cancelled");
    assert.equal(tok.cancelled, true);
  });
  it("cancel() before the handle exists only sets the token", async () => {
    let tok;
    const agents = { run: async (id, p, o) => { tok = o.cancelToken; return okResult({ status: "cancelled" }); } };
    const { run, exec } = rig(agents);
    const h = exec.execute(run, routine(), noop);
    h.cancel();
    assert.equal(tok.cancelled, true);
    assert.equal((await h.done).status, "cancelled");
  });
  it("HttpError from the agent layer becomes skipped with that reason", async () => {
    for (const [status, msg] of [[409, "the folder no longer exists: C:\\gone"], [409, "the conversation is open in a running terminal session; close it or wait before running the agent"], [400, "prompt is required"]]) {
      const agents = { run: async () => { throw new HttpError(status, msg); } };
      const { run, exec } = rig(agents);
      assert.deepEqual(await exec.execute(run, routine(), noop).done, { status: "skipped", reason: msg });
    }
  });
  it('a deleted agent (404) becomes skipped "agent no longer exists"', async () => {
    const agents = { run: async () => { throw new HttpError(404, "agent not found"); } };
    const { run, exec } = rig(agents);
    assert.deepEqual(await exec.execute(run, routine(), noop).done, { status: "skipped", reason: "agent no longer exists" });
  });
  it("an unexpected error becomes failed with a clipped message; the executor never throws", async () => {
    const agents = { run: async () => { throw new Error("x".repeat(2000)); }, runInFolder: () => { throw new TypeError("sync boom"); } };
    const { run, exec } = rig(agents);
    const a = await exec.execute(run, routine(), noop).done;
    assert.equal(a.status, "failed"); assert.ok(a.error.length <= 500); assert.equal(a.conversationId, "");
    const f = await exec.execute(run, routine({ target: { kind: "folder", cwd: "x" } }), noop).done;
    assert.equal(f.status, "failed"); assert.equal(f.error, "sync boom");
  });
  it("a hook that throws does not break the run", async () => {
    const agents = { run: async (id, p, o) => { o.onHandle(() => {}); return okResult(); } };
    const { run, exec } = rig(agents);
    assert.equal((await exec.execute(run, routine(), { onStart: () => { throw new Error("hook"); } }).done).status, "succeeded");
  });
});

describe("applyResult", () => {
  const mk = () => { const runs = runStore(); const run = runs.create("rt1", "schedule"); return { runs, run }; };
  const rt = routine();
  it("maps status, cost, turns, conversationId, exitCode, summary and timings", () => {
    const { runs, run } = mk();
    const out = applyResult(runs, run, rt, { status: "succeeded", conversationId: "conv-9", text: "s".repeat(3000), costUsd: 0.5, numTurns: 4, durationMs: 900, exitCode: 0 }, () => 5000);
    assert.equal(out.status, "succeeded"); assert.equal(out.costUsd, 0.5); assert.equal(out.numTurns, 4);
    assert.equal(out.conversationId, "conv-9"); assert.equal(out.exitCode, 0); assert.equal(out.durationMs, 900);
    assert.equal(out.finishedAt, 5000); assert.equal(out.summary.length, 2000); assert.equal(out.error, "");
    assert.deepEqual(runs.get(run.id), out);
  });
  it("maps failed, timed_out and cancelled 1:1 and keeps the error (clipped by the store)", () => {
    for (const status of ["failed", "timed_out", "cancelled"]) {
      const { runs, run } = mk();
      const out = applyResult(runs, run, rt, { status, conversationId: "", text: "", costUsd: 0, numTurns: 0, durationMs: 10, exitCode: null, error: "e".repeat(900) });
      assert.equal(out.status, status); assert.equal(out.error.length, 500); assert.equal(out.conversationId, ""); assert.equal(out.exitCode, null);
    }
  });
  it("skipped keeps status skipped with its reason and a finish time", () => {
    const { runs, run } = mk();
    const out = applyResult(runs, run, rt, { status: "skipped", reason: "agent no longer exists" }, () => 42);
    assert.equal(out.status, "skipped"); assert.equal(out.reason, "agent no longer exists"); assert.equal(out.finishedAt, 42); assert.equal(out.startedAt, null);
  });
  it("an unsafe conversation id is dropped instead of failing the update", () => {
    const { runs, run } = mk();
    const out = applyResult(runs, run, rt, { status: "succeeded", conversationId: "../evil id", text: "", costUsd: 0, numTurns: 0, durationMs: 1, exitCode: 0 });
    assert.equal(out.conversationId, ""); assert.equal(out.status, "succeeded");
  });
});

describe("applyResult charges for kills and finishRun is safe", () => {
  const mk = () => { const runs = runStore(); const run = runs.create("rt1", "schedule"); return { runs, run }; };
  const res = (o) => ({ status: "failed", conversationId: "", text: "", costUsd: 0, numTurns: 0, durationMs: 5, exitCode: null, ...o });
  it("a timed_out run is charged the routine's maxBudgetUsd when it reported less", () => {
    const { runs, run } = mk();
    assert.equal(applyResult(runs, run, routine({ maxBudgetUsd: 3 }), res({ status: "timed_out", costUsd: 0 })).costUsd, 3);
    const b = mk();
    assert.equal(applyResult(b.runs, b.run, routine({ maxBudgetUsd: 3 }), res({ status: "timed_out", costUsd: 0.5 })).costUsd, 3);
    const c = mk();
    assert.equal(applyResult(c.runs, c.run, routine({ maxBudgetUsd: 3 }), res({ status: "timed_out", costUsd: 4 })).costUsd, 4);
  });
  it("cancelled and failed runs keep their reported cost", () => {
    for (const status of ["cancelled", "failed"]) {
      const { runs, run } = mk();
      assert.equal(applyResult(runs, run, routine({ maxBudgetUsd: 3 }), res({ status, costUsd: 0.25 })).costUsd, 0.25);
    }
  });
  it("a timing-out routine moves the daily cap", () => {
    const runs = runStore(), st = settings(); st.set({ maxDailyCostUsd: 2 });
    const run = runs.create("rt1", "schedule");
    runs.update(run.id, { status: "running", startedAt: Date.now() });
    applyResult(runs, run, routine({ maxBudgetUsd: 2 }), res({ status: "timed_out" }));
    assert.equal(new AutomationGuards({ settings: st, runs }).check(routine(), "schedule").ok, false);
  });
  it("finishRun records the result like applyResult", () => {
    const { runs, run } = mk();
    const out = finishRun(runs, run, routine(), res({ status: "succeeded", text: "ok", exitCode: 0 }));
    assert.equal(out.status, "succeeded"); assert.equal(runs.get(run.id).summary, "ok");
  });
  it("finishRun falls back to a failed run with a short error when the update throws, never leaving it running", () => {
    const { runs, run } = mk();
    runs.update(run.id, { status: "running", startedAt: 1 });
    let n = 0;
    const flaky = { update: (id, patch) => { if (n++ === 0) throw new Error("disk full"); return runs.update(id, patch); } };
    finishRun(flaky, run, routine(), res({ status: "succeeded", text: "ok", exitCode: 0 }));
    const cur = runs.get(run.id);
    assert.equal(cur.status, "failed"); assert.match(cur.error, /disk full/); assert.ok(cur.finishedAt !== null);
  });
  it("finishRun never throws even if the fallback also fails", () => {
    const { run } = mk();
    const dead = { update: () => { throw new Error("gone"); } };
    assert.doesNotThrow(() => finishRun(dead, run, routine(), res({})));
  });
});

describe("AgentRunExecutor with the real AgentService and the fake claude", () => {
  function real(mode = "ok") {
    const dir = tmp(), state = tmp(), cwd = tmp();
    const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
    const store = new AgentStore(jsonStore(dir, "agents.enc", () => []), isDir);
    const runner = new TrackedRunner(new ClaudeRunner({ bin: FAKE, env: { FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_STATE: state } }));
    const sessions = { create: () => ({}), get: () => undefined, all: () => [] };
    const svc = new AgentService({ store, forker: new ConversationForker({ runner }), runner, sessions, isDir, projectsDir: state });
    const runs = runStore(dir);
    const exec = new AgentRunExecutor({ agents: svc, runs });
    const agent = svc.createBlank({ name: "Bob", specialty: "x", cwd });
    return { svc, runs, exec, agent, cwd, state };
  }
  const calls = (state) => { const f = path.join(state, "calls.jsonl"); return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []; };
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r("TIMEOUT"), ms))]);
  const pidFile = (state) => path.join(state, "child.pid");
  const readPid = (state) => (fs.existsSync(pidFile(state)) ? Number(fs.readFileSync(pidFile(state), "utf8")) : 0);

  it("runs the routine for an agent, records the result and writes the run log", async () => {
    const r = real();
    const run = r.runs.create("rt1", "schedule");
    let started = false;
    const res = await r.exec.execute(run, routine({ target: { kind: "agent", agentId: r.agent.id }, model: "haiku", timeoutMin: 3 }), { onStart: () => { started = true; } }).done;
    assert.equal(res.status, "succeeded"); assert.equal(started, true);
    const c = calls(r.state)[0];
    assert.equal(c.argv.at(-1), "do the thing"); assert.equal(c.argv[c.argv.indexOf("--model") + 1], "haiku");
    const done = applyResult(r.runs, run, routine(), res);
    assert.equal(done.status, "succeeded"); assert.equal(done.summary, "reply to: do the thing"); assert.equal(done.costUsd, 0.0123); assert.equal(done.numTurns, 1);
    assert.ok(done.startedAt !== null); assert.ok(fs.existsSync(r.runs.logPath(run.id)));
  });
  it("a folder target runs in that folder", async () => {
    const r = real(); const run = r.runs.create("rt1", "manual");
    const res = await r.exec.execute(run, routine({ target: { kind: "folder", cwd: r.cwd }, conversation: "fresh" }), { onStart() {} }).done;
    assert.equal(res.status, "succeeded");
    assert.equal(calls(r.state)[0].cwd, fs.realpathSync(r.cwd));
  });
  it("a missing folder and a deleted agent are skipped without spawning", async () => {
    const r = real(); const run = r.runs.create("rt1", "manual");
    const gone = await r.exec.execute(run, routine({ target: { kind: "folder", cwd: path.join(r.cwd, "gone") }, conversation: "fresh" }), { onStart() {} }).done;
    assert.equal(gone.status, "skipped"); assert.match(gone.reason, /no longer exists/);
    const noAgent = await r.exec.execute(run, routine({ target: { kind: "agent", agentId: "nope" } }), { onStart() {} }).done;
    assert.deepEqual(noAgent, { status: "skipped", reason: "agent no longer exists" });
    assert.equal(calls(r.state).length, 0);
  });
  it("cancel() on a running run kills the process tree and resolves cancelled", async () => {
    const r = real("hang"); const run = r.runs.create("rt1", "manual");
    const h = r.exec.execute(run, routine({ target: { kind: "agent", agentId: r.agent.id } }), { onStart() {} });
    await until(() => fs.existsSync(path.join(r.state, "child.pid")) && r.runs.get(run.id).status === "running");
    const child = Number(fs.readFileSync(path.join(r.state, "child.pid"), "utf8"));
    assert.ok(alive(child));
    h.cancel();
    const res = await h.done;
    assert.equal(res.status, "cancelled");
    await until(() => !alive(child));
    assert.equal(applyResult(r.runs, run, routine(), res).status, "cancelled");
  });
  it("cancel() before the run starts resolves cancelled without spawning", async () => {
    const r = real("slow");
    const first = r.runs.create("rt1", "manual"), second = r.runs.create("rt1", "manual");
    const rt = routine({ target: { kind: "agent", agentId: r.agent.id } });
    const h1 = r.exec.execute(first, rt, { onStart() {} });
    const h2 = r.exec.execute(second, rt, { onStart() {} });   // waits behind the first on the same agent
    h2.cancel();
    assert.equal((await h1.done).status, "succeeded");
    const res = await h2.done;
    assert.equal(res.status, "cancelled");
    assert.equal(calls(r.state).length, 1);
    assert.equal(r.runs.get(second.id).startedAt, null);
  });
  it("the queue plus executor cancel a running run and free the slot for the next", async () => {
    const r = real("hang");
    const rt = routine({ target: { kind: "agent", agentId: r.agent.id } });
    const handles = new Map();
    const queue = new RunQueue({
      limit: 1,
      execute: async (run, register) => {
        const h = r.exec.execute(run, rt, { onStart() {} });
        handles.set(run.id, h);
        register(() => h.cancel());
        finishRun(r.runs, run, rt, await h.done);
      },
    });
    const a = r.runs.create("rt1", "manual"), b = r.runs.create("rt1", "manual");
    queue.enqueue(a); queue.enqueue(b);
    await until(() => readPid(r.state) > 0);
    const childA = readPid(r.state);
    assert.equal(queue.size(), 1);
    assert.equal(queue.cancel(a.id), true);
    await until(() => readPid(r.state) !== childA && r.runs.get(b.id).status === "running");   // b really started its own process
    const childB = readPid(r.state);
    assert.equal(r.runs.get(a.id).status, "cancelled");
    assert.equal(queue.cancel(b.id), true);
    await queue.idle();
    assert.equal(r.runs.get(b.id).status, "cancelled");
    await until(() => !alive(childA) && !alive(childB));
  });
  it("cancelling a run still waiting behind a long predecessor frees its queue slot at once", async () => {
    const r = real("hang");
    const rt = routine({ target: { kind: "agent", agentId: r.agent.id } });
    const first = r.runs.create("rt1", "manual"), second = r.runs.create("rt1", "manual");
    const h1 = r.exec.execute(first, rt, { onStart() {} });
    await until(() => readPid(r.state) > 0 && r.runs.get(first.id).status === "running");
    const queue = new RunQueue({ limit: 1, execute: async (run, register) => { const h = r.exec.execute(run, rt, { onStart() {} }); register(() => h.cancel()); finishRun(r.runs, run, rt, await h.done); } });
    try {
      queue.enqueue(second);                                   // waits behind first on the same agent chain
      await tick();
      assert.equal(queue.running(), 1);
      assert.equal(queue.cancel(second.id), true);
      assert.notEqual(await within(queue.idle(), 500), "TIMEOUT");   // slot freed while the predecessor still runs
      assert.equal(r.runs.get(second.id).status, "cancelled");
      assert.equal(r.runs.get(first.id).status, "running");
      h1.cancel();                                             // cleanup
      assert.equal((await h1.done).status, "cancelled");
      await until(() => !alive(readPid(r.state)));
      assert.equal(calls(r.state).length, 1);                  // the cancelled run never spawned
    } finally { h1.cancel(); }
  });
  it("3 manual runs with maxRunsPerDay 1: only the first spawns, preflight skips the others at dequeue", async () => {
    const r = real("ok");
    const st = settings();
    const guards = new AutomationGuards({ settings: st, runs: r.runs });
    const exec = new AgentRunExecutor({ agents: r.svc, runs: r.runs, preflight: (run, rt) => { const g = guards.check(rt, run.trigger); return g.ok ? null : g.reason; } });
    const rt = routine({ target: { kind: "agent", agentId: r.agent.id }, maxRunsPerDay: 1 });
    const queue = new RunQueue({ limit: 1, execute: async (run) => { finishRun(r.runs, run, rt, await exec.execute(run, rt, { onStart() {} }).done); } });
    const ids = [1, 2, 3].map(() => r.runs.create("rt1", "manual"));
    for (const x of ids) queue.enqueue(x);
    await queue.idle();
    assert.equal(calls(r.state).length, 1);
    assert.deepEqual(ids.map((x) => r.runs.get(x.id).status), ["succeeded", "skipped", "skipped"]);
    assert.equal(r.runs.get(ids[1].id).reason, "daily run limit reached (1)");
    assert.equal(r.runs.get(ids[2].id).startedAt, null);
  });
  it("a pause that happens while runs are queued stops them at dequeue", async () => {
    const r = real("slow");
    const st = settings();
    const guards = new AutomationGuards({ settings: st, runs: r.runs });
    const exec = new AgentRunExecutor({ agents: r.svc, runs: r.runs, preflight: (run, rt) => { const g = guards.check(rt, run.trigger); return g.ok ? null : g.reason; } });
    const rt = routine({ target: { kind: "agent", agentId: r.agent.id } });
    const queue = new RunQueue({ limit: 1, execute: async (run) => { finishRun(r.runs, run, rt, await exec.execute(run, rt, { onStart() {} }).done); } });
    const a = r.runs.create("rt1", "manual"), b = r.runs.create("rt1", "manual");
    queue.enqueue(a); queue.enqueue(b);
    await until(() => r.runs.get(a.id).status === "running");
    st.set({ paused: true });
    await queue.idle();
    assert.equal(r.runs.get(a.id).status, "succeeded");
    assert.equal(r.runs.get(b.id).status, "skipped"); assert.equal(r.runs.get(b.id).reason, "automation paused");
    assert.equal(calls(r.state).length, 1);
  });
});
