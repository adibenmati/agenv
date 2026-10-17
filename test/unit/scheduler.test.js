// test/unit/scheduler.test.js — routine scheduler, concurrency/catch-up policies and AutomationService
// Fake clock, fake agent service (controllable runs), real encrypted stores in temp dirs.
"use strict";
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { Crypto } = require("../../dist/core/Crypto");
const { JsonStore } = require("../../dist/core/JsonStore");
const { HttpError } = require("../../dist/core/HttpError");
const { RoutineStore } = require("../../dist/automation/RoutineStore");
const { RunStore } = require("../../dist/automation/RunStore");
const { AutomationSettings } = require("../../dist/automation/AutomationSettings");
const { AutomationGuards } = require("../../dist/automation/AutomationGuards");
const { AgentRunExecutor } = require("../../dist/automation/RunExecutor");
const { nextCronTime } = require("../../dist/automation/cron");
const { RoutineScheduler, createRunQueue, makePreflight } = require("../../dist/automation/RoutineScheduler");
const { AutomationService } = require("../../dist/automation/AutomationService");

const tmpDirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "agenv-sched-")); tmpDirs.push(d); return d; };
const timers = [];
afterEach(() => {
  while (timers.length) timers.pop()();
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});
const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 10)); } assert.fail("timed out waiting"); };

const DAY = 24 * 3600 * 1000, HOUR = 3600 * 1000;
const jsonStore = (dir, name, fallback) => new JsonStore({ path: path.join(dir, name), crypto: new Crypto(path.join(dir, "key")), fallback });
const okResult = (o = {}) => ({ status: "succeeded", conversationId: "conv-1", text: "done", costUsd: 0.1, numTurns: 1, durationMs: 5, exitCode: 0, ...o });
const cancelledResult = () => ({ status: "cancelled", conversationId: "", text: "", costUsd: 0, numTurns: 0, durationMs: 0, exitCode: null, error: "cancelled" });

/** Fake AgentService: runs stay pending until the test finishes them (or resolve at once with auto). */
function fakeAgents(o = {}) {
  const calls = [];
  const start = (kind, target, prompt, opts) => {
    const call = { kind, target, prompt, opts, resolve: null, cancelled: false };
    calls.push(call);
    if (o.throwWith) return Promise.reject(o.throwWith(call));
    if (o.throwSync) throw o.throwSync(call);
    // like the real service, the handle (the moment the process exists) is reported asynchronously, after the dequeue
    if (!o.noHandle) queueMicrotask(() => opts.onHandle?.(() => { call.cancelled = true; call.resolve?.(cancelledResult()); }));
    if (o.auto) return Promise.resolve(okResult());
    return new Promise((res) => { call.resolve = res; });
  };
  return {
    calls,
    run: (id, prompt, opts) => start("agent", id, prompt, opts),
    runInFolder: (cwd, prompt, opts) => start("folder", cwd, prompt, opts),
    finish: (i, result = okResult()) => calls[i].resolve(result),
    opened: [],
    get: (id) => ({ id, cwd: "C:\\agent-home" }),
    openTerminal(id) { this.opened.push(["terminal", id]); return { id: 7 }; },
    openConversation(conv, cwd) { this.opened.push(["conversation", conv, cwd]); return { id: 8 }; },
  };
}

const baseInput = (o = {}) => ({
  name: "Nightly", cron: "0 * * * *", timezone: "UTC", prompt: "do the thing",
  target: { kind: "agent", agentId: "ag1" }, ...o,
});

/** A fully wired automation stack on a fake clock. */
function rig(o = {}) {
  const dir = tmp();
  const clock = { t: Date.UTC(2026, 5, 10, 8, 30, 0) };       // Wed 08:30 UTC
  const now = () => clock.t;
  const saves = { n: 0 };
  const counted = (name, fb) => { const s = jsonStore(dir, name, fb); const save = s.save.bind(s); s.save = (v) => { saves.n++; return save(v); }; return s; };
  const changes = { n: 0 };
  const onChange = () => { changes.n++; };
  const isDir = o.isDir ?? (() => true), agentExists = o.agentExists ?? (() => true);
  const routines = new RoutineStore(counted("routines.enc", () => []), isDir, agentExists);
  const runs = new RunStore({ store: counted("runs.enc", () => []), logDir: path.join(dir, "logs") });
  const settings = new AutomationSettings(counted("auto.enc", () => ({})));
  const guards = o.guards ?? new AutomationGuards({ settings, runs, now, dayStart: (ms) => Math.floor(ms / DAY) * DAY });
  const agents = o.agents ?? fakeAgents(o.agentOpts);
  const executor = o.executor ?? new AgentRunExecutor({ agents, runs, now, preflight: makePreflight({ runs, routines, guards, now }) });
  const queue = createRunQueue({ limit: o.limit ?? 2, routines, runs, executor, now, onChange });
  const scheduler = new RoutineScheduler({ routines, runs, guards, queue, now, onChange, missedGraceMs: o.grace, log: () => {} });
  const service = new AutomationService({ routines, runs, settings, scheduler, queue, agents, isDir, agentExists, now, onChange });
  return { dir, clock, saves, changes, routines, runs, settings, guards, agents, executor, queue, scheduler, service, reopen: (name, fb) => jsonStore(dir, name, fb) };
}
const due = (r, rt, plusMs = 1000) => { r.clock.t = rt.nextRunAt + plusMs; };

describe("RoutineScheduler.tick", () => {
  it("a due routine is claimed (nextRunAt advanced and persisted) before the run is created", async () => {
    const r = rig({ agentOpts: { auto: true } });
    const rt = r.service.createRoutine(baseInput());
    due(r, rt);
    const seen = [];
    const create = r.runs.create.bind(r.runs);
    r.runs.create = (...a) => {
      const persisted = new RoutineStore(r.reopen("routines.enc", () => []), () => true, () => true).get(a[0]);
      seen.push(persisted.nextRunAt);
      return create(...a);
    };
    r.scheduler.tick();
    const expected = nextCronTime("0 * * * *", "UTC", r.clock.t);
    assert.deepEqual(seen, [expected]);
    assert.ok(expected > r.clock.t);
    await flush();
    assert.equal(r.routines.get(rt.id).nextRunAt, expected);
    assert.equal(r.runs.list(rt.id)[0].trigger, "schedule");
  });

  it("a crash between claim and run (executor throws synchronously) does not re-fire", async () => {
    const r = rig({ executor: { execute() { throw new Error("boom"); } } });
    const rt = r.service.createRoutine(baseInput());
    due(r, rt);
    r.scheduler.tick();
    await flush();
    const runs = r.runs.list(rt.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, "failed");
    assert.match(runs[0].error, /boom/);
    r.scheduler.tick(); r.scheduler.tick();
    await flush();
    assert.equal(r.runs.list(rt.id).length, 1, "the claimed slot is not fired again");
    assert.ok(r.routines.get(rt.id).nextRunAt > r.clock.t);
  });

  it("a throwing or rejecting executor never leaves a run queued or running", async () => {
    for (const executor of [
      { execute() { throw new Error("sync"); } },
      { execute() { return { done: Promise.reject(new Error("async")), cancel() {} }; } },
    ]) {
      const r = rig({ executor });
      const rt = r.service.createRoutine(baseInput());
      due(r, rt);
      r.scheduler.tick();
      await flush();
      assert.equal(r.runs.list(rt.id).length, 1);
      assert.ok(!["queued", "running"].includes(r.runs.list(rt.id)[0].status), r.runs.list(rt.id)[0].status);
    }
    // a preflight that throws, through the real executor
    const r = rig({ agentOpts: { auto: true } });
    const ex = new AgentRunExecutor({ agents: r.agents, runs: r.runs, now: () => r.clock.t, preflight: () => { throw new Error("pre"); } });
    const q2 = createRunQueue({ limit: 1, routines: r.routines, runs: r.runs, executor: ex, now: () => r.clock.t, onChange() {} });
    const s2 = new RoutineScheduler({ routines: r.routines, runs: r.runs, guards: r.guards, queue: q2, now: () => r.clock.t, onChange() {}, log() {} });
    const rt = r.service.createRoutine(baseInput());
    due(r, rt); s2.tick(); await flush();
    const run = r.runs.list(rt.id)[0];
    assert.equal(run.status, "skipped"); assert.match(run.reason, /preflight failed: pre/);
  });

  it("coalesce_if_active links the new firing to the active run (status coalesced, no second process)", async () => {
    const r = rig();
    const rt = r.service.createRoutine(baseInput());
    due(r, rt); r.scheduler.tick(); await flush();
    assert.equal(r.agents.calls.length, 1);
    const first = r.runs.list(rt.id)[0];
    assert.equal(first.status, "running");
    due(r, r.routines.get(rt.id)); r.scheduler.tick(); await flush();
    const [second] = r.runs.list(rt.id);
    assert.equal(second.status, "coalesced");
    assert.ok(second.reason.includes(first.id), second.reason);
    assert.equal(r.agents.calls.length, 1, "no second process");
    r.agents.finish(0); await flush();
    assert.equal(r.runs.get(first.id).status, "succeeded");
    assert.equal(r.routines.get(rt.id).lastRunAt, r.clock.t, "completion records lastRunAt");
  });

  it("skip_if_active records skipped", async () => {
    const r = rig();
    const rt = r.service.createRoutine(baseInput({ concurrency: "skip_if_active" }));
    due(r, rt); r.scheduler.tick(); await flush();
    const first = r.runs.list(rt.id)[0];
    due(r, r.routines.get(rt.id)); r.scheduler.tick(); await flush();
    const [second] = r.runs.list(rt.id);
    assert.equal(second.status, "skipped");
    assert.ok(second.reason.includes(first.id), second.reason);
    assert.equal(r.agents.calls.length, 1);
  });

  it("always_enqueue queues another", async () => {
    const r = rig({ limit: 1 });
    const rt = r.service.createRoutine(baseInput({ concurrency: "always_enqueue" }));
    due(r, rt); r.scheduler.tick(); await flush();
    due(r, r.routines.get(rt.id)); r.scheduler.tick(); await flush();
    const [second, first] = r.runs.list(rt.id);
    assert.equal(first.status, "running"); assert.equal(second.status, "queued");
    assert.equal(r.agents.calls.length, 1);
    r.agents.finish(0); await flush();
    assert.equal(r.agents.calls.length, 2, "the queued run starts when the slot frees");
    assert.equal(r.runs.get(second.id).status, "running");
  });

  it("paused automation records skipped \"automation paused\" and still advances nextRunAt", async () => {
    const r = rig({ agentOpts: { auto: true } });
    const rt = r.service.createRoutine(baseInput());
    r.service.setSettings({ paused: true });
    due(r, rt); r.scheduler.tick(); await flush();
    const [run] = r.runs.list(rt.id);
    assert.equal(run.status, "skipped"); assert.equal(run.reason, "automation paused");
    assert.equal(r.agents.calls.length, 0);
    assert.ok(r.routines.get(rt.id).nextRunAt > r.clock.t);
  });

  it("missing agent / missing folder / busy conversation → skipped with reason, schedule kept", async () => {
    const cases = [
      [() => new HttpError(404, "agent not found"), /agent no longer exists/],
      [() => new HttpError(409, "the folder no longer exists: C:\\gone"), /folder no longer exists/],
      [() => new HttpError(409, "the conversation is open in a running terminal session; close it"), /open in a running terminal/],
    ];
    for (const [throwWith, re] of cases) {
      const r = rig({ agentOpts: { throwWith } });
      const rt = r.service.createRoutine(baseInput());
      due(r, rt); r.scheduler.tick(); await flush();
      const [run] = r.runs.list(rt.id);
      assert.equal(run.status, "skipped"); assert.match(run.reason, re);
      assert.equal(run.startedAt, null, "a skipped run is never counted as started");
      const cur = r.routines.get(rt.id);
      assert.equal(cur.enabled, true); assert.ok(cur.nextRunAt > r.clock.t, "schedule kept");
      assert.equal(cur.lastRunAt, null, "a skipped run did not run");
    }
  });

  it("disabled routines never fire", async () => {
    const r = rig({ agentOpts: { auto: true } });
    const rt = r.service.createRoutine(baseInput({ enabled: false }));
    r.clock.t += 10 * DAY;
    r.scheduler.tick(); r.scheduler.startup(); await flush();
    assert.equal(r.runs.list().length, 0);
  });

  it("two routines due in one tick are both claimed and fired", async () => {
    const r = rig({ agentOpts: { auto: true } });
    const a = r.service.createRoutine(baseInput({ name: "A" }));
    const b = r.service.createRoutine(baseInput({ name: "B", target: { kind: "agent", agentId: "ag2" } }));
    due(r, a);
    r.scheduler.tick(); await flush();
    for (const x of [a, b]) {
      assert.equal(r.runs.list(x.id).length, 1);
      assert.ok(r.routines.get(x.id).nextRunAt > r.clock.t);
    }
  });

  it("a tick with zero due routines does no writes", async () => {
    const r = rig({ agentOpts: { auto: true } });
    r.service.createRoutine(baseInput());
    const before = r.saves.n;
    r.scheduler.tick(); r.scheduler.tick();
    assert.equal(r.saves.n, before);
  });

  it("run updates trigger onChange", async () => {
    const r = rig();
    const rt = r.service.createRoutine(baseInput());
    const afterCreate = r.changes.n;
    assert.ok(afterCreate > 0, "creating a routine notifies");
    due(r, rt); r.scheduler.tick(); await flush();
    const afterStart = r.changes.n;
    assert.ok(afterStart > afterCreate, "creating/starting a run notifies");
    r.agents.finish(0); await flush();
    assert.ok(r.changes.n > afterStart, "finishing a run notifies");
  });

  it("start() ticks on an interval and stop() ends it", async () => {
    const r = rig({ agentOpts: { auto: true } });
    const rt = r.service.createRoutine(baseInput());
    timers.push(() => r.scheduler.stop());
    due(r, rt);
    r.scheduler.start(15);
    r.scheduler.start(15);                        // idempotent
    await until(() => r.runs.list(rt.id).length === 1);
    r.scheduler.stop();
    due(r, r.routines.get(rt.id));
    await new Promise((res) => setTimeout(res, 120));
    assert.equal(r.runs.list(rt.id).length, 1, "no tick after stop()");
  });

  it("a daily 02:30 America/New_York routine across 2026-03-08 fires once that day", async () => {
    const r = rig({ agentOpts: { auto: true }, grace: HOUR });
    r.clock.t = Date.UTC(2026, 2, 7, 12, 0, 0);
    const rt = r.service.createRoutine(baseInput({ cron: "30 2 * * *", timezone: "America/New_York" }));
    const fired = [];
    const create = r.runs.create.bind(r.runs);
    r.runs.create = (...a) => { fired.push(r.clock.t); return create(...a); };
    const end = Date.UTC(2026, 2, 9, 12, 0, 0);
    while (r.clock.t < end) {
      r.clock.t += 10 * 60 * 1000;
      const n = fired.length;
      r.scheduler.tick();
      if (fired.length !== n) await flush();
    }
    assert.equal(fired.length, 2, `fired at ${fired.map((t) => new Date(t).toISOString())}`);
    // 03-08 02:30 does not exist: the single run happens at 03:00 EDT = 07:00Z; 03-09 02:30 EDT = 06:30Z
    assert.ok(fired[0] >= Date.UTC(2026, 2, 8, 7, 0) && fired[0] < Date.UTC(2026, 2, 8, 7, 10), new Date(fired[0]).toISOString());
    assert.ok(fired[1] >= Date.UTC(2026, 2, 9, 6, 30) && fired[1] < Date.UTC(2026, 2, 9, 6, 40), new Date(fired[1]).toISOString());
    assert.equal(r.routines.get(rt.id).nextRunAt, Date.UTC(2026, 2, 10, 6, 30));
  });
});

describe("startup and catch-up", () => {
  it("startup marks running runs failed \"interrupted by restart\"", () => {
    const r = rig();
    const rt = r.service.createRoutine(baseInput());
    const queued = r.runs.create(rt.id, "schedule");
    const running = r.runs.update(r.runs.create(rt.id, "manual").id, { status: "running", startedAt: 1 });
    r.scheduler.startup();
    for (const id of [queued.id, running.id]) {
      const x = r.runs.get(id);
      assert.equal(x.status, "failed"); assert.equal(x.reason, "interrupted by restart");
    }
  });

  it("skip_missed after 3 days down fires nothing and jumps to the next future slot", async () => {
    const r = rig({ agentOpts: { auto: true } });
    const rt = r.service.createRoutine(baseInput({ cron: "0 9 * * *" }));
    r.clock.t = rt.nextRunAt + 3 * DAY + 2 * HOUR;
    r.scheduler.startup(); await flush();
    assert.equal(r.runs.list(rt.id).length, 0);
    const next = r.routines.get(rt.id).nextRunAt;
    assert.equal(next, nextCronTime("0 9 * * *", "UTC", r.clock.t));
    assert.ok(next > r.clock.t);
    r.scheduler.tick(); await flush();
    assert.equal(r.runs.list(rt.id).length, 0, "and nothing fires afterwards for the missed slots");
  });

  it("enqueue_missed_with_cap replays at most 25", async () => {
    const r = rig({ agentOpts: { auto: true } });
    const rt = r.service.createRoutine(baseInput({ catchUp: "enqueue_missed_with_cap" }));
    r.clock.t = rt.nextRunAt + 100 * HOUR + 5 * 60000;
    r.scheduler.startup();
    await flush(200);
    const runs = r.runs.list(rt.id, 500);
    assert.equal(runs.length, 25);
    assert.ok(runs.every((x) => x.trigger === "catch_up"));
    assert.equal(r.agents.calls.length, 25);
    assert.equal(r.routines.get(rt.id).nextRunAt, nextCronTime("0 * * * *", "UTC", r.clock.t));
  });

  it("enqueue_missed_with_cap replays only the slots that were missed", async () => {
    const r = rig({ agentOpts: { auto: true } });
    const rt = r.service.createRoutine(baseInput({ catchUp: "enqueue_missed_with_cap" }));
    r.clock.t = rt.nextRunAt + 2 * HOUR + 5 * 60000;     // 09:00, 10:00, 11:00 missed
    r.scheduler.startup(); await flush(60);
    assert.equal(r.runs.list(rt.id).length, 3);
  });

  it("catch-up bursts still obey maxRunsPerDay (guards apply per run)", async () => {
    const r = rig({ agentOpts: { auto: true } });
    const rt = r.service.createRoutine(baseInput({ catchUp: "enqueue_missed_with_cap", maxRunsPerDay: 3 }));
    r.clock.t = rt.nextRunAt + 10 * HOUR + 5 * 60000;
    r.scheduler.startup(); await flush(200);
    assert.equal(r.agents.calls.length, 3, "only three processes spawn");
    const runs = r.runs.list(rt.id, 500);
    assert.equal(runs.filter((x) => x.status === "succeeded").length, 3);
    assert.ok(runs.filter((x) => x.status === "skipped").every((x) => /daily run limit reached \(3\)/.test(x.reason)));
  });

  it("an 8-hour clock jump produces one catch-up decision, not a storm (skip_missed)", async () => {
    const r = rig({ agentOpts: { auto: true } });
    const rt = r.service.createRoutine(baseInput());
    due(r, rt, 10000); r.scheduler.tick(); await flush();
    assert.equal(r.runs.list(rt.id).length, 1);
    r.clock.t += 8 * HOUR;                                 // the laptop slept
    r.scheduler.tick(); await flush();
    assert.equal(r.runs.list(rt.id).length, 1, "missed slots fire nothing");
    const next = r.routines.get(rt.id).nextRunAt;
    assert.equal(next, nextCronTime("0 * * * *", "UTC", r.clock.t));
    r.scheduler.tick(); r.scheduler.tick(); await flush();
    assert.equal(r.runs.list(rt.id).length, 1);
  });

  it("an 8-hour clock jump with enqueue_missed_with_cap replays the missed slots once", async () => {
    const r = rig({ agentOpts: { auto: true } });
    const rt = r.service.createRoutine(baseInput({ catchUp: "enqueue_missed_with_cap" }));
    due(r, rt, 10000); r.scheduler.tick(); await flush();
    r.clock.t += 8 * HOUR;
    r.scheduler.tick(); await flush(60);
    const catchUps = r.runs.list(rt.id, 100).filter((x) => x.trigger === "catch_up");
    assert.equal(catchUps.length, 8);
    r.scheduler.tick(); r.scheduler.tick(); await flush(60);
    assert.equal(r.runs.list(rt.id, 100).length, 9, "no further runs");
  });
});

describe("runNow and guards", () => {
  it("manual runNow works while the schedule is untouched", async () => {
    const r = rig({ agentOpts: { auto: true } });
    const rt = r.service.createRoutine(baseInput());
    const run = r.service.runNow(rt.id);
    assert.equal(run.trigger, "manual");
    await flush();
    assert.equal(r.runs.get(run.id).status, "succeeded");
    const cur = r.routines.get(rt.id);
    assert.equal(cur.nextRunAt, rt.nextRunAt, "nextRunAt untouched");
    assert.equal(r.agents.calls.length, 1);
  });

  it("manual runNow obeys the global pause (409) and the daily limit", async () => {
    const r = rig({ agentOpts: { auto: true } });
    const rt = r.service.createRoutine(baseInput({ maxRunsPerDay: 1 }));
    r.service.setSettings({ paused: true });
    assert.throws(() => r.service.runNow(rt.id), (e) => e instanceof HttpError && e.status === 409 && /automation paused/.test(e.message));
    assert.equal(r.runs.list(rt.id).length, 0);
    r.service.setSettings({ paused: false });
    r.service.runNow(rt.id); await flush();
    assert.throws(() => r.service.runNow(rt.id), (e) => e instanceof HttpError && e.status === 409 && /daily run limit reached \(1\)/.test(e.message));
    assert.throws(() => r.service.runNow("nope"), (e) => e.status === 404);
  });

  it("the guards claim atomically at dequeue: queue limit 2, maxRunsPerDay 1, 3 manual runs spawn exactly once", async () => {
    const r = rig({ limit: 2 });
    const b1 = r.service.createRoutine(baseInput({ name: "B1", target: { kind: "agent", agentId: "b1" } }));
    const b2 = r.service.createRoutine(baseInput({ name: "B2", target: { kind: "agent", agentId: "b2" } }));
    const x = r.service.createRoutine(baseInput({ name: "X", maxRunsPerDay: 1, concurrency: "always_enqueue" }));
    r.service.runNow(b1.id); r.service.runNow(b2.id);        // both slots taken
    for (let i = 0; i < 3; i++) r.service.runNow(x.id);       // none has started yet, so the early check passes for all
    assert.equal(r.queue.size(), 3);
    assert.equal(r.agents.calls.length, 2);
    r.agents.finish(0); r.agents.finish(1); await flush();
    const xr = r.runs.list(x.id);
    assert.equal(xr.filter((y) => y.status === "running").length, 1, "exactly one X run started");
    assert.equal(xr.filter((y) => y.status === "skipped").length, 2);
    assert.ok(xr.filter((y) => y.status === "skipped").every((y) => /daily run limit reached \(1\)/.test(y.reason)));
    assert.equal(r.agents.calls.filter((c) => c.target === "ag1").length, 1, "exactly one spawn for X");
  });

  it("running runs reserve their budget against the daily cost cap (checked at dequeue)", async () => {
    const r = rig({ limit: 2 });
    const mk = (name, agentId) => r.service.createRoutine(baseInput({ name, target: { kind: "agent", agentId } }));
    const [p, q, x, y] = [mk("P", "p"), mk("Q", "q"), mk("X", "x"), mk("Y", "y")];
    for (const rt of [p, q, x, y]) r.service.runNow(rt.id);      // P and Q run; X and Y wait (no cap yet, so the early check passes)
    assert.equal(r.queue.size(), 2);
    r.service.setSettings({ maxDailyCostUsd: 2.15 });
    r.agents.finish(0); r.agents.finish(1); await flush();       // P and Q cost $0.10 each
    const xs = r.runs.list(x.id)[0], ys = r.runs.list(y.id)[0];
    assert.equal(xs.status, "running", "X claims first: 0.20 spent < 2.15");
    assert.equal(ys.status, "skipped", "Y: 0.20 spent + X's reserved 2 >= 2.15");
    assert.match(ys.reason, /daily cost cap reached/);
    assert.equal(r.agents.calls.length, 3);
  });
});

describe("AutomationService routines", () => {
  it("createRoutine computes nextRunAt from now and fills defaults", () => {
    const r = rig();
    const rt = r.service.createRoutine(baseInput({ cron: "preset:weekdays" }));
    assert.equal(rt.cron, "0 9 * * 1-5");
    assert.equal(rt.nextRunAt, nextCronTime("0 9 * * 1-5", "UTC", r.clock.t));
    assert.equal(rt.permission.mode, "acceptEdits", "no permission inheritance from the agent");
    assert.equal(r.service.listRoutines().length, 1);
    assert.throws(() => r.service.createRoutine(baseInput({ cron: "nope" })), (e) => e.status === 400);
  });

  it("an enabled flip false→true recomputes nextRunAt", () => {
    const r = rig();
    const rt = r.service.createRoutine(baseInput({ enabled: false }));
    r.clock.t += 5 * DAY + 20 * 60000;
    const up = r.service.updateRoutine(rt.id, { enabled: true });
    assert.equal(up.nextRunAt, nextCronTime("0 * * * *", "UTC", r.clock.t));
    assert.ok(up.nextRunAt > r.clock.t);
    const off = r.service.updateRoutine(rt.id, { enabled: false });
    assert.equal(off.nextRunAt, up.nextRunAt, "disabling clears nothing");
  });

  it("a cron edit recomputes nextRunAt (and a preset works)", () => {
    const r = rig();
    const rt = r.service.createRoutine(baseInput());
    const up = r.service.updateRoutine(rt.id, { cron: "30 * * * *" });
    assert.equal(up.cron, "30 * * * *");
    assert.equal(up.nextRunAt, nextCronTime("30 * * * *", "UTC", r.clock.t));
    const up2 = r.service.updateRoutine(rt.id, { cron: "preset:daily" });
    assert.equal(up2.cron, "0 9 * * *");
    assert.equal(up2.nextRunAt, nextCronTime("0 9 * * *", "UTC", r.clock.t));
  });

  it("a timezone change recomputes nextRunAt", () => {
    const r = rig();
    const rt = r.service.createRoutine(baseInput({ cron: "0 9 * * *" }));
    const up = r.service.updateRoutine(rt.id, { timezone: "Asia/Jerusalem" });
    assert.equal(up.nextRunAt, nextCronTime("0 9 * * *", "Asia/Jerusalem", r.clock.t));
    assert.notEqual(up.nextRunAt, rt.nextRunAt);
  });

  it("a non-schedule edit keeps nextRunAt, and clients cannot set bookkeeping fields", () => {
    const r = rig();
    const rt = r.service.createRoutine(baseInput());
    const up = r.service.updateRoutine(rt.id, { name: "Renamed", nextRunAt: 5, lastRunAt: 7, id: "zzzz", created: 1 });
    assert.equal(up.name, "Renamed");
    assert.equal(up.nextRunAt, rt.nextRunAt); assert.equal(up.lastRunAt, null);
    assert.equal(up.id, rt.id); assert.equal(up.created, rt.created);
    assert.throws(() => r.service.updateRoutine(rt.id, { cron: "bad cron" }), (e) => e.status === 400);
    assert.equal(r.routines.get(rt.id).cron, "0 * * * *");
    assert.throws(() => r.service.updateRoutine("nope", { name: "x" }), (e) => e.status === 404);
  });

  it("deleting a routine cancels its queued and running runs and removes its history", async () => {
    const r = rig({ limit: 1 });
    const rt = r.service.createRoutine(baseInput({ concurrency: "always_enqueue" }));
    r.service.runNow(rt.id); r.service.runNow(rt.id);
    await flush();
    assert.equal(r.runs.list(rt.id).length, 2);
    await r.service.deleteRoutine(rt.id);
    assert.equal(r.agents.calls[0].cancelled, true, "the running process was cancelled");
    assert.equal(r.agents.calls.length, 1, "the queued run never started");
    assert.equal(r.routines.get(rt.id), undefined);
    assert.equal(r.runs.list(rt.id).length, 0);
    assert.equal(r.queue.size(), 0); assert.equal(r.queue.running(), 0);
    await assert.rejects(() => r.service.deleteRoutine(rt.id), (e) => e.status === 404);
  });

  it("settings round trip notifies and rejects bad input", () => {
    const r = rig();
    assert.deepEqual(r.service.getSettings(), { paused: false, maxDailyCostUsd: null });
    const n = r.changes.n;
    assert.deepEqual(r.service.setSettings({ paused: true, maxDailyCostUsd: 5 }), { paused: true, maxDailyCostUsd: 5 });
    assert.ok(r.changes.n > n);
    assert.throws(() => r.service.setSettings({ maxDailyCostUsd: -1 }), (e) => e.status === 400);
  });
});

describe("AutomationService runs", () => {
  it("listRuns / getRun / readLog validate ids and 404 unknown ones", async () => {
    const r = rig({ agentOpts: { auto: true } });
    const rt = r.service.createRoutine(baseInput());
    const run = r.service.runNow(rt.id); await flush();
    assert.equal(r.service.listRuns(rt.id).length, 1);
    assert.equal(r.service.listRuns().length, 1);
    assert.throws(() => r.service.listRuns("nope"), (e) => e.status === 404);
    assert.equal(r.service.getRun(run.id).id, run.id);
    assert.throws(() => r.service.getRun("aaaaaaaaaaaa"), (e) => e.status === 404);
    assert.throws(() => r.service.getRun("../../x"), (e) => e.status === 400);
    fs.mkdirSync(path.join(r.dir, "logs"), { recursive: true });
    fs.writeFileSync(r.runs.logPath(run.id), "line1\nline2\nline3\n");
    assert.equal(r.service.readLog(run.id, 6), "line3\n");
    assert.throws(() => r.service.readLog("../../x", 10), (e) => e.status === 400);
    assert.throws(() => r.service.readLog("aaaaaaaaaaaa", 10), (e) => e.status === 404);
  });

  it("cancelRun removes a queued run and cancels a running one; a finished run is a 409", async () => {
    const r = rig({ limit: 1 });
    const rt = r.service.createRoutine(baseInput({ concurrency: "always_enqueue" }));
    const a = r.service.runNow(rt.id), b = r.service.runNow(rt.id);
    await flush();
    const cb = await r.service.cancelRun(b.id);
    assert.equal(cb.status, "cancelled");
    assert.equal(r.queue.size(), 0);
    const ca = await r.service.cancelRun(a.id);
    assert.equal(ca.status, "cancelled");
    assert.equal(r.agents.calls.length, 1);
    assert.equal(r.queue.running(), 0);
    await assert.rejects(() => r.service.cancelRun(a.id), (e) => e.status === 409);
    await assert.rejects(() => r.service.cancelRun("aaaaaaaaaaaa"), (e) => e.status === 404);
  });

  it("openRun opens the agent terminal for agent mode and the run's conversation for fork/fresh/folder", async () => {
    const r = rig();
    const agentRt = r.service.createRoutine(baseInput({ name: "a" }));
    const forkRt = r.service.createRoutine(baseInput({ name: "f", conversation: "fork" }));
    const folderRt = r.service.createRoutine(baseInput({ name: "d", target: { kind: "folder", cwd: "C:\\work" }, conversation: "fresh" }));
    const mk = (rt, patch) => r.runs.update(r.runs.create(rt.id, "manual").id, patch);
    const fin = { status: "succeeded", finishedAt: 5 };
    r.service.openRun(mk(agentRt, fin).id);
    r.service.openRun(mk(forkRt, { ...fin, conversationId: "conv-fork" }).id);
    r.service.openRun(mk(folderRt, { ...fin, conversationId: "conv-fold" }).id);
    assert.deepEqual(r.agents.opened, [["terminal", "ag1"], ["conversation", "conv-fork", "C:\\agent-home"], ["conversation", "conv-fold", "C:\\work"]]);
    assert.throws(() => r.service.openRun(mk(forkRt, fin).id), (e) => e.status === 404, "finished without a conversation");
    assert.throws(() => r.service.openRun(mk(forkRt, { status: "running", startedAt: 1 }).id), (e) => e.status === 409, "not finished, no conversation yet");
    assert.throws(() => r.service.openRun("aaaaaaaaaaaa"), (e) => e.status === 404);
  });
});

describe("dispose", () => {
  it("dispose stops the tick, drops queued runs and cancels running ones", async () => {
    const r = rig({ limit: 1 });
    const rt = r.service.createRoutine(baseInput({ concurrency: "always_enqueue" }));
    r.scheduler.start(15);
    timers.push(() => r.scheduler.stop());
    r.service.runNow(rt.id); r.service.runNow(rt.id);
    await flush();
    await r.service.dispose();
    assert.equal(r.agents.calls[0].cancelled, true);
    const runs = r.runs.list(rt.id);
    assert.deepEqual(runs.map((x) => x.status).sort(), ["cancelled", "cancelled"]);
    assert.equal(r.agents.calls.length, 1);
    due(r, r.routines.get(rt.id));
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(r.runs.list(rt.id).length, 2, "the tick is stopped");
  });
});
