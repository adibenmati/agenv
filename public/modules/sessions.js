// sessions.js — Session management sidebar panel (agent-deck style)
// Shows all sessions grouped by user-defined groups, with live status,
// agent badges, costs, durations, expandable details, and context menus.

import { api, esc, ago, short, fname } from "./util.js";

let panelEl = null;
let _onOpenSession = null;    // (sessionId, meta, opts?) => {}
let _onCreateSession = null;  // (opts?) => {}
let _onLaunchAgent = null;    // (agent?) => {}
let _onDeleteSession = null;  // (sessionId) => {}
let _onRestartSession = null; // (sessionId) => {}
let _getAgentCommand = null;  // () => string
let _isSessionOpen = null;    // (sessionId) => boolean
let _showContextMenu = null;  // (x, y, items) => {}

let sessions = [];
let groups = [];          // [{ name, collapsed, color, sessions }]
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

function loadPersistedGroups() {
  try { return JSON.parse(localStorage.getItem("tl-sp-groups") || "[]"); } catch { return []; }
}
function savePersistedGroups() {
  // Save user-created group names + colors (empty groups survive refresh)
  const data = groups.filter(g => g.name).map(g => ({ name: g.name, color: g.color || "" }));
  localStorage.setItem("tl-sp-groups", JSON.stringify(data));
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

export async function refresh() {
  try {
    const resp = await fetch(api("/api/sessions"));
    if (!resp.ok) return;
    sessions = await resp.json();
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
// Group logic — merges server data with persisted empty groups
// ---------------------------------------------------------------------------
function buildGroups() {
  const groupMap = new Map(); // name -> [session]
  for (const s of sessions) {
    const g = s.group || "";
    if (!groupMap.has(g)) groupMap.set(g, []);
    groupMap.get(g).push(s);
  }

  // Merge persisted groups (keeps empty groups alive)
  const persisted = loadPersistedGroups();
  for (const pg of persisted) {
    if (!groupMap.has(pg.name)) groupMap.set(pg.name, []);
  }

  // Build color map from persisted
  const colorMap = new Map();
  for (const pg of persisted) colorMap.set(pg.name, pg.color || "");

  // Sort: named groups alphabetically, ungrouped ("") last
  const names = [...groupMap.keys()].sort((a, b) => {
    if (!a) return 1;
    if (!b) return -1;
    return a.localeCompare(b);
  });

  groups = [];
  for (const name of names) {
    const sArr = groupMap.get(name);
    sArr.sort((a, b) => {
      const aw = statusWeight(a.status);
      const bw = statusWeight(b.status);
      if (aw !== bw) return bw - aw;
      return (b.lastActivity || 0) - (a.lastActivity || 0);
    });
    groups.push({
      name,
      collapsed: collapsedGroups.has(name),
      color: colorMap.get(name) || "",
      sessions: sArr,
    });
  }
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

  for (const g of groups) {
    const filtered = g.sessions.filter(matchesFilter);
    if (filtered.length === 0 && filterQuery && !g.name) continue; // hide empty ungrouped when filtering

    const groupName = g.name || "Ungrouped";
    const groupKey = g.name;
    const isCollapsed = g.collapsed;
    const runningCount = filtered.filter(s => s.status === "running" || s.status === "waiting").length;
    const groupCost = filtered.reduce((sum, s) => sum + (s.analytics?.estimatedCost || 0), 0);
    const colorStyle = g.color ? ` style="border-left:2px solid ${g.color}"` : "";

    h += `<div class="sp-group" data-group="${esc(groupKey)}">`;
    h += `<div class="sp-group-header${isCollapsed ? " collapsed" : ""}" data-group-toggle="${esc(groupKey)}"${colorStyle}>`;
    h += `<span class="sp-group-arrow">${isCollapsed ? "\u25B6" : "\u25BC"}</span>`;
    h += `<span class="sp-group-name">${esc(groupName)}</span>`;
    if (runningCount > 0) {
      h += `<span class="sp-group-badge running">${runningCount}</span>`;
    }
    if (groupCost > 0) {
      h += `<span class="sp-group-cost">${fmtCost(groupCost)}</span>`;
    }
    h += `<span class="sp-group-count">${filtered.length}</span>`;
    if (g.name) {
      h += `<button class="sp-group-action" data-act="rename-group" data-group="${esc(groupKey)}" title="Rename">&#9998;</button>`;
      h += `<button class="sp-group-action" data-act="delete-group" data-group="${esc(groupKey)}" title="Ungroup all">&#10005;</button>`;
    }
    h += `</div>`;

    if (!isCollapsed) {
      h += `<div class="sp-group-body">`;
      for (const s of filtered) {
        h += renderSessionCard(s);
        if (expandedSessions.has(s.id)) h += renderSessionDetail(s);
      }
      if (filtered.length === 0 && g.name) {
        h += `<div class="sp-empty">Drag sessions here or <span class="sp-link" data-act="new-in-group" data-group="${esc(groupKey)}">create new</span></div>`;
      } else if (filtered.length === 0) {
        h += `<div class="sp-empty">No sessions</div>`;
      }
      h += `</div>`;
    }
    h += `</div>`;
  }

  if (groups.length === 0 || (filterQuery && h === "")) {
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

function renderSessionCard(s) {
  const isOpen = _isSessionOpen ? _isSessionOpen(s.id) : false;
  const isExpanded = expandedSessions.has(s.id);
  const toolClass = s.tool && s.tool !== "terminal" ? s.tool : "";
  const a = s.analytics || {};
  const uptime = s.created ? duration(Date.now() - s.created) : "";

  let h = `<div class="sp-session${isOpen ? " open" : ""}${isExpanded ? " expanded" : ""}" data-sid="${s.id}" draggable="true">`;
  h += `<div class="sp-status ${s.status || "idle"}"></div>`;
  h += `<div class="sp-info">`;
  h += `<div class="sp-name-row">`;
  h += `<span class="sp-name">${esc(s.name || "Session " + s.id)}</span>`;
  if (s.clients > 0) h += `<span class="sp-viewers" title="${s.clients} connected">${s.clients}&#128065;</span>`;
  h += `</div>`;
  h += `<div class="sp-path">${esc(short(s.cwd))}</div>`;
  h += `<div class="sp-meta">`;
  if (toolClass) h += `<span class="sp-badge ${esc(toolClass)}">${esc(s.tool)}</span>`;
  h += `<span class="sp-status-label ${s.status || "idle"}">${esc(s.status || "idle")}</span>`;
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
  // Group toggle (but not on action buttons)
  const groupToggle = e.target.closest("[data-group-toggle]");
  if (groupToggle && !e.target.closest(".sp-group-action")) {
    const gName = groupToggle.dataset.groupToggle;
    if (collapsedGroups.has(gName)) collapsedGroups.delete(gName);
    else collapsedGroups.add(gName);
    saveCollapsed();
    const g = groups.find(g => g.name === gName);
    if (g) g.collapsed = collapsedGroups.has(gName);
    renderSessions();
    return;
  }

  // Group rename
  const renameGroupBtn = e.target.closest("[data-act='rename-group']");
  if (renameGroupBtn) {
    const oldName = renameGroupBtn.dataset.group;
    const newName = prompt("Rename group:", oldName);
    if (newName != null && newName.trim() && newName.trim() !== oldName) {
      renameGroup(oldName, newName.trim());
    }
    return;
  }

  // Group delete
  const deleteGroupBtn = e.target.closest("[data-act='delete-group']");
  if (deleteGroupBtn) {
    const gName = deleteGroupBtn.dataset.group;
    if (confirm(`Ungroup all sessions from "${gName}"?`)) dissolveGroup(gName);
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
      const s = sessions.find(s => s.id === sid);
      const newName = prompt("Session name:", s?.name || "");
      if (newName != null) {
        fetch(api("/api/sessions/" + sid), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: newName.trim() }),
        }).then(() => refresh()).catch(() => {});
      }
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
    else if (act === "new-group") {
      const name = prompt("New group name:");
      if (name && name.trim()) createGroup(name.trim());
    }
  }
}

function handleDblClick(e) {
  // Double-click session name to rename
  const nameEl = e.target.closest(".sp-name");
  if (nameEl) {
    const card = nameEl.closest(".sp-session");
    if (!card) return;
    const sid = parseInt(card.dataset.sid, 10);
    const s = sessions.find(s => s.id === sid);
    const newName = prompt("Session name:", s?.name || "");
    if (newName != null) {
      fetch(api("/api/sessions/" + sid), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim() }),
      }).then(() => refresh()).catch(() => {});
    }
  }
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

  // Session card
  const sessionCard = e.target.closest(".sp-session");
  if (sessionCard) {
    e.preventDefault();
    const sid = parseInt(sessionCard.dataset.sid, 10);
    const s = sessions.find(s => s.id === sid);
    if (!s) return;

    const groupNames = groups.filter(g => g.name).map(g => g.name);
    const moveItems = groupNames
      .filter(gn => gn !== (s.group || ""))
      .map(gn => ({
        label: gn, action: "move-to-" + gn, handler() { moveSessionToGroup(sid, gn); }
      }));
    if (s.group) {
      moveItems.push({ label: "Ungrouped", action: "move-ungrouped", handler() { moveSessionToGroup(sid, ""); } });
    }

    const items = [
      { label: "Open", action: "open", handler() { if (_onOpenSession) _onOpenSession(sid, s); } },
    ];
    if (s.tool && s.tool !== "terminal") {
      items.push({ label: "Continue Agent", action: "continue", handler() { if (_onOpenSession) _onOpenSession(sid, s, { continueAgent: true }); } });
    }
    items.push({ separator: true });
    items.push({ label: "Rename", action: "rename", handler() {
      const name = prompt("Session name:", s.name || "");
      if (name != null) {
        fetch(api("/api/sessions/" + sid), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim() }) }).then(() => refresh()).catch(() => {});
      }
    }});
    if (moveItems.length > 0) {
      items.push({ separator: true });
      for (const mi of moveItems) items.push(mi);
    }
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
    const gName = groupHeader.dataset.groupToggle;
    const g = groups.find(g => g.name === gName);
    if (!g) return;

    const items = [];
    if (g.name) {
      items.push({ label: "Rename Group", action: "rename", handler() {
        const n = prompt("Rename group:", g.name);
        if (n != null && n.trim() && n.trim() !== g.name) renameGroup(g.name, n.trim());
      }});

      // Color submenu
      items.push({ separator: true });
      for (let i = 0; i < GROUP_COLORS.length; i++) {
        const c = GROUP_COLORS[i];
        const label = (c === (g.color || "") ? "\u2713 " : "") + COLOR_NAMES[i];
        items.push({ label, action: "color-" + i, handler() { setGroupColor(g.name, c); } });
      }

      items.push({ separator: true });
      if (g.sessions.length > 0) {
        items.push({ label: "Restart All (" + g.sessions.length + ")", action: "restart-all", handler() { batchRestart(g.name); } });
        items.push({ label: "Delete All (" + g.sessions.length + ")", action: "delete-all", handler() { batchDelete(g.name); } });
        items.push({ separator: true });
      }
      items.push({ label: "Dissolve Group", action: "dissolve", handler() {
        if (confirm(`Ungroup all sessions from "${g.name}"?`)) dissolveGroup(g.name);
      }});
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
  if (!groupEl || dragSessionId == null) return;
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
    moveSessionToGroup(dragSessionId, dragOverGroup);
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
async function moveSessionToGroup(sessionId, groupName) {
  try {
    await fetch(api("/api/sessions/" + sessionId), {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group: groupName }),
    });
    const s = sessions.find(s => s.id === sessionId);
    if (s) s.group = groupName;
    buildGroups();
    savePersistedGroups();
    renderSessions();
  } catch {}
}

async function renameGroup(oldName, newName) {
  const toUpdate = sessions.filter(s => (s.group || "") === oldName);
  for (const s of toUpdate) {
    try {
      await fetch(api("/api/sessions/" + s.id), {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ group: newName }),
      });
      s.group = newName;
    } catch {}
  }
  if (collapsedGroups.has(oldName)) {
    collapsedGroups.delete(oldName);
    collapsedGroups.add(newName);
    saveCollapsed();
  }
  // Update persisted group entry
  const persisted = loadPersistedGroups();
  const pg = persisted.find(p => p.name === oldName);
  if (pg) pg.name = newName;
  else persisted.push({ name: newName, color: "" });
  localStorage.setItem("tl-sp-groups", JSON.stringify(persisted));

  buildGroups();
  savePersistedGroups();
  renderSessions();
}

async function dissolveGroup(groupName) {
  const toUpdate = sessions.filter(s => (s.group || "") === groupName);
  for (const s of toUpdate) {
    try {
      await fetch(api("/api/sessions/" + s.id), {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ group: "" }),
      });
      s.group = "";
    } catch {}
  }
  collapsedGroups.delete(groupName);
  saveCollapsed();
  // Remove from persisted
  const persisted = loadPersistedGroups().filter(p => p.name !== groupName);
  localStorage.setItem("tl-sp-groups", JSON.stringify(persisted));

  buildGroups();
  renderSessions();
}

function createGroup(name) {
  if (groups.find(g => g.name === name)) return;
  // Persist immediately so it survives poll refresh
  const persisted = loadPersistedGroups();
  if (!persisted.find(p => p.name === name)) {
    persisted.push({ name, color: "" });
    localStorage.setItem("tl-sp-groups", JSON.stringify(persisted));
  }
  groups.push({ name, collapsed: false, color: "", sessions: [] });
  savePersistedGroups();
  renderSessions();
}

function setGroupColor(groupName, color) {
  const g = groups.find(g => g.name === groupName);
  if (g) g.color = color;
  savePersistedGroups();
  renderSessions();
}

async function batchRestart(groupName) {
  const toRestart = sessions.filter(s => (s.group || "") === groupName);
  if (!confirm(`Restart ${toRestart.length} sessions in "${groupName}"?`)) return;
  for (const s of toRestart) {
    try {
      await fetch(api("/api/sessions/" + s.id + "/restart"), { method: "POST" });
    } catch {}
  }
  refresh();
}

async function batchDelete(groupName) {
  const toDelete = sessions.filter(s => (s.group || "") === groupName);
  if (!confirm(`Delete ${toDelete.length} sessions in "${groupName}"? This cannot be undone.`)) return;
  for (const s of toDelete) {
    if (_onDeleteSession) _onDeleteSession(s.id);
    try {
      await fetch(api("/api/sessions/" + s.id), { method: "DELETE" });
    } catch {}
  }
  refresh();
}
