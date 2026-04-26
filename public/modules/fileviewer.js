// fileviewer.js — file viewer with syntax highlighting + git diff

import { api, esc } from "./util.js";

let overlayEl = null;
let bodyEl = null;
let filenameEl = null;
let langEl = null;
let sizeEl = null;
let tabCodeEl = null;
let tabDiffEl = null;

let currentFile = null; // { path, name, content, size }
let currentDiff = null; // string or null
let activeView = "code"; // "code" | "diff" | "edit"
let _currentCwd = ""; // CWD for git operations
let tabEditEl = null;
let saveBtnEl = null;
let monacoEditor = null;
let monacoLoaded = false;
let monacoLoadPromise = null;
let isEditing = false;
let isDirty = false;
let pinBtnEl = null;
let _onPinChange = null; // callback when pin state changes

// Extension to highlight.js language mapping
const EXT_LANG = {
  js: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript",
  jsx: "javascript",
  py: "python", pyw: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  c: "c", h: "c",
  cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp",
  cs: "csharp",
  swift: "swift",
  kt: "kotlin",
  php: "php",
  sh: "bash", bash: "bash", zsh: "bash",
  ps1: "powershell", psm1: "powershell",
  json: "json",
  yaml: "yaml", yml: "yaml",
  toml: "ini",
  xml: "xml",
  html: "xml", htm: "xml",
  css: "css", scss: "scss", less: "less",
  sql: "sql",
  md: "markdown",
  dockerfile: "dockerfile",
  makefile: "makefile",
  r: "r",
  lua: "lua",
  perl: "perl", pl: "perl",
  zig: "zig",
  dart: "dart",
  env: "ini",
  ini: "ini", cfg: "ini", conf: "ini",
  txt: "plaintext",
  gitignore: "plaintext",
  lock: "json",
};

function getLang(filename) {
  const name = filename.toLowerCase();
  // Check full name first (Dockerfile, Makefile, etc.)
  if (EXT_LANG[name]) return EXT_LANG[name];
  const ext = name.split(".").pop();
  return EXT_LANG[ext] || "plaintext";
}

function formatSize(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

export function init(opts) {
  overlayEl = document.getElementById("file-viewer");
  bodyEl = document.getElementById("fv-body");
  filenameEl = document.getElementById("fv-filename");
  langEl = document.getElementById("fv-lang");
  sizeEl = document.getElementById("fv-size");
  tabCodeEl = document.getElementById("fv-tab-code");
  tabDiffEl = document.getElementById("fv-tab-diff");
  tabEditEl = document.getElementById("fv-tab-edit");
  saveBtnEl = document.getElementById("fv-save");
  pinBtnEl = document.getElementById("fv-pin");
  _onPinChange = opts?.onPinChange || null;

  document.getElementById("fv-close").addEventListener("click", hide);
  overlayEl.addEventListener("click", (e) => {
    if (e.target === overlayEl) hide();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlayEl.classList.contains("visible")) {
      hide();
      e.stopPropagation();
    }
  });

  tabCodeEl.addEventListener("click", () => switchView("code"));
  tabDiffEl.addEventListener("click", () => switchView("diff"));
  tabEditEl.addEventListener("click", () => switchView("edit"));
  saveBtnEl.addEventListener("click", () => saveFile());

  if (pinBtnEl) {
    pinBtnEl.addEventListener("click", () => {
      if (!currentFile) return;
      const path = currentFile.path;
      if (isPinned(path)) {
        unpinFile(path);
        pinBtnEl.textContent = "\u{1F4CC}";
        pinBtnEl.title = "Pin file";
        pinBtnEl.classList.remove("pinned");
      } else {
        pinFile(path, currentFile.name);
        pinBtnEl.textContent = "\u{1F4CC}";
        pinBtnEl.title = "Unpin file";
        pinBtnEl.classList.add("pinned");
      }
      if (_onPinChange) _onPinChange();
    });
  }

  // Global Ctrl+S for file save when editing
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s" && isEditing && overlayEl.classList.contains("visible")) {
      e.preventDefault();
      saveFile();
    }
  });
}

function switchView(view) {
  // Clean up Monaco when leaving edit mode
  if (activeView === "edit" && view !== "edit" && monacoEditor) {
    monacoEditor.dispose();
    monacoEditor = null;
  }
  activeView = view;
  tabCodeEl.classList.toggle("active", view === "code");
  tabDiffEl.classList.toggle("active", view === "diff");
  tabEditEl.classList.toggle("active", view === "edit");
  saveBtnEl.style.display = view === "edit" ? "inline-block" : "none";
  isEditing = view === "edit";
  isDirty = false;
  saveBtnEl.classList.remove("dirty");
  saveBtnEl.textContent = "Save";
  render();
}

export async function openFile(filePath) {
  currentFile = null;
  currentDiff = null;
  activeView = "code";
  tabCodeEl.classList.add("active");
  tabDiffEl.classList.remove("active");
  tabEditEl.classList.remove("active");
  saveBtnEl.style.display = "none";
  isEditing = false;

  const absPath = resolveFilePath(filePath);
  const name = absPath.replace(/\\/g, "/").split("/").pop();
  filenameEl.textContent = name;
  langEl.textContent = getLang(name);
  sizeEl.textContent = "";
  bodyEl.innerHTML = '<div class="fv-empty">Loading...</div>';
  overlayEl.classList.add("visible");
  updatePinButton(absPath);

  try {
    const resp = await fetch(api("/api/file?path=" + encodeURIComponent(absPath)));
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: "Failed to load" }));
      bodyEl.innerHTML = `<div class="fv-empty">${esc(err.error)}</div>`;
      return;
    }
    const data = await resp.json();
    currentFile = data;
    sizeEl.textContent = formatSize(data.size);
    render();
  } catch (e) {
    bodyEl.innerHTML = `<div class="fv-empty">Error: ${esc(e.message)}</div>`;
  }
}

export function setCwd(cwd) { _currentCwd = cwd || ""; }

/**
 * Resolve a possibly-relative file path to an absolute one using the current CWD.
 * Git panel passes relative paths; file explorer passes absolute paths.
 */
function resolveFilePath(filePath) {
  // Already absolute (Windows drive letter or Unix /)
  if (/^[a-zA-Z]:/.test(filePath) || filePath.startsWith("/")) return filePath;
  // Relative — combine with current CWD
  if (_currentCwd) {
    const base = _currentCwd.replace(/\\/g, "/").replace(/\/$/, "");
    return base + "/" + filePath;
  }
  return filePath;
}

export async function openDiff(filePath) {
  currentFile = null;
  currentDiff = null;
  activeView = "diff";
  tabCodeEl.classList.remove("active");
  tabDiffEl.classList.add("active");
  tabEditEl.classList.remove("active");
  saveBtnEl.style.display = "none";
  isEditing = false;

  const name = filePath.replace(/\\/g, "/").split("/").pop();
  filenameEl.textContent = name;
  langEl.textContent = "diff";
  sizeEl.textContent = "";
  bodyEl.innerHTML = '<div class="fv-empty">Loading diff...</div>';
  overlayEl.classList.add("visible");
  updatePinButton(resolveFilePath(filePath));

  try {
    let url = "/api/git/diff-file?path=" + encodeURIComponent(filePath);
    if (_currentCwd) url += "&cwd=" + encodeURIComponent(_currentCwd);
    const resp = await fetch(api(url));
    if (!resp.ok) {
      bodyEl.innerHTML = '<div class="fv-empty">Failed to load diff</div>';
      return;
    }
    const data = await resp.json();
    if (!data.ok && data.error) {
      bodyEl.innerHTML = `<div class="fv-empty">${esc(data.error)}</div>`;
      return;
    }
    currentDiff = data.diff || "";
    // Also load the file content for code/edit tabs — use resolved absolute path
    const absPath = resolveFilePath(filePath);
    try {
      const fResp = await fetch(api("/api/file?path=" + encodeURIComponent(absPath)));
      if (fResp.ok) {
        currentFile = await fResp.json();
        sizeEl.textContent = formatSize(currentFile.size);
      }
    } catch {}
    render();
  } catch (e) {
    bodyEl.innerHTML = `<div class="fv-empty">Error: ${esc(e.message)}</div>`;
  }
}

function render() {
  if (activeView === "diff") {
    renderDiff();
  } else if (activeView === "edit") {
    renderEdit();
  } else {
    renderCode();
  }
}

function renderCode() {
  if (!currentFile || !currentFile.content) {
    bodyEl.innerHTML = '<div class="fv-empty">No content</div>';
    return;
  }

  const content = currentFile.content;
  const lines = content.split("\n");
  const lang = getLang(currentFile.name);

  // Build gutter (line numbers)
  let gutterHtml = "";
  for (let i = 1; i <= lines.length; i++) {
    gutterHtml += i + "\n";
  }

  // Highlight code
  let highlighted;
  if (typeof hljs !== "undefined") {
    try {
      if (lang !== "plaintext" && hljs.getLanguage(lang)) {
        highlighted = hljs.highlight(content, { language: lang }).value;
      } else {
        highlighted = hljs.highlightAuto(content).value;
      }
    } catch {
      highlighted = esc(content);
    }
  } else {
    highlighted = esc(content);
  }

  bodyEl.innerHTML =
    `<div class="fv-lines">` +
    `<div class="fv-gutter"><pre>${gutterHtml}</pre></div>` +
    `<div class="fv-code"><pre><code class="hljs">${highlighted}</code></pre></div>` +
    `</div>`;
}

function renderDiff() {
  if (currentDiff === null || currentDiff === undefined) {
    bodyEl.innerHTML = '<div class="fv-empty">No diff available</div>';
    return;
  }
  if (!currentDiff) {
    bodyEl.innerHTML = '<div class="fv-empty">No changes (clean)</div>';
    return;
  }

  const lines = currentDiff.split("\n");
  let html = '<div class="fv-diff">';

  for (const line of lines) {
    if (line.startsWith("@@")) {
      html += `<div class="diff-line diff-hunk">${esc(line)}</div>`;
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      html += `<div class="diff-line diff-add">${esc(line)}</div>`;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      html += `<div class="diff-line diff-del">${esc(line)}</div>`;
    } else if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) {
      html += `<div class="diff-line diff-hunk">${esc(line)}</div>`;
    } else {
      html += `<div class="diff-line diff-ctx">${esc(line)}</div>`;
    }
  }

  html += "</div>";
  bodyEl.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Edit mode (Monaco editor with intellisense)
// ---------------------------------------------------------------------------

const MONACO_LANG_MAP = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript",
  py: "python", rb: "ruby", go: "go", rs: "rust",
  java: "java", c: "c", h: "c", cpp: "cpp", cs: "csharp",
  swift: "swift", kt: "kotlin", php: "php",
  json: "json", yaml: "yaml", yml: "yaml",
  html: "html", htm: "html", xml: "xml", svg: "xml",
  css: "css", scss: "scss", less: "less",
  md: "markdown", sql: "sql", sh: "shell", bash: "shell",
  ps1: "powershell", dockerfile: "dockerfile",
  ini: "ini", toml: "ini", cfg: "ini",
  r: "r", lua: "lua", perl: "perl", dart: "dart",
};

function getMonacoLang(filename) {
  const ext = filename.split(".").pop().toLowerCase();
  return MONACO_LANG_MAP[ext] || "plaintext";
}

function loadMonaco() {
  if (monacoLoaded) return Promise.resolve();
  if (monacoLoadPromise) return monacoLoadPromise;

  monacoLoadPromise = new Promise((resolve, reject) => {
    if (!window.require) {
      reject(new Error("Monaco loader not available"));
      return;
    }

    window.MonacoEnvironment = {
      getWorkerUrl: function (_workerId, _label) {
        return `data:text/javascript;charset=utf-8,${encodeURIComponent(
          "self.MonacoEnvironment = { baseUrl: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/' };\n" +
          "importScripts('https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs/base/worker/workerMain.js');"
        )}`;
      },
    };

    window.require.config({ paths: { vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs" } });
    window.require(["vs/editor/editor.main"], function () {
      monacoLoaded = true;
      resolve();
    }, function (err) {
      monacoLoadPromise = null;
      reject(err);
    });
  });

  return monacoLoadPromise;
}

async function renderEdit() {
  if (!currentFile || !currentFile.content) {
    bodyEl.innerHTML = '<div class="fv-empty">No content to edit</div>';
    return;
  }

  bodyEl.innerHTML = '<div class="fv-empty">Loading editor...</div>';

  try {
    await loadMonaco();
    bodyEl.innerHTML = '<div id="monaco-container"></div>';
    const container = document.getElementById("monaco-container");
    const lang = getMonacoLang(currentFile.name);
    const theme = document.documentElement.getAttribute("data-theme") === "light" ? "vs" : "vs-dark";

    if (monacoEditor) {
      monacoEditor.dispose();
      monacoEditor = null;
    }

    monacoEditor = monaco.editor.create(container, {
      value: currentFile.content,
      language: lang,
      theme: theme,
      minimap: { enabled: true },
      fontSize: 13,
      fontFamily: "'Cascadia Code','Fira Code','Consolas','Monaco',monospace",
      automaticLayout: true,
      scrollBeyondLastLine: false,
      wordWrap: "on",
      tabSize: 2,
      renderWhitespace: "selection",
      bracketPairColorization: { enabled: true },
    });

    monacoEditor.onDidChangeModelContent(() => {
      isDirty = true;
      saveBtnEl.classList.add("dirty");
      saveBtnEl.textContent = "Save *";
    });

    // Ctrl+S within Monaco
    monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveFile());
  } catch {
    // Fallback to textarea if Monaco fails to load
    bodyEl.innerHTML = `<textarea class="fv-textarea" id="fv-editor-textarea">${esc(currentFile.content)}</textarea>`;
    const ta = document.getElementById("fv-editor-textarea");
    if (ta) {
      ta.addEventListener("input", () => {
        isDirty = true;
        saveBtnEl.classList.add("dirty");
        saveBtnEl.textContent = "Save *";
      });
      // Tab key inserts spaces
      ta.addEventListener("keydown", (e) => {
        if (e.key === "Tab") {
          e.preventDefault();
          const start = ta.selectionStart;
          ta.value = ta.value.substring(0, start) + "  " + ta.value.substring(ta.selectionEnd);
          ta.selectionStart = ta.selectionEnd = start + 2;
          ta.dispatchEvent(new Event("input"));
        }
      });
    }
  }
}

async function saveFile() {
  if (!currentFile) return;

  let content;
  if (monacoEditor) {
    content = monacoEditor.getValue();
  } else {
    const ta = document.getElementById("fv-editor-textarea");
    if (ta) content = ta.value;
  }

  if (content == null) return;

  try {
    saveBtnEl.textContent = "Saving...";
    const resp = await fetch(api("/api/file"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: currentFile.path, content }),
    });
    if (resp.ok) {
      isDirty = false;
      saveBtnEl.textContent = "Saved!";
      saveBtnEl.classList.remove("dirty");
      currentFile.content = content;
      setTimeout(() => { if (!isDirty) saveBtnEl.textContent = "Save"; }, 1500);
    } else {
      saveBtnEl.textContent = "Error!";
      setTimeout(() => { saveBtnEl.textContent = "Save"; }, 2000);
    }
  } catch {
    saveBtnEl.textContent = "Error!";
    setTimeout(() => { saveBtnEl.textContent = "Save"; }, 2000);
  }
}

export function hide() {
  if (monacoEditor) {
    monacoEditor.dispose();
    monacoEditor = null;
  }
  isEditing = false;
  isDirty = false;
  overlayEl.classList.remove("visible");
  currentFile = null;
  currentDiff = null;
}

export function isVisible() {
  return overlayEl && overlayEl.classList.contains("visible");
}

// ---------------------------------------------------------------------------
// Pin management — localStorage per-session
// ---------------------------------------------------------------------------

let _pinSessionId = 0;

export function setPinSession(sid) { _pinSessionId = sid; }

function pinStorageKey() { return "agenv-pins-" + (_pinSessionId || "global"); }

export function getPinnedFiles() {
  try { return JSON.parse(localStorage.getItem(pinStorageKey()) || "[]"); }
  catch { return []; }
}

export function pinFile(filePath, name) {
  const pins = getPinnedFiles();
  const norm = filePath.replace(/\\/g, "/");
  if (pins.some(p => p.path.replace(/\\/g, "/") === norm)) return;
  pins.push({ path: filePath, name: name || filePath.replace(/\\/g, "/").split("/").pop() });
  localStorage.setItem(pinStorageKey(), JSON.stringify(pins));
}

export function unpinFile(filePath) {
  const norm = filePath.replace(/\\/g, "/");
  const pins = getPinnedFiles().filter(p => p.path.replace(/\\/g, "/") !== norm);
  localStorage.setItem(pinStorageKey(), JSON.stringify(pins));
}

export function isPinned(filePath) {
  const norm = filePath.replace(/\\/g, "/");
  return getPinnedFiles().some(p => p.path.replace(/\\/g, "/") === norm);
}

function updatePinButton(filePath) {
  if (!pinBtnEl) return;
  if (!filePath) { pinBtnEl.style.display = "none"; return; }
  pinBtnEl.style.display = "inline-block";
  if (isPinned(filePath)) {
    pinBtnEl.title = "Unpin file";
    pinBtnEl.classList.add("pinned");
  } else {
    pinBtnEl.title = "Pin file";
    pinBtnEl.classList.remove("pinned");
  }
}

export function getCurrentFilePath() {
  return currentFile ? currentFile.path : null;
}
