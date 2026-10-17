// test/unit/routines.test.js — Routine validation, RoutineStore and AutomationSettings
"use strict";
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { Crypto } = require("../../dist/core/Crypto");
const { JsonStore } = require("../../dist/core/JsonStore");
const { RoutineStore } = require("../../dist/automation/RoutineStore");
const { AutomationSettings } = require("../../dist/automation/AutomationSettings");
const { validateRoutineInput } = require("../../dist/automation/Routine");
const { PRESETS } = require("../../dist/automation/cron");

const isDir = (p) => p === "/ok" || p === "/ok2";
const agentExists = (id) => id === "a1b2c3d4";
// a zone that is never the machine's, so "changing" the timezone really changes it
const OTHER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone === "Asia/Tokyo" ? "Europe/Paris" : "Asia/Tokyo";
const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);
const opts = { isDir, agentExists, now: NOW };
const input = (o = {}) => ({ name: "Nightly", cron: "0 9 * * *", prompt: "do it", target: { kind: "agent", agentId: "a1b2c3d4" }, ...o });
const status = (fn) => { try { fn(); } catch (e) { return e.status; } return null; };
const check = (o) => validateRoutineInput(input(o), opts);

const tmpDirs = [];
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

function mkEnc(dir, file) {
  return new JsonStore({ path: path.join(dir, file), crypto: new Crypto(path.join(dir, "key")), fallback: () => [] });
}
function mkStore(dir = tmp("agenv-r-")) {
  return { dir, store: new RoutineStore(mkEnc(dir, "routines.enc"), isDir, agentExists) };
}

describe("validateRoutineInput", () => {
  it("defaults match the spec", () => {
    const r = check();
    assert.equal(r.enabled, true);
    assert.equal(r.concurrency, "coalesce_if_active");
    assert.equal(r.catchUp, "skip_missed");
    assert.equal(r.conversation, "agent");
    assert.equal(r.maxBudgetUsd, 2);
    assert.equal(r.timeoutMin, 20);
    assert.deepEqual(r.permission, { mode: "acceptEdits", allowedTools: [] });
    assert.equal(r.allowBypass, false);
    assert.equal(r.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
    assert.equal(r.maxRunsPerDay, null);
    assert.equal(r.model, "");
    assert.deepEqual(r.target, { kind: "agent", agentId: "a1b2c3d4" });
  });
  it("trims name and prompt", () => {
    const r = check({ name: "  Nightly  ", prompt: "  go  " });
    assert.equal(r.name, "Nightly"); assert.equal(r.prompt, "go");
  });
  it("rejects bad cron, bad timezone, long name/prompt, timeout 121, negative budget, unknown enums", () => {
    const cases = {
      "cron garbage": { cron: "nope" }, "cron 6 fields": { cron: "0 0 9 * * *" }, "cron missing": { cron: undefined },
      "tz": { timezone: "Mars/Base" },
      "name 65": { name: "x".repeat(65) }, "name 129": { name: "x".repeat(129) }, "name blank": { name: "   " }, "name missing": { name: undefined },
      "prompt 20001": { prompt: "x".repeat(20001) }, "prompt blank": { prompt: "  " }, "prompt missing": { prompt: undefined },
      "timeout 121": { timeoutMin: 121 }, "timeout 0": { timeoutMin: 0 }, "timeout 1.5": { timeoutMin: 1.5 }, "timeout str": { timeoutMin: "5" },
      "budget -1": { maxBudgetUsd: -1 }, "budget 0": { maxBudgetUsd: 0 }, "budget 101": { maxBudgetUsd: 101 }, "budget NaN": { maxBudgetUsd: NaN },
      "concurrency": { concurrency: "yolo" }, "catchUp": { catchUp: "all" }, "conversation": { conversation: "new" },
      "permission mode": { permission: { mode: "bogus" } }, "enabled": { enabled: "yes" },
      "maxRunsPerDay 0": { maxRunsPerDay: 0 }, "maxRunsPerDay 1001": { maxRunsPerDay: 1001 }, "maxRunsPerDay 1.5": { maxRunsPerDay: 1.5 },
      "preset unknown": { cron: "preset:monthly" },
    };
    for (const [label, o] of Object.entries(cases)) assert.equal(status(() => check(o)), 400, label);
    assert.equal(status(() => validateRoutineInput(null, opts)), 400);
    assert.equal(status(() => validateRoutineInput("x", opts)), 400);
  });
  it("accepts boundary values", () => {
    const r = check({ name: "x".repeat(64), prompt: "x".repeat(20000), timeoutMin: 120, maxBudgetUsd: 100, maxRunsPerDay: 1000 });
    assert.equal(r.name.length, 64); assert.equal(r.timeoutMin, 120); assert.equal(r.maxBudgetUsd, 100); assert.equal(r.maxRunsPerDay, 1000);
    assert.equal(check({ timeoutMin: 1, maxBudgetUsd: 0.01, maxRunsPerDay: 1 }).maxRunsPerDay, 1);
    assert.equal(check({ maxRunsPerDay: null }).maxRunsPerDay, null);
  });
  it("accepts an explicit valid timezone and rejects a cron that never fires", () => {
    assert.equal(check({ timezone: "Asia/Jerusalem" }).timezone, "Asia/Jerusalem");
    assert.equal(status(() => check({ cron: "0 0 30 2 *" })), 400);
    assert.equal(status(() => check({ cron: "0 0 31 4 *" })), 400);
  });
  it("expands presets to their cron expression", () => {
    for (const [k, expr] of Object.entries(PRESETS)) assert.equal(check({ cron: `preset:${k}` }).cron, expr, k);
  });
  it("enqueue_missed_with_cap is rejected for a sub-hourly cron", () => {
    assert.equal(status(() => check({ cron: "*/15 * * * *", catchUp: "enqueue_missed_with_cap" })), 400);
    assert.equal(status(() => check({ cron: "*/59 * * * *", catchUp: "enqueue_missed_with_cap" })), 400);
    assert.equal(check({ cron: "0 * * * *", catchUp: "enqueue_missed_with_cap" }).catchUp, "enqueue_missed_with_cap");
    assert.equal(check({ cron: "*/15 * * * *", catchUp: "skip_missed" }).catchUp, "skip_missed");
    assert.equal(check({ cron: "preset:hourly", catchUp: "enqueue_missed_with_cap" }).cron, PRESETS.hourly);
  });
  it("bypassPermissions requires allowBypass true", () => {
    const bypass = { mode: "bypassPermissions" };
    assert.equal(status(() => check({ permission: bypass })), 400);
    assert.equal(status(() => check({ permission: bypass, allowBypass: false })), 400);
    assert.equal(status(() => check({ permission: bypass, allowBypass: "true" })), 400);
    const r = check({ permission: bypass, allowBypass: true });
    assert.equal(r.permission.mode, "bypassPermissions"); assert.equal(r.allowBypass, true);
    assert.equal(status(() => check({ allowBypass: 1 })), 400);
  });
  it("allowBypass is only kept when the mode is bypassPermissions", () => {
    assert.equal(check({ allowBypass: true }).allowBypass, false);
    assert.equal(check({ permission: { mode: "plan" }, allowBypass: true }).allowBypass, false);
    assert.equal(check({ permission: { mode: "bypassPermissions" }, allowBypass: true }).allowBypass, true);
  });
  it("rejects over-long permission lists and model, control characters in the name, Infinity/-0 budgets, bare preset:", () => {
    const tools = (n) => Array.from({ length: n }, (_, i) => `t${i}`);
    assert.equal(check({ permission: { mode: "plan", allowedTools: tools(200) } }).permission.allowedTools.length, 200);
    assert.equal(status(() => check({ permission: { mode: "plan", allowedTools: tools(201) } })), 400);
    assert.equal(status(() => check({ permission: { mode: "plan", allowedTools: ["x".repeat(201)] } })), 400);
    assert.equal(check({ permission: { mode: "plan", allowedTools: ["x".repeat(200)] } }).permission.allowedTools[0].length, 200);
    assert.equal(check({ model: "m".repeat(100) }).model.length, 100);
    assert.equal(status(() => check({ model: "m".repeat(101) })), 400);
    for (const name of ["a\nb", "a\u0000b", "a\tb", "a\u007fb"]) assert.equal(status(() => check({ name })), 400, JSON.stringify(name));
    for (const maxBudgetUsd of [Infinity, -Infinity, -0, 0]) assert.equal(status(() => check({ maxBudgetUsd })), 400, String(maxBudgetUsd));
    assert.equal(status(() => check({ cron: "preset:" })), 400);
    assert.equal(status(() => check({ cron: "preset" })), 400);
  });
  it("does not mutate the input object", () => {
    const o = input({ cron: "preset:daily", name: "  padded  ", permission: { mode: "plan", allowedTools: [" Read "] } });
    const copy = JSON.parse(JSON.stringify(o));
    validateRoutineInput(o, opts);
    assert.deepEqual(o, copy);
  });
  it("agent target must exist, folder target must be an existing directory", () => {
    assert.equal(status(() => check({ target: { kind: "agent", agentId: "deadbeef" } })), 400);
    assert.equal(status(() => check({ target: { kind: "agent" } })), 400);
    assert.equal(status(() => check({ target: { kind: "folder", cwd: "/nope" } })), 400);
    assert.equal(status(() => check({ target: { kind: "folder" } })), 400);
    assert.equal(status(() => check({ target: { kind: "other" } })), 400);
    assert.equal(status(() => check({ target: undefined })), 400);
    assert.equal(status(() => check({ target: "x" })), 400);
    const f = check({ target: { kind: "folder", cwd: "/ok" } });
    assert.deepEqual(f.target, { kind: "folder", cwd: "/ok" });
  });
  it("target kind agent forbids cwd and folder forbids agentId", () => {
    assert.equal(status(() => check({ target: { kind: "agent", agentId: "a1b2c3d4", cwd: "/ok" } })), 400);
    assert.equal(status(() => check({ target: { kind: "folder", cwd: "/ok", agentId: "a1b2c3d4" } })), 400);
  });
  it("folder targets run in a fresh conversation", () => {
    assert.equal(check({ target: { kind: "folder", cwd: "/ok" } }).conversation, "fresh");
    assert.equal(check({ target: { kind: "folder", cwd: "/ok" }, conversation: "fresh" }).conversation, "fresh");
    assert.equal(status(() => check({ target: { kind: "folder", cwd: "/ok" }, conversation: "agent" })), 400);
    assert.equal(status(() => check({ target: { kind: "folder", cwd: "/ok" }, conversation: "fork" })), 400);
    assert.equal(check({ conversation: "fork" }).conversation, "fork");
  });
});

describe("RoutineStore", () => {
  it("adds with a caller-supplied nextRunAt and an 8-hex id", () => {
    const { store } = mkStore();
    const r = store.add(input(), NOW + 1000);
    assert.match(r.id, /^[0-9a-f]{8}$/);
    assert.equal(r.nextRunAt, NOW + 1000); assert.equal(r.lastRunAt, null);
    assert.equal(r.created, r.updated);
    assert.equal(status(() => store.add(input({ name: "" }), null)), 400);
    assert.equal(store.list().length, 1);
    assert.equal(store.add(input({ name: "b" }), null).nextRunAt, null);
  });
  it("store persists across reload", () => {
    const { dir, store } = mkStore();
    const r = store.add(input(), 123);
    const again = new RoutineStore(mkEnc(dir, "routines.enc"), isDir, agentExists);
    assert.deepEqual(again.get(r.id), r);
    assert.equal(again.list().length, 1);
    assert.equal(again.get("nope"), undefined);
  });
  it("setSchedule persists nextRunAt and lastRunAt without touching other fields", () => {
    const { dir, store } = mkStore();
    const r = store.add(input(), 100);
    const before = JSON.stringify({ ...store.get(r.id), nextRunAt: 0, lastRunAt: 0 });
    store.setSchedule(r.id, { nextRunAt: 200 });
    assert.equal(store.get(r.id).nextRunAt, 200); assert.equal(store.get(r.id).lastRunAt, null);
    store.setSchedule(r.id, { nextRunAt: null, lastRunAt: 150 });
    const reload = new RoutineStore(mkEnc(dir, "routines.enc"), isDir, agentExists).get(r.id);
    assert.equal(reload.nextRunAt, null); assert.equal(reload.lastRunAt, 150);
    assert.equal(JSON.stringify({ ...reload, nextRunAt: 0, lastRunAt: 0 }), before);
    assert.equal(status(() => store.setSchedule("nope", { nextRunAt: 1 })), 404);
    assert.equal(status(() => store.setSchedule(r.id, { nextRunAt: "x" })), 400);
    assert.equal(status(() => store.setSchedule(r.id, { nextRunAt: 1, lastRunAt: NaN })), 400);
  });
  it("update re-validates only supplied editable fields (bookkeeping patch with missing folder succeeds)", () => {
    const dir = tmp("agenv-r-");
    let folderOk = true, agentOk = true;
    const store = new RoutineStore(mkEnc(dir, "routines.enc"), (p) => folderOk && isDir(p), (id) => agentOk && agentExists(id));
    const f = store.add(input({ target: { kind: "folder", cwd: "/ok" } }), 1);
    const a = store.add(input({ name: "agent one" }), 1);
    folderOk = false; agentOk = false;
    assert.equal(store.update(f.id, { lastRunAt: 5, nextRunAt: 9 }).lastRunAt, 5);
    assert.equal(store.update(a.id, { nextRunAt: 10 }).nextRunAt, 10);
    assert.equal(store.update(f.id, { enabled: false }).enabled, false); // editable but target unchanged: not re-checked
    assert.equal(status(() => store.update(f.id, { target: { kind: "folder", cwd: "/ok" } })), 400); // target supplied: re-checked
    assert.equal(status(() => store.update(a.id, { target: { kind: "agent", agentId: "a1b2c3d4" } })), 400);
    folderOk = true; agentOk = true;
    const u = store.update(f.id, { name: "renamed", timeoutMin: 30 });
    assert.equal(u.name, "renamed"); assert.equal(u.timeoutMin, 30);
    assert.ok(u.updated >= u.created);
    assert.equal(store.get(f.id).lastRunAt, 5);
  });
  it("update validates supplied fields and rejects bad bookkeeping", () => {
    const { store } = mkStore();
    const r = store.add(input(), 1);
    assert.equal(status(() => store.update(r.id, { cron: "nope" })), 400);
    assert.equal(status(() => store.update(r.id, { timeoutMin: 500 })), 400);
    assert.equal(status(() => store.update(r.id, { catchUp: "enqueue_missed_with_cap", cron: "*/5 * * * *" })), 400);
    assert.equal(status(() => store.update(r.id, { permission: { mode: "bypassPermissions" } })), 400);
    assert.equal(status(() => store.update(r.id, { lastRunAt: "x" })), 400);
    assert.equal(status(() => store.update("nope", { name: "x" })), 404);
    assert.equal(store.get(r.id).cron, "0 9 * * *"); // failed updates leave the store untouched
    const ok = store.update(r.id, { permission: { mode: "bypassPermissions" }, allowBypass: true });
    assert.equal(ok.permission.mode, "bypassPermissions");
    assert.equal(store.update(r.id, { cron: "preset:weekly", nextRunAt: 2 }).cron, PRESETS.weekly);
  });
  it("a stale allowBypass is never inherited: bypass -> plan -> bypass without the flag is 400", () => {
    const { store } = mkStore();
    const r = store.add(input({ permission: { mode: "bypassPermissions" }, allowBypass: true }), 1);
    assert.equal(r.allowBypass, true);
    const plan = store.update(r.id, { permission: { mode: "plan" } });
    assert.equal(plan.allowBypass, false);
    assert.equal(status(() => store.update(r.id, { permission: { mode: "bypassPermissions" } })), 400);
    assert.equal(store.get(r.id).permission.mode, "plan");
    const again = store.update(r.id, { permission: { mode: "bypassPermissions" }, allowBypass: true });
    assert.equal(again.permission.mode, "bypassPermissions"); assert.equal(again.allowBypass, true);
    // supplying permission without the flag never reuses the stored one, even when staying on bypass
    assert.equal(status(() => store.update(r.id, { permission: { mode: "bypassPermissions", allowedTools: ["Read"] } })), 400);
    // an unrelated edit keeps the acknowledged bypass
    assert.equal(store.update(r.id, { name: "other" }).allowBypass, true);
  });
  it("add with a non-bypass mode and allowBypass:true stores allowBypass false", () => {
    const { store } = mkStore();
    assert.equal(store.add(input({ allowBypass: true }), 1).allowBypass, false);
  });
  it("schedule changes and enabling require a finite nextRunAt", () => {
    const { store } = mkStore();
    const r = store.add(input(), 1000);
    const snap = () => JSON.stringify(store.get(r.id));
    const before = snap();
    for (const patch of [{ cron: "0 10 * * *" }, { cron: "preset:weekly" }, { timezone: OTHER_TZ }, { cron: "0 10 * * *", nextRunAt: null }, { cron: "0 10 * * *", nextRunAt: NaN }]) {
      assert.equal(status(() => store.update(r.id, patch)), 400, JSON.stringify(patch));
      assert.equal(snap(), before);
    }
    const u = store.update(r.id, { cron: "0 10 * * *", nextRunAt: 5000 });
    assert.equal(u.cron, "0 10 * * *"); assert.equal(u.nextRunAt, 5000);
    assert.equal(store.update(r.id, { timezone: OTHER_TZ, nextRunAt: 6000 }).nextRunAt, 6000);
    // unchanged schedule values and ordinary edits need no nextRunAt
    assert.equal(store.update(r.id, { cron: "0 10 * * *", timezone: OTHER_TZ }).nextRunAt, 6000);
    assert.equal(store.update(r.id, { name: "n2", prompt: "p2" }).nextRunAt, 6000);
    assert.equal(store.update(r.id, { cron: "0 10 * * *", enabled: true }).nextRunAt, 6000);
    // enable flip
    assert.equal(store.update(r.id, { enabled: false }).enabled, false);
    const b2 = snap();
    assert.equal(status(() => store.update(r.id, { enabled: true })), 400);
    assert.equal(snap(), b2);
    assert.equal(store.update(r.id, { enabled: true, nextRunAt: 7000 }).nextRunAt, 7000);
    // disabling, and enabled:false on a disabled routine, need nothing
    assert.equal(store.update(r.id, { enabled: false }).enabled, false);
    assert.equal(store.update(r.id, { enabled: false, name: "again" }).name, "again");
  });
  it("update rejects null for editable fields except maxRunsPerDay, and non-object patches", () => {
    const { store } = mkStore();
    const r = store.add(input({ maxRunsPerDay: 5 }), 1);
    for (const f of ["name", "prompt", "cron", "timezone", "target", "conversation", "permission", "allowBypass", "model", "maxBudgetUsd", "timeoutMin", "concurrency", "catchUp", "enabled"]) {
      assert.equal(status(() => store.update(r.id, { [f]: null })), 400, f);
    }
    assert.equal(store.update(r.id, { maxRunsPerDay: null }).maxRunsPerDay, null);
    for (const p of [null, undefined, "x", 5, []]) assert.equal(status(() => store.update(r.id, p)), 400, String(p));
  });
  it("switching the target kind adjusts conversation unless supplied", () => {
    const { store } = mkStore();
    const r = store.add(input({ conversation: "fork" }), 1);
    assert.equal(store.update(r.id, { target: { kind: "folder", cwd: "/ok" } }).conversation, "fresh");
    assert.equal(store.update(r.id, { target: { kind: "agent", agentId: "a1b2c3d4" } }).conversation, "agent");
    assert.equal(store.update(r.id, { target: { kind: "agent", agentId: "a1b2c3d4" }, conversation: "fork" }).conversation, "fork");
    // staying on an agent target keeps the chosen conversation
    assert.equal(store.update(r.id, { target: { kind: "agent", agentId: "a1b2c3d4" } }).conversation, "fork");
  });
  it("update cannot set id/created, and bookkeeping-only updates do not bump updated", async () => {
    const { store } = mkStore();
    const r = store.add(input(), 1);
    await new Promise((res) => setTimeout(res, 5));
    const u = store.update(r.id, { id: "deadbeef", created: 1, nextRunAt: 3, lastRunAt: 2 });
    assert.equal(u.id, r.id); assert.equal(u.created, r.created); assert.equal(u.updated, r.updated);
    assert.equal(u.nextRunAt, 3);
    const e = store.update(r.id, { id: "deadbeef", created: 1, name: "renamed" });
    assert.equal(e.id, r.id); assert.equal(e.created, r.created); assert.ok(e.updated > r.updated);
    assert.equal(store.get("deadbeef"), undefined);
  });
  it("remove deletes and 404s when missing", () => {
    const { store } = mkStore();
    const r = store.add(input(), null);
    store.remove(r.id);
    assert.equal(store.list().length, 0);
    assert.equal(status(() => store.remove(r.id)), 404);
  });
});

describe("AutomationSettings", () => {
  const mk = (dir = tmp("agenv-s-")) =>
    ({ dir, s: new AutomationSettings(new JsonStore({ path: path.join(dir, "auto.enc"), crypto: new Crypto(path.join(dir, "key")), fallback: () => ({}) })) });
  it("defaults to {paused:false,maxDailyCostUsd:null}", () => {
    assert.deepEqual(mk().s.get(), { paused: false, maxDailyCostUsd: null });
  });
  it("sets, merges and persists", () => {
    const { dir, s } = mk();
    assert.deepEqual(s.set({ paused: true }), { paused: true, maxDailyCostUsd: null });
    assert.deepEqual(s.set({ maxDailyCostUsd: 12.5 }), { paused: true, maxDailyCostUsd: 12.5 });
    assert.deepEqual(s.set({ maxDailyCostUsd: null, paused: undefined }), { paused: true, maxDailyCostUsd: null });
    s.set({ maxDailyCostUsd: 3 });
    assert.deepEqual(mk(dir).s.get(), { paused: true, maxDailyCostUsd: 3 });
  });
  it("rejects negative or non-numeric caps and non-boolean pause, leaving settings untouched", () => {
    const { s } = mk();
    for (const p of [{ maxDailyCostUsd: -1 }, { maxDailyCostUsd: "5" }, { maxDailyCostUsd: NaN }, { paused: "yes" }]) {
      assert.equal(status(() => s.set(p)), 400, JSON.stringify(p));
    }
    assert.equal(status(() => s.set(null)), 400);
    assert.deepEqual(s.get(), { paused: false, maxDailyCostUsd: null });
  });
});
