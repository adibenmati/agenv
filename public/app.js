// app.js — main application orchestrator
import { $, setToken, api, esc, short, tIcon, ago, fname } from "./modules/util.js";
import { setCallbacks, getTerminal, sendInput, pasteText, smartPaste, createTerminal as createTerm, fitAllTerminals, destroyTerminal, getCommandHistory } from "./modules/terminal.js";
import * as tabs from "./modules/tabs.js";
import * as sidebar from "./modules/sidebar.js";
import * as notif from "./modules/notifications.js";
import * as ctxmenu from "./modules/contextmenu.js";
import * as fileviewer from "./modules/fileviewer.js";
import * as palette from "./modules/palette.js";
import * as extensions from "./modules/extensions.js";
import * as mobile from "./modules/mobile.js";
import * as sessionsPanel from "./modules/sessions.js";
import * as claudeSearch from "./modules/claude-search.js";
import * as claudeMd from "./modules/claudemd.js";
import * as promptLib from "./modules/prompts.js";

// ---------------------------------------------------------------------------
// Runtime data
// ---------------------------------------------------------------------------
const RT = window.__RUNTIME__ || {};
setToken(RT.token || "");

// ---------------------------------------------------------------------------
// Settings (persisted to localStorage)
// ---------------------------------------------------------------------------
const settings = {
  theme: localStorage.getItem("tl-theme") || "dark",
  fontSize: parseInt(localStorage.getItem("tl-fontSize") || "14", 10),
  browserNotifs: localStorage.getItem("tl-browserNotifs") !== "false",
  cmdNotifs: localStorage.getItem("tl-cmdNotifs") !== "false",
  showSysStats: localStorage.getItem("tl-sysStats") !== "false",
  defaultAgent: localStorage.getItem("tl-defaultAgent") || "claude",
  defaultModel: localStorage.getItem("tl-defaultModel") || "",
  agentContinue: localStorage.getItem("tl-agentContinue") === "true",
  agentSkipPerms: localStorage.getItem("tl-agentSkipPerms") === "true",
  aiModel: localStorage.getItem("tl-aiModel") || "sonnet",
};

/** Build the full agent command from settings */
function buildAgentCommand(opts) {
  const agent = (opts && opts.agent) || settings.defaultAgent || "claude";
  const parts = [agent];
  if (agent === "claude") {
    if ((opts && opts.continue) || settings.agentContinue) parts.push("--continue");
    if (settings.defaultModel) parts.push("--model", settings.defaultModel);
    if (settings.agentSkipPerms) parts.push("--dangerously-skip-permissions");
  }
  return parts.join(" ");
}

function saveSetting(key, val) {
  settings[key] = val;
  localStorage.setItem("tl-" + key, String(val));
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  saveSetting("theme", theme);
  // Update highlight.js theme
  const hljsLink = document.getElementById("hljs-theme");
  if (hljsLink) {
    const hljsTheme = theme === "light" ? "github" : "github-dark";
    hljsLink.href = `https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/${hljsTheme}.min.css`;
  }
}
applyTheme(settings.theme);

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const workspaceArea = $("workspace-area");
const tabBar = $("tab-bar");
const termHolder = $("terminal-holder");
const dashboard = $("dashboard");
const appMain = $("app-main");
const sbName = $("sb-name");
const sbCwd = $("sb-cwd");
const sbStatus = $("sb-status");
const sbPanes = $("sb-panes");
const statusBar = $("status-bar");
const homeBtn = $("home-btn");
const addTabBtn = $("add-tab");
const splitHBtn = $("split-h-btn");
const splitVBtn = $("split-v-btn");
const helpOverlay = $("help-overlay");
const settingsOverlay = $("settings-overlay");
const sysStatsEl = $("sys-stats");
const bottomPanel = $("bottom-panel");
const bottomTermMount = $("bottom-terminal-mount");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatBytes(b) {
  if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(0) + "MB";
  return (b / (1024 * 1024 * 1024)).toFixed(1) + "GB";
}
function formatTokens(n) {
  if (!n) return "0";
  if (n < 1000) return String(n);
  if (n < 1000000) return (n / 1000).toFixed(1) + "K";
  return (n / 1000000).toFixed(2) + "M";
}
function formatCost(c) {
  if (!c) return "";
  return "$" + c.toFixed(4);
}

// ---------------------------------------------------------------------------
// Initialize tabs/workspace system
// ---------------------------------------------------------------------------
tabs.init({
  tabBar,
  workspaceArea,
  termHolder,
  onStatusUpdate(info) {
    sbName.textContent = info.name;
    sbCwd.textContent = short(info.cwd);
    sbPanes.textContent = info.paneCount > 1 ? (info.paneCount + " panes") : "";
    if (info.connected) {
      sbStatus.textContent = "connected";
      statusBar.className = "";
    } else {
      sbStatus.textContent = "disconnected";
      statusBar.className = "disconnected";
    }
    // Keep sidebar file explorer + git panel synced with active pane's CWD
    if (info.sessionId) {
      sidebar.connectToSession(info.sessionId, info.name, info.cwd);
      sidebar.setGitSession(info.sessionId);
      fileviewer.setPinSession(info.sessionId);
      sidebar.renderPinned();
      if (info.cwd) {
        fileviewer.setCwd(info.cwd);
        palette.setCwd(info.cwd);
      }
    }
  },
});

// ---------------------------------------------------------------------------
// Initialize sidebar (file explorer + git)
// ---------------------------------------------------------------------------
sidebar.init({
  sidebar: $("sidebar"),
  tree: $("file-tree"),
  divider: $("sidebar-divider"),
  main: $("main-content"),
  onFileAction(filePath, isDir) {
    if (isDir) {
      // Navigate sidebar into the directory (sidebar handles this via breadcrumb/tree)
      // Also cd in the active terminal so they stay in sync
      const paneId = tabs.getActivePaneId();
      const entry = paneId ? getTerminal(paneId) : null;
      if (entry && entry.ws && entry.ws.readyState === 1) {
        entry.ws.send(JSON.stringify({ type: "input", data: `cd "${filePath}"\r` }));
      }
    } else {
      // Open file as an editor tab (VS Code style)
      tabs.createEditorWorkspace(filePath);
    }
  },
  // When user clicks the refresh button, poll the real CWD from the server
  async onRefreshRequest() {
    const paneId = tabs.getActivePaneId();
    const entry = paneId ? getTerminal(paneId) : null;
    if (!entry) return;
    try {
      const resp = await fetch(api("/api/sessions/" + entry.sessionId + "/cwd"));
      if (resp.ok) {
        const data = await resp.json();
        if (data.cwd) {
          tabs.setSessionMeta(entry.sessionId, { cwd: data.cwd });
          sidebar.setCwd(data.cwd);
        }
      }
    } catch {}
  },
  getDefaultAgent() { return buildAgentCommand(); },
  async onLaunchAgent(dir, command) {
    showTerminals();
    // If command was the raw agent name, build the full command with settings
    const fullCmd = command.includes("--") ? command : buildAgentCommand({ agent: command });
    const toolName = fullCmd.split(/\s/)[0];
    const name = toolName.charAt(0).toUpperCase() + toolName.slice(1);
    try {
      const resp = await fetch(api("/api/quick-launch"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: fullCmd, name, cwd: dir }),
      });
      if (!resp.ok) return;
      const data = await resp.json();
      if (data && data.id != null) {
        tabs.setSessionMeta(data.id, { ...data, tool: toolName });
        await tabs.createWorkspace(name + " \u2014 " + dir.replace(/\\/g, "/").split("/").pop(), data.id);
        activatePanel("files");
      }
    } catch (e) {
      notif.showToast(null, "Failed to launch agent: " + e.message, "error");
    }
  },
});

// Poll active session CWD to keep sidebar in sync
setInterval(async () => {
  if (document.hidden || !sidebar.isVisible()) return;
  const paneId = tabs.getActivePaneId();
  const entry = paneId ? getTerminal(paneId) : null;
  if (!entry) return;
  try {
    const resp = await fetch(api("/api/sessions/" + entry.sessionId + "/cwd"));
    if (resp.ok) {
      const data = await resp.json();
      if (data.cwd) {
        tabs.setSessionMeta(entry.sessionId, { cwd: data.cwd });
        sidebar.setCwd(data.cwd);
      }
    }
  } catch {}
}, 10000);

// ---------------------------------------------------------------------------
// Initialize notifications
// ---------------------------------------------------------------------------
notif.init({
  toastContainer: $("toast-container"),
  onNotifCountChange(count) {
    const badge = $("notif-badge");
    if (badge) {
      badge.textContent = count > 0 ? count : "";
      badge.style.display = count > 0 ? "inline-block" : "none";
    }
  },
});
notif.setToastClickHandler((paneId) => {
  showTerminals();
  tabs.setActivePane(paneId);
});

// ---------------------------------------------------------------------------
// Initialize file viewer
// ---------------------------------------------------------------------------
fileviewer.init({
  onPinChange() { sidebar.renderPinned(); },
});

// ---------------------------------------------------------------------------
// Initialize command palette
// ---------------------------------------------------------------------------
palette.init({
  onOpen(filePath, _line) {
    if (filePath) fileviewer.openFile(filePath);
  },
});

// ---------------------------------------------------------------------------
// Initialize extension panels
// ---------------------------------------------------------------------------
extensions.initCostPanel();
extensions.initNgrokPanel();

// ---------------------------------------------------------------------------
// Initialize sessions panel (agent-deck style session manager)
// ---------------------------------------------------------------------------
sessionsPanel.init({
  panel: $("sessions-panel"),
  showContextMenu: ctxmenu.show,
  onOpenSession(sid, meta, opts) {
    if (meta) tabs.setSessionMeta(sid, meta);
    const existing = tabs.findWorkspaceBySession(sid);
    if (existing) {
      showTerminals();
      tabs.switchToWorkspace(existing);
    } else {
      showTerminals();
      tabs.createWorkspace(meta?.name || "Session " + sid, sid, meta);
    }
    // If continue-agent requested, send the command after connection
    if (opts && opts.continueAgent) {
      setTimeout(() => {
        const paneId = tabs.getActivePaneId();
        if (paneId) {
          const cmd = buildAgentCommand({ continue: true });
          sendInput(paneId, cmd + "\r");
        }
      }, 800);
    }
  },
  async onCreateSession(opts) {
    showTerminals();
    const body = {};
    if (opts && opts.group) body.group = opts.group;
    try {
      const resp = await fetch(api("/api/sessions"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) { tabs.createWorkspace("Terminal"); return; }
      const data = await resp.json();
      if (opts && opts.group) {
        // Assign group to the new session
        await fetch(api("/api/sessions/" + data.id), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ group: opts.group }),
        }).catch(() => {});
      }
      tabs.setSessionMeta(data.id, data);
      await tabs.createWorkspace(data.name || "Terminal", data.id);
      sessionsPanel.refresh();
    } catch {
      tabs.createWorkspace("Terminal");
    }
  },
  onLaunchAgent() {
    launchAgentWindow("claude", "Claude");
  },
  onDeleteSession(sid) {
    tabs.closeWorkspacesWithSession(sid);
  },
  onRestartSession(sid) {
    // Just let the sessions panel handle the API call; terminal will auto-reconnect
  },
  getAgentCommand() { return buildAgentCommand(); },
  isSessionOpen(sid) { return !!tabs.findWorkspaceBySession(sid); },
});

// ---------------------------------------------------------------------------
// Initialize Claude session search (cross-project session index & reuse)
// ---------------------------------------------------------------------------
claudeSearch.init({
  panel: $("claude-search-panel"),
  showContextMenu: ctxmenu.show,
  async onResumeSession(cwd, command) {
    showTerminals();
    const fullCmd = command.includes("--") ? command : buildAgentCommand({ continue: true });
    const toolName = fullCmd.split(/\s/)[0];
    const name = toolName.charAt(0).toUpperCase() + toolName.slice(1);
    try {
      const resp = await fetch(api("/api/quick-launch"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: fullCmd, name, cwd }),
      });
      if (!resp.ok) return;
      const data = await resp.json();
      if (data && data.id != null) {
        tabs.setSessionMeta(data.id, { ...data, tool: toolName });
        await tabs.createWorkspace(name + " \u2014 " + (cwd || "").replace(/\\/g, "/").split("/").pop(), data.id);
        activatePanel("files");
      }
    } catch (e) {
      notif.showToast(null, "Failed to resume: " + e.message, "error");
    }
  },
  async onOpenInTerminal(cwd) {
    showTerminals();
    await createSessionInDir(cwd);
  },
});

// ---------------------------------------------------------------------------
// Initialize CLAUDE.md Manager (cross-project CLAUDE.md editor)
// ---------------------------------------------------------------------------
claudeMd.init({
  panel: $("claudemd-panel"),
  onOpenInTerminal(cwd) {
    showTerminals();
    createSessionInDir(cwd);
  },
  onSendToTerminal(text) {
    const paneId = tabs.getActivePaneId();
    if (paneId) sendInput(paneId, text);
  },
});

// ---------------------------------------------------------------------------
// Initialize Prompt Library (saved prompt snippets)
// ---------------------------------------------------------------------------
promptLib.init({
  panel: $("prompts-panel"),
  onSendToTerminal(text) {
    const paneId = tabs.getActivePaneId();
    if (paneId) sendInput(paneId, text);
  },
});

// ---------------------------------------------------------------------------
// Initialize mobile (touch device keyboard + options panel)
// ---------------------------------------------------------------------------
mobile.init({
  sendInput(data) {
    const paneId = tabs.getActivePaneId();
    if (paneId) sendInput(paneId, data);
  },
  getHistory() { return getCommandHistory(); },
  onLaunchAgent(cmd, name) {
    launchAgentWindow(cmd, name.charAt(0).toUpperCase() + name.slice(1));
  },
  onNewTab() {
    showTerminals();
    tabs.createWorkspace("Terminal");
  },
  onCopy() {
    const paneId = tabs.getActivePaneId();
    const entry = paneId ? getTerminal(paneId) : null;
    if (entry && entry.term.hasSelection()) {
      navigator.clipboard.writeText(entry.term.getSelection()).catch(() => {});
      entry.term.clearSelection();
    }
  },
  onPaste() {
    const paneId = tabs.getActivePaneId();
    if (paneId) {
      navigator.clipboard.readText().then((text) => {
        if (text) pasteText(paneId, text);
      }).catch(() => {});
    }
  },
  onSmartPaste() {
    const paneId = tabs.getActivePaneId();
    if (paneId) smartPaste(paneId);
  },
  onSelectAll() {
    const paneId = tabs.getActivePaneId();
    const entry = paneId ? getTerminal(paneId) : null;
    if (entry) entry.term.selectAll();
  },
  onClear() {
    const paneId = tabs.getActivePaneId();
    const entry = paneId ? getTerminal(paneId) : null;
    if (entry) entry.term.clear();
  },
  onHome() { showDashboard(); },
  getAgentCommand() { return buildAgentCommand(); },
  onStartSTT() { startSTT(); },
  onStopSTT() { stopSTT(); },
  isSTTListening() { return sttListening; },
});

// ---------------------------------------------------------------------------
// Generic command interception
// ---------------------------------------------------------------------------
// Register patterns to react when the user types specific commands in a terminal.
// Each handler receives (paneId, fullCommandString).
const commandHandlers = [];

function onCommandIntercepted(paneId, command) {
  for (const { pattern, handler } of commandHandlers) {
    if (pattern.test(command)) handler(paneId, command);
  }
}

function registerCommand(pattern, handler) {
  commandHandlers.push({ pattern, handler });
}

// cd — update sidebar file explorer + git panel to follow the new directory
registerCommand(/^\s*cd(\s|$)/i, (paneId, _cmd) => {
  const entry = getTerminal(paneId);
  if (!entry) return;
  // Give the shell time to process the cd, then poll the real CWD
  setTimeout(async () => {
    try {
      const resp = await fetch(api("/api/sessions/" + entry.sessionId + "/cwd"));
      if (!resp.ok) return;
      const data = await resp.json();
      if (data.cwd) {
        tabs.setSessionMeta(entry.sessionId, { cwd: data.cwd });
        tabs.updatePaneHeaderByPaneId(paneId);
        if (paneId === tabs.getActivePaneId()) {
          sidebar.setCwd(data.cwd);
        }
      }
    } catch {}
  }, 500);
});

// pushd / popd — same behavior as cd
registerCommand(/^\s*(pushd|popd)(\s|$)/i, (paneId, _cmd) => {
  const entry = getTerminal(paneId);
  if (!entry) return;
  setTimeout(async () => {
    try {
      const resp = await fetch(api("/api/sessions/" + entry.sessionId + "/cwd"));
      if (!resp.ok) return;
      const data = await resp.json();
      if (data.cwd) {
        tabs.setSessionMeta(entry.sessionId, { cwd: data.cwd });
        tabs.updatePaneHeaderByPaneId(paneId);
        if (paneId === tabs.getActivePaneId()) {
          sidebar.setCwd(data.cwd);
        }
      }
    } catch {}
  }, 500);
});

// ---------------------------------------------------------------------------
// Terminal callbacks
// ---------------------------------------------------------------------------
setCallbacks({
  onCommand: onCommandIntercepted,
  onCwd(paneId, cwd) {
    const sid = getTerminal(paneId)?.sessionId;
    if (sid != null) {
      tabs.setSessionMeta(sid, { cwd });
      tabs.updatePaneHeaderByPaneId(paneId);
    }
    if (paneId === tabs.getActivePaneId()) {
      sidebar.setCwd(cwd);
      fileviewer.setCwd(cwd);
      palette.setCwd(cwd);
    }
  },
  onOutput(paneId, data) {
    const isActive = paneId === tabs.getActivePaneId();
    if (settings.cmdNotifs) notif.onPaneOutput(paneId, data, isActive);
  },
  onExit(paneId, code) {
    const isActive = paneId === tabs.getActivePaneId();
    notif.onPaneExit(paneId, code, isActive);
  },
  onConnect(paneId) {
    if (paneId === tabs.getActivePaneId()) {
      sbStatus.textContent = "connected";
      statusBar.className = "";
    }
  },
  onDisconnect(paneId) {
    if (paneId === tabs.getActivePaneId()) {
      sbStatus.textContent = "disconnected";
      statusBar.className = "disconnected";
    }
  },
  onStatus(sessionId, status) {
    tabs.setSessionMeta(sessionId, { status });
    tabs.updateStatusIndicators();
    sessionsPanel.updateSession(sessionId, { status });
  },
});

// ---------------------------------------------------------------------------
// Bottom terminal panel
// ---------------------------------------------------------------------------
let bottomTermEntry = null;
let bottomTermSessionId = null;
let bottomPanelHeight = 200;

async function toggleBottomPanel() {
  if (bottomPanel.classList.contains("visible")) {
    closeBottomPanel();
  } else {
    await openBottomPanel();
  }
}

async function openBottomPanel() {
  bottomPanel.classList.add("visible");
  bottomPanel.style.height = bottomPanelHeight + "px";
  $("ab-terminal").classList.add("active");

  if (!bottomTermEntry) {
    // Create a new session for the bottom terminal
    try {
      const resp = await fetch(api("/api/sessions"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!resp.ok) return;
      const data = await resp.json();
      bottomTermSessionId = data.id;
      bottomTermEntry = createTerm("bottom-term", data.id, bottomTermMount);
    } catch (e) {
      console.error("Failed to create bottom terminal:", e);
    }
  }

  requestAnimationFrame(() => {
    fitAllTerminals();
    if (bottomTermEntry) {
      try { bottomTermEntry.fitAddon.fit(); } catch {}
      bottomTermEntry.term.focus();
    }
  });
}

function closeBottomPanel() {
  bottomPanel.classList.remove("visible");
  $("ab-terminal").classList.remove("active");
  // Refit main terminals
  requestAnimationFrame(() => fitAllTerminals());
}

// Bottom panel resize
(function initBottomPanelResize() {
  const header = $("bottom-panel-header");
  let dragging = false;
  let startY = 0;
  let startH = 0;

  header.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".bp-btn")) return;
    e.preventDefault();
    header.setPointerCapture(e.pointerId);
    dragging = true;
    startY = e.clientY;
    startH = bottomPanel.offsetHeight;
    document.body.style.cursor = "row-resize";
  });

  header.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const newH = Math.max(100, Math.min(600, startH - (e.clientY - startY)));
    bottomPanel.style.height = newH + "px";
    bottomPanelHeight = newH;
  });

  const stop = () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = "";
    requestAnimationFrame(() => {
      fitAllTerminals();
      if (bottomTermEntry) try { bottomTermEntry.fitAddon.fit(); } catch {}
    });
  };

  header.addEventListener("pointerup", stop);
  header.addEventListener("pointercancel", stop);
})();

$("bp-close").addEventListener("click", closeBottomPanel);
$("bp-maximize").addEventListener("click", () => {
  if (bottomPanel.offsetHeight > 400) {
    bottomPanel.style.height = "200px";
    bottomPanelHeight = 200;
  } else {
    bottomPanel.style.height = "70vh";
    bottomPanelHeight = window.innerHeight * 0.7;
  }
  requestAnimationFrame(() => {
    fitAllTerminals();
    if (bottomTermEntry) try { bottomTermEntry.fitAddon.fit(); } catch {}
  });
});

// ---------------------------------------------------------------------------
// Activity bar
// ---------------------------------------------------------------------------
// Activity bar — each button with data-panel toggles that sidebar panel
function activatePanel(panelName) {
  const panelId = panelName + "-panel";
  const isAlreadyActive = sidebar.isVisible() && sidebar.getActivePanel() === panelId;
  if (isAlreadyActive) {
    sidebar.hide();
  } else {
    sidebar.showTab(panelName);
  }
  // Update active states on all ab buttons
  for (const btn of document.querySelectorAll("#activity-bar .ab-btn[data-panel]")) {
    btn.classList.toggle("active", sidebar.isVisible() && btn.dataset.panel === panelId);
  }
  // Sessions panel: poll when visible, stop when hidden
  if (panelId === "sessions-panel" && sidebar.isVisible() && sidebar.getActivePanel() === "sessions-panel") {
    sessionsPanel.refresh();
    sessionsPanel.startPolling();
  } else {
    sessionsPanel.stopPolling();
  }
  // Claude search panel: load on show, poll at 30s interval
  if (panelId === "claude-search-panel" && sidebar.isVisible() && sidebar.getActivePanel() === "claude-search-panel") {
    claudeSearch.refresh();
    claudeSearch.startPolling();
  } else {
    claudeSearch.stopPolling();
  }
  // CLAUDE.md Manager: load on show
  if (panelId === "claudemd-panel" && sidebar.isVisible() && sidebar.getActivePanel() === "claudemd-panel") {
    claudeMd.refresh();
  }
  // Prompt Library: load on show
  if (panelId === "prompts-panel" && sidebar.isVisible() && sidebar.getActivePanel() === "prompts-panel") {
    promptLib.refresh();
  }
  requestAnimationFrame(() => tabs.handleResize());
}

for (const btn of document.querySelectorAll("#activity-bar .ab-btn[data-panel]")) {
  btn.addEventListener("click", () => {
    const panelId = btn.dataset.panel;
    const panelName = panelId.replace(/-panel$/, "");
    activatePanel(panelName);
  });
}

$("ab-terminal").addEventListener("click", toggleBottomPanel);
$("ab-settings").addEventListener("click", () => toggleSettings());

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
let dashSearchQuery = "";

async function showDashboard() {
  dashboard.classList.remove("hidden");
  appMain.classList.add("hidden");
  try {
    const resp = await fetch(api("/api/sessions"));
    if (resp.ok) RT.sessions = await resp.json();
  } catch {}
  renderDashboard();
  requestAnimationFrame(() => {
    const input = dashboard.querySelector(".search-bar input");
    if (input) input.focus();
  });
}

function showTerminals() {
  dashboard.classList.add("hidden");
  appMain.classList.remove("hidden");
  requestAnimationFrame(() => tabs.handleResize());
}

function renderDashboard() {
  const inner = $("dash-inner");
  let h = '<div class="dash-hero"><h1>Term<span>Link</span></h1><p>CLI Development Environment</p></div>';

  // Search
  h += `<div class="search-bar"><span class="search-icon">/</span><input type="text" placeholder="Search sessions, tools, folders..." value="${esc(dashSearchQuery)}" id="dash-search" /></div>`;

  // Quick actions — Agent Windows first
  h += '<div class="dash-section"><div class="dash-label">Agent Windows</div><div class="act-grid">';
  h += '<div class="act-btn" data-action="agent-claude"><div class="act-icon claude">C</div><div class="act-text"><div class="act-title">Claude Agent</div><div class="act-sub">AI + Terminal + Explorer</div></div></div>';
  h += '<div class="act-btn" data-action="agent-vertex"><div class="act-icon vertex">V</div><div class="act-text"><div class="act-title">Vertex Agent</div><div class="act-sub">Google AI + Terminal</div></div></div>';
  h += '<div class="act-btn" data-action="agent-codex"><div class="act-icon codex">Cx</div><div class="act-text"><div class="act-title">Codex Agent</div><div class="act-sub">OpenAI + Terminal</div></div></div>';
  h += '<div class="act-btn" data-action="agent-gemini"><div class="act-icon gemini">Gm</div><div class="act-text"><div class="act-title">Gemini Agent</div><div class="act-sub">Google CLI + Terminal</div></div></div>';
  h += '</div></div>';

  h += '<div class="dash-section"><div class="dash-label">Quick Launch</div><div class="act-grid">';
  h += '<div class="act-btn" data-action="new-terminal"><div class="act-icon terminal">></div><div class="act-text"><div class="act-title">Terminal</div><div class="act-sub">Open a shell</div></div></div>';
  h += '<div class="act-btn" data-action="new-python"><div class="act-icon python">Py</div><div class="act-text"><div class="act-title">Python</div><div class="act-sub">REPL</div></div></div>';
  h += '<div class="act-btn" data-action="new-node"><div class="act-icon node">N</div><div class="act-text"><div class="act-title">Node.js</div><div class="act-sub">REPL</div></div></div>';
  h += '<div class="act-btn" data-action="new-split"><div class="act-icon folder">&#9646;&#9646;</div><div class="act-text"><div class="act-title">Split View</div><div class="act-sub">Side by side</div></div></div>';
  h += '</div></div>';

  // Active sessions
  const sessions = RT.sessions || [];
  const filtered = dashSearchQuery
    ? sessions.filter(s => {
        const q = dashSearchQuery.toLowerCase();
        return (s.name || "").toLowerCase().includes(q)
          || (s.cwd || "").toLowerCase().includes(q)
          || (s.tool || "").toLowerCase().includes(q);
      })
    : sessions;

  if (filtered.length) {
    h += '<div class="dash-section"><div class="dash-label">Active Sessions <span style="font-weight:400;color:var(--text3)">' + filtered.length + '</span></div><div class="ses-list">';
    for (const s of filtered) {
      h += `<div class="ses-card" data-session="${s.id}">`;
      h += `<div class="ses-dot ${s.status || 'idle'}"></div>`;
      h += '<div class="ses-info">';
      h += `<div class="ses-name">${esc(s.name || "Session " + s.id)}</div>`;
      h += `<div class="ses-path">${esc(short(s.cwd))}</div>`;
      h += '<div class="ses-meta">';
      if (s.tool && s.tool !== "terminal") h += `<span class="ses-badge ${esc(s.tool)}">${esc(s.tool)}</span>`;
      h += `<span class="ses-status-label ${s.status || 'idle'}">${esc(s.status || "idle")}</span>`;
      const a = s.analytics || {};
      if (a.estimatedCost > 0) h += `<span class="ses-cost">${formatCost(a.estimatedCost)}</span>`;
      if (a.inputTokens > 0 || a.outputTokens > 0) {
        h += `<span style="font-size:9px;color:var(--text3)">${formatTokens(a.inputTokens)}/${formatTokens(a.outputTokens)} tok</span>`;
      }
      h += '</div></div>';
      h += `<div class="ses-time">${ago(s.lastActivity)}</div></div>`;
    }
    h += '</div></div>';
  }

  // Recent folders
  const folders = RT.recentFolders || [];
  const filteredFolders = dashSearchQuery
    ? folders.filter(f => (f.cwd || "").toLowerCase().includes(dashSearchQuery.toLowerCase()))
    : folders;
  if (filteredFolders.length) {
    h += '<div class="dash-section"><div class="dash-label">Recent Folders</div><div class="ses-list">';
    for (const f of filteredFolders.slice(0, 8)) {
      h += `<div class="ses-card" data-folder="${esc(f.cwd)}">`;
      h += '<div class="ses-dot dead"></div>';
      h += `<div class="ses-info"><div class="ses-name">${esc(fname(f.cwd))}</div><div class="ses-path">${esc(short(f.cwd))}</div></div>`;
      h += `<div class="ses-time">${ago(f.lastActivity)}</div></div>`;
    }
    h += '</div></div>';
  }

  inner.innerHTML = h;

  const searchInput = $("dash-search");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      dashSearchQuery = e.target.value;
      renderDashboard();
      const el = $("dash-search");
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    });
  }
}

// ---------------------------------------------------------------------------
// Agent Window — the core new feature
// ---------------------------------------------------------------------------
// Creates an "Agent Window": Claude/Vertex as main pane, with sidebar
// auto-opened and bottom terminal available via Ctrl+`

async function launchAgentWindow(toolCommand, toolName) {
  showTerminals();

  // Build full command with model/flags settings for Claude
  const fullCmd = (toolCommand === "claude") ? buildAgentCommand() : toolCommand;

  // Launch the AI tool via quick-launch
  let data;
  try {
    const resp = await fetch(api("/api/quick-launch"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: fullCmd, name: toolName }),
    });
    if (!resp.ok) { showDashboard(); return; }
    data = await resp.json();
  } catch {
    showDashboard();
    return;
  }

  if (!data || data.id == null) { showDashboard(); return; }

  tabs.setSessionMeta(data.id, { ...data, tool: toolCommand });
  const ws = await tabs.createWorkspace(toolName, data.id);
  if (!ws) { showDashboard(); return; }

  // Auto-open sidebar with explorer
  activatePanel("files");
}

// Quick-launch helper for non-agent tools
async function quickLaunch(command, name) {
  try {
    const resp = await fetch(api("/api/quick-launch"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, name }),
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch { return null; }
}

// Create a new session in a specific directory (used from folder context menu)
async function createSessionInDir(dir) {
  showTerminals();
  try {
    const resp = await fetch(api("/api/sessions"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: dir, name: fname(dir) }),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    tabs.setSessionMeta(data.id, data);
    await tabs.createWorkspace(data.name || fname(dir), data.id);
  } catch (e) {
    notif.showToast(null,"Failed to create session: " + e.message, "error");
  }
}

// Launch an agent CLI in a specific directory
async function launchAgentInDir(dir, command) {
  showTerminals();
  const toolName = command.split(/\s/)[0];
  const name = toolName.charAt(0).toUpperCase() + toolName.slice(1);
  try {
    const resp = await fetch(api("/api/quick-launch"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, name, cwd: dir }),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    if (data && data.id != null) {
      tabs.setSessionMeta(data.id, { ...data, tool: toolName });
      await tabs.createWorkspace(name + " \u2014 " + fname(dir), data.id);
      activatePanel("files");
    }
  } catch (e) {
    notif.showToast(null, "Failed to launch agent: " + e.message, "error");
  }
}

// Start a git worktree in a directory — prompts for branch name
async function startWorktreeDialog(dir) {
  const name = prompt("New worktree branch name:");
  if (!name || !name.trim()) return;
  const branch = name.trim();
  try {
    const resp = await fetch(api("/api/git/worktree-add"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir, branch }),
    });
    const data = await resp.json();
    if (!data.ok) {
      notif.showToast(null,data.output || data.error || "Worktree creation failed", "error");
      return;
    }
    notif.showToast(null,"Worktree created: " + branch, "success");
    // Open a session in the new worktree directory
    if (data.path) {
      await createSessionInDir(data.path);
    }
  } catch (e) {
    notif.showToast(null,"Failed: " + e.message, "error");
  }
}

// ---------------------------------------------------------------------------
// Dashboard click handler
// ---------------------------------------------------------------------------
$("dash-inner").addEventListener("click", async (e) => {
  const actionEl = e.target.closest("[data-action]");
  if (actionEl) {
    const act = actionEl.dataset.action;

    // Agent Windows
    if (act === "agent-claude") { await launchAgentWindow("claude", "Claude"); return; }
    if (act === "agent-vertex") { await launchAgentWindow("vertex", "Vertex"); return; }
    if (act === "agent-codex") { await launchAgentWindow("codex", "Codex"); return; }
    if (act === "agent-gemini") { await launchAgentWindow("gemini", "Gemini"); return; }

    // Quick launch
    showTerminals();
    if (act === "new-terminal") {
      const ws = await tabs.createWorkspace("Terminal");
      if (!ws) showDashboard();
    } else if (act === "new-python") {
      const data = await quickLaunch("python", "Python");
      if (data && data.id != null) {
        tabs.setSessionMeta(data.id, data);
        await tabs.createWorkspace("Python", data.id);
      } else { showDashboard(); }
    } else if (act === "new-node") {
      const data = await quickLaunch("node", "Node.js");
      if (data && data.id != null) {
        tabs.setSessionMeta(data.id, data);
        await tabs.createWorkspace("Node.js", data.id);
      } else { showDashboard(); }
    } else if (act === "new-split") {
      const ws = await tabs.createWorkspace("Terminal");
      if (ws) setTimeout(() => tabs.splitActivePane("h"), 300);
      else showDashboard();
    }
    return;
  }

  const sessionEl = e.target.closest("[data-session]");
  if (sessionEl) {
    const sid = parseInt(sessionEl.dataset.session, 10);
    const meta = (RT.sessions || []).find(s => s.id === sid);
    if (meta) tabs.setSessionMeta(sid, meta);

    // Check if any existing workspace already has this session open — switch to it
    const existingWs = tabs.findWorkspaceBySession(sid);
    if (existingWs) {
      showTerminals();
      tabs.switchToWorkspace(existingWs);
      return;
    }

    showTerminals();
    await tabs.createWorkspace(meta?.name || "Session " + sid, sid, meta);
    return;
  }

  const folderEl = e.target.closest("[data-folder]");
  if (folderEl) {
    showTerminals();
    await tabs.createWorkspace(fname(folderEl.dataset.folder), null, { cwd: folderEl.dataset.folder });
  }
});

// ---------------------------------------------------------------------------
// Top bar buttons
// ---------------------------------------------------------------------------
homeBtn.addEventListener("click", showDashboard);
addTabBtn.addEventListener("click", async () => {
  showTerminals();
  await tabs.createWorkspace("Terminal");
});
splitHBtn.addEventListener("click", () => tabs.splitActivePane("h"));
splitVBtn.addEventListener("click", () => tabs.splitActivePane("v"));

// ---------------------------------------------------------------------------
// Help & Settings overlays
// ---------------------------------------------------------------------------
function toggleHelp() { helpOverlay.classList.toggle("visible"); }
function toggleSettings() { settingsOverlay.classList.toggle("visible"); }

$("help-close").addEventListener("click", toggleHelp);
helpOverlay.addEventListener("click", (e) => { if (e.target === helpOverlay) toggleHelp(); });
$("settings-close").addEventListener("click", toggleSettings);
settingsOverlay.addEventListener("click", (e) => { if (e.target === settingsOverlay) toggleSettings(); });

// Settings wiring
$("theme-select").value = settings.theme;
$("theme-select").addEventListener("change", (e) => applyTheme(e.target.value));
$("fontsize-select").value = String(settings.fontSize);
$("fontsize-select").addEventListener("change", (e) => saveSetting("fontSize", parseInt(e.target.value, 10)));
$("browser-notif-toggle").checked = settings.browserNotifs;
$("browser-notif-toggle").addEventListener("change", (e) => saveSetting("browserNotifs", e.target.checked));
$("cmd-notif-toggle").checked = settings.cmdNotifs;
$("cmd-notif-toggle").addEventListener("change", (e) => saveSetting("cmdNotifs", e.target.checked));
$("sys-stats-toggle").checked = settings.showSysStats;
$("sys-stats-toggle").addEventListener("change", (e) => {
  saveSetting("showSysStats", e.target.checked);
  if (!e.target.checked) sysStatsEl.textContent = "";
});

// Default agent setting
const defaultAgentSelect = $("default-agent-select");
if (defaultAgentSelect) {
  defaultAgentSelect.value = settings.defaultAgent;
  defaultAgentSelect.addEventListener("change", (e) => saveSetting("defaultAgent", e.target.value));
}
const defaultModelSelect = $("default-model-select");
if (defaultModelSelect) {
  defaultModelSelect.value = settings.defaultModel;
  defaultModelSelect.addEventListener("change", (e) => saveSetting("defaultModel", e.target.value));
}
const aiModelSelect = $("ai-model-select");
if (aiModelSelect) {
  aiModelSelect.value = settings.aiModel;
  aiModelSelect.addEventListener("change", (e) => saveSetting("aiModel", e.target.value));
}
const agentContinueToggle = $("agent-continue-toggle");
if (agentContinueToggle) {
  agentContinueToggle.checked = settings.agentContinue;
  agentContinueToggle.addEventListener("change", (e) => saveSetting("agentContinue", e.target.checked));
}
const agentSkipPermsToggle = $("agent-skip-perms-toggle");
if (agentSkipPermsToggle) {
  agentSkipPermsToggle.checked = settings.agentSkipPerms;
  agentSkipPermsToggle.addEventListener("change", (e) => saveSetting("agentSkipPerms", e.target.checked));
}

// Extension toggles in settings
const extSettings = JSON.parse(localStorage.getItem("tl-ext-settings") || '{"cost":true,"ngrok":true,"claudemd":true,"prompts":true}');

function applyExtVisibility() {
  const costBtn = $("ab-cost");
  const ngrokBtn = $("ab-ngrok");
  const claudemdBtn = $("ab-claudemd");
  const promptsBtn = $("ab-prompts");
  if (costBtn) costBtn.style.display = extSettings.cost ? "" : "none";
  if (ngrokBtn) ngrokBtn.style.display = extSettings.ngrok ? "" : "none";
  if (claudemdBtn) claudemdBtn.style.display = extSettings.claudemd !== false ? "" : "none";
  if (promptsBtn) promptsBtn.style.display = extSettings.prompts !== false ? "" : "none";
}
applyExtVisibility();

const extCostToggle = $("ext-cost-toggle");
const extNgrokToggle = $("ext-ngrok-toggle");
if (extCostToggle) {
  extCostToggle.checked = extSettings.cost !== false;
  extCostToggle.addEventListener("change", () => {
    extSettings.cost = extCostToggle.checked;
    localStorage.setItem("tl-ext-settings", JSON.stringify(extSettings));
    applyExtVisibility();
    if (!extCostToggle.checked && sidebar.getActivePanel() === "cost-panel") {
      sidebar.hide();
    }
  });
}
if (extNgrokToggle) {
  extNgrokToggle.checked = extSettings.ngrok !== false;
  extNgrokToggle.addEventListener("change", () => {
    extSettings.ngrok = extNgrokToggle.checked;
    localStorage.setItem("tl-ext-settings", JSON.stringify(extSettings));
    applyExtVisibility();
    if (!extNgrokToggle.checked && sidebar.getActivePanel() === "ngrok-panel") {
      sidebar.hide();
    }
  });
}

const extClaudemdToggle = $("ext-claudemd-toggle");
if (extClaudemdToggle) {
  extClaudemdToggle.checked = extSettings.claudemd !== false;
  extClaudemdToggle.addEventListener("change", () => {
    extSettings.claudemd = extClaudemdToggle.checked;
    localStorage.setItem("tl-ext-settings", JSON.stringify(extSettings));
    applyExtVisibility();
    if (!extClaudemdToggle.checked && sidebar.getActivePanel() === "claudemd-panel") {
      sidebar.hide();
    }
  });
}

const extPromptsToggle = $("ext-prompts-toggle");
if (extPromptsToggle) {
  extPromptsToggle.checked = extSettings.prompts !== false;
  extPromptsToggle.addEventListener("change", () => {
    extSettings.prompts = extPromptsToggle.checked;
    localStorage.setItem("tl-ext-settings", JSON.stringify(extSettings));
    applyExtVisibility();
    if (!extPromptsToggle.checked && sidebar.getActivePanel() === "prompts-panel") {
      sidebar.hide();
    }
  });
}

$("shutdown-btn").addEventListener("click", () => {
  if (confirm("Shut down the Agenv server? All sessions will be saved.")) {
    fetch(api("/api/shutdown"), { method: "POST" }).catch(() => {});
    document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;color:var(--text3);font-family:var(--font);font-size:14px">Server shut down. Refresh to reconnect.</div>';
  }
});

// ---------------------------------------------------------------------------
// System stats polling
// ---------------------------------------------------------------------------
async function updateSysStats() {
  if (document.hidden || !settings.showSysStats) return;
  try {
    const resp = await fetch(api("/api/stats"));
    if (resp.ok) {
      const s = await resp.json();
      sysStatsEl.textContent = `CPU ${s.cpu}% | RAM ${s.memPercent}% (${formatBytes(s.memUsed)}/${formatBytes(s.memTotal)})`;
    }
  } catch {}
}
updateSysStats();
setInterval(updateSysStats, 10000);

// Cost monitor status bar indicator
const costStatusEl = $("sb-cost");
async function updateCostStatus() {
  if (document.hidden || !costStatusEl) return;
  const summary = await extensions.getCostSummary();
  costStatusEl.textContent = summary;
  costStatusEl.style.display = summary ? "inline" : "none";
}
updateCostStatus();
setInterval(updateCostStatus, 30000);

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------
document.addEventListener("keydown", (e) => {
  const tag = e.target.tagName;
  const isEditing = tag === "INPUT" || tag === "TEXTAREA" || e.target.isContentEditable;

  // ? — help
  if (e.key === "?" && !isEditing && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault(); toggleHelp(); return;
  }
  // Escape — close overlays
  if (e.key === "Escape") {
    if (palette.isVisible()) { palette.hide(); return; }
    if (fileviewer.isVisible()) { fileviewer.hide(); return; }
    if (helpOverlay.classList.contains("visible")) { toggleHelp(); return; }
    if (settingsOverlay.classList.contains("visible")) { toggleSettings(); return; }
  }
  // / — search on dashboard
  if (e.key === "/" && !isEditing && !e.ctrlKey && !dashboard.classList.contains("hidden")) {
    e.preventDefault();
    const input = dashboard.querySelector(".search-bar input");
    if (input) input.focus();
    return;
  }
  // Ctrl+S — save active editor
  if ((e.ctrlKey || e.metaKey) && e.key === "s" && !e.shiftKey) { e.preventDefault(); tabs.saveActiveEditor(); return; }
  // Ctrl+P — quick file open
  if ((e.ctrlKey || e.metaKey) && e.key === "p" && !e.shiftKey) { e.preventDefault(); palette.show("files"); return; }
  // Ctrl+K — dashboard
  if ((e.ctrlKey || e.metaKey) && e.key === "k") { e.preventDefault(); showDashboard(); return; }
  // Ctrl+B — toggle explorer
  if ((e.ctrlKey || e.metaKey) && e.key === "b") {
    e.preventDefault();
    activatePanel("files");
    return;
  }
  // Ctrl+T — search text in files
  if ((e.ctrlKey || e.metaKey) && e.key === "t") {
    e.preventDefault(); palette.show("text"); return;
  }
  // Ctrl+` — toggle bottom terminal
  if ((e.ctrlKey || e.metaKey) && e.key === "`") {
    e.preventDefault(); toggleBottomPanel(); return;
  }
  // Ctrl+, — settings
  if ((e.ctrlKey || e.metaKey) && e.key === ",") { e.preventDefault(); toggleSettings(); return; }
  // Ctrl+Shift+D — split horizontal
  if (e.ctrlKey && e.shiftKey && (e.key === "D" || e.key === "d")) { e.preventDefault(); tabs.splitActivePane("h"); return; }
  // Ctrl+Shift+E — split vertical
  if (e.ctrlKey && e.shiftKey && (e.key === "E" || e.key === "e")) { e.preventDefault(); tabs.splitActivePane("v"); return; }
  // Ctrl+Shift+W — close pane
  if (e.ctrlKey && e.shiftKey && (e.key === "W" || e.key === "w")) { e.preventDefault(); tabs.closeActivePane(); return; }
  // Ctrl+Shift+C — copy if selection, else new Claude agent window
  if (e.ctrlKey && e.shiftKey && (e.key === "C" || e.key === "c")) {
    e.preventDefault();
    const pid = tabs.getActivePaneId();
    const ent = pid ? getTerminal(pid) : null;
    if (ent && ent.term.hasSelection()) {
      navigator.clipboard.writeText(ent.term.getSelection()).catch(() => {});
      ent.term.clearSelection();
    } else {
      launchAgentWindow("claude", "Claude");
    }
    return;
  }
  // Ctrl+Shift+V — paste (fallback when xterm not focused)
  if (e.ctrlKey && e.shiftKey && (e.key === "V" || e.key === "v")) {
    e.preventDefault();
    const pid = tabs.getActivePaneId();
    if (pid) {
      navigator.clipboard.readText().then((text) => {
        if (text) pasteText(pid, text);
      }).catch(() => {});
    }
    return;
  }
  // Ctrl+Shift+B — Smart Paste (save clipboard to file, insert path)
  if (e.ctrlKey && e.shiftKey && (e.key === "B" || e.key === "b")) {
    e.preventDefault();
    const pid = tabs.getActivePaneId();
    if (pid) smartPaste(pid);
    return;
  }
  // Alt+Arrow — navigate panes
  if (e.altKey && e.key.startsWith("Arrow")) {
    e.preventDefault(); tabs.navigatePane(e.key.replace("Arrow", "").toLowerCase()); return;
  }
  // Ctrl+1-9 or Alt+1-9 — switch tabs
  if (((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) || (e.altKey && !e.ctrlKey && !e.shiftKey)) {
    if (e.key >= "1" && e.key <= "9") {
      e.preventDefault(); tabs.switchToTab(parseInt(e.key, 10) - 1); return;
    }
  }
});

// ---------------------------------------------------------------------------
// Speech-to-text (shared by status bar button, right-click menu, and mobile)
// ---------------------------------------------------------------------------
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let sttRecognition = null;
let sttListening = false;

function startSTT() {
  if (sttListening || !SpeechRecognition) return;
  sttRecognition = new SpeechRecognition();
  sttRecognition.continuous = true;
  sttRecognition.interimResults = true;
  sttRecognition.lang = "en-US";

  sttRecognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        const text = event.results[i][0].transcript;
        if (text.trim()) {
          const paneId = tabs.getActivePaneId();
          if (paneId) sendInput(paneId, text);
        }
      }
    }
  };

  sttRecognition.onerror = (event) => {
    if (event.error !== "aborted") {
      notif.showToast(null, "Speech error: " + event.error, "error");
    }
    stopSTT();
  };

  sttRecognition.onend = () => {
    if (sttListening) {
      try { sttRecognition.start(); } catch {}
    }
  };

  try {
    sttRecognition.start();
    sttListening = true;
    const sttBtn = $("stt-btn");
    if (sttBtn) { sttBtn.classList.add("listening"); sttBtn.title = "Listening... (click to stop)"; }
  } catch (e) {
    notif.showToast(null, "Could not start speech recognition", "error");
  }
}

function stopSTT() {
  sttListening = false;
  const sttBtn = $("stt-btn");
  if (sttBtn) { sttBtn.classList.remove("listening"); sttBtn.title = "Speech to Text (click to start)"; }
  if (sttRecognition) {
    try { sttRecognition.stop(); } catch {}
    sttRecognition = null;
  }
}

function toggleSTT() {
  if (sttListening) stopSTT();
  else startSTT();
}

function isSTTListening() { return sttListening; }

// Wire status bar button
(function() {
  const sttBtn = $("stt-btn");
  if (!sttBtn) return;
  if (!SpeechRecognition) {
    sttBtn.title = "Speech recognition not supported in this browser";
    sttBtn.style.opacity = "0.3";
    sttBtn.style.cursor = "not-allowed";
    return;
  }
  sttBtn.addEventListener("click", toggleSTT);
})();

// ---------------------------------------------------------------------------
// Window resize + visual viewport (mobile virtual keyboard)
// ---------------------------------------------------------------------------
window.addEventListener("resize", () => tabs.handleResize());
window.addEventListener("orientationchange", () => setTimeout(() => tabs.handleResize(), 200));

// When the virtual keyboard opens/closes on mobile, the visual viewport shrinks
// but document.body height stays at window.innerHeight (behind the keyboard).
// Force body height to match the visible area so the mobile bar + terminals
// stay above the keyboard instead of being hidden behind it.
if (window.visualViewport) {
  let vvTimer;
  const handleViewportResize = () => {
    clearTimeout(vvTimer);
    vvTimer = setTimeout(() => {
      document.body.style.height = window.visualViewport.height + "px";
      fitAllTerminals();
      tabs.handleResize();
    }, 50);
  };
  window.visualViewport.addEventListener("resize", handleViewportResize);
  window.visualViewport.addEventListener("scroll", () => {
    document.body.style.height = window.visualViewport.height + "px";
  });
}

// ---------------------------------------------------------------------------
// Pane click to focus
// ---------------------------------------------------------------------------
tabs.initPaneClick();

// ---------------------------------------------------------------------------
// Context menus (right-click)
// ---------------------------------------------------------------------------
ctxmenu.init();

// Tab bar right-click
tabBar.addEventListener("contextmenu", (e) => {
  const tabEl = e.target.closest(".tab");
  if (!tabEl) return;
  e.preventDefault();
  const wsId = tabEl.dataset.wsId;
  const allWs = tabs.getWorkspaces();
  const wsIdx = allWs.findIndex((w) => w.id === wsId);
  const isActive = wsId === tabs.getActiveWorkspaceId();
  const hasMultiple = allWs.length > 1;
  const hasRight = wsIdx < allWs.length - 1;

  ctxmenu.show(e.clientX, e.clientY, [
    { label: "Rename", action: "rename", handler() {
      const lbl = tabEl.querySelector(".tab-label");
      if (lbl) { lbl.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); }
    }},
    { separator: true },
    { label: "Split Right", action: "split-h", shortcut: "Ctrl+Shift+D", handler() {
      if (!isActive) tabs.switchToTab(wsIdx);
      setTimeout(() => tabs.splitActivePane("h"), 50);
    }},
    { label: "Split Down", action: "split-v", shortcut: "Ctrl+Shift+E", handler() {
      if (!isActive) tabs.switchToTab(wsIdx);
      setTimeout(() => tabs.splitActivePane("v"), 50);
    }},
    { label: "Duplicate Tab", action: "dup", handler() { tabs.duplicateWorkspace(wsId); }},
    { separator: true },
    { label: "Close", action: "close", disabled: !hasMultiple, handler() { tabs.closeWorkspace(wsId); }},
    { label: "Close Others", action: "close-others", disabled: !hasMultiple, handler() { tabs.closeOtherWorkspaces(wsId); }},
    { label: "Close to the Right", action: "close-right", disabled: !hasRight, handler() { tabs.closeWorkspacesToRight(wsId); }},
  ]);
});

// Workspace area right-click (pane headers and terminal area)
workspaceArea.addEventListener("contextmenu", (e) => {
  // Don't intercept right-click in xterm itself (it may have its own handling)
  // But we do want it on pane headers and empty space
  const paneLeaf = e.target.closest(".pane-leaf");
  if (!paneLeaf) return;

  const paneId = paneLeaf.dataset.paneId;
  const entry = getTerminal(paneId);
  if (!entry) return;

  // Only show our menu on pane-header or if user right-clicks in the terminal area
  e.preventDefault();

  // Make this pane active
  if (paneId !== tabs.getActivePaneId()) {
    tabs.setActivePane(paneId);
  }

  const term = entry.term;
  const hasSelection = term.hasSelection();

  ctxmenu.show(e.clientX, e.clientY, [
    { label: "Copy", action: "copy", shortcut: "Ctrl+Shift+C", disabled: !hasSelection, handler() {
      if (term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection()).catch(() => {});
        term.clearSelection();
      }
    }},
    { label: "Paste", action: "paste", shortcut: "Ctrl+Shift+V", handler() {
      navigator.clipboard.readText().then((text) => {
        if (text) pasteText(paneId, text);
      }).catch(() => {});
    }},
    { label: "Smart Paste", action: "smart-paste", shortcut: "Ctrl+Shift+B", handler() {
      smartPaste(paneId);
    }},
    { label: "Select All", action: "select-all", handler() { term.selectAll(); }},
    { separator: true },
    { label: "Clear Terminal", action: "clear", handler() { term.clear(); }},
    { separator: true },
    { label: "Continue Agent", action: "continue-agent", handler() {
      const cmd = buildAgentCommand({ continue: true });
      if (entry.ws && entry.ws.readyState === 1) {
        entry.ws.send(JSON.stringify({ type: "input", data: cmd + "\r" }));
      }
    }},
    { label: sttListening ? "Stop Recording" : "Start Recording", action: "stt", disabled: !SpeechRecognition, handler() { toggleSTT(); }},
    { separator: true },
    { label: "Split Right", action: "split-h", shortcut: "Ctrl+Shift+D", handler() { tabs.splitActivePane("h"); }},
    { label: "Split Down", action: "split-v", shortcut: "Ctrl+Shift+E", handler() { tabs.splitActivePane("v"); }},
    { separator: true },
    { label: "Close Pane", action: "close-pane", shortcut: "Ctrl+Shift+W", handler() { tabs.closeActivePane(); }},
  ]);
});

// Bottom panel right-click
bottomPanel.addEventListener("contextmenu", (e) => {
  if (!bottomTermEntry) return;
  e.preventDefault();

  const term = bottomTermEntry.term;
  const hasSelection = term.hasSelection();

  ctxmenu.show(e.clientX, e.clientY, [
    { label: "Copy", action: "copy", disabled: !hasSelection, handler() {
      if (term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection()).catch(() => {});
        term.clearSelection();
      }
    }},
    { label: "Paste", action: "paste", handler() {
      const bpId = bottomTermEntry?.paneId;
      if (bpId) {
        navigator.clipboard.readText().then((text) => {
          if (text) pasteText(bpId, text);
        }).catch(() => {});
      }
    }},
    { label: "Smart Paste", action: "smart-paste", handler() {
      const bpId = bottomTermEntry?.paneId;
      if (bpId) smartPaste(bpId);
    }},
    { label: "Select All", action: "select-all", handler() { term.selectAll(); }},
    { separator: true },
    { label: "Clear Terminal", action: "clear", handler() { term.clear(); }},
    { separator: true },
    { label: "Maximize", action: "maximize", handler() { $("bp-maximize").click(); }},
    { label: "Close Panel", action: "close-panel", shortcut: "Ctrl+`", handler() { closeBottomPanel(); }},
  ]);
});

// File tree right-click
$("file-tree").addEventListener("contextmenu", (e) => {
  const item = e.target.closest(".ft-item");
  if (!item) return;
  e.preventDefault();

  const filePath = item.dataset.path;
  const isDir = item.dataset.isDir === "true";
  const fileName = filePath.replace(/\\/g, "/").split("/").pop();

  const items = [];

  if (!isDir) {
    items.push({ label: "View File", action: "view", handler() {
      fileviewer.openFile(filePath);
    }});
    items.push({ label: "Git Diff", action: "diff", handler() {
      fileviewer.openDiff(filePath);
    }});
    // Pin / unpin
    const pinned = fileviewer.isPinned(filePath);
    items.push({ label: pinned ? "Unpin File" : "Pin File", action: "pin", handler() {
      if (pinned) fileviewer.unpinFile(filePath);
      else fileviewer.pinFile(filePath, fileName);
      sidebar.renderPinned();
    }});
    items.push({ separator: true });
    items.push({ label: "Open in Terminal (cat)", action: "cat", handler() {
      const paneId = tabs.getActivePaneId();
      if (paneId) sendInput(paneId, `cat "${filePath}"\r`);
    }});
  }

  if (isDir) {
    items.push({ label: "Launch Agent Here", action: "launch-agent", handler() {
      const cmd = buildAgentCommand();
      launchAgentInDir(filePath, cmd);
    }});
    items.push({ label: "Open New Session Here", action: "new-session", handler() {
      createSessionInDir(filePath);
    }});
    items.push({ label: "Start Worktree", action: "worktree", handler() {
      startWorktreeDialog(filePath);
    }});
    items.push({ separator: true });
  }

  items.push({ label: isDir ? "cd into" : "cd to folder", action: "cd", handler() {
    const dir = isDir ? filePath : filePath.replace(/\\/g, "/").replace(/\/[^/]+$/, "");
    const paneId = tabs.getActivePaneId();
    if (paneId) sendInput(paneId, `cd "${dir}"\r`);
  }});

  if (!isDir) {
    items.push({ label: "Open in bottom terminal", action: "open-bottom", handler() {
      if (bottomTermEntry && bottomTermEntry.ws && bottomTermEntry.ws.readyState === 1) {
        bottomTermEntry.ws.send(JSON.stringify({ type: "input", data: `cat "${filePath}"\r` }));
      } else {
        openBottomPanel().then(() => {
          setTimeout(() => {
            if (bottomTermEntry && bottomTermEntry.ws && bottomTermEntry.ws.readyState === 1) {
              bottomTermEntry.ws.send(JSON.stringify({ type: "input", data: `cat "${filePath}"\r` }));
            }
          }, 500);
        });
      }
    }});
  }

  items.push({ separator: true });
  items.push({ label: "Copy Path", action: "copy-path", handler() {
    navigator.clipboard.writeText(filePath).catch(() => {});
  }});
  items.push({ label: "Copy Name", action: "copy-name", handler() {
    navigator.clipboard.writeText(fileName).catch(() => {});
  }});

  ctxmenu.show(e.clientX, e.clientY, items);
});

// Git panel changed files — click to diff (or view for untracked), right-click for menu
$("git-panel").addEventListener("click", (e) => {
  // Don't intercept clicks on interactive elements (buttons, checkboxes, inputs, selects)
  if (e.target.closest(".gf-action, .gf-check, .gf-section-btn, .git-btn, .git-agent-resume-btn, .git-repo-agent-btn, .git-stash-btn, .git-stash-pop-btn, .git-stage-all-btn, .git-commit-btn, .git-push-btn, .git-branch-select, .git-commit-input, button, input, select")) return;
  const gitFile = e.target.closest(".git-file");
  if (!gitFile) return;
  const file = gitFile.dataset.file;
  const repo = gitFile.dataset.repo;
  const status = gitFile.dataset.status;
  if (!file) return;
  if (repo) fileviewer.setCwd(repo);
  const fullPath = repo ? (repo.replace(/\\/g, "/") + "/" + file) : file;
  // For untracked (??) or newly added (A) files, open file content since git diff returns nothing useful
  if (status === "??" || status === "A") {
    fileviewer.openFile(fullPath);
  } else {
    fileviewer.openDiff(file);
  }
});

$("git-panel").addEventListener("contextmenu", (e) => {
  const gitFile = e.target.closest(".git-file");
  if (!gitFile) return;
  e.preventDefault();

  const file = gitFile.dataset.file;
  const repo = gitFile.dataset.repo;
  if (!file) return;

  const fullPath = repo ? (repo.replace(/\\/g, "/") + "/" + file) : file;
  const isUntracked = gitFile.dataset.status === "??";
  const pinned = fileviewer.isPinned(fullPath);
  ctxmenu.show(e.clientX, e.clientY, [
    { label: "View Diff", action: "diff", disabled: isUntracked, handler() { if (repo) fileviewer.setCwd(repo); fileviewer.openDiff(file); }},
    { label: "View File", action: "view", handler() { if (repo) fileviewer.setCwd(repo); fileviewer.openFile(fullPath); }},
    { label: pinned ? "Unpin File" : "Pin File", action: "pin", handler() {
      if (pinned) fileviewer.unpinFile(fullPath);
      else fileviewer.pinFile(fullPath, file.replace(/\\/g, "/").split("/").pop());
      sidebar.renderPinned();
    }},
    { separator: true },
    { label: "Copy Path", action: "copy-path", handler() {
      navigator.clipboard.writeText(file).catch(() => {});
    }},
  ]);
});

// Dashboard session card right-click
$("dash-inner").addEventListener("contextmenu", (e) => {
  const sessionEl = e.target.closest("[data-session]");
  if (!sessionEl) return;
  e.preventDefault();

  const sid = parseInt(sessionEl.dataset.session, 10);
  const meta = (RT.sessions || []).find(s => s.id === sid);

  ctxmenu.show(e.clientX, e.clientY, [
    { label: "Open in New Tab", action: "open", handler() {
      if (meta) tabs.setSessionMeta(sid, meta);
      // Switch to existing workspace if session is already open
      const existing = tabs.findWorkspaceBySession(sid);
      if (existing) {
        showTerminals();
        tabs.switchToWorkspace(existing);
      } else {
        showTerminals();
        tabs.createWorkspace(meta?.name || "Session " + sid, sid, meta);
      }
    }},
    { label: "Copy Session ID", action: "copy-id", handler() {
      navigator.clipboard.writeText(String(sid)).catch(() => {});
    }},
    { separator: true },
    { label: "Continue Agent Here", action: "continue-agent", handler() {
      // Open the session and type the agent continue command
      const existing = tabs.findWorkspaceBySession(sid);
      if (existing) {
        showTerminals();
        tabs.switchToWorkspace(existing);
      } else {
        showTerminals();
        tabs.createWorkspace(meta?.name || "Session " + sid, sid, meta);
      }
      // Send the command after a short delay to let the terminal connect
      setTimeout(() => {
        const paneId = tabs.getActivePaneId();
        if (paneId) {
          const cmd = buildAgentCommand({ continue: true });
          sendInput(paneId, cmd + "\r");
        }
      }, 800);
    }},
    { label: "Restart Session", action: "restart", handler() {
      fetch(api("/api/sessions/" + sid + "/restart"), { method: "POST" })
        .then(r => r.json())
        .then(data => {
          if (data.ok) {
            notif.showToast(null, "Session " + sid + " restarted", "success");
            fetch(api("/api/sessions")).then(r => r.json()).then(s => { RT.sessions = s; renderDashboard(); }).catch(() => {});
          } else {
            notif.showToast(null, data.error || "Restart failed", "error");
          }
        })
        .catch(() => notif.showToast(null, "Restart failed", "error"));
    }},
    { label: "Delete Session", action: "delete", handler() {
      // Close any workspace tab that references this session
      tabs.closeWorkspacesWithSession(sid);
      // Then delete the server-side session
      fetch(api("/api/sessions/" + sid), { method: "DELETE" }).catch(() => {});
      sessionEl.remove();
    }},
  ]);
});

// ---------------------------------------------------------------------------
// Drag-and-drop file upload (like Cursor)
// ---------------------------------------------------------------------------
workspaceArea.addEventListener("dragover", (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
  workspaceArea.classList.add("drag-over");
});

workspaceArea.addEventListener("dragleave", (e) => {
  // Only remove when leaving the workspace area entirely
  if (!workspaceArea.contains(e.relatedTarget)) {
    workspaceArea.classList.remove("drag-over");
  }
});

workspaceArea.addEventListener("drop", async (e) => {
  e.preventDefault();
  workspaceArea.classList.remove("drag-over");

  // Session drag from sessions panel — open session as terminal tab
  const sessionData = e.dataTransfer?.getData("text/agenv-session");
  if (sessionData) {
    try {
      const sess = JSON.parse(sessionData);
      if (sess && sess.id != null) {
        tabs.setSessionMeta(sess.id, sess);
        const existing = tabs.findWorkspaceBySession(sess.id);
        if (existing) {
          tabs.switchToWorkspace(existing);
        } else {
          await tabs.createWorkspace(sess.name || "Session " + sess.id, sess.id, sess);
        }
      }
    } catch {}
    return;
  }

  // Internal file drag from sidebar explorer
  const internalPath = e.dataTransfer?.getData("text/agenv-path");
  if (internalPath) {
    const paneLeaf = e.target.closest(".pane-leaf");
    if (paneLeaf) {
      // Dropped on a terminal pane — insert file path
      const paneId = paneLeaf.dataset.paneId;
      if (paneId) {
        const p = internalPath.includes(" ") ? `"${internalPath}"` : internalPath;
        sendInput(paneId, p + " ");
      }
    } else {
      // Dropped on workspace area — open as editor tab
      tabs.createEditorWorkspace(internalPath);
    }
    return;
  }

  const files = e.dataTransfer?.files;
  if (!files || files.length === 0) return;

  for (const file of files) {
    try {
      notif.showToast(null, `Uploading ${file.name}...`, "info");
      const base64 = await fileToBase64(file);
      const resp = await fetch(api("/api/upload"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, data: base64, type: file.type }),
      });
      if (resp.ok) {
        const data = await resp.json();
        // Insert the file path into the active terminal
        const paneId = tabs.getActivePaneId();
        if (paneId) {
          // Quote path if it has spaces
          const p = data.path.includes(" ") ? `"${data.path}"` : data.path;
          sendInput(paneId, p + " ");
        }
        notif.showToast(null, `Uploaded: ${file.name}`, "success");
      } else {
        notif.showToast(null, `Upload failed: ${file.name}`, "error");
      }
    } catch {
      notif.showToast(null, `Upload failed: ${file.name}`, "error");
    }
  }
});

// ---------------------------------------------------------------------------
// Clipboard paste — images from clipboard (like Cursor)
// ---------------------------------------------------------------------------
document.addEventListener("paste", async (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;

  // Check for image data or files in clipboard
  let imageItem = null;
  let fileItems = [];
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      imageItem = item;
    }
    if (item.kind === "file") {
      fileItems.push(item);
    }
  }

  // Also check clipboardData.files (for OS-copied files)
  const clipFiles = e.clipboardData?.files;
  if (!imageItem && fileItems.length === 0 && (!clipFiles || clipFiles.length === 0)) return;

  // Only intercept if a terminal pane is focused (not editing a real text field)
  // xterm uses a hidden textarea with class "xterm-helper-textarea" — allow paste through for that
  const ae = document.activeElement;
  const tag = ae?.tagName;
  const isXtermTextarea = ae?.classList?.contains("xterm-helper-textarea");
  if ((tag === "INPUT" || tag === "TEXTAREA" || ae?.isContentEditable) && !isXtermTextarea) return;

  e.preventDefault();

  // Upload helper
  async function uploadAndInsert(file, label) {
    try {
      notif.showToast(null, `Uploading ${label}...`, "info");
      const base64 = await fileToBase64(file);
      const resp = await fetch(api("/api/upload"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name || label, data: base64, type: file.type }),
      });
      if (resp.ok) {
        const data = await resp.json();
        const paneId = tabs.getActivePaneId();
        if (paneId) {
          const p = data.path.includes(" ") ? `"${data.path}"` : data.path;
          sendInput(paneId, p + " ");
        }
        notif.showToast(null, `Uploaded: ${label}`, "success");
      } else {
        notif.showToast(null, `Upload failed: ${label}`, "error");
      }
    } catch {
      notif.showToast(null, `Upload failed: ${label}`, "error");
    }
  }

  // Handle clipboard files first (OS file copy)
  if (clipFiles && clipFiles.length > 0) {
    for (const file of clipFiles) {
      await uploadAndInsert(file, file.name);
    }
    return;
  }

  // Handle image item from clipboard
  if (imageItem) {
    const blob = imageItem.getAsFile();
    if (!blob) return;
    const ext = imageItem.type === "image/png" ? ".png" : imageItem.type === "image/jpeg" ? ".jpg" : ".png";
    await uploadAndInsert(blob, "clipboard" + ext);
    return;
  }

  // Handle other file items
  for (const item of fileItems) {
    const file = item.getAsFile();
    if (file) await uploadAndInsert(file, file.name || "clipboard-file");
  }
});

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      // Remove data:...;base64, prefix
      const idx = result.indexOf(",");
      resolve(idx >= 0 ? result.substring(idx + 1) : result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
if (RT.sessions && RT.sessions.length) {
  for (const s of RT.sessions) {
    tabs.setSessionMeta(s.id, { name: s.name, cwd: s.cwd, tool: s.tool, status: s.status, group: s.group, note: s.note, analytics: s.analytics });
  }
}

// Try to restore previous workspace layout — if not, show dashboard
(async () => {
  const layout = RT.workspaceLayout;
  if (layout && Array.isArray(layout) && layout.length > 0) {
    // Validate that the sessions referenced in the layout still exist
    const activeSids = new Set((RT.sessions || []).map(s => s.id));
    const layoutValid = layout.every(ws => {
      if (!ws.rootNode) return false;
      const sids = collectNodeSessionIds(ws.rootNode);
      return sids.length > 0 && sids.every(sid => activeSids.has(sid));
    });
    if (layoutValid) {
      showTerminals();
      const restored = await tabs.restoreLayout(layout);
      if (restored) return;
    }
  }
  showDashboard();
})();

function collectNodeSessionIds(node) {
  if (!node) return [];
  if (node.type === "leaf") return [node.sessionId];
  return (node.children || []).flatMap(c => collectNodeSessionIds(c));
}
