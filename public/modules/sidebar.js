// sidebar.js — file explorer + git panel sidebar

import { api, esc, fname } from "./util.js";
import { getPinnedFiles, unpinFile, pinFile, isPinned } from "./fileviewer.js";
import * as ai from "./ai.js";

let sidebarEl = null;
let treeEl = null;
let pinnedEl = null;
let sidebarDivider = null;
let mainEl = null;
let visible = false;
let currentDir = "";
let activeTab = "files-panel";
let onFileAction = null;
let onRefreshRequest = null;
let getDefaultAgent = null;
let onLaunchAgent = null;

// Session tracking
let connectedSessionId = null;
let connectedSessionName = "";
let sesDotEl = null;
let sesLabelEl = null;

// SVG icon templates
const _f = (color, letter) => `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 1h7l4 4v10H3V1z" fill="${color}" fill-opacity=".15" stroke="${color}" stroke-width="1.2"/><text x="8" y="12" text-anchor="middle" font-size="7" font-weight="700" font-family="sans-serif" fill="${color}">${letter}</text></svg>`;
const _fi = (color, d) => `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 1h7l4 4v10H3V1z" fill="${color}" fill-opacity=".15" stroke="${color}" stroke-width="1.2"/><path d="${d}" fill="${color}"/></svg>`;
const _folder = (color) => `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 3h5l2 2h7v9H1V3z" fill="${color}" fill-opacity=".25" stroke="${color}" stroke-width="1.2"/></svg>`;
const _folderOpen = (color) => `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 3h5l2 2h7v2H4l-3 7V3z" fill="${color}" fill-opacity=".25" stroke="${color}" stroke-width="1.2"/><path d="M1 7h13l-3 7H1z" fill="${color}" fill-opacity=".18"/></svg>`;
const _img = (color) => `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="1.5" y="1.5" width="13" height="13" rx="1.5" fill="${color}" fill-opacity=".15" stroke="${color}" stroke-width="1.2"/><circle cx="5.5" cy="5.5" r="1.5" fill="${color}"/><path d="M2 13l4-5 3 3 2-2 3 4H2z" fill="${color}" fill-opacity=".4"/></svg>`;
const _gear = (color) => `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 1h7l4 4v10H3V1z" fill="${color}" fill-opacity=".15" stroke="${color}" stroke-width="1.2"/><circle cx="8.5" cy="9.5" r="2" stroke="${color}" stroke-width="1.1" fill="none"/></svg>`;

const FILE_ICONS = {
  // JavaScript / TypeScript
  js:    { svg: _f("#e8d44d", "JS"), color: "#e8d44d" },
  mjs:   { svg: _f("#e8d44d", "JS"), color: "#e8d44d" },
  cjs:   { svg: _f("#e8d44d", "JS"), color: "#e8d44d" },
  jsx:   { svg: _f("#61dafb", "JX"), color: "#61dafb" },
  ts:    { svg: _f("#3178c6", "TS"), color: "#3178c6" },
  tsx:   { svg: _f("#3178c6", "TX"), color: "#3178c6" },
  // Python
  py:    { svg: _f("#3572a5", "Py"), color: "#3572a5" },
  pyw:   { svg: _f("#3572a5", "Py"), color: "#3572a5" },
  // Go / Rust / Ruby / Java / C
  go:    { svg: _f("#00add8", "Go"), color: "#00add8" },
  rs:    { svg: _f("#dea584", "Rs"), color: "#dea584" },
  rb:    { svg: _f("#cc342d", "Rb"), color: "#cc342d" },
  java:  { svg: _f("#b07219", "Jv"), color: "#b07219" },
  kt:    { svg: _f("#a97bff", "Kt"), color: "#a97bff" },
  c:     { svg: _f("#555555", "C"),  color: "#555555" },
  cpp:   { svg: _f("#f34b7d", "C+"), color: "#f34b7d" },
  cc:    { svg: _f("#f34b7d", "C+"), color: "#f34b7d" },
  h:     { svg: _f("#a074c4", "H"),  color: "#a074c4" },
  hpp:   { svg: _f("#a074c4", "H"),  color: "#a074c4" },
  cs:    { svg: _f("#68217a", "C#"), color: "#68217a" },
  swift: { svg: _f("#f05138", "Sw"), color: "#f05138" },
  php:   { svg: _f("#4f5d95", "Ph"), color: "#4f5d95" },
  // Web
  html:  { svg: _f("#e34c26", "H"),  color: "#e34c26" },
  htm:   { svg: _f("#e34c26", "H"),  color: "#e34c26" },
  css:   { svg: _f("#563d7c", "C"),  color: "#563d7c" },
  scss:  { svg: _f("#c6538c", "S"),  color: "#c6538c" },
  sass:  { svg: _f("#c6538c", "S"),  color: "#c6538c" },
  less:  { svg: _f("#1d365d", "L"),  color: "#1d365d" },
  vue:   { svg: _f("#41b883", "V"),  color: "#41b883" },
  svelte:{ svg: _f("#ff3e00", "Sv"), color: "#ff3e00" },
  // Data / Config
  json:  { svg: _f("#cbcb41", "{}"), color: "#cbcb41" },
  jsonc: { svg: _f("#cbcb41", "{}"), color: "#cbcb41" },
  yaml:  { svg: _f("#cb171e", "Y"),  color: "#cb171e" },
  yml:   { svg: _f("#cb171e", "Y"),  color: "#cb171e" },
  toml:  { svg: _f("#9c4121", "T"),  color: "#9c4121" },
  ini:   { svg: _gear("#848484"),    color: "#848484" },
  xml:   { svg: _f("#e37933", "X"),  color: "#e37933" },
  csv:   { svg: _f("#237346", "Cs"), color: "#237346" },
  sql:   { svg: _f("#e38c00", "Sq"), color: "#e38c00" },
  // Docs
  md:    { svg: _f("#519aba", "M"),  color: "#519aba" },
  mdx:   { svg: _f("#519aba", "Mx"), color: "#519aba" },
  txt:   { svg: _f("#848484", "T"),  color: "#848484" },
  pdf:   { svg: _f("#ec1c24", "Pd"), color: "#ec1c24" },
  doc:   { svg: _f("#2b579a", "W"),  color: "#2b579a" },
  docx:  { svg: _f("#2b579a", "W"),  color: "#2b579a" },
  // Shell / DevOps
  sh:    { svg: _f("#3fb950", "#"),  color: "#3fb950" },
  bash:  { svg: _f("#3fb950", "#"),  color: "#3fb950" },
  zsh:   { svg: _f("#3fb950", "#"),  color: "#3fb950" },
  fish:  { svg: _f("#3fb950", "#"),  color: "#3fb950" },
  ps1:   { svg: _f("#012456", "Ps"), color: "#012456" },
  bat:   { svg: _f("#c1f12e", "Bt"), color: "#c1f12e" },
  cmd:   { svg: _f("#c1f12e", "Cm"), color: "#c1f12e" },
  dockerfile: { svg: _f("#384d54", "Dk"), color: "#384d54" },
  // Images
  png:   { svg: _img("#3fb950"), color: "#3fb950" },
  jpg:   { svg: _img("#3fb950"), color: "#3fb950" },
  jpeg:  { svg: _img("#3fb950"), color: "#3fb950" },
  gif:   { svg: _img("#3fb950"), color: "#3fb950" },
  webp:  { svg: _img("#3fb950"), color: "#3fb950" },
  ico:   { svg: _img("#3fb950"), color: "#3fb950" },
  svg:   { svg: _f("#ffb13b", "Sv"), color: "#ffb13b" },
  // Archives
  zip:   { svg: _f("#6d8086", "Zp"), color: "#6d8086" },
  tar:   { svg: _f("#6d8086", "Tr"), color: "#6d8086" },
  gz:    { svg: _f("#6d8086", "Gz"), color: "#6d8086" },
  "7z":  { svg: _f("#6d8086", "7z"), color: "#6d8086" },
  rar:   { svg: _f("#6d8086", "Rr"), color: "#6d8086" },
  // Special
  lock:  { svg: _gear("#848484"),    color: "#848484" },
  env:   { svg: _f("#faf743", "E"),  color: "#faf743" },
  gitignore: { svg: _f("#f54d27", "Gi"), color: "#f54d27" },
  editorconfig: { svg: _gear("#848484"), color: "#848484" },
  eslintrc: { svg: _f("#4b32c3", "Es"), color: "#4b32c3" },
  prettierrc: { svg: _f("#56b3b4", "Pr"), color: "#56b3b4" },
  log:   { svg: _f("#848484", "Lg"), color: "#848484" },
  map:   { svg: _f("#848484", "Mp"), color: "#848484" },
  wasm:  { svg: _f("#654ff0", "Wm"), color: "#654ff0" },
};

const FOLDER_ICON = _folder("#e8a838");
const FOLDER_OPEN_ICON = _folderOpen("#e8a838");
const DEFAULT_FILE_ICON = { svg: _f("#848484", ""), color: "#848484" };

function getFileIcon(name, isDir, isOpen) {
  if (isDir) return isOpen ? FOLDER_OPEN_ICON : FOLDER_ICON;
  // Check full filename first (e.g. "Dockerfile", ".gitignore")
  const lower = name.toLowerCase();
  const bareMatch = FILE_ICONS[lower] || FILE_ICONS[lower.replace(/^\./, "")];
  if (bareMatch) return bareMatch.svg;
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  return (FILE_ICONS[ext] || DEFAULT_FILE_ICON).svg;
}

// Exported for reuse in git panel
export function getFileIconSvg(name) {
  const lower = name.toLowerCase();
  const bareMatch = FILE_ICONS[lower] || FILE_ICONS[lower.replace(/^\./, "")];
  if (bareMatch) return bareMatch.svg;
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  return (FILE_ICONS[ext] || DEFAULT_FILE_ICON).svg;
}

function formatSize(bytes) {
  if (bytes === 0) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " K";
  return (bytes / (1024 * 1024)).toFixed(1) + " M";
}

export function init(els) {
  sidebarEl = els.sidebar;
  treeEl = els.tree;
  pinnedEl = document.getElementById("sb-pinned");
  sidebarDivider = els.divider;
  mainEl = els.main;
  onFileAction = els.onFileAction || null;
  onRefreshRequest = els.onRefreshRequest || null;
  getDefaultAgent = els.getDefaultAgent || (() => "claude");
  onLaunchAgent = els.onLaunchAgent || null;

  // Session bar
  sesDotEl = document.getElementById("sb-ses-dot");
  sesLabelEl = document.getElementById("sb-ses-label");
  document.getElementById("sb-refresh").addEventListener("click", () => {
    if (onRefreshRequest) onRefreshRequest();
    if (activeTab === "files-panel") navigateTo(currentDir || "");
    else if (activeTab === "git-panel") refreshGit();
  });

  // Pinned files click handler
  if (pinnedEl) {
    pinnedEl.addEventListener("click", (e) => {
      const removeBtn = e.target.closest(".pin-remove");
      if (removeBtn) {
        e.stopPropagation();
        const path = removeBtn.dataset.path;
        if (path) { unpinFile(path); renderPinned(); }
        return;
      }
      const item = e.target.closest(".pin-item");
      if (item && item.dataset.path) {
        if (onFileAction) onFileAction(item.dataset.path, false);
      }
    });
  }

  // Tree click handler
  treeEl.addEventListener("click", async (e) => {
    const item = e.target.closest(".ft-item");
    if (!item) return;

    const filePath = item.dataset.path;
    const isDir = item.dataset.isDir === "true";

    if (isDir) {
      const childList = item.nextElementSibling;
      const iconEl = item.querySelector(".ft-icon");
      if (childList && childList.classList.contains("ft-children")) {
        const isOpen = !childList.classList.contains("hidden");
        childList.classList.toggle("hidden");
        const arrow = item.querySelector(".ft-arrow");
        if (arrow) arrow.textContent = isOpen ? "\u25B6" : "\u25BC";
        if (iconEl) iconEl.innerHTML = isOpen ? FOLDER_ICON : FOLDER_OPEN_ICON;
      } else {
        const arrow = item.querySelector(".ft-arrow");
        if (arrow) arrow.textContent = "\u25BC";
        if (iconEl) iconEl.innerHTML = FOLDER_OPEN_ICON;
        await loadDir(filePath, item);
      }
    } else {
      if (onFileAction) onFileAction(filePath, false);
    }
  });

  // Breadcrumb navigation
  const pathEl = sidebarEl.querySelector(".sb-path");
  if (pathEl) {
    pathEl.addEventListener("click", (e) => {
      const seg = e.target.closest(".sb-seg");
      if (seg && seg.dataset.path) {
        navigateTo(seg.dataset.path);
      }
    });
  }

  initSidebarResize();
}

function switchTab(panelId) {
  activeTab = panelId;
  for (const panel of sidebarEl.querySelectorAll(".sb-panel")) {
    panel.classList.toggle("active", panel.id === panelId);
  }
  if (panelId === "git-panel") {
    refreshGit();
  } else if (panelId === "files-panel" && visible) {
    navigateTo(currentDir || "");
  }
}

export function getActivePanel() { return activeTab; }

export function showTab(tabName) {
  const panelId = tabName + "-panel";
  if (!visible) show();
  switchTab(panelId);
}

export function show() {
  visible = true;
  sidebarEl.classList.remove("hidden");
  sidebarDivider.classList.remove("hidden");
  if (activeTab === "files-panel") {
    navigateTo(currentDir || "");
  } else if (activeTab === "git-panel") {
    refreshGit();
  }
}

export function hide() {
  visible = false;
  sidebarEl.classList.add("hidden");
  sidebarDivider.classList.add("hidden");
}

export function toggle() {
  if (visible) hide(); else show();
}

export function isVisible() { return visible; }

/**
 * Connect sidebar to a session. Updates the session bar and refreshes content.
 */
export function connectToSession(sessionId, name, cwd) {
  connectedSessionId = sessionId;
  connectedSessionName = name || "Session " + sessionId;
  gitSessionId = sessionId; // keep git panel synced with active session
  if (sesDotEl) sesDotEl.classList.add("connected");
  if (sesLabelEl) sesLabelEl.textContent = connectedSessionName + (cwd ? " — " + fname(cwd) : "");
  if (cwd) setCwd(cwd);
}

export function setCwd(cwd) {
  if (!cwd || cwd === currentDir) return;
  currentDir = cwd;
  // Update session bar label
  if (sesLabelEl && connectedSessionName) {
    sesLabelEl.textContent = connectedSessionName + " — " + fname(cwd);
  }
  if (visible) {
    if (activeTab === "files-panel") navigateTo(cwd);
    else if (activeTab === "git-panel") refreshGit();
  }
}

// ---------------------------------------------------------------------------
// File explorer
// ---------------------------------------------------------------------------

async function navigateTo(dir) {
  currentDir = dir;
  updateBreadcrumb(dir);
  renderPinned();
  treeEl.innerHTML = '<div class="ft-loading">Loading...</div>';

  try {
    const resp = await fetch(api("/api/files?dir=" + encodeURIComponent(dir)));
    const data = await resp.json();
    if (data.error) {
      treeEl.innerHTML = `<div class="ft-error">${esc(data.error)}</div>`;
      return;
    }
    currentDir = data.dir;
    updateBreadcrumb(data.dir);
    renderItems(data.items, treeEl, data.parent);
  } catch (e) {
    treeEl.innerHTML = '<div class="ft-error">Failed to load</div>';
  }
}

async function loadDir(dir, parentItemEl) {
  const placeholder = document.createElement("div");
  placeholder.className = "ft-children";
  placeholder.innerHTML = '<div class="ft-loading">Loading...</div>';
  parentItemEl.after(placeholder);

  try {
    const resp = await fetch(api("/api/files?dir=" + encodeURIComponent(dir)));
    const data = await resp.json();
    if (data.error) {
      placeholder.innerHTML = `<div class="ft-error">${esc(data.error)}</div>`;
      return;
    }
    placeholder.innerHTML = "";
    for (const item of data.items) {
      placeholder.appendChild(makeItemEl(item, 1));
    }
    if (data.items.length === 0) {
      placeholder.innerHTML = '<div class="ft-empty">Empty</div>';
    }
  } catch {
    placeholder.innerHTML = '<div class="ft-error">Failed to load</div>';
  }
}

function renderItems(items, container, parentDir) {
  container.innerHTML = "";

  if (parentDir && parentDir !== currentDir) {
    const upEl = document.createElement("div");
    upEl.className = "ft-item ft-up";
    upEl.dataset.path = parentDir;
    upEl.dataset.isDir = "true";
    upEl.innerHTML = '<span class="ft-arrow">\u25B6</span><span class="ft-icon">' + FOLDER_ICON + '</span><span class="ft-name">..</span>';
    upEl.addEventListener("click", (e) => {
      e.stopPropagation();
      navigateTo(parentDir);
    });
    container.appendChild(upEl);
  }

  for (const item of items) {
    container.appendChild(makeItemEl(item, 0));
  }

  if (items.length === 0) {
    container.innerHTML += '<div class="ft-empty">Empty directory</div>';
  }
}

function makeItemEl(item, depth) {
  const el = document.createElement("div");
  el.className = "ft-item" + (item.isDir ? " ft-dir" : " ft-file");
  el.dataset.path = item.path;
  el.dataset.isDir = String(item.isDir);
  if (depth > 0) el.style.paddingLeft = (12 + depth * 16) + "px";

  // Make files draggable for drag-to-terminal / drag-to-editor
  if (!item.isDir) {
    el.draggable = true;
    el.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/agenv-path", item.path);
      e.dataTransfer.effectAllowed = "copyMove";
      el.style.opacity = "0.5";
    });
    el.addEventListener("dragend", () => { el.style.opacity = ""; });
  }

  const arrow = item.isDir ? '<span class="ft-arrow">\u25B6</span>' : '<span class="ft-arrow-space"></span>';
  const icon = `<span class="ft-icon">${getFileIcon(item.name, item.isDir, false)}</span>`;
  const name = `<span class="ft-name">${esc(item.name)}</span>`;
  const size = !item.isDir && item.size ? `<span class="ft-size">${formatSize(item.size)}</span>` : "";

  el.innerHTML = arrow + icon + name + size;
  return el;
}

function updateBreadcrumb(dir) {
  const pathEl = sidebarEl.querySelector(".sb-path");
  if (!pathEl) return;

  const parts = dir.replace(/\\/g, "/").split("/").filter(Boolean);
  let html = "";
  let accumulated = "";

  for (let i = 0; i < parts.length; i++) {
    accumulated += (i === 0 && !dir.startsWith("/") ? "" : "/") + parts[i];
    if (i === 0 && parts[i].endsWith(":")) {
      accumulated = parts[i] + "/";
    }
    const isLast = i === parts.length - 1;
    html += `<span class="sb-seg${isLast ? ' active' : ''}" data-path="${esc(accumulated)}">${esc(parts[i])}</span>`;
    if (!isLast) html += '<span class="sb-sep">/</span>';
  }

  pathEl.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Pinned files
// ---------------------------------------------------------------------------

export function renderPinned() {
  if (!pinnedEl) return;
  const pins = getPinnedFiles();
  if (pins.length === 0) { pinnedEl.innerHTML = ""; return; }

  let html = '<div class="sb-pinned-title">Pinned</div>';
  for (const pin of pins) {
    const name = pin.name || pin.path.replace(/\\/g, "/").split("/").pop();
    html += `<div class="pin-item" data-path="${esc(pin.path)}" title="${esc(pin.path)}">`;
    html += `<span class="pin-icon">${getFileIconSvg(name)}</span>`;
    html += `<span class="pin-name">${esc(name)}</span>`;
    html += `<span class="pin-remove" data-path="${esc(pin.path)}" title="Unpin">&times;</span>`;
    html += `</div>`;
  }
  pinnedEl.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Git panel
// ---------------------------------------------------------------------------

let gitSessionId = 0;

export function setGitSession(sid) {
  gitSessionId = sid;
}

/**
 * Parse git porcelain status line into { index, work, file, origFile }.
 * Format: XY PATH  or  XY ORIG -> PATH (for renames)
 */
function parseStatusLine(line) {
  if (line.length < 4) return null;
  const index = line[0]; // staging area status
  const work = line[1];  // working tree status
  let filePart = line.substring(3);
  let origFile = null;
  // Handle renames: "R  old.txt -> new.txt"
  const arrowIdx = filePart.indexOf(" -> ");
  if (arrowIdx !== -1) {
    origFile = filePart.substring(0, arrowIdx);
    filePart = filePart.substring(arrowIdx + 4);
  }
  return { index, work, file: filePart, origFile };
}

function statusClass(code) {
  if (code === "M") return "modified";
  if (code === "A") return "added";
  if (code === "D") return "deleted";
  if (code === "R") return "renamed";
  if (code === "C") return "added";
  if (code === "U") return "modified";
  return "untracked";
}

// Split a git file path into {name, dir} for display (e.g. "src/app.js" -> {name:"app.js", dir:"src/"})
function gitFileName(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  if (idx < 0) return { name: filePath, dir: "" };
  return { name: normalized.slice(idx + 1), dir: normalized.slice(0, idx + 1) };
}

async function refreshGit() {
  const panel = document.getElementById("git-panel");
  if (!panel) return;
  panel.innerHTML = '<div class="ft-loading">Loading git info...</div>';

  try {
    const reposResp = await fetch(api("/api/git/repos?dir=" + encodeURIComponent(currentDir)));
    const reposData = await reposResp.json();
    const repos = reposData.repos || [];

    if (repos.length === 0) {
      panel.innerHTML = '<div class="git-empty">Not a git repository</div>';
      return;
    }

    const repoResults = await Promise.all(repos.map(async (repo) => {
      const dir = encodeURIComponent(repo.path);
      const [statusResp, logResp, branchResp] = await Promise.all([
        fetch(api("/api/git/status?dir=" + dir)),
        fetch(api("/api/git/log?dir=" + dir)),
        fetch(api("/api/git/branch?dir=" + dir)),
      ]);
      return {
        repo,
        status: await statusResp.json(),
        log: await logResp.json(),
        branch: await branchResp.json(),
      };
    }));

    let html = "";
    const multiRepo = repos.length > 1;

    for (let ri = 0; ri < repoResults.length; ri++) {
      const { repo, status, log, branch } = repoResults[ri];
      const rawLines = status.ok ? (status.output || "").trim().split("\n").filter(l => l.length >= 4) : [];
      const parsed = rawLines.map(parseStatusLine).filter(Boolean);

      // Separate staged vs unstaged vs untracked
      const staged = [];
      const unstaged = [];
      const untracked = [];
      for (const p of parsed) {
        if (p.index === "?" && p.work === "?") {
          untracked.push(p);
        } else {
          // Index column: anything other than ' ' or '?' means staged
          if (p.index !== " " && p.index !== "?") {
            staged.push({ ...p, code: p.index });
          }
          // Work column: anything other than ' ' means unstaged change
          if (p.work !== " " && p.work !== "?") {
            unstaged.push({ ...p, code: p.work });
          }
        }
      }

      // Parse branches
      const branchLines = branch.ok ? (branch.output || "").trim().split("\n").filter(l => l.trim()) : [];
      const currentBranch = (branchLines.find(l => l.startsWith("*")) || "").replace(/^\*\s*/, "").trim();
      const localBranches = branchLines
        .filter(l => !l.includes("remotes/") && !l.includes("HEAD detached"))
        .map(l => l.replace(/^\*?\s*/, "").trim())
        .filter(Boolean);
      const remoteBranches = branchLines
        .filter(l => l.includes("remotes/") && !l.includes("->"))
        .map(l => l.trim())
        .filter(Boolean);

      if (multiRepo) {
        const relLabel = repo.relation === "worktree" ? " (worktree)" : "";
        const totalChanges = staged.length + unstaged.length + untracked.length;
        html += `<div class="git-repo-header" data-repo-idx="${ri}">`;
        html += `<span class="git-repo-arrow">\u25BC</span>`;
        html += `<span class="git-repo-name">${esc(repo.name)}${relLabel}</span>`;
        if (currentBranch) html += `<span class="git-repo-branch">${esc(currentBranch)}</span>`;
        if (totalChanges > 0) html += `<span class="git-repo-count">${totalChanges}</span>`;
        html += `<span class="git-repo-agent-btn" data-repo="${esc(repo.path)}" title="Resume with agent">&#9654;</span>`;
        html += `</div>`;
        html += `<div class="git-repo-body" data-repo-idx="${ri}">`;
      }

      // Branch selector + agent resume
      html += `<div class="git-branch-section" data-repo="${esc(repo.path)}">`;
      html += `<span class="branch-icon">&#9741;</span>`;
      html += `<select class="git-branch-select" data-repo="${esc(repo.path)}">`;
      // Local branches first
      for (const b of localBranches) {
        html += `<option value="${esc(b)}"${b === currentBranch ? " selected" : ""}>${esc(b)}</option>`;
      }
      // Remote branches in optgroup
      if (remoteBranches.length > 0) {
        html += '<optgroup label="Remote">';
        for (const b of remoteBranches) {
          const short = b.replace(/^remotes\/[^/]+\//, "");
          // Skip if already in local
          if (localBranches.includes(short)) continue;
          html += `<option value="${esc(b)}">${esc(b)}</option>`;
        }
        html += '</optgroup>';
      }
      html += `</select>`;
      html += `<button class="git-agent-resume-btn" data-repo="${esc(repo.path)}" title="Launch agent here">&#9654; Agent</button>`;
      html += `</div>`;

      // Commit/push actions
      html += `<div class="git-actions" data-repo-path="${esc(repo.path)}">`;
      html += `<div class="git-commit-row">`;
      html += `<input type="text" class="git-commit-input" placeholder="Commit message..." data-repo="${esc(repo.path)}">`;
      html += `</div>`;
      html += `<div class="git-btn-row">`;
      html += `<button class="git-btn git-stage-all-btn" data-repo="${esc(repo.path)}" title="Stage all changes">Stage All</button>`;
      html += `<button class="git-btn git-commit-btn" data-repo="${esc(repo.path)}" title="Commit staged changes">Commit</button>`;
      html += `<button class="git-btn git-push-btn" data-repo="${esc(repo.path)}" title="Push to remote">Push</button>`;
      html += `</div>`;
      html += `<div class="git-btn-row git-ai-row">`;
      html += `<button class="git-btn git-ai-btn" data-action="ai-commit" data-repo="${esc(repo.path)}" title="AI: Generate commit message from diff">&#9733; AI Commit</button>`;
      html += `<button class="git-btn git-ai-btn" data-action="ai-review" data-repo="${esc(repo.path)}" title="AI: Review changes">&#9733; Review</button>`;
      html += `</div>`;
      html += `<div class="git-action-output" data-repo="${esc(repo.path)}"></div>`;
      html += `</div>`;

      // Staged changes
      if (staged.length > 0) {
        html += '<div class="git-section">';
        html += '<div class="git-section-title">Staged Changes <span style="font-size:9px;color:var(--text3)">' + staged.length + '</span>';
        html += `<span class="git-section-actions">`;
        html += `<span class="gf-section-btn" data-action="unstage-all" data-repo="${esc(repo.path)}" title="Unstage all">\u2212</span>`;
        html += `</span>`;
        html += '</div>';
        for (const s of staged.slice(0, 40)) {
          const display = s.origFile ? s.origFile + " \u2192 " + s.file : s.file;
          const gfn = gitFileName(display);
          html += `<div class="git-file staged" data-file="${esc(s.file)}" data-repo="${esc(repo.path)}" data-staged="true" data-status="${esc(s.code)}">`;
          html += `<input type="checkbox" class="gf-check" data-file="${esc(s.file)}" data-repo="${esc(repo.path)}" data-staged="true">`;
          html += `<span class="gf-file-icon">${getFileIconSvg(gfn.name)}</span>`;
          html += `<span class="gf-name"><span class="gf-fname">${esc(gfn.name)}</span>${gfn.dir ? `<span class="gf-fpath">${esc(gfn.dir)}</span>` : ""}</span>`;
          html += `<span class="gf-status ${statusClass(s.code)}">${esc(s.code)}</span>`;
          html += `<span class="gf-action" data-action="unstage" data-file="${esc(s.file)}" data-repo="${esc(repo.path)}" title="Unstage">\u2212</span>`;
          html += `</div>`;
        }
        html += '</div>';
      }

      // Unstaged changes (modified tracked files)
      if (unstaged.length > 0) {
        html += '<div class="git-section">';
        html += '<div class="git-section-title">Changes <span style="font-size:9px;color:var(--text3)">' + unstaged.length + '</span>';
        html += `<span class="git-section-actions">`;
        html += `<span class="gf-section-btn" data-action="discard-selected" data-repo="${esc(repo.path)}" title="Undo selected">\u21B6</span>`;
        html += `<span class="gf-section-btn" data-action="stage-all-changes" data-repo="${esc(repo.path)}" title="Stage all changes">+</span>`;
        html += `</span>`;
        html += '</div>';
        for (const u of unstaged.slice(0, 40)) {
          const gfn = gitFileName(u.file);
          html += `<div class="git-file" data-file="${esc(u.file)}" data-repo="${esc(repo.path)}" data-staged="false" data-status="${esc(u.code)}">`;
          html += `<input type="checkbox" class="gf-check" data-file="${esc(u.file)}" data-repo="${esc(repo.path)}" data-staged="false">`;
          html += `<span class="gf-file-icon">${getFileIconSvg(gfn.name)}</span>`;
          html += `<span class="gf-name"><span class="gf-fname">${esc(gfn.name)}</span>${gfn.dir ? `<span class="gf-fpath">${esc(gfn.dir)}</span>` : ""}</span>`;
          html += `<span class="gf-status ${statusClass(u.code)}">${esc(u.code)}</span>`;
          html += `<span class="gf-action" data-action="discard" data-file="${esc(u.file)}" data-repo="${esc(repo.path)}" title="Undo changes">\u21B6</span>`;
          html += `<span class="gf-action" data-action="stage" data-file="${esc(u.file)}" data-repo="${esc(repo.path)}" title="Stage">+</span>`;
          html += `</div>`;
        }
        html += '</div>';
      }

      // Untracked files
      if (untracked.length > 0) {
        html += '<div class="git-section">';
        html += '<div class="git-section-title">Untracked <span style="font-size:9px;color:var(--text3)">' + untracked.length + '</span>';
        html += `<span class="git-section-actions">`;
        html += `<span class="gf-section-btn" data-action="track-all" data-repo="${esc(repo.path)}" title="Track all (git add)">+</span>`;
        html += `</span>`;
        html += '</div>';
        for (const u of untracked.slice(0, 20)) {
          const gfn = gitFileName(u.file);
          html += `<div class="git-file" data-file="${esc(u.file)}" data-repo="${esc(repo.path)}" data-staged="false" data-status="??">`;
          html += `<input type="checkbox" class="gf-check" data-file="${esc(u.file)}" data-repo="${esc(repo.path)}" data-staged="false">`;
          html += `<span class="gf-file-icon">${getFileIconSvg(gfn.name)}</span>`;
          html += `<span class="gf-name"><span class="gf-fname">${esc(gfn.name)}</span>${gfn.dir ? `<span class="gf-fpath">${esc(gfn.dir)}</span>` : ""}</span>`;
          html += `<span class="gf-status untracked">U</span>`;
          html += `<span class="gf-action" data-action="stage" data-file="${esc(u.file)}" data-repo="${esc(repo.path)}" title="Track / Stage">+</span>`;
          html += `</div>`;
        }
        html += '</div>';
      }

      // Stash section
      html += `<div class="git-section git-stash-section">`;
      html += `<div class="git-section-title">Stash</div>`;
      html += `<div class="git-btn-row">`;
      html += `<button class="git-btn git-stash-btn" data-repo="${esc(repo.path)}" title="Stash all changes (including untracked)">Stash</button>`;
      html += `<button class="git-btn git-stash-pop-btn" data-repo="${esc(repo.path)}" title="Pop latest stash">Pop</button>`;
      html += `</div>`;
      html += `</div>`;

      // Clean state
      if (staged.length === 0 && unstaged.length === 0 && untracked.length === 0 && !multiRepo) {
        html += '<div class="git-section"><div class="git-section-title">Changes</div><div class="git-empty">Working tree clean</div></div>';
      }

      // Log
      if (log.ok) {
        const lines = (log.output || "").trim().split("\n").filter(l => l.trim());
        if (lines.length > 0) {
          html += '<div class="git-section"><div class="git-section-title">Recent Commits</div>';
          for (const line of lines.slice(0, 10)) {
            const spaceIdx = line.indexOf(" ");
            const hash = spaceIdx > 0 ? line.substring(0, spaceIdx) : line;
            const msg = spaceIdx > 0 ? line.substring(spaceIdx + 1) : "";
            html += `<div class="git-log-item"><span class="git-log-hash">${esc(hash)}</span><span class="git-log-msg">${esc(msg)}</span></div>`;
          }
          html += '</div>';
        }
      }

      if (multiRepo) html += '</div>';
    }

    if (!html) html = '<div class="git-empty">Not a git repository</div>';
    panel.innerHTML = html;

    // Wire collapsible repo headers
    if (multiRepo) {
      for (const hdr of panel.querySelectorAll(".git-repo-header")) {
        hdr.addEventListener("click", () => {
          const idx = hdr.dataset.repoIdx;
          const body = panel.querySelector(`.git-repo-body[data-repo-idx="${idx}"]`);
          if (body) {
            const collapsed = body.classList.toggle("collapsed");
            const arrow = hdr.querySelector(".git-repo-arrow");
            if (arrow) arrow.textContent = collapsed ? "\u25B6" : "\u25BC";
          }
        });
      }
    }

    // Wire git action buttons
    wireGitActions(panel);
  } catch (e) {
    panel.innerHTML = '<div class="ft-error">Failed to load git info</div>';
  }
}

function wireGitActions(panel) {
  // Stage All buttons
  for (const btn of panel.querySelectorAll(".git-stage-all-btn")) {
    btn.addEventListener("click", async () => {
      const repoPath = btn.dataset.repo;
      const output = panel.querySelector(`.git-action-output[data-repo="${CSS.escape(repoPath)}"]`);
      btn.disabled = true;
      btn.textContent = "Staging...";
      try {
        const resp = await fetch(api("/api/git/stage"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dir: repoPath, files: ["."] }),
        });
        const data = await resp.json();
        if (output) output.textContent = data.ok ? "All changes staged" : (data.output || "Stage failed");
        if (data.ok) setTimeout(() => refreshGit(), 500);
      } catch (e) {
        if (output) output.textContent = "Error: " + e.message;
      }
      btn.disabled = false;
      btn.textContent = "Stage All";
    });
  }

  // Commit buttons
  for (const btn of panel.querySelectorAll(".git-commit-btn")) {
    btn.addEventListener("click", async () => {
      const repoPath = btn.dataset.repo;
      const input = panel.querySelector(`.git-commit-input[data-repo="${CSS.escape(repoPath)}"]`);
      const output = panel.querySelector(`.git-action-output[data-repo="${CSS.escape(repoPath)}"]`);
      const message = input?.value?.trim();
      if (!message) {
        if (output) output.textContent = "Please enter a commit message";
        if (input) input.focus();
        return;
      }
      btn.disabled = true;
      btn.textContent = "Committing...";
      try {
        const resp = await fetch(api("/api/git/commit"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dir: repoPath, message }),
        });
        const data = await resp.json();
        if (output) output.textContent = data.ok ? "Committed successfully" : (data.output || "Commit failed");
        if (data.ok) {
          if (input) input.value = "";
          setTimeout(() => refreshGit(), 500);
        }
      } catch (e) {
        if (output) output.textContent = "Error: " + e.message;
      }
      btn.disabled = false;
      btn.textContent = "Commit";
    });
  }

  // Push buttons
  for (const btn of panel.querySelectorAll(".git-push-btn")) {
    btn.addEventListener("click", async () => {
      const repoPath = btn.dataset.repo;
      const output = panel.querySelector(`.git-action-output[data-repo="${CSS.escape(repoPath)}"]`);
      btn.disabled = true;
      btn.textContent = "Pushing...";
      try {
        const resp = await fetch(api("/api/git/push"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dir: repoPath }),
        });
        const data = await resp.json();
        if (output) output.textContent = data.ok ? "Pushed successfully" : (data.output || "Push failed");
        if (data.ok) setTimeout(() => refreshGit(), 500);
      } catch (e) {
        if (output) output.textContent = "Error: " + e.message;
      }
      btn.disabled = false;
      btn.textContent = "Push";
    });
  }

  // AI buttons (commit message generation, code review)
  for (const btn of panel.querySelectorAll(".git-ai-btn")) {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const repoPath = btn.dataset.repo;
      const output = panel.querySelector(`.git-action-output[data-repo="${CSS.escape(repoPath)}"]`);
      const input = panel.querySelector(`.git-commit-input[data-repo="${CSS.escape(repoPath)}"]`);

      btn.disabled = true;
      const origText = btn.textContent;
      btn.textContent = "\u2733 Thinking...";
      if (output) output.textContent = `Asking ${ai.getAgentName()} (${ai.getModelName()})...`;

      try {
        // Get the diff to send to AI
        const diffResp = await fetch(api("/api/git/diff-for-ai?dir=" + encodeURIComponent(repoPath)));
        if (!diffResp.ok) { if (output) output.textContent = "Failed to get diff"; btn.disabled = false; btn.textContent = origText; return; }
        const diffData = await diffResp.json();
        const diff = diffData.diff || "";
        const stagedDiff = diffData.stagedDiff || "";
        const recentCommits = diffData.recentCommits || "";

        if (!diff && !stagedDiff) {
          if (output) output.textContent = "No changes to analyze";
          btn.disabled = false; btn.textContent = origText;
          return;
        }

        let prompt;
        if (action === "ai-commit") {
          const changes = stagedDiff || diff;
          prompt = `Generate a concise, well-written git commit message for these changes. Follow conventional commit style (e.g. "feat:", "fix:", "refactor:"). Be specific about what changed and why. Output ONLY the commit message, nothing else.\n\nRecent commits for style reference:\n${recentCommits}\n\nDiff:\n${changes.slice(0, 8000)}`;
        } else if (action === "ai-review") {
          const changes = diff || stagedDiff;
          prompt = `Review this code diff. Be concise and focus on:\n1. Potential bugs or issues\n2. Security concerns\n3. Performance issues\n4. Suggestions for improvement\n\nKeep your review under 200 words. If the code looks good, say so briefly.\n\nDiff:\n${changes.slice(0, 12000)}`;
        }

        const result = await ai.ask(prompt, { cwd: repoPath });

        if (result.error) {
          if (output) output.textContent = "AI error: " + result.error;
        } else if (action === "ai-commit") {
          // Put the generated message into the commit input
          const msg = result.response.replace(/^["'`]+|["'`]+$/g, "").trim();
          if (input) { input.value = msg; input.focus(); }
          if (output) output.textContent = `Generated in ${(result.elapsed / 1000).toFixed(1)}s`;
        } else if (action === "ai-review") {
          if (output) {
            output.style.maxHeight = "200px";
            output.textContent = result.response;
          }
        }
      } catch (err) {
        if (output) output.textContent = "Error: " + err.message;
      }

      btn.disabled = false;
      btn.textContent = origText;
    });
  }

  // Enter key in commit input triggers commit
  for (const input of panel.querySelectorAll(".git-commit-input")) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const repoPath = input.dataset.repo;
        const btn = panel.querySelector(`.git-commit-btn[data-repo="${CSS.escape(repoPath)}"]`);
        if (btn) btn.click();
      }
    });
  }

  // Branch checkout on select change
  for (const sel of panel.querySelectorAll(".git-branch-select")) {
    sel.addEventListener("change", async () => {
      const repoPath = sel.dataset.repo;
      const branch = sel.value;
      if (!branch) return;
      const output = panel.querySelector(`.git-action-output[data-repo="${CSS.escape(repoPath)}"]`);
      sel.disabled = true;
      try {
        const resp = await fetch(api("/api/git/checkout"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dir: repoPath, branch }),
        });
        const data = await resp.json();
        if (output) output.textContent = data.ok ? `Switched to ${branch}` : (data.output || "Checkout failed");
        setTimeout(() => refreshGit(), 500);
      } catch (e) {
        if (output) output.textContent = "Error: " + e.message;
      }
      sel.disabled = false;
    });
  }

  // Individual file stage (+) buttons
  for (const btn of panel.querySelectorAll('.gf-action[data-action="stage"]')) {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const file = btn.dataset.file;
      const repoPath = btn.dataset.repo;
      const output = panel.querySelector(`.git-action-output[data-repo="${CSS.escape(repoPath)}"]`);
      btn.textContent = "...";
      try {
        const resp = await fetch(api("/api/git/stage"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dir: repoPath, files: [file] }),
        });
        const data = await resp.json();
        if (output) output.textContent = data.ok ? `Staged ${file}` : (data.output || "Stage failed");
        setTimeout(() => refreshGit(), 300);
      } catch (e) {
        if (output) output.textContent = "Error: " + e.message;
        btn.textContent = "+";
      }
    });
  }

  // Individual file unstage (-) buttons
  for (const btn of panel.querySelectorAll('.gf-action[data-action="unstage"]')) {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const file = btn.dataset.file;
      const repoPath = btn.dataset.repo;
      const output = panel.querySelector(`.git-action-output[data-repo="${CSS.escape(repoPath)}"]`);
      btn.textContent = "...";
      try {
        const resp = await fetch(api("/api/git/unstage"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dir: repoPath, files: [file] }),
        });
        const data = await resp.json();
        if (output) output.textContent = data.ok ? `Unstaged ${file}` : (data.output || "Unstage failed");
        setTimeout(() => refreshGit(), 300);
      } catch (e) {
        if (output) output.textContent = "Error: " + e.message;
        btn.textContent = "\u2212";
      }
    });
  }

  // Individual file discard (undo) buttons
  for (const btn of panel.querySelectorAll('.gf-action[data-action="discard"]')) {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const file = btn.dataset.file;
      const repoPath = btn.dataset.repo;
      if (!confirm(`Discard changes to ${file}? This cannot be undone.`)) return;
      const output = panel.querySelector(`.git-action-output[data-repo="${CSS.escape(repoPath)}"]`);
      btn.textContent = "...";
      try {
        const resp = await fetch(api("/api/git/discard"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dir: repoPath, files: [file] }),
        });
        const data = await resp.json();
        if (output) output.textContent = data.ok ? `Discarded ${file}` : (data.output || "Discard failed");
        setTimeout(() => refreshGit(), 300);
      } catch (e) {
        if (output) output.textContent = "Error: " + e.message;
        btn.textContent = "\u21B6";
      }
    });
  }

  // Section-level action buttons
  for (const btn of panel.querySelectorAll(".gf-section-btn")) {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const repoPath = btn.dataset.repo;
      const output = panel.querySelector(`.git-action-output[data-repo="${CSS.escape(repoPath)}"]`);

      if (action === "unstage-all") {
        try {
          const resp = await fetch(api("/api/git/unstage"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dir: repoPath, files: ["."] }),
          });
          const data = await resp.json();
          if (output) output.textContent = data.ok ? "All files unstaged" : (data.output || "Unstage failed");
          setTimeout(() => refreshGit(), 300);
        } catch (err) {
          if (output) output.textContent = "Error: " + err.message;
        }
      } else if (action === "stage-all-changes") {
        try {
          const resp = await fetch(api("/api/git/stage"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dir: repoPath, files: ["."] }),
          });
          const data = await resp.json();
          if (output) output.textContent = data.ok ? "All changes staged" : (data.output || "Stage failed");
          setTimeout(() => refreshGit(), 300);
        } catch (err) {
          if (output) output.textContent = "Error: " + err.message;
        }
      } else if (action === "track-all") {
        // Stage all untracked files
        const untrackedFiles = [...panel.querySelectorAll('.git-file[data-status="??"] .gf-check')]
          .map(cb => cb.dataset.file).filter(Boolean);
        const filesToAdd = untrackedFiles.length > 0 ? untrackedFiles : ["."];
        try {
          const resp = await fetch(api("/api/git/stage"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dir: repoPath, files: filesToAdd }),
          });
          const data = await resp.json();
          if (output) output.textContent = data.ok ? "All untracked files added" : (data.output || "Add failed");
          setTimeout(() => refreshGit(), 300);
        } catch (err) {
          if (output) output.textContent = "Error: " + err.message;
        }
      } else if (action === "discard-selected") {
        // Discard selected (checked) files, or all unstaged if none checked
        const checked = [...panel.querySelectorAll('.gf-check[data-staged="false"]:checked')]
          .map(cb => cb.dataset.file).filter(Boolean);
        if (checked.length === 0) {
          if (output) output.textContent = "Select files to discard (use checkboxes)";
          return;
        }
        if (!confirm(`Discard changes to ${checked.length} file(s)? This cannot be undone.`)) return;
        try {
          const resp = await fetch(api("/api/git/discard"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dir: repoPath, files: checked }),
          });
          const data = await resp.json();
          if (output) output.textContent = data.ok ? `Discarded ${checked.length} file(s)` : (data.output || "Discard failed");
          setTimeout(() => refreshGit(), 300);
        } catch (err) {
          if (output) output.textContent = "Error: " + err.message;
        }
      }
    });
  }

  // Stash button
  for (const btn of panel.querySelectorAll(".git-stash-btn")) {
    btn.addEventListener("click", async () => {
      const repoPath = btn.dataset.repo;
      const output = panel.querySelector(`.git-action-output[data-repo="${CSS.escape(repoPath)}"]`);
      btn.disabled = true;
      btn.textContent = "Stashing...";
      try {
        const resp = await fetch(api("/api/git/stash"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dir: repoPath }),
        });
        const data = await resp.json();
        if (output) output.textContent = data.ok ? (data.output || "Stashed") : (data.output || "Stash failed");
        if (data.ok) setTimeout(() => refreshGit(), 500);
      } catch (e) {
        if (output) output.textContent = "Error: " + e.message;
      }
      btn.disabled = false;
      btn.textContent = "Stash";
    });
  }

  // Stash Pop button
  for (const btn of panel.querySelectorAll(".git-stash-pop-btn")) {
    btn.addEventListener("click", async () => {
      const repoPath = btn.dataset.repo;
      const output = panel.querySelector(`.git-action-output[data-repo="${CSS.escape(repoPath)}"]`);
      btn.disabled = true;
      btn.textContent = "Popping...";
      try {
        const resp = await fetch(api("/api/git/stash-pop"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dir: repoPath }),
        });
        const data = await resp.json();
        if (output) output.textContent = data.ok ? (data.output || "Stash popped") : (data.output || "Pop failed");
        if (data.ok) setTimeout(() => refreshGit(), 500);
      } catch (e) {
        if (output) output.textContent = "Error: " + e.message;
      }
      btn.disabled = false;
      btn.textContent = "Pop";
    });
  }

  // Checkbox multi-select: Shift+click selects range
  let lastCheckedIdx = -1;
  const allChecks = [...panel.querySelectorAll(".gf-check")];
  for (let i = 0; i < allChecks.length; i++) {
    allChecks[i].addEventListener("click", (e) => {
      e.stopPropagation();
      if (e.shiftKey && lastCheckedIdx >= 0) {
        const from = Math.min(lastCheckedIdx, i);
        const to = Math.max(lastCheckedIdx, i);
        const checked = allChecks[i].checked;
        for (let j = from; j <= to; j++) {
          allChecks[j].checked = checked;
        }
      }
      lastCheckedIdx = i;
    });
  }

  // Git file click → open file in editor tab (VS Code style)
  for (const fileEl of panel.querySelectorAll(".git-file")) {
    fileEl.addEventListener("click", (e) => {
      // Don't open if clicking action buttons, checkboxes, or status badges
      if (e.target.closest(".gf-action, .gf-check, .gf-section-btn")) return;
      const file = fileEl.dataset.file;
      const repoPath = fileEl.dataset.repo;
      const status = fileEl.dataset.status;
      // Skip deleted files — they don't exist on disk
      if (status === "D") return;
      if (file && repoPath) {
        // Normalize: always use forward slashes for consistent path handling
        const normRepo = repoPath.replace(/\\/g, "/");
        const normFile = file.replace(/\\/g, "/");
        const fullPath = normRepo + "/" + normFile;
        if (onFileAction) {
          onFileAction(fullPath, false);
        } else {
          navigateToFile(fullPath);
        }
      }
    });
  }

  // Agent resume buttons (inline in branch section)
  for (const btn of panel.querySelectorAll(".git-agent-resume-btn")) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const repoPath = btn.dataset.repo;
      const agent = getDefaultAgent ? getDefaultAgent() : "claude";
      if (onLaunchAgent) onLaunchAgent(repoPath, agent);
    });
  }

  // Agent buttons on repo headers (multi-repo / worktree)
  for (const btn of panel.querySelectorAll(".git-repo-agent-btn")) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const repoPath = btn.dataset.repo;
      const agent = getDefaultAgent ? getDefaultAgent() : "claude";
      if (onLaunchAgent) onLaunchAgent(repoPath, agent);
    });
  }
}

// Expose for manual refresh
export function refreshGitPanel() { refreshGit(); }

// Navigate file explorer to a directory and optionally highlight a file
export async function navigateToFile(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  const dir = idx >= 0 ? normalized.slice(0, idx) : currentDir;
  const fileName = idx >= 0 ? normalized.slice(idx + 1) : filePath;

  // Switch to files panel and navigate
  showTab("files-panel");
  await navigateTo(dir);

  // Highlight the file
  requestAnimationFrame(() => {
    const items = treeEl.querySelectorAll(".ft-item");
    for (const item of items) {
      if (item.dataset.path && item.dataset.path.replace(/\\/g, "/").endsWith("/" + fileName)) {
        item.classList.add("ft-highlight");
        item.scrollIntoView({ block: "nearest" });
        setTimeout(() => {
          item.classList.remove("ft-highlight");
          item.classList.add("ft-highlight-out");
          setTimeout(() => item.classList.remove("ft-highlight-out"), 800);
        }, 1200);
        break;
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Sidebar resize
// ---------------------------------------------------------------------------

function initSidebarResize() {
  let dragging = false;
  let startX = 0;
  let startWidth = 0;

  sidebarDivider.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    sidebarDivider.setPointerCapture(e.pointerId);
    dragging = true;
    startX = e.clientX;
    startWidth = sidebarEl.offsetWidth;
    sidebarDivider.classList.add("active");
    document.body.style.cursor = "col-resize";
  });

  sidebarDivider.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const newWidth = Math.max(150, Math.min(500, startWidth + (e.clientX - startX)));
    sidebarEl.style.width = newWidth + "px";
  });

  const stop = () => {
    if (!dragging) return;
    dragging = false;
    sidebarDivider.classList.remove("active");
    document.body.style.cursor = "";
  };

  sidebarDivider.addEventListener("pointerup", stop);
  sidebarDivider.addEventListener("pointercancel", stop);
}
