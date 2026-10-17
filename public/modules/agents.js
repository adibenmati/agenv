// agents.js — Agents sidebar panel: named agents (folder + conversation + specialty), create / edit / duplicate / delete / open.
// Creating an agent from a conversation costs real tokens, so nothing runs until the user clicks Create in the dialog.

import { api, esc, ago, short } from "./util.js";

let panelEl = null;
let _onOpenSession = null; // (session) => {}  shows the returned session as a tab
let _showContextMenu = null;
let _toast = null;         // (message, type) => {}
let pollTimer = null;
let agents = [];
let loaded = false;

const json = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });

async function request(path, opts) {
  let resp;
  try { resp = await fetch(api(path), opts); } catch (e) { throw new Error("Network error: " + e.message); }
  let data = null;
  try { data = await resp.json(); } catch {}
  if (!resp.ok) { const err = new Error((data && data.error) || "Request failed (" + resp.status + ")"); err.status = resp.status; throw err; }
  return data;
}

const toast = (msg, type) => { if (_toast) _toast(msg, type || "info"); };

// ---- Init ----
export function init(opts) {
  panelEl = opts.panel;
  _onOpenSession = opts.onOpenSession || null;
  _toast = opts.showToast || null;
  _showContextMenu = opts.showContextMenu || null;
  if (!panelEl) return;
  renderShell();
  panelEl.addEventListener("click", handleClick);
  panelEl.addEventListener("contextmenu", handleContextMenu);
}

export function startPolling() { stopPolling(); pollTimer = setInterval(refresh, 10000); }
export function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

export async function refresh() {
  if (!panelEl) return;
  try {
    const resp = await fetch(api("/api/agents"));
    if (!resp.ok) return;
    agents = await resp.json();
    loaded = true;
    renderList();
  } catch {}
}

// ---- Panel ----
function renderShell() {
  panelEl.innerHTML = `
    <div class="ag-header">
      <span class="ag-title">Agents</span>
      <button class="ag-new" title="Create an agent">+ New agent</button>
    </div>
    <div class="ag-list" id="ag-list"></div>`;
}

function renderList() {
  const list = panelEl.querySelector("#ag-list");
  if (!list) return;
  if (!agents.length) {
    list.innerHTML = `<div class="ag-empty"><div class="ag-empty-text">${loaded ? "No agents yet" : "Loading..."}</div>
      <div class="ag-empty-hint">An agent is a named Claude conversation bound to a folder. Create one from scratch, from a session, or by forking a past conversation.</div></div>`;
    return;
  }
  list.innerHTML = agents.map(renderRow).join("");
}

function renderRow(a) {
  const conv = a.conversationId ? a.conversationId.slice(0, 8) : "no conv";
  const last = a.lastRunAt ? "ran " + ago(a.lastRunAt) + " ago" : "never run";
  let h = `<div class="ag-row" data-id="${esc(a.id)}" data-name="${esc(a.name)}">`;
  h += `<div class="ag-row-main">`;
  h += `<div class="ag-name"><span class="ag-name-text">${esc(a.name)}</span></div>`;
  if (a.specialty) h += `<div class="ag-specialty-text" title="${esc(a.specialty)}">${esc(a.specialty)}</div>`;
  h += `<div class="ag-path" title="${esc(a.cwd)}">${esc(short(a.cwd))}</div>`;
  h += `<div class="ag-meta"><span class="ag-conv" title="${esc(a.conversationId || "")}">${esc(conv)}</span><span class="ag-last">${esc(last)}</span></div>`;
  h += `</div>`;
  h += `<div class="ag-actions">`;
  h += `<button class="ag-btn open" data-act="open" title="Open terminal">&#9654;</button>`;
  h += `<button class="ag-btn" data-act="edit" title="Edit">&#9998;</button>`;
  h += `<button class="ag-btn" data-act="duplicate" title="Duplicate">&#10064;</button>`;
  h += `<button class="ag-btn danger" data-act="delete" title="Delete">&#10005;</button>`;
  h += `</div></div>`;
  return h;
}

function handleClick(e) {
  if (e.target.closest(".ag-new")) { openCreateDialog(); return; }
  const btn = e.target.closest(".ag-btn");
  if (!btn) return;
  const row = btn.closest(".ag-row");
  const a = row && agents.find((x) => x.id === row.dataset.id);
  if (!a) return;
  rowAction(btn.dataset.act, a);
}

function handleContextMenu(e) {
  const row = e.target.closest(".ag-row");
  if (!row || !_showContextMenu) return;
  const a = agents.find((x) => x.id === row.dataset.id);
  if (!a) return;
  e.preventDefault();
  _showContextMenu(e.clientX, e.clientY, [
    { label: "Open Terminal", action: "open", handler() { rowAction("open", a); } },
    { label: "Edit…", action: "edit", handler() { rowAction("edit", a); } },
    { label: "Duplicate…", action: "duplicate", handler() { rowAction("duplicate", a); } },
    { separator: true },
    { label: "Copy Name", action: "copy", handler() { navigator.clipboard.writeText(a.name).catch(() => {}); } },
    { label: "Delete…", action: "delete", handler() { rowAction("delete", a); } },
  ]);
}

function rowAction(act, a) {
  if (act === "open") openTerminal(a);
  else if (act === "edit") openEditDialog(a);
  else if (act === "duplicate") openCreateDialog({ kind: "duplicate", agentId: a.id });
  else if (act === "delete") openDeleteDialog(a);
}

async function openTerminal(a) {
  try {
    const session = await request("/api/agents/" + encodeURIComponent(a.id) + "/open", json("POST"));
    if (_onOpenSession) _onOpenSession(session);
    refresh();
  } catch (e) { toast("Could not open " + a.name + ": " + e.message, "error"); }
}

/** Open a terminal that forks a conversation (claude --resume <id> --fork-session) in its folder. */
export async function forkConversation(conversationId, cwd) {
  try {
    const session = await request("/api/claude/conversations/" + encodeURIComponent(conversationId) + "/fork", json("POST", { cwd }));
    if (_onOpenSession) _onOpenSession(session);
  } catch (e) { toast("Could not fork the conversation: " + e.message, "error"); }
}

// ---- Dialog plumbing ----
function overlay(html) {
  const ov = document.createElement("div");
  ov.className = "ask-overlay";
  ov.innerHTML = `<div class="ask-box ag-dialog" role="dialog" aria-modal="true">${html}</div>`;
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } };
  const close = () => { document.removeEventListener("keydown", onKey, true); ov.remove(); };
  ov.addEventListener("mousedown", (e) => { if (e.target === ov) close(); });
  // Escape works even when focus was lost (a disabled button); other keystrokes stay away from the terminal underneath.
  document.addEventListener("keydown", onKey, true);
  ov.addEventListener("keydown", (e) => e.stopPropagation());
  document.body.appendChild(ov);
  return { ov, close };
}

function openDeleteDialog(a) {
  const { ov, close } = overlay(`
    <div class="ask-title">Delete agent "${esc(a.name)}"?</div>
    <div class="ask-hint">The agent record is removed. Its Claude conversation and any files in ${esc(a.cwd)} are kept.</div>
    <div class="ask-actions"><button class="ask-btn" data-r="cancel">Cancel</button><button class="ask-btn primary ag-confirm-ok" data-r="ok">Delete</button></div>`);
  ov.addEventListener("click", async (e) => {
    const r = e.target.closest("[data-r]");
    if (!r) return;
    close();
    if (r.dataset.r !== "ok") return;
    try { await request("/api/agents/" + encodeURIComponent(a.id), { method: "DELETE" }); toast("Deleted " + a.name, "success"); }
    catch (err) { toast("Could not delete: " + err.message, "error"); }
    refresh();
  });
  ov.querySelector(".ag-confirm-ok").focus();
}

function openEditDialog(a) {
  const { ov, close } = overlay(`
    <div class="ask-title">Edit agent</div>
    <label class="ag-label">Name<input class="ask-input ag-name" type="text" spellcheck="false" /></label>
    <label class="ag-label">Specialty<input class="ask-input ag-specialty" type="text" spellcheck="false" /></label>
    <label class="ag-label">Folder<input class="ask-input ag-cwd" type="text" spellcheck="false" /></label>
    <label class="ag-label">Model (optional)<input class="ask-input ag-model" type="text" spellcheck="false" /></label>
    <label class="ag-label">Instructions<textarea class="ask-input ag-instructions" rows="3" spellcheck="false"></textarea></label>
    <div class="ag-err" hidden></div>
    <div class="ask-actions"><button class="ask-btn" data-r="cancel">Cancel</button><button class="ask-btn primary ag-save" data-r="ok">Save</button></div>`);
  const q = (s) => ov.querySelector(s);
  q(".ag-name").value = a.name; q(".ag-specialty").value = a.specialty || ""; q(".ag-cwd").value = a.cwd;
  q(".ag-model").value = a.model || ""; q(".ag-instructions").value = a.instructions || "";
  ov.addEventListener("click", async (e) => {
    const r = e.target.closest("[data-r]");
    if (!r) return;
    if (r.dataset.r !== "ok") { close(); return; }
    const body = { name: q(".ag-name").value.trim(), specialty: q(".ag-specialty").value, cwd: q(".ag-cwd").value.trim(), model: q(".ag-model").value.trim(), instructions: q(".ag-instructions").value };
    try {
      await request("/api/agents/" + encodeURIComponent(a.id), json("PUT", body));
      close();
      toast("Saved " + body.name, "success");
      refresh();
    } catch (err) {
      toast("Could not save: " + err.message, "error");
      const el = q(".ag-err"); el.textContent = err.message; el.hidden = false;
    }
  });
  q(".ag-name").focus();
}

// ---- Create dialog ----
const fmtKb = (n) => (n < 1024 * 1024 ? Math.max(1, Math.round(n / 1024)) + " KB" : (n / 1024 / 1024).toFixed(1) + " MB");
const fmtUsd = (c) => (c < 0.01 ? "$" + c.toFixed(4) : "$" + c.toFixed(2));
const projectShort = (p) => { const parts = String(p || "").split("-"); return parts[parts.length - 1] || p || ""; };

const MODES = [
  ["fork", "Fork (keeps the whole conversation)"],
  ["fork-compact", "Fork + compact (smaller, cheaper to run)"],
  ["distill-briefing", "Distill to a briefing file (starts a fresh conversation)"],
  ["distill-skill", "Distill to a skill file (starts a fresh conversation)"],
];

/** Where a distill mode will write, shown verbatim before the user confirms. */
function targetPath(mode, cwd, name) {
  if (!cwd || !name) return "";
  const sep = cwd.includes("\\") ? "\\" : "/";
  const base = cwd.replace(/[\\/]+$/, "");
  if (mode === "distill-skill") return [base, ".claude", "skills", name, "SKILL.md"].join(sep);
  if (mode === "distill-briefing") return [base, ".claude", "agenv-briefings", name + ".md"].join(sep);
  return "";
}

/**
 * Create dialog. prefill: { kind?, sourceConversationId?, sessionId?, cwd?, agentId? }.
 * Nothing is sent to Claude until the user clicks Create.
 */
export async function openCreateDialog(prefill) {
  prefill = prefill || {};
  let kind = prefill.kind || (prefill.sessionId != null ? "session" : prefill.sourceConversationId ? "conversation" : "blank");
  const { ov, close } = overlay(`
    <div class="ask-title">Create agent</div>
    <div class="ag-kinds">
      <button class="ag-kind" data-kind="blank">Blank</button>
      <button class="ag-kind" data-kind="session">From session</button>
      <button class="ag-kind" data-kind="conversation">From conversation</button>
      <button class="ag-kind" data-kind="duplicate">Duplicate</button>
    </div>
    <div class="ag-kind-hint"></div>
    <div data-sec="common-name">
      <label class="ag-label">Name<input class="ask-input ag-name" type="text" spellcheck="false" placeholder="letters, digits, - and _" /></label>
      <label class="ag-label">Specialty<input class="ask-input ag-specialty" type="text" spellcheck="false" placeholder="what this agent is good at" /></label>
    </div>
    <div data-sec="cwd"><label class="ag-label">Folder<input class="ask-input ag-cwd" type="text" spellcheck="false" placeholder="absolute path of the project folder" /></label></div>
    <div data-sec="blank"><label class="ag-label">Instructions (optional)<textarea class="ask-input ag-instructions" rows="2" spellcheck="false"></textarea></label></div>
    <div data-sec="session"><label class="ag-label">Session<select class="ask-input ag-session"></select></label></div>
    <div data-sec="conversation">
      <label class="ag-label">Source conversation<select class="ask-input ag-source"></select></label>
      <label class="ag-label">Mode<select class="ask-input ag-mode"></select></label>
      <div class="ag-estimate"></div>
      <div class="ag-target" hidden>
        <div class="ag-target-title">This writes a file into your project folder:</div>
        <code class="ag-target-path"></code>
        <label class="ag-check"><input type="checkbox" class="ag-confirm" /> I confirm this file may be written</label>
        <label class="ag-check ag-overwrite-row" hidden><input type="checkbox" class="ag-overwrite" /> The file already exists: overwrite it</label>
      </div>
    </div>
    <div data-sec="duplicate">
      <label class="ag-label">Agent to duplicate<select class="ask-input ag-dup-agent"></select></label>
      <label class="ag-check"><input type="checkbox" class="ag-dup-compact" /> Compact the copy (fewer tokens per run)</label>
      <div class="ag-estimate-note">Duplicating forks the conversation with Claude, which uses tokens.</div>
    </div>
    <div class="ag-err" hidden></div>
    <div class="ask-actions"><button class="ask-btn" data-r="cancel">Cancel</button><button class="ask-btn primary ag-create" data-r="ok">Create</button></div>`);
  const q = (s) => ov.querySelector(s);

  let conversations = [], sessions = [];
  let est = null, estState = "idle", estSeq = 0, busy = false, needOverwrite = false, cwdTouched = false;
  const hints = {
    blank: "An empty agent. Its conversation starts the first time it runs or its terminal is opened.",
    session: "Binds the conversation a session is running. No Claude call, no cost; the session keeps using that conversation.",
    conversation: "Starts from a past conversation. The source is never changed.",
    duplicate: "Copies an agent's profile and forks its conversation.",
  };

  const mode = () => q(".ag-mode").value;
  const isDistill = () => kind === "conversation" && mode().startsWith("distill-");
  const curTarget = () => (isDistill() ? targetPath(mode(), q(".ag-cwd").value.trim(), q(".ag-name").value.trim()) : "");

  function fillSelect(sel, items, current) {
    sel.innerHTML = items.map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join("");
    if (current != null && items.some(([v]) => v === current)) sel.value = current;
  }

  function sync() {
    for (const k of ov.querySelectorAll(".ag-kind")) k.classList.toggle("active", k.dataset.kind === kind);
    q(".ag-kind-hint").textContent = hints[kind];
    const show = {
      "common-name": kind !== "duplicate", cwd: kind === "blank" || kind === "conversation",
      blank: kind === "blank", session: kind === "session", conversation: kind === "conversation", duplicate: kind === "duplicate",
    };
    for (const [sec, on] of Object.entries(show)) q(`[data-sec="${sec}"]`).hidden = !on;
    const distill = isDistill();
    q(".ag-target").hidden = !distill;
    if (distill) {
      const t = curTarget();
      const pathEl = q(".ag-target-path");
      if (pathEl.dataset.path !== t) { q(".ag-confirm").checked = false; q(".ag-overwrite").checked = false; pathEl.dataset.path = t; }
      pathEl.textContent = t || "(enter a name and a folder first)";
      pathEl.classList.toggle("empty", !t);
    }
    q(".ag-overwrite-row").hidden = !(distill && needOverwrite);
    renderEstimate();
    const okToSend = !busy
      && !(kind === "conversation" && estState === "loading")
      && !(distill && (!curTarget() || !q(".ag-confirm").checked || (needOverwrite && !q(".ag-overwrite").checked)));
    q(".ag-create").disabled = !okToSend;
    q(".ag-create").textContent = busy ? "Working…" : distill ? "Write file and create" : "Create";
  }

  function renderEstimate() {
    const el = q(".ag-estimate");
    if (kind !== "conversation") { el.innerHTML = ""; return; }
    if (estState === "loading") { el.innerHTML = `<div class="ag-est-line">Estimating cost…</div>`; return; }
    if (estState === "error") { el.innerHTML = `<div class="ag-est-line">Estimate unavailable.</div>`; return; }
    if (!est) { el.innerHTML = ""; return; }
    const m = mode();
    const note = m === "fork-compact" ? " A compact pass is added." : m.startsWith("distill-") ? " The conversation is read once to write the file." : "";
    let h = `<div class="ag-est-line">Transcript ${esc(fmtKb(est.sizeBytes))}, about <span class="ag-est-tokens">${esc(est.approxTokens.toLocaleString("en-US"))} tokens</span>. `;
    h += `Estimated cost up to <span class="ag-est-cost">${esc(fmtUsd(est.estimatedCostUsd))}</span>.${esc(note)}</div>`;
    h += `<div class="ag-est-basis">${esc(est.basis || "")}</div>`;
    h += `<div class="ag-est-basis">Creating spends real tokens, nothing runs until you click Create.</div>`;
    if (est.suggestCompact && m === "fork") {
      h += `<div class="ag-compact-hint">This conversation is large. Fork + compact is recommended: the agent re-reads less on every run. <button class="ag-use-compact" type="button">Use Fork + compact</button></div>`;
    }
    el.innerHTML = h;
  }

  async function loadEstimate() {
    est = null;
    const id = q(".ag-source").value;
    if (kind !== "conversation" || !id) { estState = "idle"; sync(); return; }
    const seq = ++estSeq;
    estState = "loading"; sync();
    try {
      const data = await request("/api/claude/conversations/" + encodeURIComponent(id) + "/estimate");
      if (seq !== estSeq) return;
      est = data; estState = "ready";
    } catch { if (seq !== estSeq) return; estState = "error"; }
    sync();
  }

  function onSourceChange() {
    const c = conversations.find((x) => x.id === q(".ag-source").value);
    if (c && !cwdTouched) q(".ag-cwd").value = c.cwd || c.projectPath || "";
    loadEstimate();
  }

  async function submit() {
    if (busy) return;
    const name = q(".ag-name").value.trim(), specialty = q(".ag-specialty").value;
    let path, body;
    const missing = kind === "session" ? !q(".ag-session").value : kind === "conversation" ? !q(".ag-source").value : kind === "duplicate" ? !q(".ag-dup-agent").value : false;
    if (missing) { const el = q(".ag-err"); el.textContent = "Nothing is selected."; el.hidden = false; return; }
    if (kind === "blank") {
      path = "/api/agents"; body = { name, specialty, cwd: q(".ag-cwd").value.trim(), instructions: q(".ag-instructions").value };
    } else if (kind === "session") {
      const sid = Number(q(".ag-session").value);
      path = "/api/agents/from-session"; body = { sessionId: sid, name, specialty };
    } else if (kind === "conversation") {
      path = "/api/agents/from-conversation";
      body = { name, specialty, sourceConversationId: q(".ag-source").value, cwd: q(".ag-cwd").value.trim(), mode: mode(), overwrite: isDistill() && q(".ag-overwrite").checked };
    } else {
      const id = q(".ag-dup-agent").value;
      path = "/api/agents/" + encodeURIComponent(id) + "/duplicate"; body = { compact: q(".ag-dup-compact").checked };
    }
    busy = true; q(".ag-err").hidden = true; sync();
    try {
      const a = await request(path, json("POST", body));
      close();
      toast("Created agent " + (a && a.name ? a.name : name), "success");
      refresh();
    } catch (e) {
      busy = false;
      if (isDistill() && e.status === 409 && /already exists/.test(e.message) && !/agent named/.test(e.message)) needOverwrite = true;
      toast("Could not create the agent: " + e.message, "error");
      const el = q(".ag-err"); el.textContent = e.message; el.hidden = false;
      sync();
    }
  }

  // ---- wiring ----
  fillSelect(q(".ag-mode"), MODES);
  ov.addEventListener("click", (e) => {
    const k = e.target.closest(".ag-kind");
    if (k) { kind = k.dataset.kind; if (kind === "conversation" && estState === "idle") loadEstimate(); else sync(); return; }
    if (e.target.closest(".ag-use-compact")) { q(".ag-mode").value = "fork-compact"; sync(); return; }
    const r = e.target.closest("[data-r]");
    if (!r) return;
    if (r.dataset.r === "ok") submit(); else close();
  });
  ov.addEventListener("input", (e) => {
    if (e.target.classList.contains("ag-cwd")) cwdTouched = true;
    needOverwrite = needOverwrite && e.target.classList.contains("ag-overwrite");
    sync();
  });
  ov.addEventListener("change", (e) => {
    if (e.target.classList.contains("ag-source")) onSourceChange();
    else sync();
  });
  ov.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.tagName === "INPUT" && e.target.type === "text" && !q(".ag-create").disabled) { e.preventDefault(); submit(); } });
  sync();

  // Lists load after the dialog is up so it appears immediately.
  const [convs, sess, ags] = await Promise.all([
    fetch(api("/api/claude/sessions")).then((r) => (r.ok ? r.json() : [])).catch(() => []),
    fetch(api("/api/sessions")).then((r) => (r.ok ? r.json() : [])).catch(() => []),
    fetch(api("/api/agents")).then((r) => (r.ok ? r.json() : [])).catch(() => []),
  ]);
  if (!ov.isConnected) return;
  agents = ags; renderList();
  conversations = convs.slice().sort((a, b) => (b.lastMessage || 0) - (a.lastMessage || 0));
  const convItems = conversations.map((c) => [c.id, `${c.slug || c.id.slice(0, 8)} · ${projectShort(c.project)} · ${c.id.slice(0, 8)}`]);
  const want = prefill.sourceConversationId;
  if (want && !convItems.some(([v]) => v === want)) convItems.unshift([want, want.slice(0, 8) + " (conversation)"]);
  if (!convItems.length) convItems.push(["", "No Claude conversations found"]);
  fillSelect(q(".ag-source"), convItems, want);

  sessions = sess.filter((s) => s.claudeSessionId);
  const sessItems = sessions.map((s) => [String(s.id), `${s.name || "Session " + s.id} · ${s.claudeSessionId.slice(0, 8)}`]);
  if (!sessItems.length) sessItems.push(["", "No session is linked to a Claude conversation"]);
  fillSelect(q(".ag-session"), sessItems, prefill.sessionId != null ? String(prefill.sessionId) : null);

  const dupItems = ags.map((a) => [a.id, a.name]);
  if (!dupItems.length) dupItems.push(["", "No agents to duplicate"]);
  fillSelect(q(".ag-dup-agent"), dupItems, prefill.agentId);

  if (prefill.cwd) { q(".ag-cwd").value = prefill.cwd; cwdTouched = true; }
  else if (kind === "conversation") onSourceChange();
  if (kind === "conversation") loadEstimate(); else sync();
  q(kind === "duplicate" ? ".ag-dup-agent" : ".ag-name").focus();
}

export const agentsPanel = { init, refresh, startPolling, stopPolling, openCreateDialog, forkConversation };
