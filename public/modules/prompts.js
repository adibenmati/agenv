// prompts.js — Prompt Library extension
// Save, search, and reuse prompt snippets across projects.
// Prompts can be sent directly to the active terminal.

import { api, esc } from "./util.js";
import * as ai from "./ai.js";

let panelEl = null;
let _onSendToTerminal = null;

let prompts = [];
let filteredPrompts = [];
let searchQuery = "";
let categoryFilter = "";
let editingId = null;   // null = list view, "new" = creating, id = editing
let formData = { title: "", content: "", category: "general", tags: "" };
let loading = false;

const CATEGORIES = [
  { id: "general", label: "General", color: "var(--text3)" },
  { id: "debugging", label: "Debugging", color: "var(--red)" },
  { id: "refactoring", label: "Refactoring", color: "var(--orange)" },
  { id: "review", label: "Code Review", color: "var(--green)" },
  { id: "testing", label: "Testing", color: "var(--cyan)" },
  { id: "docs", label: "Documentation", color: "var(--accent)" },
  { id: "architecture", label: "Architecture", color: "var(--purple)" },
];

// ---- Init ----
export function init(opts) {
  panelEl = opts.panel;
  _onSendToTerminal = opts.onSendToTerminal || null;
  if (!panelEl) return;
  renderShell();
  panelEl.addEventListener("click", handleClick);
  panelEl.addEventListener("input", handleInput);
  panelEl.addEventListener("change", handleChange);
}

export async function refresh() {
  loading = true;
  renderBody();
  try {
    const resp = await fetch(api("/api/prompts"));
    if (resp.ok) {
      prompts = await resp.json();
      applyFilters();
    }
  } catch {} finally {
    loading = false;
    renderBody();
  }
}

function applyFilters() {
  let result = prompts;
  if (categoryFilter) result = result.filter(p => p.category === categoryFilter);
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    result = result.filter(p =>
      p.title.toLowerCase().includes(q) ||
      p.content.toLowerCase().includes(q) ||
      (p.tags || []).some(t => t.toLowerCase().includes(q))
    );
  }
  // Sort: most recently used first, then most recently created
  result = [...result].sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0) || b.created - a.created);
  filteredPrompts = result;
}

// ---- Rendering ----
function renderShell() {
  panelEl.innerHTML = `
    <div class="pl-header">
      <span class="pl-title">Prompt Library</span>
      <div class="pl-actions">
        <button class="pl-btn" data-act="new" title="New Prompt">+</button>
        <button class="pl-btn" data-act="refresh" title="Refresh">&#8635;</button>
      </div>
    </div>
    <div class="pl-search">
      <input type="text" class="pl-search-input" placeholder="Search prompts..." />
    </div>
    <div class="pl-cats" id="pl-cats"></div>
    <div class="pl-body" id="pl-body"></div>
  `;
}

function renderBody() {
  const body = panelEl.querySelector("#pl-body");
  const catsEl = panelEl.querySelector("#pl-cats");
  if (!body) return;

  // Category filter
  if (editingId === null && prompts.length > 0) {
    let ch = `<span class="pl-cat-tag${!categoryFilter ? " active" : ""}" data-cat="">All</span>`;
    const usedCats = new Set(prompts.map(p => p.category));
    for (const c of CATEGORIES) {
      if (usedCats.has(c.id) || c.id === "general") {
        ch += `<span class="pl-cat-tag${categoryFilter === c.id ? " active" : ""}" data-cat="${c.id}" style="--cat-color:${c.color}">${c.label}</span>`;
      }
    }
    catsEl.innerHTML = ch;
  } else {
    catsEl.innerHTML = "";
  }

  if (loading) {
    body.innerHTML = `<div class="pl-loading">Loading prompts...</div>`;
    return;
  }

  // Form view
  if (editingId !== null) {
    body.innerHTML = renderForm();
    return;
  }

  // List view
  if (filteredPrompts.length === 0) {
    body.innerHTML = `<div class="pl-empty">
      <div class="pl-empty-icon">&#128221;</div>
      <div class="pl-empty-text">${searchQuery ? "No prompts matching search" : "No saved prompts yet"}</div>
      <button class="pl-create-btn" data-act="new">Create Prompt</button>
    </div>`;
    return;
  }

  let h = "";
  for (const p of filteredPrompts) {
    const cat = CATEGORIES.find(c => c.id === p.category) || CATEGORIES[0];
    h += `<div class="pl-card" data-id="${esc(p.id)}">`;
    h += `<div class="pl-card-header">`;
    h += `<span class="pl-card-cat" style="background:${cat.color}">${cat.label.charAt(0)}</span>`;
    h += `<span class="pl-card-title">${esc(p.title)}</span>`;
    h += `<div class="pl-card-actions">`;
    h += `<button class="pl-card-btn" data-act="use" data-id="${esc(p.id)}" title="Send to terminal">&#9654;</button>`;
    h += `<button class="pl-card-btn" data-act="copy" data-id="${esc(p.id)}" title="Copy">&#128203;</button>`;
    h += `<button class="pl-card-btn" data-act="edit" data-id="${esc(p.id)}" title="Edit">&#9998;</button>`;
    h += `</div>`;
    h += `</div>`;
    h += `<div class="pl-card-preview">${esc(p.content.slice(0, 120))}${p.content.length > 120 ? "..." : ""}</div>`;
    if (p.tags && p.tags.length > 0) {
      h += `<div class="pl-card-tags">`;
      for (const t of p.tags) h += `<span class="pl-tag">${esc(t)}</span>`;
      h += `</div>`;
    }
    h += `<div class="pl-card-meta">`;
    if (p.used > 0) h += `<span class="pl-used">Used ${p.used}x</span>`;
    h += `<span class="pl-date">${fmtDate(p.created)}</span>`;
    h += `</div>`;
    h += `</div>`;
  }

  h += `<div class="pl-footer">${filteredPrompts.length} prompt${filteredPrompts.length !== 1 ? "s" : ""}</div>`;
  body.innerHTML = h;
}

function renderForm() {
  const isNew = editingId === "new";
  let h = `<div class="pl-form">`;
  h += `<div class="pl-form-title">${isNew ? "New Prompt" : "Edit Prompt"}</div>`;

  h += `<label class="pl-label">Title</label>`;
  h += `<input type="text" class="pl-input" id="pl-f-title" value="${esc(formData.title)}" placeholder="e.g. Fix TypeScript errors" />`;

  h += `<label class="pl-label">Category</label>`;
  h += `<select class="pl-select" id="pl-f-category">`;
  for (const c of CATEGORIES) {
    h += `<option value="${c.id}"${formData.category === c.id ? " selected" : ""}>${c.label}</option>`;
  }
  h += `</select>`;

  h += `<label class="pl-label">Prompt Content</label>`;
  h += `<textarea class="pl-textarea" id="pl-f-content" placeholder="Write your prompt here. Use {file}, {selection}, {cwd} as placeholders...">${esc(formData.content)}</textarea>`;

  h += `<label class="pl-label">Tags (comma-separated)</label>`;
  h += `<input type="text" class="pl-input" id="pl-f-tags" value="${esc(formData.tags)}" placeholder="e.g. typescript, fix, error" />`;

  h += `<div class="pl-form-actions">`;
  h += `<button class="pl-action-btn save" data-act="save-form">${isNew ? "Create" : "Save"}</button>`;
  h += `<button class="pl-action-btn cm-ai-btn" data-act="ai-enhance" title="AI: Improve this prompt">&#9733; Enhance</button>`;
  h += `<button class="pl-action-btn" data-act="cancel-form">Cancel</button>`;
  if (!isNew) h += `<button class="pl-action-btn danger" data-act="delete-form">Delete</button>`;
  h += `</div>`;
  h += `<div class="pl-ai-output" id="pl-ai-output"></div>`;
  h += `</div>`;
  return h;
}

// ---- Helpers ----
function fmtDate(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const diff = Math.floor((now - d) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return diff + "d ago";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ---- Event handlers ----
function handleClick(e) {
  // Category filter
  const catTag = e.target.closest(".pl-cat-tag");
  if (catTag) {
    categoryFilter = catTag.dataset.cat;
    applyFilters();
    renderBody();
    return;
  }

  // Action buttons
  const actionBtn = e.target.closest("[data-act]");
  if (actionBtn) {
    const act = actionBtn.dataset.act;
    const id = actionBtn.dataset.id;

    if (act === "refresh") { refresh(); return; }
    if (act === "new") {
      editingId = "new";
      formData = { title: "", content: "", category: "general", tags: "" };
      renderBody();
      return;
    }
    if (act === "edit") {
      const p = prompts.find(x => x.id === id);
      if (p) {
        editingId = id;
        formData = { title: p.title, content: p.content, category: p.category || "general", tags: (p.tags || []).join(", ") };
        renderBody();
      }
      return;
    }
    if (act === "use") {
      const p = prompts.find(x => x.id === id);
      if (p) {
        if (_onSendToTerminal) _onSendToTerminal(p.content);
        // Track usage
        fetch(api("/api/prompts/" + id + "/use"), { method: "POST" }).catch(() => {});
        p.used = (p.used || 0) + 1;
        p.lastUsed = Date.now();
      }
      return;
    }
    if (act === "copy") {
      const p = prompts.find(x => x.id === id);
      if (p) navigator.clipboard.writeText(p.content).catch(() => {});
      return;
    }
    if (act === "save-form") { saveForm(); return; }
    if (act === "ai-enhance") { aiEnhance(actionBtn); return; }
    if (act === "cancel-form") {
      editingId = null;
      renderBody();
      return;
    }
    if (act === "delete-form") { deletePrompt(); return; }
    return;
  }
}

function handleInput(e) {
  if (e.target.classList.contains("pl-search-input")) {
    searchQuery = e.target.value.trim().toLowerCase();
    applyFilters();
    renderBody();
    return;
  }
  if (e.target.id === "pl-f-title") { formData.title = e.target.value; return; }
  if (e.target.id === "pl-f-content") { formData.content = e.target.value; return; }
  if (e.target.id === "pl-f-tags") { formData.tags = e.target.value; return; }
}

function handleChange(e) {
  if (e.target.id === "pl-f-category") { formData.category = e.target.value; return; }
}

// ---- API calls ----
async function saveForm() {
  const tags = formData.tags.split(",").map(t => t.trim()).filter(Boolean);
  const payload = { title: formData.title, content: formData.content, category: formData.category, tags };

  if (!payload.title || !payload.content) return;

  try {
    let resp;
    if (editingId === "new") {
      resp = await fetch(api("/api/prompts"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } else {
      resp = await fetch(api("/api/prompts/" + editingId), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
    if (resp.ok) {
      editingId = null;
      await refresh();
    }
  } catch {}
}

async function deletePrompt() {
  if (!editingId || editingId === "new") return;
  try {
    await fetch(api("/api/prompts/" + editingId), { method: "DELETE" });
    editingId = null;
    await refresh();
  } catch {}
}

// ---- AI features ----
async function aiEnhance(btn) {
  // Read current form content from DOM (formData may be stale)
  const contentEl = panelEl.querySelector("#pl-f-content");
  const titleEl = panelEl.querySelector("#pl-f-title");
  const outputEl = panelEl.querySelector("#pl-ai-output");
  const content = contentEl?.value || formData.content;
  const title = titleEl?.value || formData.title;

  if (!content.trim()) {
    if (outputEl) outputEl.textContent = "Write some prompt content first, then enhance it";
    return;
  }

  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = "\u2733 Enhancing...";
  if (outputEl) outputEl.textContent = `Asking ${ai.getAgentName()} (${ai.getModelName()})...`;

  const prompt = `Improve this prompt that will be sent to an AI coding assistant. Make it clearer, more specific, and more effective. Keep the same intent but improve the wording, add useful context cues, and make it produce better results.

Title: ${title}
Current prompt:
${content}

Output ONLY the improved prompt text, nothing else. No title, no explanations.`;

  const result = await ai.ask(prompt, { timeout: 45000 });

  if (result.error) {
    if (outputEl) outputEl.textContent = "AI error: " + result.error;
  } else {
    formData.content = result.response;
    if (contentEl) contentEl.value = result.response;
    if (outputEl) outputEl.textContent = `Enhanced in ${(result.elapsed / 1000).toFixed(1)}s`;
  }
  btn.disabled = false;
  btn.textContent = orig;
}
