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
const { AutomationOwnership } = require("../../dist/automation/AutomationOwnership");
const { ChangeBatcher } = require("../../dist/automation/ChangeBatcher");

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
    return new Promise((res) => { call.resolve = (v) => { call.done = true; res(v); }; });
  };
  return {
    calls,
    run: (id, prompt, opts) => start("agent", id, prompt, opts),
    runInFolder: (cwd, prompt, opts) => start("folder", cwd, prompt, opts),
    finish: (i, result = okResult()) => calls[i].resolve(result),
    opened: [],
    isAgentBusy: (id) => calls.some((c) => c.kind === "agent" && c.target === id && !c.done && c.resolve !== null),
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
  const onChange = o.onChange ?? (() => { changes.n++; });
  const isDir = o.isDir ?? (() => true), agentExists = o.agentExists ?? (() => true);
  const routines = new RoutineStore(counted("routines.enc", () => []), isDir, agentExists);
  const runs = new RunStore({ store: counted("runs.enc", () => []), logDir: path.join(dir, "logs") });
  const settings = new AutomationSettings(counted("auto.enc", () => ({})));
  const guards = o.guards ?? new AutomationGuards({ settings, runs, now, dayStart: (ms) => Math.floor(ms / DAY) * DAY });
  const agents = o.agents ?? fakeAgents(o.agentOpts);
  const executor = o.executor ?? new AgentRunExecutor({ agents, runs, now, preflight: makePreflight({ runs, routines, guards, now }) });
  const queue = createRunQueue({ limit: o.limit ?? 2, routines, runs, executor, now, onChange });
  const scheduler = new RoutineScheduler({ routines, runs, guards, queue, now, onChange, missedGraceMs: o.grace, tickMs: o.tickMs, log: () => {} });
  const service = new AutomationService({ routines, runs, settings, scheduler, queue, agents, isDir, agentExists, now, onChange, timers: o.timers, ownership: o.ownership });
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
    const rows = r.runs.list(rt.id);
    assert.equal(rows.length, 1, "one visible row, no process");
    assert.equal(rows[0].status, "skipped"); assert.match(rows[0].reason, /missed 4 slots while agenv was not running \(skip_missed\)/);
    assert.equal(r.agents.calls.length, 0);
    const next = r.routines.get(rt.id).nextRunAt;
    assert.equal(next, nextCronTime("0 9 * * *", "UTC", r.clock.t));
    assert.ok(next > r.clock.t);
    r.scheduler.tick(); await flush();
    assert.equal(r.runs.list(rt.id).length, 1, "and nothing fires afterwards for the missed slots");
  });

  it("enqueue_missed_with_cap replays at most 25", async () => {
    const r = rig({ agentOpts: { auto: true } });
    const rt = r.service.createRoutine(baseInput({ catchUp: "enqueue_missed_with_cap" }));
    r.clock.t = rt.nextRunAt + 100 * HOUR + 5 * 60000;
    r.scheduler.startup();
    await flush(200);
    const all = r.runs.list(rt.id, 500);
    const runs = all.filter((x) => x.status !== "skipped");
    assert.equal(runs.length, 25);
    assert.ok(runs.every((x) => x.trigger === "catch_up"));
    assert.equal(r.agents.calls.length, 25);
    const note = all.filter((x) => x.status === "skipped");
    assert.equal(note.length, 1, "one row records the dropped slots");
    assert.match(note[0].reason, /catch-up: ran 25 of 101 missed slots/); assert.equal(note[0].startedAt, null);
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
    r.clock.t += 8 * HOUR + 30 * 60000;                    // the laptop slept
    r.scheduler.tick(); await flush();
    assert.equal(r.runs.list(rt.id).length, 2, "missed slots fire nothing; one row says so");
    assert.equal(r.agents.calls.length, 1);
    assert.match(r.runs.list(rt.id)[0].reason, /missed 8 slots/);
    const next = r.routines.get(rt.id).nextRunAt;
    assert.equal(next, nextCronTime("0 * * * *", "UTC", r.clock.t));
    r.scheduler.tick(); r.scheduler.tick(); await flush();
    assert.equal(r.runs.list(rt.id).length, 2);
  });

  it("an 8-hour clock jump with enqueue_missed_with_cap replays the missed slots once", async () => {
    const r = rig({ agentOpts: { auto: true } });
    const rt = r.service.createRoutine(baseInput({ catchUp: "enqueue_missed_with_cap" }));
    due(r, rt, 10000); r.scheduler.tick(); await flush();
    r.clock.t += 8 * HOUR + 30 * 60000;
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
    // X1 starts; X2 and X3 need the same agent, so they stay queued behind it (they no longer hold a slot) and are guarded when they dequeue
    assert.equal(r.runs.list(x.id).filter((y) => y.status === "queued").length, 2);
    r.agents.finish(2); await flush();
    const xr = r.runs.list(x.id);
    assert.equal(xr.filter((y) => y.status === "succeeded").length, 1, "exactly one X run started");
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

describe("head-of-line blocking: a busy agent must not hold a queue slot", () => {
  const mk = (r, name, agentId, extra = {}) => r.service.createRoutine(baseInput({ name, target: { kind: "agent", agentId }, concurrency: "always_enqueue", ...extra }));

  it("limit 2: two runs on agent A and one on agent B => B starts at once and A2 stays queued (not running) until A1 ends", async () => {
    const r = rig({ limit: 2 });
    const a1 = mk(r, "A1", "A"), a2 = mk(r, "A2", "A"), b = mk(r, "B", "B");
    r.service.runNow(a1.id); r.service.runNow(a2.id); r.service.runNow(b.id);
    await flush();
    assert.deepEqual(r.agents.calls.map((c) => c.target), ["A", "B"], "B started although A2 is ahead of it");
    assert.equal(r.runs.list(a2.id)[0].status, "queued");
    assert.equal(r.runs.list(a2.id)[0].startedAt, null, "no claim before it can spawn");
    assert.equal(r.runs.list(b.id)[0].status, "running");
    assert.equal(r.queue.size(), 1);
    r.agents.finish(0); await flush();
    assert.deepEqual(r.agents.calls.map((c) => c.target), ["A", "B", "A"]);
    assert.equal(r.runs.list(a2.id)[0].status, "running");
    r.agents.finish(1); r.agents.finish(2); await flush();
  });

  it("pausing while A2 waits behind A1 => A2 is skipped 'automation paused' when it finally dequeues", async () => {
    const r = rig({ limit: 2 });
    const a1 = mk(r, "A1", "A"), a2 = mk(r, "A2", "A");
    r.service.runNow(a1.id); r.service.runNow(a2.id);
    await flush();
    assert.equal(r.runs.list(a2.id)[0].status, "queued");
    r.service.setSettings({ paused: true });
    r.agents.finish(0); await flush();
    const run = r.runs.list(a2.id)[0];
    assert.equal(run.status, "skipped");
    assert.equal(run.reason, "automation paused");
    assert.equal(r.agents.calls.length, 1, "A2 never spawned");
  });

  it("a catch-up burst of 25 on one agent never blocks another agent's run", async () => {
    const r = rig({ limit: 2 });
    const hourly = mk(r, "Burst", "A", { catchUp: "enqueue_missed_with_cap", concurrency: "coalesce_if_active" });
    const other = mk(r, "Other", "B");
    r.clock.t = hourly.nextRunAt + 30 * HOUR + 5 * 60000;
    r.scheduler.tick();
    await flush();
    assert.equal(r.agents.calls.length, 1, "only one of the burst runs at a time");
    assert.ok(r.queue.size() >= 20);
    r.service.runNow(other.id);
    await flush();
    assert.deepEqual(r.agents.calls.map((c) => c.target), ["A", "B"]);
    assert.equal(r.runs.list(other.id)[0].status, "running");
  });

  it("folder targets are keyed by their resolved folder", async () => {
    const r = rig({ limit: 2 });
    const dir = path.resolve(r.dir);
    const f = (name) => r.service.createRoutine(baseInput({ name, target: { kind: "folder", cwd: dir }, conversation: "fresh", concurrency: "always_enqueue" }));
    const f1 = f("F1"), f2 = f("F2"), other = mk(r, "O", "B");
    r.service.runNow(f1.id); r.service.runNow(f2.id); r.service.runNow(other.id);
    await flush();
    assert.deepEqual(r.agents.calls.map((c) => c.kind), ["folder", "agent"]);
    assert.equal(r.runs.list(f2.id)[0].status, "queued");
  });
});

describe("routine list with lastRun, and the per-routine queue cap", () => {
  it("listRoutinesWithLastRun gives each routine its newest run from one pass over the history", async () => {
    const r = rig({ agentOpts: { auto: true } });
    const a = r.service.createRoutine(baseInput({ name: "A" })), b = r.service.createRoutine(baseInput({ name: "B" })), c = r.service.createRoutine(baseInput({ name: "C" }));
    r.service.runNow(a.id); await flush();
    r.runs.create(a.id, "schedule", "skipped", "automation paused");
    r.service.runNow(b.id); await flush();
    let latest = 0, listed = 0;
    const lb = r.runs.latestByRoutine.bind(r.runs), ll = r.runs.list.bind(r.runs);
    r.runs.latestByRoutine = () => { latest++; return lb(); };
    r.runs.list = (...x) => { listed++; return ll(...x); };
    const out = r.service.listRoutinesWithLastRun();
    assert.equal(latest, 1);
    assert.equal(listed, 0, "no per-routine run listing");
    const by = Object.fromEntries(out.map((x) => [x.name, x]));
    assert.deepEqual(Object.keys(by.A.lastRun).sort(), ["costUsd", "finishedAt", "id", "reason", "startedAt", "status"]);
    assert.equal(by.A.lastRun.status, "skipped");
    assert.equal(by.A.lastRun.reason, "automation paused");
    assert.equal(by.B.lastRun.status, "succeeded");
    assert.equal(by.B.lastRun.costUsd, 0.1);
    assert.equal(typeof by.B.lastRun.startedAt, "number");
    assert.equal(by.C.lastRun, null);
    assert.deepEqual([by.A.activeRuns, by.B.activeRuns, by.C.activeRuns], [0, 0, 0]);
    assert.equal(by.A.id, a.id, "the routine itself is unchanged");
    assert.equal(c.id, by.C.id);
  });

  it("activeRuns counts queued+running even when the newest run is a finished 'coalesced' row", async () => {
    const r = rig();
    const rt = r.service.createRoutine(baseInput());
    r.service.runNow(rt.id); await flush();
    const co = r.service.runNow(rt.id);                          // coalesced into the running one
    assert.equal(co.status, "coalesced");
    const item = r.service.listRoutinesWithLastRun()[0];
    assert.equal(item.lastRun.status, "coalesced");
    assert.equal(item.activeRuns, 1);
    r.agents.finish(0); await flush();
  });

  it("always_enqueue caps queued+running runs per routine at 25; extra firings are recorded skipped 'queue full (25)'", async () => {
    const r = rig({ limit: 1 });
    const rt = r.service.createRoutine(baseInput({ concurrency: "always_enqueue" }));
    const runs = [];
    for (let i = 0; i < 30; i++) runs.push(r.service.runNow(rt.id));
    await flush();
    const all = r.runs.list(rt.id, 100);
    assert.equal(all.filter((x) => x.status === "running" || x.status === "queued").length, 25);
    const skipped = all.filter((x) => x.status === "skipped");
    assert.equal(skipped.length, 5);
    assert.ok(skipped.every((x) => x.reason === "queue full (25)"), skipped.map((x) => x.reason).join("|"));
    r.agents.finish(0); await flush();                           // a slot frees: the next firing is accepted again
    assert.equal(r.service.runNow(rt.id).status, "queued");
  });

  it("the cap also bounds a catch-up burst", async () => {
    const r = rig({ limit: 1 });
    const rt = r.service.createRoutine(baseInput({ concurrency: "always_enqueue", catchUp: "enqueue_missed_with_cap" }));
    for (let i = 0; i < 10; i++) r.service.runNow(rt.id);
    r.clock.t = rt.nextRunAt + 40 * HOUR + 5 * 60000;
    r.scheduler.tick();
    await flush();
    const all = r.runs.list(rt.id, 200);
    assert.equal(all.filter((x) => x.status === "running" || x.status === "queued").length, 25);
    assert.ok(all.some((x) => x.status === "skipped" && x.reason === "queue full (25)"));
  });
});

describe("instance ownership of the schedules", () => {
  const fakeOwnership = (owner, port = 4321) => {
    const o = { acquires: 0, releases: 0, acquire() { o.acquires++; return owner; }, tryAcquire() { return owner; }, heartbeat() { return owner; }, release() { o.releases++; }, isOwner: () => owner, ownerPort: () => port };
    return o;
  };
  const owned = /automation is owned by another agenv instance \(port 4321\)/;

  it("the owner starts catch-up and the tick; dispose releases the lock", async () => {
    const own = fakeOwnership(true, 3000);
    const r = rig({ ownership: own });
    const calls = [];
    r.scheduler.startup = () => calls.push("startup"); r.scheduler.start = () => calls.push("start");
    assert.equal(r.service.startScheduling(), true);
    assert.deepEqual(calls, ["startup", "start"]);
    assert.equal(own.acquires, 1);
    assert.deepEqual(r.service.ownerInfo(), { owner: true, ownerPort: 3000 });
    await r.service.dispose();
    assert.equal(own.releases, 1);
  });

  it("a non-owner never runs catch-up or the tick", () => {
    const own = fakeOwnership(false);
    const r = rig({ ownership: own });
    const calls = [];
    r.scheduler.startup = () => calls.push("startup"); r.scheduler.start = () => calls.push("start"); r.scheduler.tick = () => calls.push("tick");
    assert.equal(r.service.startScheduling(), false);
    assert.deepEqual(calls, []);
    assert.deepEqual(r.service.ownerInfo(), { owner: false, ownerPort: 4321 });
  });

  it("a non-owner answers 409 to runNow, cancelRun and openRun, and the run operations change nothing", async () => {
    const own = fakeOwnership(false);
    const r = rig({ ownership: own });
    const rt = r.service.createRoutine(baseInput());           // routine CRUD stays allowed
    r.service.updateRoutine(rt.id, { name: "renamed" });
    const run = r.runs.create(rt.id, "manual", "running");
    assert.throws(() => r.service.runNow(rt.id), (e) => e instanceof HttpError && e.status === 409 && owned.test(e.message));
    await assert.rejects(() => r.service.cancelRun(run.id), (e) => e.status === 409 && owned.test(e.message));
    r.runs.update(run.id, { status: "succeeded", finishedAt: 1, conversationId: "c-1" });
    assert.throws(() => r.service.openRun(run.id), (e) => e.status === 409 && owned.test(e.message));
    assert.equal(r.runs.list(rt.id).length, 1, "no run was created");
    assert.equal(r.agents.calls.length, 0);
    assert.deepEqual(r.agents.opened, []);
    await r.service.deleteRoutine(rt.id);                      // nothing active: still fine
  });

  it("a non-owner refuses to delete a routine another instance is running", async () => {
    const r = rig({ ownership: fakeOwnership(false) });
    const rt = r.service.createRoutine(baseInput());
    r.runs.create(rt.id, "schedule", "running");
    await assert.rejects(() => r.service.deleteRoutine(rt.id), (e) => e.status === 409 && owned.test(e.message));
    assert.ok(r.routines.get(rt.id));
  });

  it("without an ownership object the service is the owner and starts scheduling", () => {
    const r = rig();
    const calls = [];
    r.scheduler.startup = () => calls.push("startup"); r.scheduler.start = () => calls.push("start");
    assert.equal(r.service.startScheduling(), true);
    assert.deepEqual(calls, ["startup", "start"]);
    assert.deepEqual(r.service.ownerInfo(), { owner: true, ownerPort: null });
  });
});

describe("makePreflight claims only queued rows", () => {
  it("refuses a run whose stored status is no longer queued and leaves the row alone", async () => {
    for (const status of ["failed", "cancelled", "running", "succeeded"]) {
      const r = rig({ agentOpts: { auto: true } });
      const rt = r.service.createRoutine(baseInput());
      const run = r.runs.create(rt.id, "manual", "queued");
      r.runs.update(run.id, { status, reason: "set elsewhere", finishedAt: status === "running" ? null : 5 });
      const before = r.runs.get(run.id);
      const pre = makePreflight({ runs: r.runs, routines: r.routines, guards: r.guards, now: r.clock.t ? () => r.clock.t : Date.now });
      assert.ok(pre(run, rt), `${status}: a reason is returned`);
      assert.deepEqual(r.runs.get(run.id), before, `${status}: untouched`);
    }
    const r = rig();
    const rt = r.service.createRoutine(baseInput());
    const run = r.runs.create(rt.id, "manual", "queued");
    assert.equal(makePreflight({ runs: r.runs, routines: r.routines, guards: r.guards, now: () => r.clock.t })(run, rt), null);
    assert.equal(r.runs.get(run.id).status, "running");
  });

  it("through the queue: a row another instance already failed stays failed and nothing spawns", async () => {
    const r = rig({ agentOpts: { auto: true } });
    const rt = r.service.createRoutine(baseInput());
    const run = r.runs.create(rt.id, "manual", "queued");
    r.runs.update(run.id, { status: "failed", reason: "interrupted by restart", error: "interrupted by restart", finishedAt: 5 });
    r.queue.enqueue(run);
    await flush();
    const cur = r.runs.get(run.id);
    assert.equal(cur.status, "failed");
    assert.equal(cur.reason, "interrupted by restart");
    assert.equal(r.agents.calls.length, 0);
  });
});

describe("ownership heartbeat, demotion and takeover", () => {
  /** Injected interval timers the test fires by hand. */
  function fakeTimers() {
    const t = { intervals: [], cleared: [], oneShots: [],
      every(fn, ms) { const h = { fn, ms, active: true }; t.intervals.push(h); return h; },
      set(fn, ms) { const h = { fn, ms, active: true }; t.oneShots.push(h); return h; },
      clear(h) { if (h) h.active = false; t.cleared.push(h); },
      fire() { for (const h of t.intervals.filter((x) => x.active)) h.fn(); },
      activeIntervals: () => t.intervals.filter((x) => x.active).length };
    return t;
  }
  /** Two instances (each with its own rig and stores) on one lock file and one fake ownership clock. */
  function twoInstances() {
    const lock = path.join(tmp(), ".agenv-automation.lock");
    const oc = { t: 5_000_000 };
    const alive = new Set([111, 222]);
    const mk = (pid, port) => {
      const timers = fakeTimers();
      const ownership = new AutomationOwnership({ path: lock, pid, port, now: () => oc.t, monotonicNow: () => oc.t, isAlive: (p) => alive.has(p) });
      const r = rig({ ownership, timers });
      const calls = [];
      const start = r.scheduler.start.bind(r.scheduler), stop = r.scheduler.stop.bind(r.scheduler), startup = r.scheduler.startup.bind(r.scheduler);
      r.scheduler.startup = () => { calls.push("startup"); startup(); };
      r.scheduler.start = () => { calls.push("start"); start(); };
      r.scheduler.stop = () => { calls.push("stop"); stop(); };
      return Object.assign(r, { ownership, fake: timers, calls });
    };
    return { lock, oc, alive, A: mk(111, 3000), B: mk(222, 3001) };
  }
  const owned = /automation is owned by another agenv instance/;

  it("the owner heartbeats on every timer tick", async () => {
    const { lock, oc, A } = twoInstances();
    assert.equal(A.service.startScheduling(), true);
    assert.equal(A.fake.activeIntervals(), 1);
    assert.equal(A.fake.intervals[0].ms, 30_000);
    const first = JSON.parse(fs.readFileSync(lock, "utf8"));
    oc.t += 30_000;
    A.fake.fire();
    assert.equal(JSON.parse(fs.readFileSync(lock, "utf8")).heartbeatAt, first.heartbeatAt + 30_000);
    await A.service.dispose();
  });

  it("an owner whose lock was taken over demotes itself: scheduler stopped, run operations answer 409, no routine fires", async () => {
    const { lock, A } = twoInstances();
    A.service.startScheduling();
    const rt = A.service.createRoutine(baseInput());
    const run = A.runs.create(rt.id, "manual", "running");
    assert.ok(A.scheduler.timer, "ticking while owner");
    fs.writeFileSync(lock, JSON.stringify({ pid: 222, port: 3001, startedAt: 1, heartbeatAt: 5_000_000 }));    // someone else took over
    const stops = A.calls.filter((c) => c === "stop").length;
    A.fake.fire();
    assert.equal(A.calls.filter((c) => c === "stop").length, stops + 1, "the scheduler was stopped");
    assert.equal(A.scheduler.timer, null, "the tick no longer runs");
    assert.deepEqual(A.service.ownerInfo(), { owner: false, ownerPort: 3001 });
    assert.throws(() => A.service.runNow(rt.id), (e) => e.status === 409 && owned.test(e.message));
    await assert.rejects(() => A.service.cancelRun(run.id), (e) => e.status === 409);
    assert.equal(A.runs.get(run.id).status, "running", "a run already in progress is not cancelled");
    assert.equal(A.fake.activeIntervals(), 1, "the demoted instance keeps polling for a takeover");
    assert.equal(JSON.parse(fs.readFileSync(lock, "utf8")).pid, 222, "the new owner's lock is untouched");
    A.runs.update(run.id, { status: "failed", finishedAt: 1 });
    await A.service.dispose();
    assert.equal(JSON.parse(fs.readFileSync(lock, "utf8")).pid, 222, "dispose of a non-owner leaves the lock");
  });

  it("a non-owner takes over after the owner stops heartbeating, then runs startup and start exactly once", async () => {
    const { lock, oc, A, B } = twoInstances();
    A.service.startScheduling();
    assert.equal(B.service.startScheduling(), false);
    assert.deepEqual(B.calls, []);
    assert.equal(B.fake.activeIntervals(), 1, "a non-owner polls too");
    oc.t += 30_000; A.fake.fire(); B.fake.fire();
    oc.t += 30_000; A.fake.fire(); B.fake.fire();
    assert.deepEqual(B.calls, [], "a live owner keeps the schedules");
    assert.equal(B.service.ownerInfo().owner, false);
    // A is killed (Electron serverProcess.kill()): no more heartbeats, the lock stays with a pid that is still "alive" (reused)
    for (let i = 0; i < 3; i++) { oc.t += 30_000; B.fake.fire(); }     // 90 s of an unchanging heartbeat observed
    assert.deepEqual(B.calls, ["startup", "start"]);
    assert.deepEqual(B.service.ownerInfo(), { owner: true, ownerPort: 3001 });
    assert.equal(JSON.parse(fs.readFileSync(lock, "utf8")).pid, 222);
    oc.t += 30_000; B.fake.fire();
    assert.deepEqual(B.calls, ["startup", "start"], "later ticks only heartbeat");
    assert.equal(JSON.parse(fs.readFileSync(lock, "utf8")).heartbeatAt, oc.t);
    await B.service.dispose();
    await A.service.dispose();
    assert.equal(fs.existsSync(lock), false, "the new owner released it");
  });

  it("demotion cancels queued runs ('ownership lost') and keeps running ones; their real result clears 'interrupted'", async () => {
    const { lock, A } = twoInstances();
    A.service.startScheduling();
    const rt = A.service.createRoutine(baseInput());
    const rt2 = A.service.createRoutine(baseInput({ name: "Other", target: { kind: "agent", agentId: "ag2" } }));
    const running = A.service.runNow(rt.id);
    await flush();
    assert.equal(A.runs.get(running.id).status, "running");
    // the same agent is busy, so this one stays queued
    const queued = A.runs.create(rt.id, "manual", "queued");
    A.queue.enqueue(A.runs.get(queued.id));
    await flush();
    assert.equal(A.queue.size(), 1);
    fs.writeFileSync(lock, JSON.stringify({ pid: 222, port: 3001, startedAt: 1, heartbeatAt: 5_000_000 }));
    A.fake.fire();
    assert.equal(A.queue.size(), 0, "the queue is emptied");
    const q = A.runs.get(queued.id);
    assert.equal(q.status, "cancelled");
    assert.equal(q.reason, "ownership lost");
    assert.equal(A.runs.get(running.id).status, "running", "running runs keep going");
    // the new owner's startup() marked the running row interrupted; the real result arrives afterwards
    A.runs.markInterrupted();
    assert.equal(A.runs.get(running.id).reason, "interrupted by restart");
    A.agents.finish(0);
    await flush();
    const done = A.runs.get(running.id);
    assert.equal(done.status, "succeeded");
    assert.equal(done.reason, "");
    assert.equal(done.error, "");
    void rt2;
    await A.service.dispose();
  });

  it("the queue still accepts runs after a demotion drain (the instance may become the owner again)", async () => {
    const { lock, A } = twoInstances();
    A.service.startScheduling();
    const rt = A.service.createRoutine(baseInput());
    fs.writeFileSync(lock, JSON.stringify({ pid: 222, port: 3001, startedAt: 1, heartbeatAt: 5_000_000 }));
    A.fake.fire();
    A.queue.enqueue(A.runs.get(A.runs.create(rt.id, "manual", "queued").id));
    await flush();
    assert.equal(A.agents.calls.length, 1);
    A.agents.finish(0);
    await A.service.dispose();
  });

  it("dispose clears the interval timer and a disposed service never polls again", async () => {
    const { A, B } = twoInstances();
    A.service.startScheduling(); B.service.startScheduling();
    await A.service.dispose(); await B.service.dispose();
    assert.equal(A.fake.activeIntervals(), 0);
    assert.equal(B.fake.activeIntervals(), 0);
    assert.ok(A.fake.cleared.includes(A.fake.intervals[0]));
  });

  it("starting twice does not stack timers", async () => {
    const { A } = twoInstances();
    A.service.startScheduling(); A.service.startScheduling();
    assert.equal(A.fake.intervals.length, 1);
    await A.service.dispose();
  });

  it("without an ownership object there is no timer at all", async () => {
    const timers = fakeTimers();
    const r = rig({ timers });
    r.scheduler.startup = () => {}; r.scheduler.start = () => {};
    r.service.startScheduling();
    assert.equal(timers.intervals.length, 0);
    await r.service.dispose();
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

  it("openRun is a 409 while the run is queued or running, and while any run of the same agent is active", async () => {
    const r = rig({ limit: 1 });
    const rt = r.service.createRoutine(baseInput({ name: "fork", conversation: "fork", concurrency: "always_enqueue" }));
    const other = r.service.createRoutine(baseInput({ name: "other", conversation: "fork", concurrency: "always_enqueue" }));
    const first = r.service.runNow(rt.id);
    const waiting = r.service.runNow(other.id);                 // queued behind the first (limit 1)
    await flush();
    assert.equal(r.runs.get(first.id).status, "running");
    assert.throws(() => r.service.openRun(first.id), (e) => e.status === 409 && /still active/.test(e.message));
    assert.throws(() => r.service.openRun(waiting.id), (e) => e.status === 409 && /still active/.test(e.message));
    assert.deepEqual(r.agents.opened, []);
    r.agents.finish(0, okResult({ conversationId: "conv-1" })); await flush();
    // the first run is finished but the same agent is busy with the second one
    assert.equal(r.runs.get(first.id).status, "succeeded");
    assert.equal(r.runs.get(waiting.id).status, "running");
    assert.throws(() => r.service.openRun(first.id), (e) => e.status === 409 && /agent is busy/.test(e.message));
    r.agents.finish(1, okResult({ conversationId: "conv-2" })); await flush();
    assert.equal(r.service.openRun(first.id).id, 8);
    assert.equal(r.service.openRun(waiting.id).id, 8);
    assert.deepEqual(r.agents.opened.map((o) => o[1]), ["conv-1", "conv-2"]);
  });

  it("a folder run needs no agent check: openRun works once the run itself finished", async () => {
    const r = rig();
    const rt = r.service.createRoutine(baseInput({ name: "d", target: { kind: "folder", cwd: path.resolve(r.dir) }, conversation: "fresh" }));
    const run = r.service.runNow(rt.id); await flush();
    assert.throws(() => r.service.openRun(run.id), (e) => e.status === 409);
    r.agents.finish(0, okResult({ conversationId: "conv-f" })); await flush();
    assert.equal(r.service.openRun(run.id).id, 8);
  });
});

describe("startup honours the grace window", () => {
  it("startup 10 s after a slot fires it exactly once (normal run, not a catch-up)", async () => {
    const r = rig({ agentOpts: { auto: true } });
    const rt = r.service.createRoutine(baseInput());
    due(r, rt, 10000);
    r.scheduler.startup(); await flush();
    const runs = r.runs.list(rt.id);
    assert.equal(runs.length, 1); assert.equal(runs[0].trigger, "schedule"); assert.equal(runs[0].status, "succeeded");
    assert.equal(r.agents.calls.length, 1);
    assert.equal(r.routines.get(rt.id).nextRunAt, nextCronTime("0 * * * *", "UTC", r.clock.t));
    r.scheduler.tick(); await flush();
    assert.equal(r.runs.list(rt.id).length, 1, "and the slot does not fire again");
  });

  it("startup 10 minutes after a slot under skip_missed fires nothing and jumps to the next future slot", async () => {
    const r = rig({ agentOpts: { auto: true } });
    const rt = r.service.createRoutine(baseInput());
    due(r, rt, 10 * 60000);
    r.scheduler.startup(); await flush();
    const runs = r.runs.list(rt.id);
    assert.equal(r.agents.calls.length, 0);
    assert.equal(runs.length, 1); assert.equal(runs[0].status, "skipped");
    assert.match(runs[0].reason, /missed 1 slot while agenv was not running \(skip_missed\)/);
    assert.equal(runs[0].startedAt, null, "not counted as started");
    assert.equal(r.routines.get(rt.id).nextRunAt, nextCronTime("0 * * * *", "UTC", r.clock.t));
  });

  it("with enqueue_missed_with_cap a slot within the grace is one normal firing and only older slots are replayed", async () => {
    const r = rig({ agentOpts: { auto: true } });
    const rt = r.service.createRoutine(baseInput({ catchUp: "enqueue_missed_with_cap" }));
    r.clock.t = rt.nextRunAt + 3 * HOUR + 10000;           // 09:00 10:00 11:00 missed, 12:00 is 10 s old
    r.scheduler.startup(); await flush(60);
    const runs = r.runs.list(rt.id, 50);
    assert.equal(runs.length, 4, "no double run for the 12:00 slot");
    assert.equal(runs.filter((x) => x.trigger === "schedule").length, 1);
    assert.equal(runs.filter((x) => x.trigger === "catch_up").length, 3);
    assert.equal(r.agents.calls.length, 4);
  });

  it("the grace scales with a custom tick interval (max(120 s, 4 x interval)) unless set explicitly", async () => {
    const late = 300000;
    const slow = rig({ agentOpts: { auto: true }, tickMs: 100000 });          // grace 400 s
    const a = slow.service.createRoutine(baseInput());
    due(slow, a, late); slow.scheduler.tick(); await flush();
    assert.equal(slow.runs.list(a.id)[0].trigger, "schedule", "300 s late is within a 400 s grace");
    const normal = rig({ agentOpts: { auto: true } });                         // grace 120 s
    const b = normal.service.createRoutine(baseInput());
    due(normal, b, late); normal.scheduler.tick(); await flush();
    assert.equal(normal.agents.calls.length, 0, "300 s late is missed at the default interval");
    const explicit = rig({ agentOpts: { auto: true }, tickMs: 100000, grace: 1000 });
    const c = explicit.service.createRoutine(baseInput());
    due(explicit, c, late); explicit.scheduler.tick(); await flush();
    assert.equal(explicit.agents.calls.length, 0, "an explicit missedGraceMs wins");
    const started = rig({ agentOpts: { auto: true } });                        // start(interval) scales it too
    const d = started.service.createRoutine(baseInput());
    timers.push(() => started.scheduler.stop());
    started.scheduler.start(100000); started.scheduler.stop();
    due(started, d, late); started.scheduler.tick(); await flush();
    assert.equal(started.agents.calls.length, 1);
  });
});

describe("clock jumps, invalid schedules and visibility", () => {
  it("a backward clock jump recomputes a nextRunAt that is later than the next real slot", async () => {
    const r = rig({ agentOpts: { auto: true } });
    const rt = r.service.createRoutine(baseInput({ cron: "0 9 * * *" }));
    r.routines.setSchedule(rt.id, { nextRunAt: r.clock.t + 3 * DAY });
    r.scheduler.tick(); await flush();
    assert.equal(r.routines.get(rt.id).nextRunAt, nextCronTime("0 9 * * *", "UTC", r.clock.t));
    assert.equal(r.runs.list(rt.id).length, 0);
    const before = r.saves.n;
    r.scheduler.tick();
    assert.equal(r.saves.n, before, "a correct nextRunAt is left alone");
  });

  it("an unparseable schedule records one skipped \"invalid schedule\" run and stops the routine", async () => {
    const r = rig({ agentOpts: { auto: true } });
    const rt = r.service.createRoutine(baseInput());
    r.reopen("routines.enc", () => []).save([{ ...rt, cron: "not a cron", nextRunAt: r.clock.t - 1000 }]);
    r.scheduler.tick(); r.scheduler.tick(); await flush();
    const runs = r.runs.list(rt.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, "skipped"); assert.match(runs[0].reason, /^invalid schedule: /);
    assert.equal(r.routines.get(rt.id).nextRunAt, null);
    assert.equal(r.agents.calls.length, 0);
  });

  it("catch-up writes at most one visible row per routine per event", async () => {
    const r = rig({ agentOpts: { auto: true } });
    const rt = r.service.createRoutine(baseInput({ cron: "*/5 * * * *" }));
    r.clock.t = rt.nextRunAt + 3 * DAY + 150000;
    r.scheduler.startup(); r.scheduler.tick(); r.scheduler.startup(); await flush();
    const rows = r.runs.list(rt.id, 50);
    assert.equal(rows.length, 1);
    assert.match(rows[0].reason, /missed 865 slots/);
  });
});

describe("change batching", () => {
  it("ChangeBatcher emits once for a burst and again for a later one", () => {
    let emitted = 0; const deferred = [];
    const b = new ChangeBatcher(() => { emitted++; }, (fn) => deferred.push(fn));
    for (let i = 0; i < 26; i++) b.notify();
    assert.equal(deferred.length, 1); assert.equal(emitted, 0);
    deferred.shift()();
    assert.equal(emitted, 1);
    b.notify(); assert.equal(deferred.length, 1);
    b.flush(); assert.equal(emitted, 2, "flush() emits at once");
    deferred.shift()(); assert.equal(emitted, 2, "the deferred call after a flush is a no-op");
  });

  it("26 changes in one tick produce one broadcast", async () => {
    let emitted = 0; const deferred = [];
    const batcher = new ChangeBatcher(() => { emitted++; }, (fn) => deferred.push(fn));
    const r = rig({ agentOpts: { auto: true }, onChange: () => batcher.notify() });
    const rt = r.service.createRoutine(baseInput({ catchUp: "enqueue_missed_with_cap" }));
    deferred.length = 0; emitted = 0; batcher.flush(); emitted = 0;
    r.clock.t = rt.nextRunAt + 40 * HOUR + 5 * 60000;     // 41 missed slots: 25 replayed + a note row
    r.scheduler.tick();
    assert.equal(r.runs.list(rt.id, 100).length, 26);
    deferred.splice(0).forEach((f) => f());
    assert.equal(emitted, 1);
  });
});

describe("dispose timers", () => {
  it("dispose leaves no pending timer", async () => {
    const live = new Set(), created = []; let id = 0;
    const fake = { set: (fn, ms) => { const h = { id: ++id, fn, ms }; live.add(h); created.push(ms); return h; }, clear: (h) => { live.delete(h); } };
    const r = rig({ limit: 1, timers: fake });
    const rt = r.service.createRoutine(baseInput());
    r.service.runNow(rt.id); await flush();
    await r.service.dispose();
    assert.ok(created.includes(3000), "dispose's bounded wait goes through the injected timers");
    assert.equal(live.size, 0, [...live].map((h) => h.ms).join(","));
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
