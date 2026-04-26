// claude-search.js — Claude Session Search & Reuse extension
// Indexes all Claude Code conversations across projects, extracts keywords,
// and provides a searchable interface to find and resume past agent sessions.

import { api, esc, ago, short, fname } from "./util.js";

let panelEl = null;
let _onResumeSession = null;  // (cwd, command) => {}
let _onOpenInTerminal = null; // (cwd) => {}
let _showContextMenu = null;

let allSessions = [];
let filteredSessions = [];
let topKeywords = [];
let searchQuery = "";
let activeKeywords = new Set();
let projectFilter = "";
let modelFilter = "";
let sortBy = "recent"; // recent | cost | tokens | messages
let expandedId = null;
let expandedEntries = null; // conversation entries for expanded session
let pollTimer = null;
let loading = false;

// ---- Init ----
export function init(opts) {
  panelEl = opts.panel;
  _onResumeSession = opts.onResumeSession || null;
  _onOpenInTerminal = opts.onOpenInTerminal || null;
  _showContextMenu = opts.showContextMenu || null;
  if (!panelEl) return;
  renderShell();
  panelEl.addEventListener("click", handleClick);
  panelEl.addEventListener("input", handleInput);
  panelEl.addEventListener("contextmenu", handleContextMenu);
}

export function startPolling() { stopPolling(); pollTimer = setInterval(() => refresh(false), 30000); }
export function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

export async function refresh(showLoading = true) {
  if (showLoading) { loading = true; renderBody(); }
  try {
    const url = searchQuery
      ? api("/api/claude/search?q=" + encodeURIComponent(searchQuery))
      : api("/api/claude/sessions");
    const resp = await fetch(url);
    if (!resp.ok) return;
    const data = await resp.json();
    if (searchQuery) {
      filteredSessions = data;
    } else {
      allSessions = data;
      buildTopKeywords();
      applyFilters();
    }
  } catch {} finally {
    loading = false;
    renderBody();
  }
}

function buildTopKeywords() {
  const kwCount = new Map();
  for (const s of allSessions) {
    for (const k of s.keywords.slice(0, 5)) {
      kwCount.set(k, (kwCount.get(k) || 0) + 1);
    }
  }
  topKeywords = [...kwCount.entries()]
    .filter(([, c]) => c >= 2) // only show keywords that appear in 2+ sessions
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([k]) => k);
}

function applyFilters() {
  let result = allSessions;
  if (projectFilter) result = result.filter(s => s.project === projectFilter);
  if (modelFilter) result = result.filter(s => s.model.includes(modelFilter));
  if (activeKeywords.size > 0) {
    result = result.filter(s =>
      [...activeKeywords].every(ak => s.keywords.some(k => k.includes(ak)))
    );
  }
  if (sortBy === "cost") result = [...result].sort((a, b) => b.estimatedCost - a.estimatedCost);
  else if (sortBy === "tokens") result = [...result].sort((a, b) => (b.totalInputTokens + b.totalOutputTokens) - (a.totalInputTokens + a.totalOutputTokens));
  else if (sortBy === "messages") result = [...result].sort((a, b) => b.userMessageCount - a.userMessageCount);
  filteredSessions = result;
}

// ---- Formatting helpers ----
function fmtTokens(n) {
  if (!n) return "0";
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1000).toFixed(1) + "K";
  return (n / 1e6).toFixed(2) + "M";
}

function fmtCost(c) {
  if (!c) return "";
  if (c < 0.01) return "$" + c.toFixed(4);
  if (c < 1) return "$" + c.toFixed(2);
  return "$" + c.toFixed(2);
}

function modelShort(m) {
  if (!m) return "?";
  if (m.includes("opus")) return "Opus";
  if (m.includes("sonnet")) return "Sonnet";
  if (m.includes("haiku")) return "Haiku";
  return m.split("-").pop();
}

function projectShort(p) {
  if (!p) return "";
  // "C--Projects-remotecontrol" → "remotecontrol"
  const parts = p.split("-");
  return parts[parts.length - 1] || p;
}

function dateShort(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const diffDays = Math.floor((now - d) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return diffDays + "d ago";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function dateRange(first, last) {
  if (!first) return "";
  const f = new Date(first);
  const l = last ? new Date(last) : f;
  const fStr = f.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const lStr = l.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (fStr === lStr) return fStr;
  return fStr + " – " + lStr;
}

// ---- Rendering ----
function renderShell() {
  panelEl.innerHTML = `
    <div class="cs-header">
      <span class="cs-title">Claude Sessions</span>
      <div class="cs-actions">
        <button class="cs-btn" data-act="reindex" title="Re-index all sessions">&#8635;</button>
      </div>
    </div>
    <div class="cs-search">
      <input type="text" class="cs-search-input" placeholder="Search sessions, keywords, files..." id="cs-search" />
    </div>
    <div class="cs-filters" id="cs-filters"></div>
    <div class="cs-keywords" id="cs-keywords"></div>
    <div class="cs-body" id="cs-body"></div>
    <div class="cs-footer" id="cs-footer"></div>
  `;
}

function renderBody() {
  const body = panelEl.querySelector("#cs-body");
  const footer = panelEl.querySelector("#cs-footer");
  const filtersEl = panelEl.querySelector("#cs-filters");
  const kwEl = panelEl.querySelector("#cs-keywords");
  if (!body) return;

  // Filters bar
  if (!searchQuery && allSessions.length > 0) {
    const projects = [...new Set(allSessions.map(s => s.project))];
    const models = [...new Set(allSessions.map(s => modelShort(s.model)))];

    let fh = "";
    fh += `<select class="cs-filter-select" id="cs-proj-filter"><option value="">All projects</option>`;
    for (const p of projects) fh += `<option value="${esc(p)}"${p === projectFilter ? " selected" : ""}>${esc(projectShort(p))}</option>`;
    fh += `</select>`;
    fh += `<select class="cs-filter-select" id="cs-model-filter"><option value="">All models</option>`;
    for (const m of models) fh += `<option value="${esc(m.toLowerCase())}"${m.toLowerCase() === modelFilter ? " selected" : ""}>${esc(m)}</option>`;
    fh += `</select>`;
    fh += `<select class="cs-filter-select" id="cs-sort"><option value="recent"${sortBy === "recent" ? " selected" : ""}>Recent</option>`;
    fh += `<option value="cost"${sortBy === "cost" ? " selected" : ""}>Cost</option>`;
    fh += `<option value="tokens"${sortBy === "tokens" ? " selected" : ""}>Tokens</option>`;
    fh += `<option value="messages"${sortBy === "messages" ? " selected" : ""}>Messages</option></select>`;
    filtersEl.innerHTML = fh;
  } else {
    filtersEl.innerHTML = "";
  }

  // Keyword tags
  if (!searchQuery && topKeywords.length > 0) {
    let kh = "";
    for (const k of topKeywords) {
      const isActive = activeKeywords.has(k);
      kh += `<span class="cs-kw-tag${isActive ? " active" : ""}" data-kw="${esc(k)}">${esc(k)}</span>`;
    }
    kwEl.innerHTML = kh;
  } else {
    kwEl.innerHTML = "";
  }

  // Body
  if (loading) {
    body.innerHTML = `<div class="cs-loading">Indexing sessions...</div>`;
    footer.innerHTML = "";
    return;
  }

  if (filteredSessions.length === 0) {
    body.innerHTML = `<div class="cs-empty">
      <div class="cs-empty-icon">C</div>
      <div class="cs-empty-text">${searchQuery ? "No sessions matching \"" + esc(searchQuery) + "\"" : "No Claude sessions found"}</div>
      ${!searchQuery ? '<div class="cs-empty-hint">Claude Code conversations from ~/.claude/projects/ will appear here</div>' : ""}
    </div>`;
    footer.innerHTML = "";
    return;
  }

  let h = "";
  // Group by project
  if (!searchQuery && !projectFilter && filteredSessions.length > 5) {
    const byProject = new Map();
    for (const s of filteredSessions) {
      if (!byProject.has(s.project)) byProject.set(s.project, []);
      byProject.get(s.project).push(s);
    }
    for (const [proj, sessions] of byProject) {
      const projCost = sessions.reduce((sum, s) => sum + s.estimatedCost, 0);
      h += `<div class="cs-project-group">`;
      h += `<div class="cs-proj-header" data-project="${esc(proj)}">`;
      h += `<span class="cs-proj-name">${esc(projectShort(proj))}</span>`;
      h += `<span class="cs-proj-count">${sessions.length}</span>`;
      if (projCost > 0.01) h += `<span class="cs-proj-cost">${fmtCost(projCost)}</span>`;
      h += `</div>`;
      for (const s of sessions) h += renderCard(s);
      h += `</div>`;
    }
  } else {
    for (const s of filteredSessions) h += renderCard(s);
  }

  body.innerHTML = h;

  // Footer stats
  const total = filteredSessions.length;
  const totalCost = filteredSessions.reduce((sum, s) => sum + s.estimatedCost, 0);
  const totalTok = filteredSessions.reduce((sum, s) => sum + s.totalInputTokens + s.totalOutputTokens, 0);
  let ft = `${total} session${total !== 1 ? "s" : ""}`;
  if (totalCost > 0) ft += ` &middot; <span class="cs-ft-cost">${fmtCost(totalCost)}</span>`;
  if (totalTok > 0) ft += ` &middot; ${fmtTokens(totalTok)} tok`;
  footer.innerHTML = ft;
}

function renderCard(s) {
  const isExpanded = expandedId === s.id;
  const score = s.score ? ` <span class="cs-score">${s.score}pts</span>` : "";

  let h = `<div class="cs-card${isExpanded ? " expanded" : ""}" data-id="${esc(s.id)}">`;
  h += `<div class="cs-card-main">`;
  h += `<div class="cs-card-left">`;
  h += `<div class="cs-model-badge ${modelShort(s.model).toLowerCase()}">${modelShort(s.model).charAt(0)}</div>`;
  h += `</div>`;
  h += `<div class="cs-card-info">`;
  h += `<div class="cs-card-title">${esc(s.slug || s.id.slice(0, 8))}${score}</div>`;
  h += `<div class="cs-card-proj">${esc(projectShort(s.project))}${s.branch ? " / " + esc(s.branch) : ""}</div>`;
  h += `<div class="cs-card-meta">`;
  h += `<span class="cs-card-date">${dateShort(s.lastMessage)}</span>`;
  h += `<span class="cs-card-msgs">${s.userMessageCount}msg</span>`;
  if (s.estimatedCost > 0) h += `<span class="cs-card-cost">${fmtCost(s.estimatedCost)}</span>`;
  h += `<span class="cs-card-tok">${fmtTokens(s.totalInputTokens + s.totalOutputTokens)}</span>`;
  h += `</div>`;
  // Keywords
  if (s.keywords.length > 0) {
    h += `<div class="cs-card-kws">`;
    for (const k of s.keywords.slice(0, 6)) {
      h += `<span class="cs-card-kw">${esc(k)}</span>`;
    }
    h += `</div>`;
  }
  // Summary
  if (s.summary) {
    h += `<div class="cs-card-summary">${esc(s.summary.slice(0, 120))}${s.summary.length > 120 ? "..." : ""}</div>`;
  }
  h += `</div>`;
  h += `<div class="cs-card-right">`;
  h += `<button class="cs-card-btn resume" data-act="resume" data-id="${esc(s.id)}" title="Resume in terminal">&#9654;</button>`;
  h += `<button class="cs-card-btn" data-act="expand" data-id="${esc(s.id)}" title="Details">${isExpanded ? "\u25B2" : "\u25BC"}</button>`;
  h += `</div>`;
  h += `</div>`;

  // Expanded detail
  if (isExpanded) {
    h += renderDetail(s);
  }

  h += `</div>`;
  return h;
}

function renderDetail(s) {
  let h = `<div class="cs-detail">`;

  // Stats
  h += `<div class="cs-detail-grid">`;
  h += `<div class="cs-ds"><span class="cs-dl">Model</span><span class="cs-dv">${esc(modelShort(s.model))}</span></div>`;
  h += `<div class="cs-ds"><span class="cs-dl">Messages</span><span class="cs-dv">${s.userMessageCount} user / ${s.messageCount} total</span></div>`;
  h += `<div class="cs-ds"><span class="cs-dl">Tokens</span><span class="cs-dv">${fmtTokens(s.totalInputTokens)} in / ${fmtTokens(s.totalOutputTokens)} out</span></div>`;
  h += `<div class="cs-ds"><span class="cs-dl">Cost</span><span class="cs-dv cs-cost">${fmtCost(s.estimatedCost) || "\u2014"}</span></div>`;
  h += `<div class="cs-ds"><span class="cs-dl">Period</span><span class="cs-dv">${dateRange(s.firstMessage, s.lastMessage)}</span></div>`;
  h += `<div class="cs-ds"><span class="cs-dl">Entry</span><span class="cs-dv">${esc(s.entrypoint)}</span></div>`;
  h += `</div>`;

  // Project path
  h += `<div class="cs-detail-row"><span class="cs-dl">Project</span><span class="cs-dv cs-path">${esc(s.cwd || s.projectPath)}</span></div>`;
  if (s.branch) h += `<div class="cs-detail-row"><span class="cs-dl">Branch</span><span class="cs-dv">${esc(s.branch)}</span></div>`;

  // Files edited
  if (s.filesEdited.length > 0) {
    h += `<div class="cs-detail-section"><span class="cs-dl">Files Edited</span><div class="cs-file-list">`;
    for (const f of s.filesEdited) h += `<span class="cs-file-tag">${esc(f)}</span>`;
    h += `</div></div>`;
  }

  // Commands
  if (s.commands.length > 0) {
    h += `<div class="cs-detail-section"><span class="cs-dl">Commands</span><div class="cs-cmd-list">`;
    for (const c of s.commands.slice(0, 10)) h += `<div class="cs-cmd-item">${esc(c)}</div>`;
    h += `</div></div>`;
  }

  // All keywords
  if (s.keywords.length > 6) {
    h += `<div class="cs-detail-section"><span class="cs-dl">All Keywords</span><div class="cs-card-kws">`;
    for (const k of s.keywords) h += `<span class="cs-card-kw">${esc(k)}</span>`;
    h += `</div></div>`;
  }

  // Conversation preview (loaded async)
  h += `<div class="cs-detail-section"><span class="cs-dl">Conversation</span>`;
  if (expandedEntries) {
    h += `<div class="cs-convo">`;
    for (const e of expandedEntries.slice(0, 20)) {
      if (e.type === "user") {
        h += `<div class="cs-convo-user"><span class="cs-convo-role">You:</span> ${esc(e.text.slice(0, 200))}${e.text.length > 200 ? "..." : ""}</div>`;
      } else {
        h += `<div class="cs-convo-asst"><span class="cs-convo-role">${esc(modelShort(e.model))}:</span> ${esc(e.text.slice(0, 300))}${e.text.length > 300 ? "..." : ""}</div>`;
      }
    }
    h += `</div>`;
  } else {
    h += `<div class="cs-convo-loading">Loading conversation...</div>`;
  }
  h += `</div>`;

  // Action buttons
  h += `<div class="cs-detail-actions">`;
  h += `<button class="cs-d-btn resume" data-act="resume" data-id="${esc(s.id)}">&#9654; Resume Agent</button>`;
  h += `<button class="cs-d-btn" data-act="open-dir" data-id="${esc(s.id)}">Open Folder</button>`;
  h += `<button class="cs-d-btn" data-act="copy-id" data-id="${esc(s.id)}">Copy ID</button>`;
  h += `</div>`;

  h += `</div>`;
  return h;
}

// ---- Event handlers ----
let searchTimer = null;

function handleInput(e) {
  if (e.target.classList.contains("cs-search-input")) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchQuery = e.target.value.trim();
      refresh(true);
    }, 400);
    return;
  }
  if (e.target.id === "cs-proj-filter") {
    projectFilter = e.target.value;
    applyFilters();
    renderBody();
    return;
  }
  if (e.target.id === "cs-model-filter") {
    modelFilter = e.target.value;
    applyFilters();
    renderBody();
    return;
  }
  if (e.target.id === "cs-sort") {
    sortBy = e.target.value;
    applyFilters();
    renderBody();
    return;
  }
}

function handleClick(e) {
  // Keyword tag toggle
  const kwTag = e.target.closest(".cs-kw-tag");
  if (kwTag && kwTag.closest("#cs-keywords")) {
    const kw = kwTag.dataset.kw;
    if (activeKeywords.has(kw)) activeKeywords.delete(kw);
    else activeKeywords.add(kw);
    applyFilters();
    renderBody();
    return;
  }

  // Card action buttons
  const actionBtn = e.target.closest(".cs-card-btn, .cs-d-btn");
  if (actionBtn) {
    e.stopPropagation();
    const act = actionBtn.dataset.act;
    const id = actionBtn.dataset.id;
    const s = filteredSessions.find(x => x.id === id) || allSessions.find(x => x.id === id);

    if (act === "resume" && s) {
      const cwd = s.cwd || s.projectPath;
      if (_onResumeSession) _onResumeSession(cwd, "claude --continue");
      return;
    }
    if (act === "open-dir" && s) {
      const cwd = s.cwd || s.projectPath;
      if (_onOpenInTerminal) _onOpenInTerminal(cwd);
      return;
    }
    if (act === "copy-id" && s) {
      navigator.clipboard.writeText(s.id).catch(() => {});
      return;
    }
    if (act === "expand" && s) {
      if (expandedId === id) {
        expandedId = null;
        expandedEntries = null;
      } else {
        expandedId = id;
        expandedEntries = null;
        loadConversation(id);
      }
      renderBody();
      return;
    }
    return;
  }

  // Header actions
  const headerBtn = e.target.closest("[data-act]");
  if (headerBtn) {
    const act = headerBtn.dataset.act;
    if (act === "reindex") {
      loading = true;
      renderBody();
      fetch(api("/api/claude/reindex"), { method: "POST" })
        .then(() => refresh(false))
        .catch(() => { loading = false; renderBody(); });
    }
    return;
  }

  // Card click → expand
  const card = e.target.closest(".cs-card");
  if (card && !e.target.closest(".cs-card-btn, .cs-d-btn, .cs-card-kw")) {
    const id = card.dataset.id;
    if (expandedId === id) {
      expandedId = null;
      expandedEntries = null;
    } else {
      expandedId = id;
      expandedEntries = null;
      loadConversation(id);
    }
    renderBody();
  }
}

async function loadConversation(id) {
  try {
    const resp = await fetch(api("/api/claude/sessions/" + id));
    if (!resp.ok) return;
    const data = await resp.json();
    if (expandedId === id) {
      expandedEntries = data.entries || [];
      renderBody();
    }
  } catch {}
}

function handleContextMenu(e) {
  if (!_showContextMenu) return;
  const card = e.target.closest(".cs-card");
  if (!card) return;
  e.preventDefault();
  const id = card.dataset.id;
  const s = filteredSessions.find(x => x.id === id) || allSessions.find(x => x.id === id);
  if (!s) return;

  const cwd = s.cwd || s.projectPath;
  _showContextMenu(e.clientX, e.clientY, [
    { label: "Resume Agent (--continue)", action: "resume", handler() { if (_onResumeSession) _onResumeSession(cwd, "claude --continue"); } },
    { label: "Open Terminal in Folder", action: "open-dir", handler() { if (_onOpenInTerminal) _onOpenInTerminal(cwd); } },
    { separator: true },
    { label: "Filter by Project", action: "filter-proj", handler() {
      projectFilter = s.project;
      applyFilters();
      renderBody();
    }},
    { label: "Filter by Model", action: "filter-model", handler() {
      modelFilter = modelShort(s.model).toLowerCase();
      applyFilters();
      renderBody();
    }},
    { separator: true },
    { label: "Copy Session ID", action: "copy-id", handler() { navigator.clipboard.writeText(s.id).catch(() => {}); } },
    { label: "Copy Project Path", action: "copy-path", handler() { navigator.clipboard.writeText(cwd).catch(() => {}); } },
  ]);
}
