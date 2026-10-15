// sessions.js — Session management sidebar panel (agent-deck style)
// Shows all sessions grouped by user-defined groups, with live status,
// agent badges, costs, durations, expandable details, and context menus.

import { api, esc, ago, short, fname, askText } from "./util.js";

let panelEl = null;
let _onOpenSession = null;    // (sessionId, meta, opts?) => {}
let _onCreateSession = null;  // (opts?) => {}
let _onLaunchAgent = null;    // (agent?) => {}
let _onDeleteSession = null;  // (sessionId) => {}
let _onRestartSession = null; // (sessionId) => {}
let _getAgentCommand = null;  // () => string
let _isSessionOpen = null;    // (sessionId) => boolean
let _showContextMenu = null;  // (x, y, items) => {}
let _onResumeClosed = null;   // (archiveEntry, { agent }) => {}

let sessions = [];
// Groups are "/"-separated paths ("project1/marketing/seo") forming a folder
// tree. groupTree is the root node (its sessions are the ungrouped ones);
// groups is every folder node, flat, for lookups.
let groupDefs = [];       // [{ path, color }] from the server — includes empty folders
let groupTree = null;     // { path, name, color, children: [node], sessions: [s] }
let groups = [];
let closedSessions = [];  // archive entries, newest first
let closedOpen = false;
try { closedOpen = localStorage.getItem("tl-sp-closed-open") === "1"; } catch {}
const MAX_CLOSED_SHOWN = 25;
let pollTimer = null;
let filterQuery = "";
let expandedSessions = new Set(); // session ids with detail row visible
let editingNote = null;   // session id currently editing note

// Drag state
let dragSessionId = null;
let dragOverGroup = null;

// ---- Persistence: groups + colors + collapsed ----
const GROUP_COLORS = ["", "#58a6ff", "#3fb950", "#d29922", "#f85149", "#bc8cff", "#39d2c0", "#f0883e"];
const COLOR_NAMES = ["Default", "Blue", "Green", "Yellow", "Red", "Purple", "Cyan", "Orange"];

// Folder definitions live on the server (they used to be in localStorage,
// which is per-origin — the desktop app on a different port saw none of them).
async function saveGroupDefs() {
  try {
    const resp = await fetch(api("/api/session-groups"), {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groups: groupDefs }),
    });
    if (resp.ok) groupDefs = await resp.json();
  } catch {}
}

async function groupRequest(path, body) {
  try {
    const resp = await fetch(api(path), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      alert(err.error || "Group update failed");
    }
  } catch {}
  await refresh();
}

/** One-time move of groups created before they were stored on the server. */
async function migrateLocalGroups() {
  let legacy = [];
  try {
    if (localStorage.getItem("tl-sp-groups-migrated")) return;
    legacy = JSON.parse(localStorage.getItem("tl-sp-groups") || "[]");
  } catch { return; }
  const known = new Set(groupDefs.map(g => g.path));
  const add = legacy.filter(g => g && g.name && !known.has(g.name)).map(g => ({ path: g.name, color: g.color || "" }));
  if (add.length) { groupDefs = groupDefs.concat(add); await saveGroupDefs(); }
  try { localStorage.setItem("tl-sp-groups-migrated", "1"); } catch {}
}

const collapsedGroups = new Set(JSON.parse(localStorage.getItem("tl-sp-collapsed") || "[]"));
function saveCollapsed() {
  localStorage.setItem("tl-sp-collapsed", JSON.stringify([...collapsedGroups]));
}

// ---- Init ----
export function init(opts) {
  panelEl = opts.panel;
  _onOpenSession = opts.onOpenSession || null;
  _onCreateSession = opts.onCreateSession || null;
  _onLaunchAgent = opts.onLaunchAgent || null;
  _onDeleteSession = opts.onDeleteSession || null;
  _onRestartSession = opts.onRestartSession || null;
  _getAgentCommand = opts.getAgentCommand || (() => "claude");
  _isSessionOpen = opts.isSessionOpen || (() => false);
  _showContextMenu = opts.showContextMenu || null;
  _onResumeClosed = opts.onResumeClosed || null;

  if (!panelEl) return;
  renderShell();
  refresh();

  panelEl.addEventListener("click", handleClick);
  panelEl.addEventListener("dblclick", handleDblClick);
  panelEl.addEventListener("input", handleInput);
  panelEl.addEventListener("contextmenu", handleContextMenu);
  panelEl.addEventListener("dragstart", handleDragStart);
  panelEl.addEventListener("dragover", handleDragOver);
  panelEl.addEventListener("dragleave", handleDragLeave);
  panelEl.addEventListener("drop", handleDrop);
  panelEl.addEventListener("dragend", handleDragEnd);
}

export function startPolling() { stopPolling(); pollTimer = setInterval(refresh, 5000); }
export function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

let _migrated = false;
export async function refresh() {
  try {
    const [resp, gResp, aResp] = await Promise.all([
      fetch(api("/api/sessions")), fetch(api("/api/session-groups")), fetch(api("/api/archive")),
    ]);
    if (!resp.ok) return;
    sessions = await resp.json();
    if (gResp.ok) groupDefs = await gResp.json();
    if (aResp.ok) closedSessions = (await aResp.json()).slice().reverse();
    if (!_migrated) { _migrated = true; await migrateLocalGroups(); }
    buildGroups();
    renderSessions();
  } catch {}
}

export function updateSession(id, meta) {
  const s = sessions.find(s => s.id === id);
  if (s) Object.assign(s, meta);
  buildGroups();
  renderSessions();
}

export function getSessions() { return sessions; }

// ---------------------------------------------------------------------------
// Group logic — builds the folder tree from server folders + session paths
// ---------------------------------------------------------------------------
const parentPath = (p) => p.split("/").slice(0, -1).join("/");
const leafName = (p) => p.split("/").pop();
const displayPath = (p) => p ? p.split("/").join(" › ") : "Ungrouped";
const inGroup = (p, root) => p === root || p.startsWith(root + "/");

function buildGroups() {
  const nodes = new Map(); // path -> node
  const node = (path) => {
    let n = nodes.get(path);
    if (!n) {
      n = { path, name: leafName(path), color: "", children: [], sessions: [] };
      nodes.set(path, n);
      if (path) node(parentPath(path)).children.push(n);
    }
    return n;
  };
  const root = node("");
  for (const g of groupDefs) node(g.path).color = g.color || "";
  for (const s of sessions) node(s.group || "").sessions.push(s);

  const sortTree = (n) => {
    n.children.sort((a, b) => a.name.localeCompare(b.name));
    n.sessions.sort((a, b) => {
      const aw = statusWeight(a.status);
      const bw = statusWeight(b.status);
      if (aw !== bw) return bw - aw;
      return (b.lastActivity || 0) - (a.lastActivity || 0);
    });
    n.children.forEach(sortTree);
  };
  sortTree(root);
  groupTree = root;
  groups = [...nodes.values()].filter(n => n.path);
}

/** Sessions in a folder and all of its subfolders. */
function subtreeSessions(n) {
  const out = [...n.sessions];
  for (const c of n.children) out.push(...subtreeSessions(c));
  return out;
}

/** Every folder in tree order, with depth — for menus. */
function flatFolders(n = groupTree, depth = 0, out = []) {
  if (!n) return out;
  for (const c of n.children) { out.push({ path: c.path, name: c.name, depth }); flatFolders(c, depth + 1, out); }
  return out;
}

function statusWeight(s) {
  if (s === "running") return 3;
  if (s === "waiting") return 2;
  if (s === "error") return 1;
  return 0;
}

function matchesFilter(s) {
  if (!filterQuery) return true;
  const q = filterQuery.toLowerCase();
  return (s.name || "").toLowerCase().includes(q)
    || (s.cwd || "").toLowerCase().includes(q)
    || (s.tool || "").toLowerCase().includes(q)
    || (s.group || "").toLowerCase().includes(q)
    || (s.note || "").toLowerCase().includes(q);
}

function duration(ms) {
  if (!ms || ms <= 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h " + (m % 60) + "m";
  return Math.floor(h / 24) + "d " + (h % 24) + "h";
}

function fmtTokens(n) {
  if (!n) return "0";
  if (n < 1000) return String(n);
  if (n < 1000000) return (n / 1000).toFixed(1) + "K";
  return (n / 1000000).toFixed(2) + "M";
}

function fmtCost(c) {
  if (!c) return "";
  if (c < 0.01) return "$" + c.toFixed(4);
  return "$" + c.toFixed(2);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderShell() {
  panelEl.innerHTML = `
    <div class="sp-header">
      <span class="sp-title">Sessions</span>
      <div class="sp-actions">
        <button class="sp-btn" data-act="new-session" title="New Terminal">+</button>
        <button class="sp-btn sp-agent-btn" data-act="new-agent" title="Launch Agent">C</button>
        <button class="sp-btn" data-act="refresh" title="Refresh">&#8635;</button>
      </div>
    </div>
    <div class="sp-filter">
      <input type="text" class="sp-search" placeholder="Filter sessions..." id="sp-search" />
    </div>
    <div class="sp-body" id="sp-body"></div>
    <div class="sp-footer" id="sp-footer"></div>
  `;
}

function renderSessions() {
  const body = panelEl.querySelector("#sp-body");
  const footer = panelEl.querySelector("#sp-footer");
  if (!body) return;

  let h = "";
  if (groupTree) {
    for (const c of groupTree.children) h += renderGroupNode(c);
    // Ungrouped sessions \u2014 a pseudo-folder for the root
    const loose = groupTree.sessions.filter(matchesFilter);
    if (loose.length > 0) h += renderGroupNode({ path: "", name: "Ungrouped", color: "", children: [], sessions: groupTree.sessions });
  }

  h += renderClosed();

  if (sessions.length === 0 && groups.length === 0 && closedSessions.length === 0 || (filterQuery && h === "")) {
    h = `<div class="sp-empty-state">
      <div class="sp-empty-icon">&#9655;</div>
      <div class="sp-empty-text">No sessions${filterQuery ? " matching filter" : ""}</div>
      <button class="sp-create-btn" data-act="new-session">New Terminal</button>
      <button class="sp-create-btn agent" data-act="new-agent">Launch Agent</button>
    </div>`;
  }

  h += `<div class="sp-new-group" data-act="new-group">+ New Group</div>`;
  body.innerHTML = h;

  // Footer
  const total = sessions.length;
  const running = sessions.filter(s => s.status === "running" || s.status === "waiting").length;
  const totalCost = sessions.reduce((sum, s) => sum + (s.analytics?.estimatedCost || 0), 0);
  const totalTokens = sessions.reduce((sum, s) => sum + (s.analytics?.inputTokens || 0) + (s.analytics?.outputTokens || 0), 0);
  let ft = `${total} session${total !== 1 ? "s" : ""}`;
  if (running > 0) ft += ` &middot; <span class="sp-ft-active">${running} active</span>`;
  if (totalCost > 0) ft += ` &middot; <span class="sp-ft-cost">${fmtCost(totalCost)}</span>`;
  if (totalTokens > 0) ft += ` &middot; ${fmtTokens(totalTokens)} tok`;
  footer.innerHTML = ft;
}

function renderGroupNode(n) {
  const own = n.sessions.filter(matchesFilter);
  const all = subtreeSessions(n).filter(matchesFilter);
  if (filterQuery && all.length === 0) return ""; // folder has nothing matching

  const key = esc(n.path);
  // While filtering, open everything so matches are visible
  const isCollapsed = !filterQuery && collapsedGroups.has(n.path);
  const runningCount = all.filter(s => s.status === "running" || s.status === "waiting").length;
  const groupCost = all.reduce((sum, s) => sum + (s.analytics?.estimatedCost || 0), 0);
  const colorStyle = n.color ? ` style="border-left:2px solid ${esc(n.color)}"` : "";

  let h = `<div class="sp-group" data-group="${key}">`;
  h += `<div class="sp-group-header${isCollapsed ? " collapsed" : ""}" data-group-toggle="${key}"${colorStyle} title="${esc(displayPath(n.path))}">`;
  h += `<span class="sp-group-arrow">${isCollapsed ? "▶" : "▼"}</span>`;
  h += `<span class="sp-group-name">${esc(n.name)}</span>`;
  if (runningCount > 0) h += `<span class="sp-group-badge running">${runningCount}</span>`;
  if (groupCost > 0) h += `<span class="sp-group-cost">${fmtCost(groupCost)}</span>`;
  h += `<span class="sp-group-count">${all.length}</span>`;
  if (n.path) {
    h += `<button class="sp-group-action" data-act="new-subgroup" data-group="${key}" title="New subgroup">+</button>`;
    h += `<button class="sp-group-action" data-act="rename-group" data-group="${key}" title="Rename">&#9998;</button>`;
    h += `<button class="sp-group-action" data-act="delete-group" data-group="${key}" title="Delete group">&#10005;</button>`;
  }
  h += `</div>`;

  if (!isCollapsed) {
    h += `<div class="sp-group-body">`;
    for (const c of n.children) h += renderGroupNode(c);
    for (const s of own) {
      h += renderSessionCard(s);
      if (expandedSessions.has(s.id)) h += renderSessionDetail(s);
    }
    if (all.length === 0 && n.children.length === 0 && n.path) {
      h += `<div class="sp-empty">Drag sessions here or <span class="sp-link" data-act="new-in-group" data-group="${key}">create new</span></div>`;
    }
    h += `</div>`;
  }
  return h + `</div>`;
}

function closedMatches(a) {
  if (!filterQuery) return true;
  const q = filterQuery.toLowerCase();
  return [a.name, a.cwd, a.tool, a.group].some((v) => (v || "").toLowerCase().includes(q));
}
const isAgentEntry = (a) => !!a.claudeSessionId || (a.tool && a.tool !== "terminal");

function renderClosed() {
  const list = closedSessions.filter(closedMatches).slice(0, MAX_CLOSED_SHOWN);
  if (list.length === 0) return "";
  const open = closedOpen || !!filterQuery;
  let h = `<div class="sp-group sp-closed">`;
  h += `<div class="sp-group-header${open ? "" : " collapsed"}" data-act="toggle-closed">`;
  h += `<span class="sp-group-arrow">${open ? "▼" : "▶"}</span>`;
  h += `<span class="sp-group-name">Recently Closed</span>`;
  h += `<span class="sp-group-count">${list.length}</span></div>`;
  if (open) {
    h += `<div class="sp-group-body">`;
    for (const a of list) {
      const agent = isAgentEntry(a);
      h += `<div class="sp-session closed" data-closed="${a.closed}">`;
      h += `<div class="sp-status asleep"></div><div class="sp-info">`;
      h += `<div class="sp-name-row"><span class="sp-name">${esc(a.name || "Session")}</span></div>`;
      h += `<div class="sp-path">${esc(short(a.cwd))}${a.group ? " &middot; " + esc(displayPath(a.group)) : ""}</div>`;
      h += `<div class="sp-meta">`;
      if (a.tool && a.tool !== "terminal") h += `<span class="sp-badge ${esc(a.tool)}">${esc(a.tool)}</span>`;
      if (a.claudeSessionId) h += `<span class="sp-status-label" title="Claude conversation ${esc(a.claudeSessionId)}">${esc(a.claudeSessionId.slice(0, 8))}</span>`;
      h += `</div></div><div class="sp-right"><span class="sp-time">${ago(a.closed)}</span><div class="sp-session-actions">`;
      if (agent) h += `<button class="sp-c-btn agent-btn" data-act="resume-closed" data-closed="${a.closed}" title="${a.claudeSessionId ? "Resume this Claude conversation" : "Continue agent in this folder"}">&#9654;</button>`;
      h += `<button class="sp-c-btn" data-act="reopen-closed" data-closed="${a.closed}" title="Reopen terminal">&#8635;</button>`;
      h += `<button class="sp-c-btn" data-act="forget-closed" data-closed="${a.closed}" title="Remove from list">&#10005;</button>`;
      h += `</div></div></div>`;
    }
    h += `</div>`;
  }
  return h + `</div>`;
}

function resumeClosed(closed, agent) {
  const a = closedSessions.find((x) => x.closed === closed);
  if (a && _onResumeClosed) _onResumeClosed(a, { agent });
}

async function forgetClosed(closed) {
  closedSessions = closedSessions.filter((x) => x.closed !== closed);
  renderSessions();
  try {
    await fetch(api("/api/archive/remove"), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ closed }),
    });
  } catch {}
}

function renderSessionCard(s) {
  const isOpen = _isSessionOpen ? _isSessionOpen(s.id) : false;
  const isExpanded = expandedSessions.has(s.id);
  const toolClass = s.tool && s.tool !== "terminal" ? s.tool : "";
  const a = s.analytics || {};
  const uptime = s.created ? duration(Date.now() - s.created) : "";

  // A restored tab whose shell has not been started yet.
  const state = s.live === false ? "asleep" : (s.status || "idle");

  let h = `<div class="sp-session${isOpen ? " open" : ""}${isExpanded ? " expanded" : ""}" data-sid="${s.id}" draggable="true">`;
  h += `<div class="sp-status ${state}"></div>`;
  h += `<div class="sp-info">`;
  h += `<div class="sp-name-row">`;
  h += `<span class="sp-name">${esc(s.name || "Session " + s.id)}</span>`;
  if (s.clients > 0) h += `<span class="sp-viewers" title="${s.clients} connected">${s.clients}&#128065;</span>`;
  h += `</div>`;
  h += `<div class="sp-path">${esc(short(s.cwd))}</div>`;
  h += `<div class="sp-meta">`;
  if (toolClass) h += `<span class="sp-badge ${esc(toolClass)}">${esc(s.tool)}</span>`;
  h += `<span class="sp-status-label ${state}" title="${state === "asleep" ? "Shell starts when you open this tab" : ""}">${esc(state)}</span>`;
  if (a.estimatedCost > 0) h += `<span class="sp-cost">${fmtCost(a.estimatedCost)}</span>`;
  if (a.turnCount > 0) h += `<span class="sp-turns" title="AI turns">${a.turnCount}T</span>`;
  if (uptime) h += `<span class="sp-uptime">${uptime}</span>`;
  h += `</div>`;
  if (s.note) h += `<div class="sp-note-preview" title="${esc(s.note)}">${esc(s.note.slice(0, 50))}</div>`;
  h += `</div>`;
  h += `<div class="sp-right">`;
  h += `<span class="sp-time">${ago(s.lastActivity)}</span>`;
  h += `<div class="sp-session-actions">`;
  if (s.tool && s.tool !== "terminal") {
    h += `<button class="sp-s-btn agent-btn" data-act="continue-agent" data-sid="${s.id}" title="Continue Agent">&#9654;</button>`;
  }
  h += `<button class="sp-s-btn" data-act="toggle-detail" data-sid="${s.id}" title="Details">${isExpanded ? "\u25B2" : "\u25BC"}</button>`;
  h += `</div>`;
  h += `</div>`;
  h += `</div>`;
  return h;
}

function renderSessionDetail(s) {
  const a = s.analytics || {};
  const uptime = s.created ? duration(Date.now() - s.created) : "—";

  let h = `<div class="sp-detail" data-sid="${s.id}">`;

  // Stats grid
  h += `<div class="sp-detail-grid">`;
  h += `<div class="sp-detail-stat"><span class="sp-dl">Uptime</span><span class="sp-dv">${uptime}</span></div>`;
  h += `<div class="sp-detail-stat"><span class="sp-dl">Commands</span><span class="sp-dv">${a.commandCount || 0}</span></div>`;
  h += `<div class="sp-detail-stat"><span class="sp-dl">AI Turns</span><span class="sp-dv">${a.turnCount || 0}</span></div>`;
  h += `<div class="sp-detail-stat"><span class="sp-dl">Cost</span><span class="sp-dv sp-cost">${fmtCost(a.estimatedCost) || "—"}</span></div>`;
  h += `<div class="sp-detail-stat"><span class="sp-dl">In Tokens</span><span class="sp-dv">${fmtTokens(a.inputTokens)}</span></div>`;
  h += `<div class="sp-detail-stat"><span class="sp-dl">Out Tokens</span><span class="sp-dv">${fmtTokens(a.outputTokens)}</span></div>`;
  h += `</div>`;

  // Last command
  if (s.lastCommand) {
    h += `<div class="sp-detail-row"><span class="sp-dl">Last cmd</span><span class="sp-dv sp-cmd">${esc(s.lastCommand.slice(0, 80))}</span></div>`;
  }
  if (s.launchCommand) {
    h += `<div class="sp-detail-row"><span class="sp-dl">Launch</span><span class="sp-dv sp-cmd">${esc(s.launchCommand.slice(0, 80))}</span></div>`;
  }
  if (s.claudeSessionId) {
    h += `<div class="sp-detail-row" title="Continue Agent resumes this conversation; renaming the session renames it in Claude Code too"><span class="sp-dl">Claude</span><span class="sp-dv sp-cmd">${esc(s.claudeSessionId)}</span></div>`;
  }

  // Note (editable)
  h += `<div class="sp-detail-note">`;
  h += `<textarea class="sp-note-input" data-sid="${s.id}" placeholder="Add a note...">${esc(s.note || "")}</textarea>`;
  h += `</div>`;

  // Action buttons
  h += `<div class="sp-detail-actions">`;
  h += `<button class="sp-d-btn" data-act="rename-session" data-sid="${s.id}">Rename</button>`;
  h += `<button class="sp-d-btn" data-act="restart-session" data-sid="${s.id}">Restart</button>`;
  h += `<button class="sp-d-btn danger" data-act="delete-session" data-sid="${s.id}">Delete</button>`;
  h += `</div>`;

  h += `</div>`;
  return h;
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------
function handleClick(e) {
  // Recently Closed section
  if (e.target.closest("[data-act='toggle-closed']")) {
    closedOpen = !closedOpen;
    try { localStorage.setItem("tl-sp-closed-open", closedOpen ? "1" : "0"); } catch {}
    renderSessions();
    return;
  }
  const closedBtn = e.target.closest(".sp-c-btn");
  if (closedBtn) {
    const closed = Number(closedBtn.dataset.closed);
    if (closedBtn.dataset.act === "forget-closed") forgetClosed(closed);
    else resumeClosed(closed, closedBtn.dataset.act === "resume-closed");
    return;
  }
  if (e.target.closest(".sp-session.closed")) return;

  // Group toggle (but not on action buttons)
  const groupToggle = e.target.closest("[data-group-toggle]");
  if (groupToggle && !e.target.closest(".sp-group-action")) {
    const gName = groupToggle.dataset.groupToggle;
    if (collapsedGroups.has(gName)) collapsedGroups.delete(gName);
    else collapsedGroups.add(gName);
    saveCollapsed();
    renderSessions();
    return;
  }

  const groupAct = e.target.closest("[data-act='rename-group'], [data-act='delete-group'], [data-act='new-subgroup']");
  if (groupAct) {
    const path = groupAct.dataset.group;
    if (groupAct.dataset.act === "rename-group") askRenameGroup(path);
    else if (groupAct.dataset.act === "delete-group") confirmDeleteGroup(path);
    else askNewGroup(path);
    return;
  }

  // New session in specific group
  const newInGroupLink = e.target.closest("[data-act='new-in-group']");
  if (newInGroupLink) {
    const gName = newInGroupLink.dataset.group;
    if (_onCreateSession) _onCreateSession({ group: gName });
    return;
  }

  // Session-level action buttons
  const actionBtn = e.target.closest(".sp-s-btn, .sp-d-btn");
  if (actionBtn) {
    e.stopPropagation();
    const sid = parseInt(actionBtn.dataset.sid, 10);
    const act = actionBtn.dataset.act;
    if (act === "delete-session") {
      if (confirm("Delete session " + sid + "?")) {
        if (_onDeleteSession) _onDeleteSession(sid);
        fetch(api("/api/sessions/" + sid), { method: "DELETE" }).then(() => refresh()).catch(() => {});
      }
    } else if (act === "restart-session") {
      if (_onRestartSession) _onRestartSession(sid);
      fetch(api("/api/sessions/" + sid + "/restart"), { method: "POST" }).then(() => refresh()).catch(() => {});
    } else if (act === "continue-agent") {
      const meta = sessions.find(s => s.id === sid);
      if (_onOpenSession) _onOpenSession(sid, meta, { continueAgent: true });
    } else if (act === "toggle-detail") {
      if (expandedSessions.has(sid)) expandedSessions.delete(sid);
      else expandedSessions.add(sid);
      renderSessions();
    } else if (act === "rename-session") {
      askRenameSession(sid);
    }
    return;
  }

  // Session card click → open
  const sessionCard = e.target.closest(".sp-session");
  if (sessionCard && !e.target.closest(".sp-note-input, .sp-note-preview, textarea")) {
    const sid = parseInt(sessionCard.dataset.sid, 10);
    const meta = sessions.find(s => s.id === sid);
    if (_onOpenSession) _onOpenSession(sid, meta);
    return;
  }

  // Header/footer actions
  const actBtn = e.target.closest("[data-act]");
  if (actBtn) {
    const act = actBtn.dataset.act;
    if (act === "new-session") { if (_onCreateSession) _onCreateSession(); }
    else if (act === "new-agent") { if (_onLaunchAgent) _onLaunchAgent(); }
    else if (act === "refresh") { refresh(); }
    else if (act === "new-group") { askNewGroup(""); }
  }
}

function handleDblClick(e) {
  // Double-click session name to rename
  const nameEl = e.target.closest(".sp-name");
  if (nameEl) {
    const card = nameEl.closest(".sp-session");
    if (!card) return;
    askRenameSession(parseInt(card.dataset.sid, 10));
  }
}

async function askRenameSession(sid) {
  const s = sessions.find(s => s.id === sid);
  const newName = await askText("Session name", s?.name || "");
  if (newName == null) return;
  fetch(api("/api/sessions/" + sid), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: newName.trim() }),
  }).then(() => refresh()).catch(() => {});
}

function handleInput(e) {
  if (e.target.classList.contains("sp-search")) {
    filterQuery = e.target.value;
    renderSessions();
    return;
  }
  // Note textarea — save on input (debounced)
  if (e.target.classList.contains("sp-note-input")) {
    const sid = parseInt(e.target.dataset.sid, 10);
    clearTimeout(editingNote);
    editingNote = setTimeout(() => {
      const note = e.target.value;
      fetch(api("/api/sessions/" + sid), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note }),
      }).catch(() => {});
      const s = sessions.find(s => s.id === sid);
      if (s) s.note = note;
    }, 600);
  }
}

// ---------------------------------------------------------------------------
// Context menu (right-click)
// ---------------------------------------------------------------------------
function handleContextMenu(e) {
  if (!_showContextMenu) return;

  const closedCard = e.target.closest(".sp-session.closed");
  if (closedCard) {
    e.preventDefault();
    const closed = Number(closedCard.dataset.closed);
    const a = closedSessions.find((x) => x.closed === closed);
    if (!a) return;
    const items = [];
    if (isAgentEntry(a)) items.push({ label: a.claudeSessionId ? "Resume Claude Conversation" : "Continue Agent", action: "resume", handler() { resumeClosed(closed, true); } });
    items.push({ label: "Reopen Terminal", action: "reopen", handler() { resumeClosed(closed, false); } });
    if (a.claudeSessionId) items.push({ label: "Copy Claude Session ID", action: "copy", handler() { navigator.clipboard.writeText(a.claudeSessionId).catch(() => {}); } });
    items.push({ separator: true });
    items.push({ label: "Remove from List", action: "forget", handler() { forgetClosed(closed); } });
    _showContextMenu(e.clientX, e.clientY, items);
    return;
  }

  // Session card
  const sessionCard = e.target.closest(".sp-session");
  if (sessionCard) {
    e.preventDefault();
    const sid = parseInt(sessionCard.dataset.sid, 10);
    const s = sessions.find(s => s.id === sid);
    if (!s) return;

    const items = [
      { label: "Open", action: "open", handler() { if (_onOpenSession) _onOpenSession(sid, s); } },
    ];
    if (s.tool && s.tool !== "terminal") {
      items.push({ label: "Continue Agent", action: "continue", handler() { if (_onOpenSession) _onOpenSession(sid, s, { continueAgent: true }); } });
    }
    items.push({ separator: true });
    items.push({ label: "Rename", action: "rename", handler() { askRenameSession(sid); } });
    items.push(moveToGroupItem([sid]));
    items.push({ separator: true });
    items.push({ label: "Restart", action: "restart", handler() {
      fetch(api("/api/sessions/" + sid + "/restart"), { method: "POST" }).then(() => refresh()).catch(() => {});
    }});
    items.push({ label: "Delete", action: "delete", handler() {
      if (confirm("Delete session " + sid + "?")) {
        if (_onDeleteSession) _onDeleteSession(sid);
        fetch(api("/api/sessions/" + sid), { method: "DELETE" }).then(() => refresh()).catch(() => {});
      }
    }});
    _showContextMenu(e.clientX, e.clientY, items);
    return;
  }

  // Group header
  const groupHeader = e.target.closest(".sp-group-header");
  if (groupHeader) {
    e.preventDefault();
    const gPath = groupHeader.dataset.groupToggle;
    const g = groups.find(g => g.path === gPath);

    const items = [];
    if (g) {
      const all = subtreeSessions(g);
      items.push({ label: "New Terminal Here", action: "new", handler() { if (_onCreateSession) _onCreateSession({ group: g.path }); } });
      items.push({ label: "New Subgroup\u2026", action: "subgroup", handler() { askNewGroup(g.path); } });
      items.push({ label: "Rename\u2026", action: "rename", handler() { askRenameGroup(g.path); } });
      items.push({ label: "Move To", action: "move", submenu: moveGroupItems(g.path) });
      items.push({ label: "Color", action: "color", submenu: GROUP_COLORS.map((c, i) => ({
        label: (c === (g.color || "") ? "\u2713 " : "") + COLOR_NAMES[i], action: "color-" + i, handler() { setGroupColor(g.path, c); },
      })) });
      items.push({ separator: true });
      if (all.length > 0) {
        items.push({ label: "Restart All (" + all.length + ")", action: "restart-all", handler() { batchRestart(g.path); } });
        items.push({ label: "Delete All Sessions (" + all.length + ")", action: "delete-all", handler() { batchDelete(g.path); } });
        items.push({ separator: true });
      }
      items.push({ label: "Delete Group", action: "dissolve", handler() { confirmDeleteGroup(g.path); } });
    } else {
      items.push({ label: "New Terminal Here", action: "new", handler() { if (_onCreateSession) _onCreateSession(); } });
      items.push({ label: "Launch Agent Here", action: "agent", handler() { if (_onLaunchAgent) _onLaunchAgent(); } });
    }
    _showContextMenu(e.clientX, e.clientY, items);
  }
}

// ---------------------------------------------------------------------------
// Drag-and-drop
// ---------------------------------------------------------------------------
function handleDragStart(e) {
  const card = e.target.closest(".sp-session");
  if (!card) return;
  dragSessionId = parseInt(card.dataset.sid, 10);
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", String(dragSessionId));
  // Also set session data for workspace drop targets
  const sess = sessions.find(s => s.id === dragSessionId);
  if (sess) {
    e.dataTransfer.setData("text/agenv-session", JSON.stringify({
      id: sess.id, name: sess.name, cwd: sess.cwd, tool: sess.tool, status: sess.status,
    }));
  }
  card.classList.add("dragging");
}

function handleDragOver(e) {
  const groupEl = e.target.closest(".sp-group");
  if (!groupEl || groupEl.classList.contains("sp-closed") || dragSessionId == null) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  const header = groupEl.querySelector(".sp-group-header");
  if (header && dragOverGroup !== groupEl.dataset.group) {
    panelEl.querySelectorAll(".sp-group-header.drag-over").forEach(el => el.classList.remove("drag-over"));
    header.classList.add("drag-over");
    dragOverGroup = groupEl.dataset.group;
  }
}

function handleDragLeave(e) {
  if (!e.target.closest(".sp-group")) {
    panelEl.querySelectorAll(".sp-group-header.drag-over").forEach(el => el.classList.remove("drag-over"));
    dragOverGroup = null;
  }
}

function handleDrop(e) {
  e.preventDefault();
  panelEl.querySelectorAll(".sp-group-header.drag-over").forEach(el => el.classList.remove("drag-over"));
  panelEl.querySelectorAll(".sp-session.dragging").forEach(el => el.classList.remove("dragging"));
  if (dragSessionId != null && dragOverGroup != null) {
    moveSessionsToGroup([dragSessionId], dragOverGroup);
  }
  dragSessionId = null;
  dragOverGroup = null;
}

function handleDragEnd() {
  panelEl.querySelectorAll(".sp-group-header.drag-over").forEach(el => el.classList.remove("drag-over"));
  panelEl.querySelectorAll(".sp-session.dragging").forEach(el => el.classList.remove("dragging"));
  dragSessionId = null;
  dragOverGroup = null;
}

// ---------------------------------------------------------------------------
// Group CRUD
// ---------------------------------------------------------------------------
async function moveSessionsToGroup(sessionIds, path) {
  for (const id of sessionIds) {
    try {
      await fetch(api("/api/sessions/" + id), {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ group: path }),
      });
      const s = sessions.find(s => s.id === id);
      if (s) s.group = path;
    } catch {}
  }
  await refresh();
}

/** Asks for a name; "a/b/c" creates nested folders. Resolves to the new path or null. */
async function askNewGroup(parent, title) {
  const name = await askText(title || (parent ? `New group inside "${displayPath(parent)}"` : "New group"), "", {
    hint: "Use / to nest, e.g. project1/marketing/seo", placeholder: "Group name", okLabel: "Create",
  });
  if (name == null) return null;
  const rel = name.split("/").map(s => s.trim()).filter(Boolean).join("/");
  if (!rel) return null;
  const path = parent ? parent + "/" + rel : rel;
  if (!groupDefs.some(g => g.path === path)) {
    groupDefs = groupDefs.concat({ path, color: "" });
    await saveGroupDefs();
  }
  collapsedGroups.delete(parent);
  saveCollapsed();
  await refresh();
  return path;
}

async function askRenameGroup(path) {
  const parent = parentPath(path);
  const name = await askText(`Rename "${displayPath(path)}"`, leafName(path), { okLabel: "Rename" });
  if (name == null || !name.trim() || name.trim() === leafName(path)) return;
  const to = parent ? parent + "/" + name.trim() : name.trim();
  remapCollapsed(path, to);
  await groupRequest("/api/session-groups/rename", { from: path, to });
}

function moveGroupTo(path, newParent) {
  const to = newParent ? newParent + "/" + leafName(path) : leafName(path);
  if (to === path) return;
  remapCollapsed(path, to);
  groupRequest("/api/session-groups/rename", { from: path, to });
}

function confirmDeleteGroup(path) {
  const parent = parentPath(path);
  const n = groups.find(g => g.path === path);
  const count = n ? subtreeSessions(n).length : 0;
  const where = parent ? `"${displayPath(parent)}"` : "Ungrouped";
  const msg = count
    ? `Delete group "${displayPath(path)}" and its subgroups? Its ${count} session(s) move to ${where}.`
    : `Delete group "${displayPath(path)}"?`;
  if (!confirm(msg)) return;
  for (const p of [...collapsedGroups]) if (inGroup(p, path)) collapsedGroups.delete(p);
  saveCollapsed();
  groupRequest("/api/session-groups/delete", { path });
}

function remapCollapsed(from, to) {
  for (const p of [...collapsedGroups]) {
    if (inGroup(p, from)) { collapsedGroups.delete(p); collapsedGroups.add(to + p.slice(from.length)); }
  }
  saveCollapsed();
}

function setGroupColor(path, color) {
  const def = groupDefs.find(g => g.path === path);
  if (def) def.color = color;
  else groupDefs = groupDefs.concat({ path, color });
  saveGroupDefs().then(() => { buildGroups(); renderSessions(); });
}

async function batchRestart(path) {
  const n = groups.find(g => g.path === path);
  const toRestart = n ? subtreeSessions(n) : [];
  if (!confirm(`Restart ${toRestart.length} sessions in "${displayPath(path)}"?`)) return;
  for (const s of toRestart) {
    try {
      await fetch(api("/api/sessions/" + s.id + "/restart"), { method: "POST" });
    } catch {}
  }
  refresh();
}

async function batchDelete(path) {
  const n = groups.find(g => g.path === path);
  const toDelete = n ? subtreeSessions(n) : [];
  if (!confirm(`Delete ${toDelete.length} sessions in "${displayPath(path)}"? This cannot be undone.`)) return;
  for (const s of toDelete) {
    if (_onDeleteSession) _onDeleteSession(s.id);
    try {
      await fetch(api("/api/sessions/" + s.id), { method: "DELETE" });
    } catch {}
  }
  refresh();
}

// ---------------------------------------------------------------------------
// Menus shared with the pane and tab context menus (app.js)
// ---------------------------------------------------------------------------
const indent = (depth) => "&nbsp;".repeat(depth * 3);

/** Submenu items that move the given sessions into a folder. */
function moveToGroupItems(sessionIds) {
  const current = new Set(sessionIds.map(id => sessions.find(s => s.id === id)?.group || ""));
  const mark = (p) => current.size === 1 && current.has(p) ? "✓ " : "";
  const items = [{ label: mark("") + "Ungrouped", action: "ungrouped", handler() { moveSessionsToGroup(sessionIds, ""); } }];
  const folders = flatFolders();
  if (folders.length) items.push({ separator: true });
  for (const f of folders) {
    items.push({ label: indent(f.depth) + mark(f.path) + esc(f.name), action: "g:" + f.path, handler() { moveSessionsToGroup(sessionIds, f.path); } });
  }
  items.push({ separator: true });
  items.push({ label: "New Group…", action: "new-group", async handler() {
    const path = await askNewGroup("", "Move to new group");
    if (path) moveSessionsToGroup(sessionIds, path);
  }});
  return items;
}

/** A complete "Move to Group" menu entry for one or more sessions. */
export function moveToGroupItem(sessionIds) {
  return { label: sessionIds.length > 1 ? `Move ${sessionIds.length} Sessions to Group` : "Move to Group", action: "move-to-group", submenu: moveToGroupItems(sessionIds) };
}

/** Submenu for moving a folder under another folder (or to the top level). */
function moveGroupItems(path) {
  const items = [{ label: "Top Level", action: "top", disabled: !parentPath(path), handler() { moveGroupTo(path, ""); } }];
  const targets = flatFolders().filter(f => !inGroup(f.path, path));
  if (targets.length) items.push({ separator: true });
  for (const f of targets) {
    items.push({ label: indent(f.depth) + esc(f.name), action: "t:" + f.path, disabled: f.path === parentPath(path), handler() { moveGroupTo(path, f.path); } });
  }
  return items;
}
