// test/routines-api.test.js — black-box API for routines, runs and the global automation switches
"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const { startServer, stopProcess, makeTempHome, get, post, put, del, waitFor, TOKEN } = require("./helpers");

const FAKE = path.join(__dirname, "fixtures", "fake-claude-cli.js");
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** A claude on PATH that does nothing, so opening a terminal can never start the real CLI. */
function stubClaudeDir() {
  const dir = tmp("agenv-stub-claude-");
  fs.writeFileSync(path.join(dir, "claude.cmd"), "@echo off\r\n");
  fs.writeFileSync(path.join(dir, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return dir;
}

async function boot(mode = "ok", beforeStart) {
  const home = makeTempHome(), state = tmp("agenv-fake-state-"), work = tmp("agenv-work-"), stub = stubClaudeDir();
  if (beforeStart) beforeStart(home);
  const server = await startServer({
    home,
    env: {
      AGENV_CLAUDE_BIN: FAKE, FAKE_CLAUDE_STATE: state, FAKE_CLAUDE_MODE: mode,
      PATH: stub + path.delimiter + process.env.PATH,
    },
  });
  return { server, home, state, work, stub, dirs: [home, state, work, stub] };
}
const rmAll = (dirs) => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } };

/** Plain-text GET (the log route is text/plain, which the JSON helpers would try to parse). */
function rawGet(ctx, p) {
  return new Promise((resolve, reject) => {
    const url = new URL(p, ctx.server.baseUrl);
    url.searchParams.set("token", TOKEN);
    http.get(url, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode, type: String(res.headers["content-type"] || ""), text: data }));
    }).on("error", reject);
  });
}

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const noStack = (r) => assert.ok(!JSON.stringify(r.body).includes("    at "), "no stack trace in " + JSON.stringify(r.body));

describe("routines API", () => {
  let ctx, agentA;
  before(async () => {
    ctx = await boot();
    agentA = (await post("/api/agents", { name: "worker", specialty: "tests", cwd: ctx.work })).body;
    assert.ok(agentA.id, JSON.stringify(agentA));
  }, { timeout: 30000 });
  after(async () => { await stopProcess(ctx.server.proc); rmAll(ctx.dirs); });

  const routine = (extra = {}) => ({
    name: "nightly", cron: "0 3 1 1 *", timezone: "UTC", prompt: "hello", target: { kind: "agent", agentId: agentA.id }, ...extra,
  });
  const create = async (extra) => { const r = await post("/api/routines", routine(extra)); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
  const runsOf = async (id) => (await get(`/api/routines/${id}/runs`)).body;
  const finished = (id, status = "succeeded") =>
    waitFor(async () => (await runsOf(id)).find((x) => x.status === status), { timeout: 20000, message: "a " + status + " run" });

  it("401 without a token", async () => {
    for (const p of ["/api/routines", "/api/runs/abc", "/api/automation"]) {
      const status = await new Promise((resolve, reject) => {
        http.get(`${ctx.server.baseUrl}${p}`, (res) => { res.resume(); resolve(res.statusCode); }).on("error", reject);
      });
      assert.equal(status, 401, p);
    }
  });

  it("create / list / update / delete round trip with defaults filled", async () => {
    const c = await post("/api/routines", routine());
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.match(c.body.id, /^[0-9a-f]+$/);
    assert.equal(c.body.enabled, true);
    assert.equal(c.body.conversation, "agent");
    assert.equal(c.body.concurrency, "coalesce_if_active");
    assert.equal(c.body.catchUp, "skip_missed");
    assert.equal(c.body.maxBudgetUsd, 2);
    assert.equal(c.body.timeoutMin, 20);
    assert.equal(c.body.maxRunsPerDay, null);
    assert.equal(c.body.permission.mode, "acceptEdits");
    assert.equal(c.body.allowBypass, false);
    assert.equal(c.body.lastRunAt, null);
    assert.ok(c.body.nextRunAt > Date.now());
    assert.ok((await get("/api/routines")).body.some((x) => x.id === c.body.id));
    const u = await put(`/api/routines/${c.body.id}`, { name: "renamed", maxBudgetUsd: 3 });
    assert.equal(u.status, 200, JSON.stringify(u.body));
    assert.equal(u.body.name, "renamed");
    assert.equal(u.body.maxBudgetUsd, 3);
    assert.equal(u.body.nextRunAt, c.body.nextRunAt);
    assert.equal((await del(`/api/routines/${c.body.id}`)).status, 200);
    assert.ok(!(await get("/api/routines")).body.some((x) => x.id === c.body.id));
  });

  it("a preset cron is stored as its expression", async () => {
    const r = await create({ cron: "preset:weekdays" });
    assert.equal(r.cron, "0 9 * * 1-5");
    assert.equal((await post("/api/routines", routine({ cron: "preset:nope" }))).status, 400);
  });

  it("invalid cron, timezone, enums, a 20001-character prompt and a never-firing cron are 400s", async () => {
    const cases = {
      "bad cron": { cron: "* * *" },
      "cron not a string": { cron: 5 },
      "never fires": { cron: "0 0 31 2 *" },
      "bad timezone": { timezone: "Mars/Base" },
      "bad conversation": { conversation: "sideways" },
      "bad concurrency": { concurrency: "yolo" },
      "bad catchUp": { catchUp: "everything" },
      "long prompt": { prompt: "x".repeat(20001) },
      "empty prompt": { prompt: "  " },
      "bad permission": { permission: { mode: "nope" } },
      "budget zero": { maxBudgetUsd: 0 },
      "timeout too big": { timeoutMin: 121 },
      "enabled not bool": { enabled: "yes" },
    };
    for (const [label, extra] of Object.entries(cases)) {
      const r = await post("/api/routines", routine(extra));
      assert.equal(r.status, 400, label + " -> " + r.status + " " + JSON.stringify(r.body));
      assert.equal(typeof r.body.error, "string", label);
      noStack(r);
    }
    assert.equal((await post("/api/routines", routine({ prompt: "x".repeat(20000) }))).status, 200);
  });

  it("bypassPermissions needs allowBypass in the same request", async () => {
    const bypass = { permission: { mode: "bypassPermissions" } };
    assert.equal((await post("/api/routines", routine(bypass))).status, 400);
    assert.equal((await post("/api/routines", routine({ ...bypass, allowBypass: false }))).status, 400);
    const ok = await post("/api/routines", routine({ ...bypass, allowBypass: true }));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.allowBypass, true);
    const plain = await create();
    assert.equal((await put(`/api/routines/${plain.id}`, bypass)).status, 400);
    assert.equal((await put(`/api/routines/${plain.id}`, { allowBypass: true })).status, 200);
    assert.equal((await get("/api/routines")).body.find((x) => x.id === plain.id).permission.mode, "acceptEdits");
    const up = await put(`/api/routines/${plain.id}`, { ...bypass, allowBypass: true });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.equal(up.body.permission.mode, "bypassPermissions");
  });

  it("an unknown agent is a 400; unknown or unsafe routine and run ids are 404 and 400", async () => {
    const r = await post("/api/routines", routine({ target: { kind: "agent", agentId: "nope" } }));
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal((await post("/api/routines", routine({ target: { kind: "folder", cwd: path.join(ctx.work, "missing") } }))).status, 400);
    const rel = await post("/api/routines", routine({ target: { kind: "folder", cwd: "relative/dir" } }));
    assert.equal(rel.status, 400);
    assert.match(rel.body.error, /absolute/);
    for (const [fn, p, b] of [
      [put, "/api/routines/deadbeef", { name: "x" }],
      [del, "/api/routines/deadbeef"],
      [post, "/api/routines/deadbeef/run", {}],
      [get, "/api/routines/deadbeef/runs"],
      [get, "/api/runs/deadbeef"],
      [get, "/api/runs/deadbeef/log"],
      [post, "/api/runs/deadbeef/cancel", {}],
      [post, "/api/runs/deadbeef/open", {}],
    ]) {
      const x = await (b === undefined ? fn(p) : fn(p, b));
      assert.equal(x.status, 404, p + " -> " + x.status);
      assert.equal(typeof x.body.error, "string");
      noStack(x);
    }
    for (const bad of ["a.b", "..%2F..", "a%20b", ".hidden"]) {
      for (const [fn, suffix, b] of [[get, ""], [get, "/log"], [post, "/cancel", {}], [post, "/open", {}]]) {
        const x = await (b === undefined ? fn(`/api/runs/${bad}${suffix}`) : fn(`/api/runs/${bad}${suffix}`, b));
        assert.equal(x.status, 400, `/api/runs/${bad}${suffix} -> ${x.status}`);
      }
      assert.equal((await get(`/api/routines/${bad}/runs`)).status, 400, "routine runs " + bad);
      assert.equal((await post(`/api/routines/${bad}/run`, {})).status, 400, "routine run " + bad);
      assert.equal((await put(`/api/routines/${bad}`, { name: "x" })).status, 400, "routine put " + bad);
      assert.equal((await del(`/api/routines/${bad}`)).status, 400, "routine del " + bad);
    }
  });

  it("array and non-object bodies are 400s", async () => {
    const c = await create();
    assert.equal((await post("/api/routines", [1, 2])).status, 400);
    assert.equal((await post("/api/routines", "just text")).status, 400);
    assert.equal((await put(`/api/routines/${c.id}`, [])).status, 400);
    assert.equal((await put("/api/automation", [])).status, 400);
    const bad = await post("/api/routines", "{not json");
    assert.equal(bad.status, 400);
    noStack(bad);
  });

  it("PUT cannot set id, nextRunAt, lastRunAt, created or updated", async () => {
    const c = await create();
    const r = await put(`/api/routines/${c.id}`, { name: "edited", id: "hacked", nextRunAt: 5, lastRunAt: 6, created: 1, updated: 2, bogus: "x" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.name, "edited");
    assert.equal(r.body.id, c.id);
    assert.equal(r.body.nextRunAt, c.nextRunAt);
    assert.equal(r.body.lastRunAt, null);
    assert.equal(r.body.created, c.created);
    assert.equal(r.body.bogus, undefined);
    const p = await post("/api/routines", { ...routine(), id: "mine", nextRunAt: 7, lastRunAt: 8, created: 1 });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.notEqual(p.body.id, "mine");
    assert.notEqual(p.body.nextRunAt, 7);
    assert.equal(p.body.lastRunAt, null);
  });

  it("changing the cron recomputes nextRunAt; enabling a disabled routine recomputes it too", async () => {
    const c = await create({ cron: "0 3 1 1 *" });
    const u = await put(`/api/routines/${c.id}`, { cron: "30 4 2 2 *" });
    assert.equal(u.status, 200, JSON.stringify(u.body));
    assert.notEqual(u.body.nextRunAt, c.nextRunAt);
    assert.equal(new Date(u.body.nextRunAt).getUTCMonth(), 1);
    const off = await put(`/api/routines/${c.id}`, { enabled: false });
    assert.equal(off.status, 200);
    assert.equal(off.body.enabled, false);
    const on = await put(`/api/routines/${c.id}`, { enabled: true });
    assert.equal(on.body.enabled, true);
    assert.ok(on.body.nextRunAt > Date.now());
    assert.equal((await put(`/api/routines/${c.id}`, { cron: "bad" })).status, 400);
    assert.equal((await put(`/api/routines/${c.id}`, { timezone: "Mars/Base" })).status, 400);
  });

  it("run now with the fake claude yields a succeeded run with cost and summary, visible in /runs", async () => {
    const c = await create({ prompt: "say hi" });
    const r = await post(`/api/routines/${c.id}/run`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.routineId, c.id);
    assert.equal(r.body.trigger, "manual");
    const done = await finished(c.id);
    assert.equal(done.id, r.body.id);
    assert.ok(done.costUsd > 0);
    assert.match(done.summary, /reply to: say hi/);
    assert.ok(done.conversationId);
    const one = await get(`/api/runs/${done.id}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.status, "succeeded");
    assert.equal(one.body.routineId, c.id);
  });

  it("GET /api/routines carries each routine's lastRun (newest run of any status), null before the first", async () => {
    const c = await create({ name: "with-last-run" });
    const before = (await get("/api/routines")).body.find((x) => x.id === c.id);
    assert.equal(before.lastRun, null);
    await post(`/api/routines/${c.id}/run`, {});
    const run = await finished(c.id);
    const item = (await get("/api/routines")).body.find((x) => x.id === c.id);
    assert.deepEqual(Object.keys(item.lastRun).sort(), ["costUsd", "finishedAt", "id", "reason", "startedAt", "status"]);
    assert.equal(item.lastRun.id, run.id);
    assert.equal(item.lastRun.status, "succeeded");
    assert.equal(item.lastRun.costUsd, run.costUsd);
    assert.equal(typeof item.lastRun.finishedAt, "number");
  });

  it("GET /api/routines/:id/runs validates limit (integer 1..500, default 50)", async () => {
    const c = await create();
    for (let i = 0; i < 3; i++) assert.equal((await post(`/api/routines/${c.id}/run`, {})).status, 200);
    await waitFor(async () => (await runsOf(c.id)).length >= 1, { message: "runs" });
    for (const bad of ["0", "-1", "501", "abc", "1.5", "", "1e2", "2&limit=3"]) {
      const r = await get(`/api/routines/${c.id}/runs?limit=${bad}`);
      assert.equal(r.status, 400, "limit=" + bad + " -> " + r.status);
    }
    const one = await get(`/api/routines/${c.id}/runs?limit=1`);
    assert.equal(one.status, 200);
    assert.equal(one.body.length, 1);
    assert.equal((await get(`/api/routines/${c.id}/runs?limit=500`)).status, 200);
  });

  it("log tail returns the end of the log; over 1 MB, zero, negative and non-integers are 400s", async () => {
    const c = await create({ prompt: "log me" });
    await post(`/api/routines/${c.id}/run`, {});
    const run = await finished(c.id);
    const full = await rawGet(ctx, `/api/runs/${run.id}/log`);
    assert.equal(full.status, 200);
    assert.match(full.type, /^text\/plain/);
    assert.match(full.text, /reply to: log me/);
    const tail = await rawGet(ctx, `/api/runs/${run.id}/log?tail=60`);
    assert.equal(tail.status, 200);
    assert.ok(tail.text.length > 0 && tail.text.length <= 60, "tail length " + tail.text.length);
    assert.ok(full.text.endsWith(tail.text), "tail is the end of the log");
    assert.equal((await rawGet(ctx, `/api/runs/${run.id}/log?tail=1048576`)).status, 200);
    for (const bad of ["1048577", "99999999999", "0", "-5", "abc", "1.5", "", "1e3", "10&tail=20"]) {
      const r = await get(`/api/runs/${run.id}/log?tail=${bad}`);
      assert.equal(r.status, 400, "tail=" + bad + " -> " + r.status);
      assert.equal(typeof r.body.error, "string");
    }
  });

  it("open a run: a fresh-conversation run opens a session that resumes the run's conversation", async () => {
    const c = await create({ conversation: "fresh", prompt: "open me" });
    await post(`/api/routines/${c.id}/run`, {});
    const run = await finished(c.id);
    assert.ok(run.conversationId);
    const o = await post(`/api/runs/${run.id}/open`, {});
    assert.equal(o.status, 200, JSON.stringify(o.body));
    assert.equal(typeof o.body.id, "number");
    assert.equal(path.resolve(o.body.cwd).toLowerCase(), path.resolve(ctx.work).toLowerCase());
    const listed = (await get("/api/sessions")).body.find((s) => s.id === o.body.id);
    assert.ok(listed, "session is listed");
    assert.equal(listed.launchCommand, `claude --resume ${run.conversationId}`);
    await del(`/api/sessions/${o.body.id}`);
  });

  it("open a run of an agent-mode routine opens the agent's terminal", async () => {
    const c = await create({ conversation: "agent", prompt: "in agent" });
    await post(`/api/routines/${c.id}/run`, {});
    const run = await finished(c.id);
    const o = await post(`/api/runs/${run.id}/open`, {});
    assert.equal(o.status, 200, JSON.stringify(o.body));
    assert.equal(o.body.name, "worker");
    const agent = (await get("/api/agents")).body.find((a) => a.id === agentA.id);
    const listed = (await get("/api/sessions")).body.find((s) => s.id === o.body.id);
    assert.ok(listed.launchCommand.includes(agent.conversationId), listed.launchCommand);
    await del(`/api/sessions/${o.body.id}`);
  });

  it("a folder-target routine runs and its run opens in that folder", async () => {
    const dir = tmp("agenv-folder-");
    ctx.dirs.push(dir);
    const c = await create({ target: { kind: "folder", cwd: dir }, prompt: "folder run" });
    assert.equal(c.conversation, "fresh");
    await post(`/api/routines/${c.id}/run`, {});
    const run = await finished(c.id);
    assert.match(run.summary, /reply to: folder run/);
    const o = await post(`/api/runs/${run.id}/open`, {});
    assert.equal(o.status, 200, JSON.stringify(o.body));
    assert.equal(path.resolve(o.body.cwd).toLowerCase(), path.resolve(dir).toLowerCase());
    await del(`/api/sessions/${o.body.id}`);
  });

  it("pausing blocks run-now with a 409 and a reason; unpausing restores it", async () => {
    const c = await create();
    assert.deepEqual((await get("/api/automation")).body, { paused: false, maxDailyCostUsd: null, owner: true, ownerPort: ctx.server.port });
    const p = await put("/api/automation", { paused: true });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.paused, true);
    assert.equal((await get("/api/automation")).body.paused, true);
    const blocked = await post(`/api/routines/${c.id}/run`, {});
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
    assert.match(blocked.body.error, /paused/i);
    assert.equal((await runsOf(c.id)).length, 0);
    assert.equal((await put("/api/automation", { paused: false })).body.paused, false);
    assert.equal((await post(`/api/routines/${c.id}/run`, {})).status, 200);
    await finished(c.id);
  });

  it("PUT /api/automation whitelists paused and maxDailyCostUsd and validates them", async () => {
    const a = await put("/api/automation", { maxDailyCostUsd: 5, junk: "x", other: 1 });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.deepEqual(a.body, { paused: false, maxDailyCostUsd: 5 });
    assert.equal((await put("/api/automation", { maxDailyCostUsd: null })).body.maxDailyCostUsd, null);
    assert.equal((await put("/api/automation", { maxDailyCostUsd: -1 })).status, 400);
    assert.equal((await put("/api/automation", { maxDailyCostUsd: "3" })).status, 400);
    assert.equal((await put("/api/automation", { paused: "yes" })).status, 400);
    // a cap of 0 blocks every run
    assert.equal((await put("/api/automation", { maxDailyCostUsd: 0 })).status, 200);
    const c = await create();
    assert.equal((await post(`/api/routines/${c.id}/run`, {})).status, 409);
    assert.equal((await put("/api/automation", { maxDailyCostUsd: null })).status, 200);
  });

  it("deleting a routine removes it and its runs", async () => {
    const c = await create({ prompt: "to delete" });
    await post(`/api/routines/${c.id}/run`, {});
    const run = await finished(c.id);
    assert.equal((await get(`/api/runs/${run.id}`)).status, 200);
    assert.equal((await del(`/api/routines/${c.id}`)).status, 200);
    assert.equal((await get(`/api/runs/${run.id}`)).status, 404);
    assert.equal((await get(`/api/routines/${c.id}/runs`)).status, 404);
    assert.equal((await rawGet(ctx, `/api/runs/${run.id}/log`)).status, 404);
  });

  it("cancelling a finished run is a 409", async () => {
    const c = await create();
    await post(`/api/routines/${c.id}/run`, {});
    const run = await finished(c.id);
    const r = await post(`/api/runs/${run.id}/cancel`, {});
    assert.equal(r.status, 409, JSON.stringify(r.body));
  });
});

describe("routines API cancel and delete of a running run", () => {
  let ctx, agent;
  before(async () => {
    ctx = await boot("hang");
    agent = (await post("/api/agents", { name: "hanger", specialty: "x", cwd: ctx.work })).body;
  }, { timeout: 30000 });
  after(async () => {
    try { const pid = Number(fs.readFileSync(path.join(ctx.state, "child.pid"), "utf8")); if (pid && isAlive(pid)) process.kill(pid); } catch {}
    await stopProcess(ctx.server.proc);
    rmAll(ctx.dirs);
  });

  const mk = async (name) => (await post("/api/routines", {
    name, cron: "0 3 1 1 *", timezone: "UTC", prompt: "hang", target: { kind: "agent", agentId: agent.id }, conversation: "fresh",
  })).body;

  it("cancelling a hanging run records cancelled and kills its process tree", async () => {
    const c = await mk("hang-cancel");
    const r = await post(`/api/routines/${c.id}/run`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const childPidFile = path.join(ctx.state, "child.pid");
    const childPid = await waitFor(() => { try { return Number(fs.readFileSync(childPidFile, "utf8")) || 0; } catch { return 0; } }, { message: "the child process" });
    await waitFor(async () => (await get(`/api/runs/${r.body.id}`)).body.status === "running", { message: "running" });
    assert.ok(isAlive(childPid));
    const x = await post(`/api/runs/${r.body.id}/cancel`, {});
    assert.equal(x.status, 200, JSON.stringify(x.body));
    assert.equal(x.body.status, "cancelled");
    assert.equal((await get(`/api/runs/${r.body.id}`)).body.status, "cancelled");
    await waitFor(() => !isAlive(childPid), { message: "the child process to exit" });
    assert.equal((await post(`/api/runs/${r.body.id}/cancel`, {})).status, 409);
  });

  it("open is a 409 while the run (or any run of its agent) is active", async () => {
    try { fs.unlinkSync(path.join(ctx.state, "child.pid")); } catch {}
    const a = await mk("hang-open-a"), b = await mk("hang-open-b");
    const ra = await post(`/api/routines/${a.id}/run`, {});
    assert.equal(ra.status, 200, JSON.stringify(ra.body));
    await waitFor(async () => (await get(`/api/runs/${ra.body.id}`)).body.status === "running", { message: "running" });
    const open = await post(`/api/runs/${ra.body.id}/open`, {});
    assert.equal(open.status, 409, JSON.stringify(open.body));
    assert.match(open.body.error, /still active/);
    // a finished run of the same agent is refused too while another run of that agent is active
    const rb = await post(`/api/routines/${b.id}/run`, {});
    assert.equal(rb.status, 200, JSON.stringify(rb.body));
    await post(`/api/runs/${rb.body.id}/cancel`, {});
    const busy = await post(`/api/runs/${rb.body.id}/open`, {});
    assert.equal(busy.status, 409, JSON.stringify(busy.body));
    assert.match(busy.body.error, /busy/);
    await post(`/api/runs/${ra.body.id}/cancel`, {});
    const after = await post(`/api/runs/${ra.body.id}/open`, {});
    assert.notEqual(after.status, 409, "not refused once nothing of the agent is active: " + JSON.stringify(after.body));
    if (after.status === 200) await del(`/api/sessions/${after.body.id}`);
  });

  it("deleting a routine with a running run cancels it and clears the history", async () => {
    try { fs.unlinkSync(path.join(ctx.state, "child.pid")); } catch {}
    const c = await mk("hang-delete");
    const r = await post(`/api/routines/${c.id}/run`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const childPid = await waitFor(() => { try { return Number(fs.readFileSync(path.join(ctx.state, "child.pid"), "utf8")) || 0; } catch { return 0; } }, { message: "the child process" });
    assert.equal((await del(`/api/routines/${c.id}`)).status, 200);
    assert.equal((await get(`/api/runs/${r.body.id}`)).status, 404);
    await waitFor(() => !isAlive(childPid), { message: "the child process to exit" });
  });
});

describe("routines: only one agenv instance runs the schedules", () => {
  const LOCK = ".agenv-automation.lock";
  // The owner rewrites the lock by rename; on Windows a read can hit the swap for a moment, so retry briefly.
  const readLock = (ctx) => {
    for (let i = 0; ; i++) {
      try { return JSON.parse(fs.readFileSync(path.join(ctx.home, LOCK), "utf8")); }
      catch (e) { if (i >= 40) throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); }
    }
  };

  it("the first instance owns the lock and reports itself as the owner", async () => {
    const ctx = await boot();
    try {
      const a = (await get("/api/automation")).body;
      assert.equal(a.owner, true);
      assert.equal(a.ownerPort, ctx.server.port);
      assert.deepEqual({ pid: readLock(ctx).pid, port: readLock(ctx).port }, { pid: ctx.server.proc.pid, port: ctx.server.port });
    } finally { await stopProcess(ctx.server.proc); rmAll(ctx.dirs); }
  }, { timeout: 30000 });

  it("a graceful shutdown gives the lock back", async () => {
    const ctx = await boot();
    try {
      assert.equal(readLock(ctx).pid, ctx.server.proc.pid);
      assert.equal((await post("/api/shutdown", {})).status, 200);
      await waitFor(() => !fs.existsSync(path.join(ctx.home, LOCK)), { message: "the lock to be released", timeout: 15000 });
    } finally { await stopProcess(ctx.server.proc); rmAll(ctx.dirs); }
  }, { timeout: 30000 });

  it("an instance that finds a live owner does not schedule and refuses run operations with a 409", async () => {
    const ctx = await boot("ok", (home) => fs.writeFileSync(path.join(home, LOCK), JSON.stringify({ pid: process.pid, port: 54321, startedAt: 1 })));
    try {
      const a = (await get("/api/automation")).body;
      assert.equal(a.owner, false);
      assert.equal(a.ownerPort, 54321);
      const agent = (await post("/api/agents", { name: "w", specialty: "t", cwd: ctx.work })).body;
      const c = await post("/api/routines", { name: "x", cron: "0 3 1 1 *", timezone: "UTC", prompt: "hi", target: { kind: "agent", agentId: agent.id } });
      assert.equal(c.status, 200, "routine edits stay allowed: " + JSON.stringify(c.body));
      const run = await post(`/api/routines/${c.body.id}/run`, {});
      assert.equal(run.status, 409, JSON.stringify(run.body));
      assert.match(run.body.error, /owned by another agenv instance \(port 54321\)/);
      assert.equal((await post("/api/runs/aaaaaaaaaaaa/cancel", {})).status, 409);
      assert.equal((await post("/api/runs/aaaaaaaaaaaa/open", {})).status, 409);
      assert.equal(readLock(ctx).pid, process.pid, "the owner's lock is untouched");
    } finally { await stopProcess(ctx.server.proc); }
    try { assert.equal(readLock(ctx).pid, process.pid, "a refused instance leaves the lock when it stops"); } finally { rmAll(ctx.dirs); }
  }, { timeout: 30000 });

  it("a stale lock (its process is gone) is taken over", async () => {
    const dead = require("child_process").spawnSync(process.execPath, ["-e", "0"]).pid;
    const ctx = await boot("ok", (home) => fs.writeFileSync(path.join(home, LOCK), JSON.stringify({ pid: dead, port: 54321, startedAt: 1 })));
    try {
      const a = (await get("/api/automation")).body;
      assert.equal(a.owner, true);
      assert.equal(readLock(ctx).pid, ctx.server.proc.pid);
    } finally { await stopProcess(ctx.server.proc); rmAll(ctx.dirs); }
  }, { timeout: 30000 });
});

describe("routines over a read-only tunnel", () => {
  let ctx, c;
  before(async () => {
    ctx = await boot();
    const a = (await post("/api/agents", { name: "kept", specialty: "x", cwd: ctx.work })).body;
    c = (await post("/api/routines", { name: "kept", cron: "0 3 1 1 *", timezone: "UTC", prompt: "hi", target: { kind: "agent", agentId: a.id } })).body;
  }, { timeout: 30000 });
  after(async () => { await stopProcess(ctx.server.proc); rmAll(ctx.dirs); });

  it("blocks writes under /api/routines, /api/runs and /api/automation but allows reads", async () => {
    assert.equal((await post("/api/ngrok/settings", { readOnly: true })).status, 200);
    const tunnel = { headers: { "x-forwarded-for": "1.2.3.4" } };
    for (const [fn, p, b] of [
      [post, "/api/routines", { name: "x" }],
      [put, `/api/routines/${c.id}`, { name: "y" }],
      [del, `/api/routines/${c.id}`],
      [post, `/api/routines/${c.id}/run`, {}],
      [post, "/api/runs/x/cancel", {}],
      [post, "/api/runs/x/open", {}],
      [post, "/API/Runs/x/cancel", {}],
      [post, "/Api/Routines", { name: "x" }],
      [put, "/api/automation", { paused: true }],
      [put, "/API/Automation", { paused: true }],
    ]) {
      const r = await (b === undefined ? fn(p, tunnel) : fn(p, b, tunnel));
      assert.equal(r.status, 403, p + " -> " + r.status);
    }
    assert.equal((await get("/api/automation", tunnel)).status, 200);
    assert.equal((await get("/api/routines", tunnel)).status, 200);
    assert.equal((await get("/api/automation")).body.paused, false);
    assert.equal((await get("/api/routines")).body.length, 1);
  });
});
