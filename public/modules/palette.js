// palette.js — Command palette for file search (Ctrl+P) and text search (Ctrl+T)

import { api, esc } from "./util.js";

let overlayEl = null;
let inputEl = null;
let resultsEl = null;
let modeEl = null;
let mode = "files"; // "files" | "text"
let results = [];
let selectedIdx = 0;
let debounceTimer = null;
let currentDir = "";
let _onOpen = null;

export function init(opts) {
  _onOpen = opts.onOpen || null;
  overlayEl = document.getElementById("cmd-palette");
  inputEl = document.getElementById("palette-input");
  resultsEl = document.getElementById("palette-results");
  modeEl = document.getElementById("palette-mode");

  overlayEl.addEventListener("click", (e) => {
    if (e.target === overlayEl) hide();
  });

  inputEl.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => search(inputEl.value), mode === "files" ? 120 : 250);
  });

  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { hide(); e.stopPropagation(); e.preventDefault(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); moveSelection(1); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); moveSelection(-1); return; }
    if (e.key === "Enter") { e.preventDefault(); openSelected(); return; }
    if (e.key === "Tab") {
      e.preventDefault();
      // Toggle mode
      show(mode === "files" ? "text" : "files", inputEl.value);
      return;
    }
  });

  resultsEl.addEventListener("click", (e) => {
    const item = e.target.closest(".palette-item");
    if (item) {
      const idx = parseInt(item.dataset.idx, 10);
      if (!isNaN(idx)) {
        selectedIdx = idx;
        openSelected();
      }
    }
  });
}

export function setCwd(cwd) { currentDir = cwd || ""; }

export function show(m, prefill) {
  mode = m || "files";
  results = [];
  selectedIdx = 0;
  modeEl.textContent = mode === "files" ? "Open File" : "Search in Files";
  inputEl.placeholder = mode === "files"
    ? "Search files by name... (Tab to switch to text search)"
    : "Search text across files... (Tab to switch to file search)";
  inputEl.value = prefill || "";
  resultsEl.innerHTML = '<div class="palette-hint">' +
    (mode === "files" ? "Type to search files" : "Type to search text in files") +
    '</div>';
  overlayEl.classList.add("visible");
  requestAnimationFrame(() => inputEl.focus());
  if (prefill) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => search(prefill), 50);
  }
}

export function hide() {
  overlayEl.classList.remove("visible");
  inputEl.value = "";
  results = [];
}

export function isVisible() {
  return overlayEl && overlayEl.classList.contains("visible");
}

async function search(query) {
  if (!query.trim()) {
    results = [];
    resultsEl.innerHTML = '<div class="palette-hint">' +
      (mode === "files" ? "Type to search files" : "Type to search text") + '</div>';
    return;
  }

  try {
    let url;
    if (mode === "files") {
      url = "/api/search/files?q=" + encodeURIComponent(query) + "&dir=" + encodeURIComponent(currentDir);
    } else {
      url = "/api/search/text?q=" + encodeURIComponent(query) + "&dir=" + encodeURIComponent(currentDir);
    }
    const resp = await fetch(api(url));
    if (!resp.ok) return;
    const data = await resp.json();
    results = data.results || [];
    selectedIdx = 0;
    renderResults(query);
  } catch {
    resultsEl.innerHTML = '<div class="palette-hint">Search failed</div>';
  }
}

function renderResults(query) {
  if (results.length === 0) {
    resultsEl.innerHTML = '<div class="palette-hint">No results found</div>';
    return;
  }

  let html = "";
  const max = Math.min(results.length, 50);
  for (let i = 0; i < max; i++) {
    const r = results[i];
    const sel = i === selectedIdx ? " selected" : "";
    if (mode === "files") {
      html += `<div class="palette-item${sel}" data-idx="${i}">`;
      html += `<span class="pi-icon">${getIcon(r.name)}</span>`;
      html += `<span class="pi-name">${highlight(r.name, query)}</span>`;
      html += `<span class="pi-path">${esc(r.relative)}</span>`;
      html += `</div>`;
    } else {
      html += `<div class="palette-item${sel}" data-idx="${i}">`;
      html += `<span class="pi-icon pi-line-icon">${r.line}</span>`;
      html += `<span class="pi-name">${esc(r.file)}</span>`;
      html += `<span class="pi-text">${highlight(r.text.trim(), query)}</span>`;
      html += `</div>`;
    }
  }
  if (results.length > max) {
    html += `<div class="palette-hint">${results.length - max} more results...</div>`;
  }
  resultsEl.innerHTML = html;
}

function highlight(text, query) {
  const escaped = esc(text);
  if (!query) return escaped;
  try {
    const re = new RegExp("(" + query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi");
    return escaped.replace(re, "<mark>$1</mark>");
  } catch {
    return escaped;
  }
}

function getIcon(name) {
  const ext = name.split(".").pop().toLowerCase();
  const icons = {
    js: "JS", ts: "TS", py: "Py", go: "Go", rs: "Rs", rb: "Rb",
    json: "{}", yaml: "Y", yml: "Y", toml: "T", md: "M",
    html: "H", css: "C", scss: "S", sh: "#", ps1: "P",
  };
  return icons[ext] || "\u{1F4C4}";
}

function moveSelection(delta) {
  if (results.length === 0) return;
  selectedIdx = (selectedIdx + delta + results.length) % results.length;
  const items = resultsEl.querySelectorAll(".palette-item");
  items.forEach((el, i) => el.classList.toggle("selected", i === selectedIdx));
  if (items[selectedIdx]) items[selectedIdx].scrollIntoView({ block: "nearest" });
}

function openSelected() {
  if (results.length === 0 || !results[selectedIdx]) return;
  const r = results[selectedIdx];
  hide();
  if (_onOpen) {
    if (mode === "files") {
      _onOpen(r.path, null);
    } else {
      _onOpen(r.fullPath || r.file, r.line);
    }
  }
}
