// tabs.js — workspace/tab management
//
// Each tab is a Workspace with its own split-pane tree.

import { uid, tIcon, fname, esc, api } from "./util.js";
import { makeLeaf, allLeaves, firstLeaf, leafCount, renderTree, splitNode, closeNode, initDividerResize, findNeighborPane, findLeafByPane } from "./layout.js";
import { createTerminal, destroyTerminal, focusTerminal, fitTerminal, fitAllTerminals, detachTerminal, reattachTerminal, getTerminal } from "./terminal.js";

// Simple error display
function showError(msg) {
  const tc = document.getElementById("toast-container");
  if (!tc) { alert(msg); return; }
  const t = document.createElement("div");
  t.className = "toast toast-error";
  t.innerHTML = `<div class="toast-body"><span class="toast-msg">${msg}</span></div>`;
  t.addEventListener("click", () => t.remove());
  tc.appendChild(t);
  setTimeout(() => { if (t.parentNode) t.remove(); }, 5000);
}

// State
const workspaces = [];
let activeWsId = null;
let activePaneId = null;

// DOM references (set via init)
let tabBarEl = null;
let workspaceAreaEl = null;
let termHolderEl = null;
let statusBarUpdater = null;

export function init(els) {
  tabBarEl = els.tabBar;
  workspaceAreaEl = els.workspaceArea;
  termHolderEl = els.termHolder;
  statusBarUpdater = els.onStatusUpdate || null;

  initDividerResize(workspaceAreaEl, () => {
    const ws = getActiveWorkspace();
    return ws ? ws.rootNode : null;
  }, () => {
    requestAnimationFrame(() => fitAllTerminals());
  });
}

// ---------------------------------------------------------------------------
// Workspace layout persistence
// ---------------------------------------------------------------------------

function serializeLayout() {
  return workspaces.map(ws => {
    if (ws.type === "editor") {
      return { type: "editor", name: ws.name, filePath: ws.filePath, isActive: ws.id === activeWsId };
    }
    return {
      name: ws.name,
      rootNode: serializeNode(ws.rootNode),
      activePaneId: ws.activePaneId,
      isActive: ws.id === activeWsId,
    };
  });
}

function serializeNode(node) {
  if (!node) return null;
  if (node.type === "leaf") {
    return { type: "leaf", sessionId: node.sessionId };
  }
  return {
    type: "split", direction: node.direction, ratio: node.ratio,
    children: node.children.map(c => serializeNode(c)),
  };
}

let _saveTimer = null;
function scheduleSaveLayout() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    const layout = serializeLayout();
    fetch(api("/api/workspace-layout"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ layout }),
    }).catch(() => {});
  }, 1000);
}

/**
 * Restore workspace layout from server-provided data.
 * Returns true if layout was restored, false if nothing to restore.
 */
export async function restoreLayout(layout) {
  if (!layout || !Array.isArray(layout) || layout.length === 0) return false;

  let activeIndex = 0;
  for (let i = 0; i < layout.length; i++) {
    const saved = layout[i];

    // Restore editor workspaces
    if (saved.type === "editor" && saved.filePath) {
      const ws = {
        id: uid("ws"),
        name: saved.name || saved.filePath.split("/").pop() || "file",
        type: "editor",
        filePath: saved.filePath,
        rootNode: null,
        activePaneId: null,
      };
      editorStates.set(ws.id, { filePath: saved.filePath, content: null, editContent: null, dirty: false, view: "code", diff: null, size: 0 });
      workspaces.push(ws);
      if (saved.isActive) activeIndex = workspaces.length - 1;
      continue;
    }

    if (!saved.rootNode) continue;

    const panes = collectSessionIds(saved.rootNode);
    if (panes.length === 0) continue;

    const rootNode = rebuildNode(saved.rootNode);
    const first = firstLeaf(rootNode);
    const ws = {
      id: uid("ws"),
      name: saved.name || "Terminal",
      rootNode,
      activePaneId: first ? first.paneId : null,
    };
    workspaces.push(ws);
    if (saved.isActive) activeIndex = workspaces.length - 1;
  }

  if (workspaces.length === 0) return false;

  renderTabBar();
  switchWorkspace(workspaces[activeIndex].id);
  return true;
}

function collectSessionIds(node) {
  if (!node) return [];
  if (node.type === "leaf") return [node.sessionId];
  return (node.children || []).flatMap(c => collectSessionIds(c));
}

function rebuildNode(saved) {
  if (!saved) return null;
  if (saved.type === "leaf") {
    const paneId = uid("pane");
    return makeLeaf(paneId, saved.sessionId);
  }
  return {
    type: "split",
    id: uid("split"),
    direction: saved.direction || "h",
    ratio: saved.ratio || 0.5,
    children: (saved.children || []).map(c => rebuildNode(c)),
  };
}

function getActiveWorkspace() {
  return workspaces.find((w) => w.id === activeWsId) || null;
}

// Session metadata cache: sessionId -> { name, cwd, tool, status, group, note, analytics }
const sessionMeta = new Map();

// Session colors — deterministic HSL per session ID using golden ratio spread
const sessionColors = new Map();

function getSessionColor(sessionId) {
  if (sessionColors.has(sessionId)) return sessionColors.get(sessionId);
  // Use golden ratio to spread hues evenly
  const hue = ((sessionId * 137.508) % 360 + 360) % 360;
  const color = `hsl(${Math.round(hue)}, 65%, 55%)`;
  sessionColors.set(sessionId, color);
  return color;
}

export { getSessionColor };

// ---------------------------------------------------------------------------
// Editor workspace support — open files as tabs like VS Code
// ---------------------------------------------------------------------------

const editorStates = new Map(); // wsId -> { filePath, content, dirty, view, diff, size, editContent }

const _langMap = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript", py: "python", rb: "ruby", go: "go",
  rs: "rust", java: "java", kt: "kotlin", c: "c", h: "c", cpp: "cpp",
  cc: "cpp", cs: "csharp", html: "xml", htm: "xml", xml: "xml", svg: "xml",
  css: "css", scss: "scss", less: "less", json: "json", yaml: "yaml",
  yml: "yaml", toml: "ini", md: "markdown", sh: "bash", bash: "bash",
  zsh: "bash", ps1: "powershell", sql: "sql", dockerfile: "dockerfile",
  makefile: "makefile", php: "php", swift: "swift", lua: "lua", r: "r",
  vue: "xml", svelte: "xml",
};

function _getLang(name) {
  const base = name.toLowerCase();
  if (base === "makefile" || base === "dockerfile") return _langMap[base] || "plaintext";
  const ext = (base.split(".").pop() || "");
  return _langMap[ext] || "plaintext";
}

// Extension colors for editor tab dots
const _extColors = {
  js: "#e8d44d", jsx: "#e8d44d", ts: "#3178c6", tsx: "#3178c6",
  py: "#3572a5", rb: "#cc342d", go: "#00add8", rs: "#dea584",
  java: "#b07219", c: "#555555", cpp: "#f34b7d", cs: "#178600",
  html: "#e34c26", css: "#563d7c", scss: "#c6538c", json: "#e8d44d",
  md: "#083fa1", sh: "#89e051", yaml: "#cb171e", xml: "#0060ac",
  sql: "#e38c00", vue: "#42b883", svelte: "#ff3e00", php: "#4f5d95",
};

function _formatSize(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

export function setSessionMeta(id, meta) {
  sessionMeta.set(id, { ...(sessionMeta.get(id) || {}), ...meta });
}

export function getSessionMeta(id) {
  return sessionMeta.get(id) || {};
}

// ---------------------------------------------------------------------------
// Workspace CRUD
// ---------------------------------------------------------------------------

export async function createWorkspace(name, sessionId, meta) {
  if (sessionId == null) {
    let resp;
    try {
      resp = await fetch(api("/api/sessions"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: meta?.cwd }),
      });
    } catch (e) {
      showError("Network error: " + e.message);
      return null;
    }
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: "Server error " + resp.status }));
      showError(err.error || "Failed to create session");
      return null;
    }
    const data = await resp.json();
    sessionId = data.id;
    setSessionMeta(sessionId, { name: data.name || "", cwd: data.cwd || "", tool: data.tool || "terminal", status: data.status || "idle", group: data.group || "" });
  }

  const paneId = uid("pane");
  const ws = {
    id: uid("ws"),
    name: name || "Terminal",
    rootNode: makeLeaf(paneId, sessionId),
    activePaneId: paneId,
  };
  workspaces.push(ws);
  renderTabBar();
  switchWorkspace(ws.id);
  scheduleSaveLayout();
  return ws;
}

export function switchWorkspace(wsId) {
  if (activeWsId === wsId) return;

  if (activeWsId) {
    const old = getActiveWorkspace();
    if (old && old.type !== "editor" && old.rootNode) {
      const leaves = allLeaves(old.rootNode);
      for (const leaf of leaves) {
        detachTerminal(leaf.paneId, termHolderEl);
      }
    }
  }

  activeWsId = wsId;
  const ws = getActiveWorkspace();
  if (!ws) return;

  // Editor workspace — render file content instead of terminal
  if (ws.type === "editor") {
    workspaceAreaEl.innerHTML = "";
    renderFileEditor(ws);
    activePaneId = null;
    renderTabBar();
    updateStatus();
    return;
  }

  const mounts = renderTree(ws.rootNode, workspaceAreaEl);

  for (const leaf of allLeaves(ws.rootNode)) {
    const mount = mounts.get(leaf.paneId);
    if (!mount) continue;

    const existing = getTerminal(leaf.paneId);
    if (existing) {
      reattachTerminal(leaf.paneId, mount.mountEl);
    } else {
      createTerminal(leaf.paneId, leaf.sessionId, mount.mountEl);
    }

    updatePaneHeader(leaf.paneId, mount.headerEl, leaf.sessionId);
  }

  activePaneId = ws.activePaneId || firstLeaf(ws.rootNode)?.paneId;
  updatePaneFocus();
  renderTabBar();

  requestAnimationFrame(() => fitAllTerminals());
  updateStatus();
}

export function switchToTab(index) {
  if (index >= 0 && index < workspaces.length) {
    switchWorkspace(workspaces[index].id);
  }
}

export async function closeWorkspace(wsId) {
  const idx = workspaces.findIndex((w) => w.id === wsId);
  if (idx === -1) return;
  if (workspaces.length <= 1) return;

  const ws = workspaces[idx];

  if (ws.type === "editor") {
    editorStates.delete(ws.id);
  } else {
    // Disconnect terminals but do NOT delete server-side sessions.
    for (const leaf of allLeaves(ws.rootNode)) {
      destroyTerminal(leaf.paneId);
    }
  }

  workspaces.splice(idx, 1);

  if (activeWsId === wsId) {
    const newIdx = Math.min(idx, workspaces.length - 1);
    activeWsId = null;
    switchWorkspace(workspaces[newIdx].id);
  }
  renderTabBar();
  scheduleSaveLayout();
}

// ---------------------------------------------------------------------------
// Split / close panes
// ---------------------------------------------------------------------------

export async function splitActivePane(direction) {
  const ws = getActiveWorkspace();
  if (!ws || !activePaneId) return;
  if (leafCount(ws.rootNode) >= 6) return;

  const currentMeta = getSessionMeta(getTerminal(activePaneId)?.sessionId);
  let resp;
  try {
    resp = await fetch(api("/api/sessions"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: currentMeta?.cwd }),
    });
  } catch (e) {
    showError("Network error: " + e.message);
    return;
  }
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: "Server error" }));
    showError(err.error || "Failed to create session");
    return;
  }
  const data = await resp.json();
  const newSessionId = data.id;
  setSessionMeta(newSessionId, { name: data.name || "", cwd: data.cwd || "", tool: data.tool || "terminal", status: data.status || "idle" });

  const newPaneId = uid("pane");
  const newLeaf = splitNode(ws.rootNode, activePaneId, direction, newPaneId, newSessionId, (newRoot) => {
    ws.rootNode = newRoot;
  });

  if (!newLeaf) return;

  // Detach existing terminals before re-rendering
  for (const leaf of allLeaves(ws.rootNode)) {
    if (getTerminal(leaf.paneId)) {
      detachTerminal(leaf.paneId, termHolderEl);
    }
  }

  const mounts = renderTree(ws.rootNode, workspaceAreaEl);

  for (const leaf of allLeaves(ws.rootNode)) {
    const mount = mounts.get(leaf.paneId);
    if (!mount) continue;

    const existing = getTerminal(leaf.paneId);
    if (existing) {
      reattachTerminal(leaf.paneId, mount.mountEl);
    } else {
      createTerminal(leaf.paneId, leaf.sessionId, mount.mountEl);
    }
    updatePaneHeader(leaf.paneId, mount.headerEl, leaf.sessionId);
  }

  activePaneId = newPaneId;
  ws.activePaneId = activePaneId;
  updatePaneFocus();
  requestAnimationFrame(() => fitAllTerminals());
  updateStatus();
  scheduleSaveLayout();
}

export function closeActivePane() {
  const ws = getActiveWorkspace();
  if (!ws || !activePaneId) return;
  if (leafCount(ws.rootNode) <= 1) {
    if (workspaces.length > 1) closeWorkspace(ws.id);
    return;
  }

  const oldPaneId = activePaneId;
  // Use the leaf node's sessionId (source of truth), not the terminal entry's
  const oldLeaf = findLeafByPane(ws.rootNode, oldPaneId);
  const oldSessionId = oldLeaf ? oldLeaf.sessionId : null;

  const newFocusPaneId = closeNode(ws.rootNode, oldPaneId, (newRoot) => {
    ws.rootNode = newRoot;
  });

  destroyTerminal(oldPaneId);
  // Do NOT delete the server-side session — it persists for reconnection.
  // Users delete sessions explicitly from the dashboard.

  // Detach remaining terminals before re-rendering
  for (const leaf of allLeaves(ws.rootNode)) {
    if (getTerminal(leaf.paneId)) {
      detachTerminal(leaf.paneId, termHolderEl);
    }
  }

  const mounts = renderTree(ws.rootNode, workspaceAreaEl);
  for (const leaf of allLeaves(ws.rootNode)) {
    const mount = mounts.get(leaf.paneId);
    if (!mount) continue;
    const existing = getTerminal(leaf.paneId);
    if (existing) {
      reattachTerminal(leaf.paneId, mount.mountEl);
    } else {
      createTerminal(leaf.paneId, leaf.sessionId, mount.mountEl);
    }
    updatePaneHeader(leaf.paneId, mount.headerEl, leaf.sessionId);
  }

  activePaneId = newFocusPaneId;
  ws.activePaneId = activePaneId;
  updatePaneFocus();
  requestAnimationFrame(() => fitAllTerminals());
  updateStatus();
  scheduleSaveLayout();
}

// ---------------------------------------------------------------------------
// Pane focus & navigation
// ---------------------------------------------------------------------------

export function setActivePane(paneId) {
  activePaneId = paneId;
  const ws = getActiveWorkspace();
  if (ws) ws.activePaneId = paneId;
  updatePaneFocus();
  updateStatus();
}

export function getActivePaneId() {
  return activePaneId;
}

export function navigatePane(direction) {
  if (!activePaneId) return;
  const neighbor = findNeighborPane(workspaceAreaEl, activePaneId, direction);
  if (neighbor) {
    setActivePane(neighbor);
    focusTerminal(neighbor);
  }
}

function updatePaneFocus() {
  const leaves = workspaceAreaEl.querySelectorAll(".pane-leaf");
  for (const el of leaves) {
    el.classList.toggle("active", el.dataset.paneId === activePaneId);
  }
  if (activePaneId) focusTerminal(activePaneId);
}

export function initPaneClick() {
  workspaceAreaEl.addEventListener("mousedown", (e) => {
    const leaf = e.target.closest(".pane-leaf");
    if (leaf && leaf.dataset.paneId && leaf.dataset.paneId !== activePaneId) {
      setActivePane(leaf.dataset.paneId);
    }
  });
}

// ---------------------------------------------------------------------------
// Tab bar rendering
// ---------------------------------------------------------------------------

function renderTabBar() {
  tabBarEl.innerHTML = "";
  for (let i = 0; i < workspaces.length; i++) {
    const ws = workspaces[i];
    const tab = document.createElement("div");
    tab.className = "tab" + (ws.id === activeWsId ? " active" : "");
    tab.dataset.wsId = ws.id;

    if (ws.type === "editor") {
      // Editor tab: colored dot + filename
      const ext = (ws.name.split(".").pop() || "").toLowerCase();
      const dotColor = _extColors[ext] || "#8b949e";
      const dot = document.createElement("span");
      dot.className = "tab-file-dot";
      dot.style.background = dotColor;
      tab.appendChild(dot);

      const edState = editorStates.get(ws.id);
      const lbl = document.createElement("span");
      lbl.className = "tab-label" + (edState?.dirty ? " tab-dirty" : "");
      lbl.textContent = ws.name || "file";
      tab.appendChild(lbl);
    } else {
      // Terminal tab: colored number badge + name
      const firstSessionId = firstLeaf(ws.rootNode)?.sessionId;
      const meta = firstSessionId != null ? getSessionMeta(firstSessionId) : {};
      const color = firstSessionId != null ? getSessionColor(firstSessionId) : "hsl(0,0%,50%)";

      const numBadge = document.createElement("span");
      numBadge.className = "tab-num";
      numBadge.textContent = i + 1;
      numBadge.style.background = color;
      numBadge.title = `Alt+${i + 1}`;
      const status = meta.status || "idle";
      if (status === "running") numBadge.style.boxShadow = `0 0 0 2px var(--green)`;
      else if (status === "waiting") numBadge.style.boxShadow = `0 0 0 2px var(--orange)`;
      else if (status === "error") numBadge.style.boxShadow = `0 0 0 2px var(--red)`;
      tab.appendChild(numBadge);

      const lbl = document.createElement("span");
      lbl.className = "tab-label";
      lbl.textContent = ws.name || "Terminal";
      tab.appendChild(lbl);

      // Double-click to rename
      lbl.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        lbl.contentEditable = "true";
        lbl.focus();
        const range = document.createRange();
        range.selectNodeContents(lbl);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
      });

      lbl.addEventListener("blur", () => {
        lbl.contentEditable = "false";
        const newName = lbl.textContent.trim().slice(0, 64);
        if (newName && newName !== ws.name) {
          ws.name = newName;
          const sid = firstLeaf(ws.rootNode)?.sessionId;
          if (sid != null) {
            fetch(api("/api/sessions/" + sid), {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: newName }),
            }).catch(() => {});
          }
        }
      });

      lbl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); lbl.blur(); }
        if (e.key === "Escape") { lbl.textContent = ws.name || "Terminal"; lbl.blur(); }
      });

      const count = leafCount(ws.rootNode);
      if (count > 1) {
        const badge = document.createElement("span");
        badge.className = "tab-count";
        badge.textContent = count;
        tab.appendChild(badge);
      }
    }

    if (workspaces.length > 1) {
      const close = document.createElement("span");
      close.className = "tab-close";
      close.textContent = "\u00d7";
      close.dataset.wsId = ws.id;
      tab.appendChild(close);
    }

    tab.addEventListener("click", (e) => {
      if (e.target.classList.contains("tab-close")) {
        closeWorkspace(e.target.dataset.wsId);
        return;
      }
      if (e.target.isContentEditable) return;
      switchWorkspace(ws.id);
    });

    tabBarEl.appendChild(tab);
  }
}

// ---------------------------------------------------------------------------
// Pane header updates
// ---------------------------------------------------------------------------

function formatTokensShort(n) {
  if (!n) return "0";
  if (n < 1000) return String(n);
  if (n < 1000000) return (n / 1000).toFixed(1) + "K";
  return (n / 1000000).toFixed(1) + "M";
}

function updatePaneHeader(paneId, headerEl, sessionId) {
  if (!headerEl) return;
  const meta = getSessionMeta(sessionId) || {};
  const name = meta.name || meta.tool || "terminal";
  const cwd = meta.cwd ? fname(meta.cwd) : "";
  const status = meta.status || "idle";
  const a = meta.analytics || {};

  // Colored left border from session color
  const color = getSessionColor(sessionId);
  headerEl.style.borderLeft = `2px solid ${color}`;

  let html = `<span class="ph-icon">${esc(tIcon(meta.tool || "terminal"))}</span><span class="ph-name">${esc(name)}</span>`;
  if (cwd) html += `<span class="ph-cwd">${esc(cwd)}</span>`;

  // Analytics in header
  if (a.inputTokens > 0 || a.outputTokens > 0) {
    html += `<span class="ph-analytics">${formatTokensShort(a.inputTokens + a.outputTokens)} tok</span>`;
  }
  if (a.estimatedCost > 0) {
    html += `<span class="ph-analytics">$${a.estimatedCost.toFixed(3)}</span>`;
  }

  html += `<span class="ph-status ${status}"></span>`;
  headerEl.innerHTML = html;
}

export function updatePaneHeaderByPaneId(paneId) {
  const entry = getTerminal(paneId);
  if (!entry) return;
  const headerEl = workspaceAreaEl.querySelector(`.pane-header[data-pane-id="${paneId}"]`);
  if (headerEl) updatePaneHeader(paneId, headerEl, entry.sessionId);
}

// Update all status indicators (called when status changes arrive)
export function updateStatusIndicators() {
  // Update tab number badges with status rings
  const tabs = tabBarEl.querySelectorAll(".tab");
  for (let i = 0; i < workspaces.length && i < tabs.length; i++) {
    const ws = workspaces[i];
    const badge = tabs[i].querySelector(".tab-num");
    if (badge) {
      const sid = firstLeaf(ws.rootNode)?.sessionId;
      const meta = sid != null ? getSessionMeta(sid) : {};
      const status = meta.status || "idle";
      if (status === "running") badge.style.boxShadow = `0 0 0 2px var(--green)`;
      else if (status === "waiting") badge.style.boxShadow = `0 0 0 2px var(--orange)`;
      else if (status === "error") badge.style.boxShadow = `0 0 0 2px var(--red)`;
      else badge.style.boxShadow = "";
    }
  }
  // Update pane headers
  for (const leaf of document.querySelectorAll(".pane-header")) {
    const paneId = leaf.dataset.paneId;
    if (paneId) updatePaneHeaderByPaneId(paneId);
  }
}

// ---------------------------------------------------------------------------
// Font size updates
// ---------------------------------------------------------------------------

export function updateFontSize(size) {
  // This would need to update all terminal instances
  // For now we'll apply on next terminal creation
  // Could also iterate and update: term.options.fontSize = size
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

function updateStatus() {
  if (!statusBarUpdater) return;
  const ws = getActiveWorkspace();
  const entry = activePaneId ? getTerminal(activePaneId) : null;
  const meta = entry ? getSessionMeta(entry.sessionId) : {};
  statusBarUpdater({
    name: meta.name || "Terminal",
    cwd: meta.cwd || "",
    tool: meta.tool || "terminal",
    sessionId: entry ? entry.sessionId : 0,
    paneCount: ws ? leafCount(ws.rootNode) : 0,
    connected: entry ? (entry.ws && entry.ws.readyState === 1) : false,
  });
}

// ---------------------------------------------------------------------------
// Public getters
// ---------------------------------------------------------------------------

export function getWorkspaces() { return workspaces; }
export function getActiveWorkspaceId() { return activeWsId; }
export function getActiveWorkspace_() { return getActiveWorkspace(); }

/**
 * Find an existing workspace that has a leaf connected to this session ID.
 * Returns the workspace ID, or null.
 */
export function findWorkspaceBySession(sessionId) {
  for (const ws of workspaces) {
    if (!ws.rootNode) continue; // skip editor workspaces
    for (const leaf of allLeaves(ws.rootNode)) {
      if (leaf.sessionId === sessionId) return ws.id;
    }
  }
  return null;
}

/**
 * Switch to a workspace by ID (public wrapper for switchWorkspace).
 */
export function switchToWorkspace(wsId) {
  switchWorkspace(wsId);
}

/**
 * Close all workspaces that reference a given session ID.
 * Used when deleting a session from the dashboard — ensures no tabs are left with dead terminals.
 */
export function closeWorkspacesWithSession(sessionId) {
  const toClose = workspaces
    .filter(ws => ws.rootNode && allLeaves(ws.rootNode).some(leaf => leaf.sessionId === sessionId))
    .map(ws => ws.id);
  for (const id of toClose) {
    const idx = workspaces.findIndex(w => w.id === id);
    if (idx === -1) continue;
    const ws = workspaces[idx];
    if (ws.rootNode) {
      for (const leaf of allLeaves(ws.rootNode)) {
        destroyTerminal(leaf.paneId);
      }
    }
    workspaces.splice(idx, 1);
  }
  // If we closed the active workspace, switch to another
  if (!workspaces.find(w => w.id === activeWsId) && workspaces.length > 0) {
    activeWsId = null;
    switchWorkspace(workspaces[0].id);
  }
  renderTabBar();
  scheduleSaveLayout();
}

export function closeOtherWorkspaces(keepWsId) {
  const toClose = workspaces.filter((w) => w.id !== keepWsId).map((w) => w.id);
  for (const id of toClose) closeWorkspace(id);
}

export function closeWorkspacesToRight(wsId) {
  const idx = workspaces.findIndex((w) => w.id === wsId);
  if (idx === -1) return;
  const toClose = workspaces.slice(idx + 1).map((w) => w.id);
  for (const id of toClose) closeWorkspace(id);
}

export async function duplicateWorkspace(wsId) {
  const ws = workspaces.find((w) => w.id === wsId);
  if (!ws) return;
  const sid = firstLeaf(ws.rootNode)?.sessionId;
  const meta = sid != null ? getSessionMeta(sid) : {};
  await createWorkspace(ws.name + " (copy)", null, { cwd: meta.cwd });
}

// ---------------------------------------------------------------------------
// Editor workspaces — files as tabs
// ---------------------------------------------------------------------------

export async function createEditorWorkspace(filePath, opts = {}) {
  const normalized = filePath.replace(/\\/g, "/");
  // Reuse if already open
  const existing = findEditorByPath(normalized);
  if (existing) {
    switchWorkspace(existing);
    const ws = workspaces.find(w => w.id === existing);
    if (opts.view) {
      const st = editorStates.get(existing);
      if (st) { st.view = opts.view; renderFileEditor(ws); }
    }
    return ws;
  }

  const name = normalized.split("/").pop() || "file";
  const ws = {
    id: uid("ws"),
    name,
    type: "editor",
    filePath: normalized,
    rootNode: null,
    activePaneId: null,
  };

  editorStates.set(ws.id, {
    filePath: normalized,
    content: null,
    editContent: null,
    dirty: false,
    view: opts.view || "code",
    diff: null,
    size: 0,
  });

  workspaces.push(ws);
  renderTabBar();
  switchWorkspace(ws.id);
  scheduleSaveLayout();
  return ws;
}

export function findEditorByPath(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  for (const ws of workspaces) {
    if (ws.type === "editor" && ws.filePath?.replace(/\\/g, "/") === normalized) return ws.id;
  }
  return null;
}

export async function saveActiveEditor() {
  const ws = getActiveWorkspace();
  if (!ws || ws.type !== "editor") return;
  const state = editorStates.get(ws.id);
  if (!state || !state.dirty) return;

  const content = state.editContent != null ? state.editContent : state.content;
  try {
    const resp = await fetch(api("/api/file"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: state.filePath, content }),
    });
    if (!resp.ok) throw new Error("Save failed");
    const data = await resp.json();
    state.content = content;
    state.dirty = false;
    state.size = data.size || content.length;
    renderFileEditor(ws);
    renderTabBar();
  } catch (e) {
    showError("Save failed: " + e.message);
  }
}

async function renderFileEditor(ws) {
  const state = editorStates.get(ws.id);
  if (!state) return;

  // Fetch content if not loaded yet
  if (state.content === null) {
    workspaceAreaEl.innerHTML = '<div class="editor-ws"><div class="editor-loading">Loading...</div></div>';
    try {
      const resp = await fetch(api("/api/file?path=" + encodeURIComponent(state.filePath)));
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: "Failed to load" }));
        const isNotFound = resp.status === 404 || err.code === "ENOENT";
        const msg = isNotFound
          ? "File not found \u2014 it may have been deleted, moved, or renamed."
          : (err.error || "Failed to load file");
        workspaceAreaEl.innerHTML = `<div class="editor-ws"><div class="editor-error"><div class="editor-error-icon">\u26A0</div><div class="editor-error-msg">${esc(msg)}</div><div class="editor-error-path">${esc(state.filePath)}</div></div></div>`;
        return;
      }
      const data = await resp.json();
      state.content = data.content;
      state.size = data.size || 0;
    } catch (e) {
      workspaceAreaEl.innerHTML = `<div class="editor-ws"><div class="editor-error"><div class="editor-error-icon">\u26A0</div><div class="editor-error-msg">${esc(e.message)}</div></div></div>`;
      return;
    }
  }

  const lang = _getLang(ws.name);
  const langLabel = lang === "plaintext" ? (ws.name.split(".").pop() || "TXT").toUpperCase() : lang.toUpperCase();

  let html = '<div class="editor-ws">';

  // Toolbar
  html += '<div class="editor-toolbar">';
  html += `<span class="editor-filepath" title="${esc(state.filePath)}">${esc(state.filePath)}</span>`;
  html += `<span class="editor-lang-badge">${esc(langLabel)}</span>`;
  html += `<span class="editor-size">${_formatSize(state.size)}</span>`;
  html += '<div class="editor-view-tabs">';
  html += `<button class="editor-view-tab${state.view === "code" ? " active" : ""}" data-view="code">Code</button>`;
  html += `<button class="editor-view-tab${state.view === "edit" ? " active" : ""}" data-view="edit">Edit</button>`;
  html += '</div>';
  html += `<button class="editor-save-btn${state.dirty ? " dirty" : ""}">${state.dirty ? "Save \u2022" : "Save"}</button>`;
  html += '</div>';

  // Content
  html += '<div class="editor-content">';
  if (state.view === "code") {
    html += renderEditorCode(state);
  } else if (state.view === "edit") {
    html += renderEditorEdit(state);
  }
  html += '</div>';

  html += '</div>';
  workspaceAreaEl.innerHTML = html;

  // Wire events
  const container = workspaceAreaEl.querySelector(".editor-ws");
  if (!container) return;

  // Tab switching
  for (const tab of container.querySelectorAll(".editor-view-tab")) {
    tab.addEventListener("click", () => {
      // Capture edit content before switching views
      if (state.view === "edit") {
        const ta = container.querySelector(".editor-textarea");
        if (ta) state.editContent = ta.value;
      }
      state.view = tab.dataset.view;
      renderFileEditor(ws);
    });
  }

  // Save button
  const saveBtn = container.querySelector(".editor-save-btn");
  if (saveBtn) {
    saveBtn.addEventListener("click", () => {
      // Capture current edit content
      const ta = container.querySelector(".editor-textarea");
      if (ta) state.editContent = ta.value;
      saveActiveEditor();
    });
  }

  // Edit mode — track dirty state and handle Ctrl+S
  if (state.view === "edit") {
    const ta = container.querySelector(".editor-textarea");
    if (ta) {
      // Restore edit content or use original
      ta.value = state.editContent != null ? state.editContent : state.content;
      ta.addEventListener("input", () => {
        state.editContent = ta.value;
        const changed = ta.value !== state.content;
        if (changed !== state.dirty) {
          state.dirty = changed;
          renderTabBar();
          const btn = container.querySelector(".editor-save-btn");
          if (btn) {
            btn.className = "editor-save-btn" + (state.dirty ? " dirty" : "");
            btn.textContent = state.dirty ? "Save \u2022" : "Save";
          }
        }
      });
      ta.addEventListener("keydown", (e) => {
        // Tab key inserts tab character
        if (e.key === "Tab") {
          e.preventDefault();
          const start = ta.selectionStart;
          const end = ta.selectionEnd;
          ta.value = ta.value.substring(0, start) + "  " + ta.value.substring(end);
          ta.selectionStart = ta.selectionEnd = start + 2;
          ta.dispatchEvent(new Event("input"));
        }
      });
      // Focus the textarea
      requestAnimationFrame(() => ta.focus());
    }
  }
}

function renderEditorCode(state) {
  const content = state.content || "";
  const lines = content.split("\n");
  const lang = _getLang(state.filePath.split("/").pop() || "");

  let highlighted;
  if (typeof hljs !== "undefined") {
    try {
      if (lang !== "plaintext" && hljs.getLanguage(lang)) {
        highlighted = hljs.highlight(content, { language: lang }).value;
      } else {
        highlighted = hljs.highlightAuto(content).value;
      }
    } catch { highlighted = esc(content); }
  } else {
    highlighted = esc(content);
  }

  let gutter = "";
  for (let i = 1; i <= lines.length; i++) gutter += i + "\n";

  return '<div class="editor-lines">' +
    `<div class="editor-gutter"><pre>${gutter}</pre></div>` +
    `<div class="editor-code"><pre><code class="hljs">${highlighted}</code></pre></div>` +
    '</div>';
}

function renderEditorEdit(state) {
  return `<textarea class="editor-textarea" spellcheck="false">${esc(state.editContent != null ? state.editContent : (state.content || ""))}</textarea>`;
}

// ---------------------------------------------------------------------------
// Window resize
// ---------------------------------------------------------------------------

let resizeTimer = null;
export function handleResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => fitAllTerminals(), 50);
}
