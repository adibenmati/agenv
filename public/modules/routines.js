// routines.js — Routines sidebar panel: scheduled runs of an agent (or a folder), their history and live logs.
// Everything that costs money (Run now, a schedule) goes through the server's guards; this panel only shows and drives them.

import { api, esc, ago, short } from "./util.js";

const POLL_MS = 2000;       // base tick; the list reloads every tick while a run is active, else every IDLE_TICKS ticks
const IDLE_TICKS = 5;
const LOG_POLL_MS = 2000;
const LOG_TAIL = 64 * 1024;
const RUNS_LIMIT = 20;
const RUNS_SHOWN = 10;
const RUN_COOLDOWN_MS = 800; // Run now ignores a second click right after the first finished (a double click)

let panelEl = null;
let _onOpenSession = null; // (session) => {}  shows the returned session as a tab
let _toast = null;         // (message, type) => {}
let pollTimer = null;
let eventTimer = null;
let polling = false;
let idleTicks = 0;
let routines = [];
let agents = [];
let settings = { paused: false, maxDailyCostUsd: null };
let loaded = false;
let refreshing = false, refreshAgain = false;
const runsByRoutine = new Map(); // routine id -> runs, newest first
const expanded = new Set();      // routine ids whose runs are shown
const pending = new Set();       // in-flight actions, keyed "run:<id>" / "toggle:<id>" / "open:<run id>" ...
let view = null;                 // the open run view: { id, ov, timer, busy, run, close }

const json = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });

async function request(path, opts) {
  let resp;
  try { resp = await fetch(api(path), opts); } catch (e) { throw new Error("Network error: " + e.message); }
  let data = null;
  try { data = await resp.json(); } catch {}
  if (!resp.ok) { const err = new Error((data && data.error) || "Request failed (" + resp.status + ")"); err.status = resp.status; err.code = data && data.code; throw err; }
  return data;
}

const toast = (msg, type) => { if (_toast) _toast(msg, type || "info"); };
const isActive = (r) => !!r && (r.status === "queued" || r.status === "running");
const pad2 = (n) => String(n).padStart(2, "0");
const fmtUsd = (c) => (Number(c) < 0.01 ? "$" + Number(c || 0).toFixed(4) : "$" + Number(c).toFixed(2));
const machineTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } };

function fmtDur(ms) {
  if (!ms || ms < 0) return "0s";
  const s = ms / 1000;
  if (s < 10) return s.toFixed(1) + "s";
  if (s < 60) return Math.round(s) + "s";
  const m = Math.floor(s / 60);
  return m < 60 ? m + "m " + Math.round(s % 60) + "s" : Math.floor(m / 60) + "h " + (m % 60) + "m";
}

const whenAgo = (ts) => { const a = ago(ts); return a === "now" ? "just now" : a + " ago"; };
const fmtDate = (ts) => new Date(ts).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
function inTime(ts) {
  const d = (ts - Date.now()) / 1000;
  if (d < 90) return "in under a minute";
  if (d < 3600) return "in " + Math.round(d / 60) + "m";
  if (d < 86400) return "in " + Math.round(d / 3600) + "h";
  return "in " + Math.round(d / 86400) + "d";
}

// ---- Schedules in words ----
export const PRESET_CRON = { hourly: "0 * * * *", daily: "0 9 * * *", weekdays: "0 9 * * 1-5", weekly: "0 9 * * 1" };
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : { 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th");

/** The schedule in words for the presets and common patterns; anything else is the raw cron. Always followed by the timezone. */
export function describeSchedule(cron, tz) {
  const raw = String(cron || "").trim();
  const zone = tz ? " (" + tz + ")" : "";
  const f = raw.split(/\s+/);
  if (f.length !== 5) return raw + zone;
  const [mi, h, dom, mo, dow] = f;
  const n = (s, max) => /^\d{1,2}$/.test(s) && Number(s) <= max;
  if (mo !== "*") return raw + zone;
  if (mi === "0" && h === "*" && dom === "*" && dow === "*") return "Every hour" + zone;
  const step = /^\*\/(\d{1,2})$/.exec(mi);
  if (step && Number(step[1]) > 0 && h === "*" && dom === "*" && dow === "*") return (step[1] === "1" ? "Every minute" : "Every " + Number(step[1]) + " minutes") + zone;
  if (n(mi, 59) && h === "*" && dom === "*" && dow === "*") return "Every hour at :" + pad2(mi) + zone;
  if (!n(mi, 59) || !n(h, 23)) return raw + zone;
  const at = " at " + pad2(h) + ":" + pad2(mi) + zone;
  if (dom === "*") {
    if (dow === "*") return "Every day" + at;
    if (dow === "1-5") return "Weekdays" + at;
    if (dow === "0,6" || dow === "6,0") return "Weekends" + at;
    if (n(dow, 7)) return "Every " + DAYS[Number(dow) % 7] + at;
  } else if (n(dom, 31) && dow === "*" && Number(dom) > 0) {
    return "Monthly on the " + ordinal(Number(dom)) + at;
  }
  return raw + zone;
}

// ---- Init ----
export function init(opts) {
  panelEl = opts.panel;
  _onOpenSession = opts.onOpenSession || null;
  _toast = opts.showToast || null;
  if (!panelEl) return;
  renderShell();
  panelEl.addEventListener("click", handleClick);
  panelEl.addEventListener("change", handleChange);
  panelEl.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.classList.contains("rt-cap")) e.target.blur(); });
}

/** Polls while the panel is visible: every tick when a run is active, otherwise every few ticks. Always clears before starting. */
export function startPolling() {
  stopPolling();
  polling = true; idleTicks = 0;
  pollTimer = setInterval(() => {
    if (anyActive() || ++idleTicks >= IDLE_TICKS) { idleTicks = 0; refresh(); }
  }, POLL_MS);
  if (view && isActive(view.run)) startViewTimer();
}

export function stopPolling() {
  polling = false;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (eventTimer) { clearTimeout(eventTimer); eventTimer = null; }
  if (view && view.timer) { clearInterval(view.timer); view.timer = null; }
}

/** A server broadcast ("runs-updated"): reload soon, but only while the panel is being looked at. */
export function handleEvent(name) {
  if (name !== "runs-updated" || !polling || !panelEl) return;
  if (eventTimer) clearTimeout(eventTimer);
  eventTimer = setTimeout(() => { eventTimer = null; if (polling) refresh(); }, 250);
}

const anyActive = () => { for (const runs of runsByRoutine.values()) if (runs.some(isActive)) return true; return false; };

async function getJson(path) {
  const resp = await fetch(api(path));
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  return resp.json();
}

/** Reloads routines, settings and each routine's recent runs. Overlapping calls are folded into one follow-up. */
export async function refresh() {
  if (!panelEl) return;
  if (refreshing) { refreshAgain = true; return; }
  refreshing = true;
  try {
    const [rs, st, ags] = await Promise.all([getJson("/api/routines"), getJson("/api/automation"), getJson("/api/agents").catch(() => null)]);
    const runs = await Promise.all(rs.map((r) => getJson("/api/routines/" + encodeURIComponent(r.id) + "/runs?limit=" + RUNS_LIMIT).catch(() => runsByRoutine.get(r.id) || [])));
    routines = rs; settings = st; if (ags) agents = ags;
    runsByRoutine.clear();
    rs.forEach((r, i) => runsByRoutine.set(r.id, runs[i]));
    for (const id of [...expanded]) if (!runsByRoutine.has(id)) expanded.delete(id);
    loaded = true;
    renderStrip(); renderList();
  } catch {}
  finally {
    refreshing = false;
    if (refreshAgain) { refreshAgain = false; if (polling) refresh(); } // a hidden panel does not keep loading
  }
}

// ---- Panel ----
function renderShell() {
  panelEl.innerHTML = `
    <div class="rt-header">
      <span class="rt-title">Routines</span>
      <button class="rt-new" title="Create a routine">+ New routine</button>
    </div>
    <div class="rt-strip">
      <label class="rt-pause-row" title="Stops every scheduled, catch-up and manual run until you turn it off"><input type="checkbox" class="rt-pause" /> Pause all automation</label>
      <label class="rt-cap-row">Daily cost cap $<input class="rt-cap" type="number" min="0" step="0.01" placeholder="none" title="Total cost per day across all routines; empty = no cap" /></label>
    </div>
    <div class="rt-banner" hidden>Automation is paused. Nothing will run, including Run now.</div>
    <div class="rt-list" id="rt-list"></div>`;
}

function renderStrip() {
  const pause = panelEl.querySelector(".rt-pause"), cap = panelEl.querySelector(".rt-cap"), banner = panelEl.querySelector(".rt-banner");
  if (!pause) return;
  pause.checked = !!settings.paused;
  banner.hidden = !settings.paused;
  if (document.activeElement !== cap) cap.value = settings.maxDailyCostUsd == null ? "" : String(settings.maxDailyCostUsd);
}

function renderList() {
  const list = panelEl.querySelector("#rt-list");
  if (!list) return;
  if (!routines.length) {
    list.innerHTML = `<div class="rt-empty"><div class="rt-empty-text">${loaded ? "No routines yet" : "Loading..."}</div>
      <div class="rt-empty-hint">A routine runs a prompt on a schedule, unattended, against one of your agents or a folder. Create agents in the Agents panel first.</div></div>`;
    return;
  }
  list.innerHTML = routines.map(renderRow).join("");
}

function targetText(r) {
  if (r.target.kind === "folder") return "Folder " + short(r.target.cwd);
  const a = agents.find((x) => x.id === r.target.agentId);
  return a ? "Agent " + a.name : "Agent (removed)";
}

function badge(status, extra) {
  return `<span class="rt-badge st-${esc(status)}${extra ? " " + extra : ""}">${esc(status)}</span>`;
}

function renderRow(r) {
  const runs = runsByRoutine.get(r.id) || [];
  const last = runs[0];
  const open = expanded.has(r.id);
  const blocked = settings.paused || pending.has("run:" + r.id);
  let next;
  if (!r.enabled) next = "Disabled";
  else if (r.nextRunAt) next = "Next " + fmtDate(r.nextRunAt) + " (" + inTime(r.nextRunAt) + ")";
  else next = "Not scheduled";
  let h = `<div class="rt-row${r.enabled ? "" : " off"}" data-id="${esc(r.id)}" data-name="${esc(r.name)}">`;
  h += `<div class="rt-line1"><label class="rt-switch" title="${r.enabled ? "Enabled: click to disable" : "Disabled: click to enable"}"><input type="checkbox" class="rt-toggle"${r.enabled ? " checked" : ""}${pending.has("toggle:" + r.id) ? " disabled" : ""} /></label>`;
  h += `<span class="rt-name-text" title="${esc(r.name)}">${esc(r.name)}</span></div>`;
  h += `<div class="rt-schedule" title="${esc(r.cron)}">${esc(describeSchedule(r.cron, r.timezone))}</div>`;
  h += `<div class="rt-target" title="${esc(r.target.kind === "folder" ? r.target.cwd : r.target.agentId)}">${esc(targetText(r))}</div>`;
  h += `<div class="rt-next">${esc(next)}</div>`;
  h += `<div class="rt-last">`;
  h += last ? `${badge(last.status)} <span class="rt-last-cost">${esc(fmtUsd(last.costUsd))}</span> <span class="rt-last-ago">${esc(whenAgo(last.queuedAt || last.startedAt))}</span>` : `<span class="rt-never">never run</span>`;
  h += `</div>`;
  h += `<div class="rt-actions">`;
  h += `<button class="rt-btn run" data-act="run" title="${settings.paused ? "Automation is paused" : "Run now"}"${blocked ? " disabled" : ""}>Run now</button>`;
  h += `<button class="rt-btn" data-act="runs" title="Show recent runs">Runs ${open ? "&#9652;" : "&#9662;"}</button>`;
  h += `<button class="rt-btn" data-act="edit" title="Edit">Edit</button>`;
  h += `<button class="rt-btn danger" data-act="delete" title="Delete">Delete</button>`;
  h += `</div>`;
  if (open) h += renderRuns(runs);
  h += `</div>`;
  return h;
}

function renderRuns(runs) {
  if (!runs.length) return `<div class="rt-runs"><div class="rt-runs-empty">No runs yet</div></div>`;
  let h = `<div class="rt-runs">`;
  for (const run of runs.slice(0, RUNS_SHOWN)) {
    const why = run.reason || run.error || "";
    const started = run.startedAt || run.queuedAt;
    h += `<div class="rt-run" data-run="${esc(run.id)}" title="Open this run">`;
    h += `<div class="rt-run-top">${badge(run.status)}<span class="rt-run-when">${esc(started ? whenAgo(started) : "")}</span>`;
    h += `<span class="rt-run-dur">${esc(run.startedAt ? fmtDur(run.durationMs) : "")}</span><span class="rt-run-cost">${esc(fmtUsd(run.costUsd))}</span></div>`;
    if (why && run.status !== "succeeded") h += `<div class="rt-run-reason" title="${esc(why)}">${esc(why)}</div>`;
    h += `</div>`;
  }
  if (runs.length > RUNS_SHOWN) h += `<div class="rt-runs-empty">Latest ${RUNS_SHOWN} of ${runs.length} loaded runs</div>`;
  return h + `</div>`;
}

function handleClick(e) {
  if (e.target.closest(".rt-new")) { openRoutineDialog(null); return; }
  const row = e.target.closest(".rt-row");
  if (!row) return;
  const r = routines.find((x) => x.id === row.dataset.id);
  if (!r) return;
  const runEl = e.target.closest(".rt-run");
  if (runEl) { openRunView(runEl.dataset.run, r.name); return; }
  const btn = e.target.closest(".rt-btn");
  if (!btn || btn.disabled) return;
  const act = btn.dataset.act;
  if (act === "run") runNow(r);
  else if (act === "runs") { if (expanded.has(r.id)) expanded.delete(r.id); else expanded.add(r.id); renderList(); }
  else if (act === "edit") openRoutineDialog(r);
  else if (act === "delete") openDeleteDialog(r);
}

function handleChange(e) {
  const t = e.target;
  if (t.classList.contains("rt-toggle")) {
    const row = t.closest(".rt-row");
    const r = row && routines.find((x) => x.id === row.dataset.id);
    if (r) toggleEnabled(r, t.checked);
  } else if (t.classList.contains("rt-pause")) setPaused(t.checked);
  else if (t.classList.contains("rt-cap")) saveCap(t);
}

/** Runs fn once per key at a time: a second call while the first is pending (or just finished, for cooldownMs) is ignored. */
async function guarded(key, fn, cooldownMs) {
  if (pending.has(key)) return;
  pending.add(key); renderList();
  try { await fn(); }
  finally {
    if (cooldownMs) setTimeout(() => { pending.delete(key); renderList(); }, cooldownMs);
    else { pending.delete(key); renderList(); }
  }
}

async function runNow(r) {
  await guarded("run:" + r.id, async () => {
    try {
      await request("/api/routines/" + encodeURIComponent(r.id) + "/run", json("POST"));
      expanded.add(r.id);
    } catch (e) { toast("Could not run " + r.name + ": " + e.message, "error"); }
    await refresh();
  }, RUN_COOLDOWN_MS);
}

async function toggleEnabled(r, enabled) {
  await guarded("toggle:" + r.id, async () => {
    try { await request("/api/routines/" + encodeURIComponent(r.id), json("PUT", { enabled })); }
    catch (e) { toast("Could not " + (enabled ? "enable " : "disable ") + r.name + ": " + e.message, "error"); }
    await refresh();
  });
}

async function setPaused(paused) {
  await guarded("pause", async () => {
    try { settings = await request("/api/automation", json("PUT", { paused })); }
    catch (e) { toast("Could not " + (paused ? "pause" : "resume") + " automation: " + e.message, "error"); }
    renderStrip();
  });
  refresh();
}

async function saveCap(input) {
  const raw = input.value.trim();
  const cap = raw === "" ? null : Number(raw);
  if (cap !== null && (!Number.isFinite(cap) || cap < 0)) { toast("The daily cost cap must be a number of dollars, 0 or more.", "error"); renderStrip(); return; }
  await guarded("cap", async () => {
    try { settings = await request("/api/automation", json("PUT", { maxDailyCostUsd: cap })); toast(cap === null ? "Daily cost cap removed" : "Daily cost cap set to " + fmtUsd(cap), "success"); }
    catch (e) { toast("Could not save the cost cap: " + e.message, "error"); }
    renderStrip();
  });
}

// ---- Dialog plumbing ----
function overlay(html, cls, onClose) {
  const ov = document.createElement("div");
  ov.className = "ask-overlay rt-ov";
  ov.innerHTML = `<div class="ask-box rt-dialog ${cls || ""}" role="dialog" aria-modal="true">${html}</div>`;
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } };
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey, true);
    ov.remove();
    if (onClose) onClose();
  };
  ov.addEventListener("mousedown", (e) => { if (e.target === ov) close(); });
  // Escape works even when focus was lost (a disabled button); other keystrokes stay away from the terminal underneath.
  document.addEventListener("keydown", onKey, true);
  ov.addEventListener("keydown", (e) => e.stopPropagation());
  document.body.appendChild(ov);
  return { ov, close };
}

function openDeleteDialog(r) {
  const { ov, close } = overlay(`
    <div class="ask-title">Delete routine "${esc(r.name)}"?</div>
    <div class="ask-hint">The schedule and its run history and logs are removed, and any run in progress is cancelled. The agent and its conversation are kept.</div>
    <div class="ask-actions"><button class="ask-btn" data-r="cancel">Cancel</button><button class="ask-btn primary rt-confirm-ok" data-r="ok">Delete</button></div>`);
  ov.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-r]");
    if (!b) return;
    close();
    if (b.dataset.r !== "ok") return;
    await guarded("delete:" + r.id, async () => {
      try { await request("/api/routines/" + encodeURIComponent(r.id), { method: "DELETE" }); toast("Deleted " + r.name, "success"); }
      catch (err) { toast("Could not delete: " + err.message, "error"); }
      await refresh();
    });
  });
  ov.querySelector(".rt-confirm-ok").focus();
}

// ---- Create / edit dialog ----
const PERMS = [
  ["plan", "Read-only (plan, changes nothing)"],
  ["acceptEdits", "Edit files (default)"],
  ["dontAsk", "Allowlist only (listed tools)"],
  ["bypassPermissions", "Skip all permissions"],
];
const PERM_HINTS = {
  plan: "Claude can read and plan but changes nothing.",
  acceptEdits: "Claude can read and edit files in the folder. Anything else that needs approval is refused. An unattended run can still change your files.",
  dontAsk: "Claude may only use the tools you list below; everything else is refused.",
  bypassPermissions: "",
};
const CONVERSATIONS = [
  ["agent", "Continue the agent's own conversation"],
  ["fork", "Fork the agent's conversation for each run"],
  ["fresh", "Start a fresh conversation each run"],
];
const CONCURRENCY = [
  ["coalesce_if_active", "If still running: merge into it (default)"],
  ["skip_if_active", "If still running: skip this one"],
  ["always_enqueue", "If still running: queue another"],
];
const CATCH_UP = [
  ["skip_missed", "Skip runs missed while off (default)"],
  ["enqueue_missed_with_cap", "Run missed ones when back (up to 25; hourly or slower only)"],
];
const PRESET_LABELS = [["hourly", "Hourly"], ["daily", "Daily 09:00"], ["weekdays", "Weekdays 09:00"], ["weekly", "Weekly Mon 09:00"], ["custom", "Custom"]];

function timeZones() {
  let list = [];
  try { list = Intl.supportedValuesOf("timeZone"); } catch {}
  return [...new Set([...list, "UTC", machineTz()])].sort();
}

const fillSelect = (sel, items, current) => {
  sel.innerHTML = items.map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join("");
  if (current != null && items.some(([v]) => v === current)) sel.value = current;
};

/** Create (routine = null) or edit a routine. Nothing is sent until Save; API validation errors are shown in the dialog. */
export async function openRoutineDialog(routine) {
  const editing = !!routine;
  const { ov, close } = overlay(`
    <div class="ask-title">${editing ? "Edit routine" : "New routine"}</div>
    <label class="rt-label">Name<input class="ask-input rt-name" type="text" maxlength="64" spellcheck="false" placeholder="e.g. Morning triage" /></label>
    <div class="rt-label">Schedule
      <div class="rt-presets">${PRESET_LABELS.map(([k, l]) => `<button type="button" class="rt-preset" data-preset="${k}">${esc(l)}</button>`).join("")}</div>
      <div class="rt-cron-row" hidden><input class="ask-input rt-cron" type="text" spellcheck="false" placeholder="minute hour day month weekday, e.g. 30 8 * * 1-5" /></div>
      <select class="ask-input rt-tz" title="Timezone"></select>
      <div class="rt-sched-preview"></div>
    </div>
    <label class="rt-label">Prompt<textarea class="ask-input rt-prompt" rows="4" spellcheck="false" placeholder="What should Claude do on each run?"></textarea></label>
    <div class="rt-label">Runs against
      <select class="ask-input rt-target-kind"><option value="agent">An agent</option><option value="folder">A folder</option></select>
    </div>
    <div data-sec="agent"><label class="rt-label">Agent<select class="ask-input rt-agent"></select></label></div>
    <div data-sec="folder"><label class="rt-label">Folder<input class="ask-input rt-folder" type="text" spellcheck="false" placeholder="absolute path of an existing folder" /></label></div>
    <label class="rt-label">Conversation<select class="ask-input rt-conv"></select></label>
    <label class="rt-label">Permissions<select class="ask-input rt-perm"></select></label>
    <div class="rt-hint rt-perm-hint"></div>
    <div data-sec="tools"><label class="rt-label">Allowed tools (one per line or comma separated)<textarea class="ask-input rt-tools" rows="3" spellcheck="false" placeholder="Read&#10;Grep&#10;Bash(git status)"></textarea></label></div>
    <div class="rt-bypass-warn" data-sec="bypass">
      <b>Warning.</b> With all permissions skipped the agent can run any command, with nobody watching. It can read, change or delete anything this user account can reach. Only use this for a folder and a prompt you fully trust.
      <label class="rt-check"><input type="checkbox" class="rt-bypass" /> I understand this agent can run any command unattended</label>
    </div>
    <details class="rt-adv"><summary>Limits and options</summary>
      <div class="rt-grid">
        <label class="rt-label">Budget per run (USD)<input class="ask-input rt-budget" type="number" min="0.01" max="100" step="0.01" /></label>
        <label class="rt-label">Timeout (minutes)<input class="ask-input rt-timeout" type="number" min="1" max="120" step="1" /></label>
        <label class="rt-label">Max runs per day<input class="ask-input rt-maxruns" type="number" min="1" max="1000" step="1" placeholder="no limit" /></label>
        <label class="rt-label">Model (optional)<input class="ask-input rt-model" type="text" spellcheck="false" placeholder="default" /></label>
      </div>
      <label class="rt-label">Overlapping runs<select class="ask-input rt-concurrency"></select></label>
      <label class="rt-label">After downtime<select class="ask-input rt-catchup"></select></label>
    </details>
    <div class="rt-err" hidden></div>
    <div class="ask-actions"><button class="ask-btn" data-r="cancel">Cancel</button><button class="ask-btn primary rt-save" data-r="ok">${editing ? "Save" : "Create"}</button></div>`);
  const q = (s) => ov.querySelector(s);
  let preset = "daily", busy = false;

  fillSelect(q(".rt-perm"), PERMS, "acceptEdits");
  fillSelect(q(".rt-conv"), CONVERSATIONS, "agent");
  fillSelect(q(".rt-concurrency"), CONCURRENCY, "coalesce_if_active");
  fillSelect(q(".rt-catchup"), CATCH_UP, "skip_missed");
  const zones = timeZones();
  if (routine && routine.timezone && !zones.includes(routine.timezone)) zones.push(routine.timezone);
  fillSelect(q(".rt-tz"), zones.map((z) => [z, z]), routine ? routine.timezone : machineTz());
  q(".rt-budget").value = "2"; q(".rt-timeout").value = "20";

  const curCron = () => (preset === "custom" ? q(".rt-cron").value.trim() : PRESET_CRON[preset]);
  const targetKind = () => q(".rt-target-kind").value;

  function sync() {
    for (const b of ov.querySelectorAll(".rt-preset")) b.classList.toggle("active", b.dataset.preset === preset);
    q(".rt-cron-row").hidden = preset !== "custom";
    q(".rt-sched-preview").textContent = curCron() ? describeSchedule(curCron(), q(".rt-tz").value) : "Enter a cron expression";
    const kind = targetKind(), perm = q(".rt-perm").value;
    q('[data-sec="agent"]').hidden = kind !== "agent";
    q('[data-sec="folder"]').hidden = kind !== "folder";
    if (kind === "folder") { q(".rt-conv").value = "fresh"; q(".rt-conv").disabled = true; } else q(".rt-conv").disabled = false;
    q('[data-sec="tools"]').hidden = perm !== "dontAsk";
    q('[data-sec="bypass"]').hidden = perm !== "bypassPermissions";
    const hint = q(".rt-perm-hint");
    hint.textContent = PERM_HINTS[perm] || ""; hint.hidden = !PERM_HINTS[perm];
    q(".rt-save").disabled = busy || (perm === "bypassPermissions" && !q(".rt-bypass").checked);
    q(".rt-save").textContent = busy ? "Working…" : editing ? "Save" : "Create";
  }

  function showErr(msg) { const el = q(".rt-err"); el.textContent = msg; el.hidden = !msg; }

  function numOrNull(sel, label, whole) {
    const v = q(sel).value.trim();
    if (v === "") return { value: null };
    const n = Number(v);
    if (!Number.isFinite(n) || (whole && !Number.isInteger(n))) return { error: label + " must be a " + (whole ? "whole " : "") + "number." };
    return { value: n };
  }

  async function submit() {
    if (busy || q(".rt-save").disabled) return;
    const perm = q(".rt-perm").value, kind = targetKind();
    const budget = numOrNull(".rt-budget", "Budget", false), timeout = numOrNull(".rt-timeout", "Timeout", true), maxRuns = numOrNull(".rt-maxruns", "Max runs per day", true);
    const bad = budget.error || timeout.error || maxRuns.error;
    if (bad) { showErr(bad); return; }
    const tools = q(".rt-tools").value.split(/[\n,]/).map((t) => t.trim()).filter(Boolean);
    const body = {
      name: q(".rt-name").value.trim(),
      cron: preset === "custom" ? curCron() : "preset:" + preset,
      timezone: q(".rt-tz").value,
      prompt: q(".rt-prompt").value,
      target: kind === "folder" ? { kind: "folder", cwd: q(".rt-folder").value.trim() } : { kind: "agent", agentId: q(".rt-agent").value },
      conversation: kind === "folder" ? "fresh" : q(".rt-conv").value,
      permission: { mode: perm, allowedTools: perm === "dontAsk" ? tools : [] },
      allowBypass: perm === "bypassPermissions" && q(".rt-bypass").checked,
      model: q(".rt-model").value.trim(),
      concurrency: q(".rt-concurrency").value,
      catchUp: q(".rt-catchup").value,
      maxRunsPerDay: maxRuns.value,
    };
    if (budget.value !== null) body.maxBudgetUsd = budget.value;
    if (timeout.value !== null) body.timeoutMin = timeout.value;
    busy = true; showErr(""); sync();
    try {
      const saved = await request(editing ? "/api/routines/" + encodeURIComponent(routine.id) : "/api/routines", json(editing ? "PUT" : "POST", body));
      close();
      toast((editing ? "Saved " : "Created ") + (saved && saved.name ? saved.name : body.name), "success");
      refresh();
    } catch (e) {
      busy = false;
      showErr(e.message);
      sync();
    }
  }

  ov.addEventListener("click", (e) => {
    const p = e.target.closest(".rt-preset");
    if (p) { preset = p.dataset.preset; sync(); if (preset === "custom") q(".rt-cron").focus(); return; }
    const r = e.target.closest("[data-r]");
    if (!r) return;
    if (r.dataset.r === "ok") submit(); else close();
  });
  ov.addEventListener("input", sync);
  ov.addEventListener("change", sync);
  ov.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.tagName === "INPUT" && e.target.type === "text") { e.preventDefault(); submit(); } });

  // Fill from the routine being edited (the agent list arrives below).
  if (routine) {
    q(".rt-name").value = routine.name; q(".rt-prompt").value = routine.prompt;
    const match = Object.keys(PRESET_CRON).find((k) => PRESET_CRON[k] === routine.cron);
    preset = match || "custom"; q(".rt-cron").value = routine.cron;
    q(".rt-target-kind").value = routine.target.kind;
    if (routine.target.kind === "folder") q(".rt-folder").value = routine.target.cwd;
    q(".rt-conv").value = routine.conversation;
    q(".rt-perm").value = routine.permission.mode;
    q(".rt-tools").value = (routine.permission.allowedTools || []).join("\n");
    q(".rt-bypass").checked = !!routine.allowBypass;
    q(".rt-budget").value = String(routine.maxBudgetUsd); q(".rt-timeout").value = String(routine.timeoutMin);
    q(".rt-maxruns").value = routine.maxRunsPerDay == null ? "" : String(routine.maxRunsPerDay);
    q(".rt-model").value = routine.model || "";
    q(".rt-concurrency").value = routine.concurrency; q(".rt-catchup").value = routine.catchUp;
  }
  fillSelect(q(".rt-agent"), [["", "Loading agents…"]]);
  sync();
  q(".rt-name").focus();

  // The agent list loads after the dialog is up so it appears immediately.
  const ags = await fetch(api("/api/agents")).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!ov.isConnected) return;
  if (ags) agents = ags;
  const items = agents.map((a) => [a.id, a.name]);
  const want = routine && routine.target.kind === "agent" ? routine.target.agentId : null;
  if (want && !items.some(([v]) => v === want)) items.unshift([want, want.slice(0, 8) + " (removed)"]);
  if (!items.length) items.push(["", "No agents yet: create one in the Agents panel"]);
  fillSelect(q(".rt-agent"), items, want);
  sync();
}

// ---- Run view ----
function startViewTimer() {
  if (!view || view.timer) return;
  view.timer = setInterval(pollRun, LOG_POLL_MS);
}
function stopViewTimer() { if (view && view.timer) { clearInterval(view.timer); view.timer = null; } }

async function fetchLog(id) {
  const resp = await fetch(api("/api/runs/" + encodeURIComponent(id) + "/log?tail=" + LOG_TAIL));
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  return resp.text();
}

/** One fetch of the run record and the log tail; stops the timer once the run is no longer queued or running. */
async function pollRun() {
  const v = view;
  if (!v || v.busy) return;
  v.busy = true;
  try {
    const [run, log] = await Promise.all([request("/api/runs/" + encodeURIComponent(v.id)), fetchLog(v.id).catch(() => null)]);
    if (view !== v || !v.ov.isConnected) return;
    v.run = run;
    paintRun(v, log);
    if (!isActive(run)) stopViewTimer();
  } catch (e) {
    if (view !== v || !v.ov.isConnected) return;
    if (e.status === 404) { stopViewTimer(); paintGone(v); }
  } finally { v.busy = false; }
}

function paintGone(v) {
  const q = (s) => v.ov.querySelector(s);
  q(".rt-rv-meta").textContent = "This run no longer exists (its routine may have been deleted).";
  q(".rt-rv-cancel").hidden = true;
}

function paintRun(v, log) {
  const q = (s) => v.ov.querySelector(s), run = v.run;
  const st = q(".rt-rv-status");
  st.className = "rt-badge rt-rv-status st-" + run.status;
  st.textContent = run.status;
  const bits = [
    "Trigger: " + run.trigger,
    run.startedAt ? "Started " + fmtDate(run.startedAt) : "Queued " + fmtDate(run.queuedAt),
    run.startedAt ? "Duration " + fmtDur(run.durationMs) : "",
    "Cost " + fmtUsd(run.costUsd),
    run.numTurns ? run.numTurns + " turns" : "",
  ].filter(Boolean);
  let meta = `<div>${esc(bits.join(" · "))}</div>`;
  if (run.reason) meta += `<div class="rt-rv-reason">${esc(run.reason)}</div>`;
  if (run.error) meta += `<div class="rt-rv-error">${esc(run.error)}</div>`;
  if (run.summary) meta += `<div class="rt-rv-summary">${esc(run.summary)}</div>`;
  q(".rt-rv-meta").innerHTML = meta;
  q(".rt-rv-cancel").hidden = !isActive(run);
  if (log != null) {
    const pre = q(".rt-log");
    const stick = !v.painted || pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
    pre.textContent = log || (isActive(run) ? "(no output yet)" : "(no output)");
    if (stick) pre.scrollTop = pre.scrollHeight;
    v.painted = true;
  }
}

/** Shows a run: its status and the log tail, re-polled every ~2 s while it is queued or running. Closing it stops the polling. */
export function openRunView(runId, routineName) {
  if (view) view.close();
  const { ov, close } = overlay(`
    <div class="ask-title">Run of <span class="rt-rv-name">${esc(routineName || "routine")}</span> <span class="rt-badge rt-rv-status">…</span></div>
    <div class="rt-rv-meta rt-hint">Loading…</div>
    <pre class="rt-log">Loading…</pre>
    <div class="ask-actions">
      <button class="ask-btn rt-rv-cancel" hidden>Cancel run</button>
      <button class="ask-btn rt-rv-open" title="Open this run's conversation in a terminal tab">Open interactively</button>
      <button class="ask-btn primary rt-rv-close" data-r="close">Close</button>
    </div>`, "rt-runview", () => { stopViewTimer(); if (view && view.ov === ov) view = null; });
  const v = { id: runId, ov, timer: null, busy: false, run: null, painted: false, close };
  view = v;
  ov.addEventListener("click", async (e) => {
    if (e.target.closest(".rt-rv-close")) { close(); return; }
    if (e.target.closest(".rt-rv-open")) { await openInteractively(v); return; }
    if (e.target.closest(".rt-rv-cancel")) await cancelRun(v);
  });
  startViewTimer();
  pollRun();
}

async function cancelRun(v) {
  const btn = v.ov.querySelector(".rt-rv-cancel");
  await guarded("cancel:" + v.id, async () => {
    btn.disabled = true;
    try { await request("/api/runs/" + encodeURIComponent(v.id) + "/cancel", json("POST")); }
    catch (e) { toast("Could not cancel: " + e.message, "error"); }
    btn.disabled = false;
    if (view === v) { v.busy = false; await pollRun(); }
    refresh();
  });
}

async function openInteractively(v) {
  const btn = v.ov.querySelector(".rt-rv-open");
  await guarded("open:" + v.id, async () => {
    btn.disabled = true;
    try {
      const session = await request("/api/runs/" + encodeURIComponent(v.id) + "/open", json("POST"));
      if (_onOpenSession) await _onOpenSession(session);
      if (view === v) v.close();
    } catch (e) { toast("Could not open the run: " + e.message, "error"); btn.disabled = false; }
  });
}

export const routinesPanel = { init, refresh, startPolling, stopPolling, handleEvent, openRoutineDialog, openRunView };
