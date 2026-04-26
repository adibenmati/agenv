// claudemd.js — CLAUDE.md Manager extension
// Browse, edit, and manage CLAUDE.md files across all Claude Code projects.
// Also view auto-memory files per project.

import { api, esc } from "./util.js";
import * as ai from "./ai.js";

let panelEl = null;
let _onOpenInTerminal = null;
let _onSendToTerminal = null;

let projects = [];
let templates = [];
let expandedProject = null;  // project path
let editingContent = "";
let editingPath = "";
let memoryData = null;       // { memories:[], path }
let dirty = false;
let loading = false;
let activeTab = "editor";    // editor | memory | templates
let searchQuery = "";

// ---- Init ----
export function init(opts) {
  panelEl = opts.panel;
  _onOpenInTerminal = opts.onOpenInTerminal || null;
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
    const [projResp, tmplResp] = await Promise.all([
      fetch(api("/api/claudemd/list")),
      fetch(api("/api/claudemd/templates")),
    ]);
    if (projResp.ok) projects = await projResp.json();
    if (tmplResp.ok) templates = await tmplResp.json();
  } catch {} finally {
    loading = false;
    renderBody();
  }
}

// ---- Rendering ----
function renderShell() {
  panelEl.innerHTML = `
    <div class="cm-header">
      <span class="cm-title">CLAUDE.md Manager</span>
      <div class="cm-actions">
        <button class="cm-btn" data-act="refresh" title="Refresh">&#8635;</button>
      </div>
    </div>
    <div class="cm-search">
      <input type="text" class="cm-search-input" placeholder="Search projects..." />
    </div>
    <div class="cm-body" id="cm-body"></div>
  `;
}

function renderBody() {
  const body = panelEl.querySelector("#cm-body");
  if (!body) return;

  if (loading) {
    body.innerHTML = `<div class="cm-loading">Loading projects...</div>`;
    return;
  }

  if (projects.length === 0) {
    body.innerHTML = `<div class="cm-empty">
      <div class="cm-empty-icon">C</div>
      <div class="cm-empty-text">No Claude projects found</div>
      <div class="cm-empty-hint">Projects from ~/.claude/projects/ will appear here</div>
    </div>`;
    return;
  }

  const filtered = searchQuery
    ? projects.filter(p => p.name.toLowerCase().includes(searchQuery) || p.path.toLowerCase().includes(searchQuery))
    : projects;

  let h = "";
  for (const p of filtered) {
    const isExpanded = expandedProject === p.path;
    h += `<div class="cm-project${isExpanded ? " expanded" : ""}" data-path="${esc(p.path)}" data-dir="${esc(p.dir)}">`;
    h += `<div class="cm-proj-row">`;
    h += `<span class="cm-proj-icon">${p.hasClaude ? "&#128220;" : "&#128196;"}</span>`;
    h += `<span class="cm-proj-name">${esc(p.name)}</span>`;
    if (p.hasClaude) h += `<span class="cm-proj-badge has">CLAUDE.md</span>`;
    else h += `<span class="cm-proj-badge none">No file</span>`;
    if (p.memoryFiles.length > 0) h += `<span class="cm-proj-mem">${p.memoryFiles.length} mem</span>`;
    h += `<span class="cm-proj-arrow">${isExpanded ? "\u25B2" : "\u25BC"}</span>`;
    h += `</div>`;

    if (isExpanded) {
      h += renderExpanded(p);
    }
    h += `</div>`;
  }

  h += `<div class="cm-footer">${filtered.length} project${filtered.length !== 1 ? "s" : ""} &middot; ${projects.filter(p => p.hasClaude).length} with CLAUDE.md</div>`;
  body.innerHTML = h;
}

function renderExpanded(p) {
  let h = `<div class="cm-expanded">`;

  // Tab bar
  h += `<div class="cm-tabs">`;
  h += `<button class="cm-tab${activeTab === "editor" ? " active" : ""}" data-tab="editor">Editor</button>`;
  h += `<button class="cm-tab${activeTab === "memory" ? " active" : ""}" data-tab="memory">Memory (${p.memoryFiles.length})</button>`;
  h += `<button class="cm-tab${activeTab === "templates" ? " active" : ""}" data-tab="templates">Templates</button>`;
  h += `</div>`;

  // Path
  h += `<div class="cm-path">${esc(p.path)}</div>`;

  if (activeTab === "editor") {
    h += `<div class="cm-editor-area">`;
    h += `<textarea class="cm-textarea" id="cm-editor" placeholder="# Project Guidelines\n\nWrite your CLAUDE.md content here...">${esc(editingContent)}</textarea>`;
    h += `<div class="cm-editor-actions">`;
    h += `<button class="cm-action-btn save${dirty ? " dirty" : ""}" data-act="save">Save</button>`;
    h += `<button class="cm-action-btn" data-act="copy-content">Copy</button>`;
    if (_onOpenInTerminal) h += `<button class="cm-action-btn" data-act="open-dir">Open Folder</button>`;
    h += `</div>`;
    h += `<div class="cm-editor-actions" style="margin-top:4px">`;
    h += `<button class="cm-action-btn cm-ai-btn" data-act="ai-generate" title="AI: Generate CLAUDE.md from codebase">&#9733; Generate</button>`;
    h += `<button class="cm-action-btn cm-ai-btn" data-act="ai-improve" title="AI: Improve current content">&#9733; Improve</button>`;
    h += `</div>`;
    h += `<div class="cm-ai-output" id="cm-ai-output"></div>`;
    h += `</div>`;
  } else if (activeTab === "memory") {
    h += renderMemory();
  } else if (activeTab === "templates") {
    h += renderTemplates();
  }

  h += `</div>`;
  return h;
}

function renderMemory() {
  let h = `<div class="cm-memory">`;
  if (!memoryData) {
    h += `<div class="cm-loading">Loading memory...</div>`;
  } else if (memoryData.memories.length === 0) {
    h += `<div class="cm-mem-empty">No memory files found for this project</div>`;
  } else {
    for (const m of memoryData.memories) {
      h += `<div class="cm-mem-file">`;
      h += `<div class="cm-mem-name">${esc(m.file)}</div>`;
      h += `<pre class="cm-mem-content">${esc(m.content.slice(0, 500))}${m.content.length > 500 ? "..." : ""}</pre>`;
      h += `</div>`;
    }
    if (memoryData.path) {
      h += `<div class="cm-mem-path">Path: ${esc(memoryData.path)}</div>`;
    }
  }
  h += `</div>`;
  return h;
}

function renderTemplates() {
  let h = `<div class="cm-templates">`;
  h += `<div class="cm-tmpl-hint">Click a template to apply it to the editor</div>`;
  for (const t of templates) {
    h += `<div class="cm-tmpl-card" data-tmpl="${esc(t.id)}">`;
    h += `<div class="cm-tmpl-name">${esc(t.name)}</div>`;
    h += `<pre class="cm-tmpl-preview">${esc(t.content.slice(0, 150))}...</pre>`;
    h += `</div>`;
  }
  h += `</div>`;
  return h;
}

// ---- Event handlers ----
async function handleClick(e) {
  // Tab switching
  const tab = e.target.closest(".cm-tab");
  if (tab) {
    activeTab = tab.dataset.tab;
    if (activeTab === "memory" && expandedProject && !memoryData) {
      const proj = projects.find(p => p.path === expandedProject);
      if (proj) loadMemory(proj.dir);
    }
    renderBody();
    return;
  }

  // Template apply
  const tmplCard = e.target.closest(".cm-tmpl-card");
  if (tmplCard) {
    const tmpl = templates.find(t => t.id === tmplCard.dataset.tmpl);
    if (tmpl) {
      editingContent = tmpl.content;
      dirty = true;
      activeTab = "editor";
      renderBody();
    }
    return;
  }

  // Action buttons
  const actionBtn = e.target.closest("[data-act]");
  if (actionBtn) {
    const act = actionBtn.dataset.act;
    if (act === "refresh") { await refresh(); return; }
    if (act === "save") { await saveFile(); return; }
    if (act === "copy-content") {
      navigator.clipboard.writeText(editingContent).catch(() => {});
      return;
    }
    if (act === "open-dir" && expandedProject && _onOpenInTerminal) {
      _onOpenInTerminal(expandedProject);
      return;
    }
    if (act === "ai-generate" && expandedProject) {
      await aiGenerate(actionBtn);
      return;
    }
    if (act === "ai-improve" && expandedProject) {
      await aiImprove(actionBtn);
      return;
    }
    return;
  }

  // Project row click → expand/collapse
  const projRow = e.target.closest(".cm-proj-row");
  if (projRow) {
    const projEl = projRow.closest(".cm-project");
    const projPath = projEl?.dataset.path;
    const projDir = projEl?.dataset.dir;
    if (!projPath) return;

    if (expandedProject === projPath) {
      expandedProject = null;
      editingContent = "";
      editingPath = "";
      memoryData = null;
      dirty = false;
      activeTab = "editor";
    } else {
      expandedProject = projPath;
      memoryData = null;
      dirty = false;
      activeTab = "editor";
      await loadClaudeMd(projPath);
    }
    renderBody();
    return;
  }
}

function handleInput(e) {
  if (e.target.classList.contains("cm-search-input")) {
    searchQuery = e.target.value.trim().toLowerCase();
    renderBody();
    return;
  }
  if (e.target.id === "cm-editor") {
    editingContent = e.target.value;
    dirty = true;
    // Update save button state
    const saveBtn = panelEl.querySelector("[data-act='save']");
    if (saveBtn && !saveBtn.classList.contains("dirty")) saveBtn.classList.add("dirty");
    return;
  }
}

function handleChange() {}

// ---- API calls ----
async function loadClaudeMd(projectPath) {
  try {
    const resp = await fetch(api("/api/claudemd/read?path=" + encodeURIComponent(projectPath)));
    if (resp.ok) {
      const data = await resp.json();
      editingContent = data.content || "";
      editingPath = data.path;
    }
  } catch {}
}

async function loadMemory(dir) {
  try {
    const resp = await fetch(api("/api/claudemd/memory?dir=" + encodeURIComponent(dir)));
    if (resp.ok) {
      memoryData = await resp.json();
      renderBody();
    }
  } catch {}
}

async function saveFile() {
  if (!expandedProject) return;
  try {
    const resp = await fetch(api("/api/claudemd/write"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: expandedProject, content: editingContent }),
    });
    if (resp.ok) {
      dirty = false;
      // Refresh project list to update hasClaude status
      const projResp = await fetch(api("/api/claudemd/list"));
      if (projResp.ok) projects = await projResp.json();
      renderBody();
    }
  } catch {}
}

// ---- AI features ----
async function aiGenerate(btn) {
  const outputEl = panelEl.querySelector("#cm-ai-output");
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = "\u2733 Generating...";
  if (outputEl) outputEl.textContent = `Asking ${ai.getAgentName()} (${ai.getModelName()}) to scan project...`;

  // Get file listing for context
  let fileTree = "";
  try {
    const resp = await fetch(api("/api/files?dir=" + encodeURIComponent(expandedProject) + "&depth=2"));
    if (resp.ok) {
      const data = await resp.json();
      fileTree = (data.files || []).map(f => (f.isDir ? "[dir] " : "      ") + f.name).join("\n");
    }
  } catch {}

  // Try to read package.json or similar for project context
  let pkgInfo = "";
  try {
    const resp = await fetch(api("/api/file?path=" + encodeURIComponent(expandedProject + "/package.json")));
    if (resp.ok) {
      const data = await resp.json();
      pkgInfo = (data.content || "").slice(0, 1000);
    }
  } catch {}

  const prompt = `Generate a CLAUDE.md file for a project with this structure. CLAUDE.md is a file that gives context to Claude Code (AI coding assistant) about the project — its architecture, conventions, how to build/test, and important notes.

Project directory: ${expandedProject}

File tree:
${fileTree.slice(0, 3000)}

${pkgInfo ? "package.json:\n" + pkgInfo + "\n" : ""}
${editingContent ? "Existing CLAUDE.md content to incorporate:\n" + editingContent.slice(0, 2000) + "\n" : ""}
Output ONLY the markdown content for CLAUDE.md. Make it practical and specific to this project.`;

  const result = await ai.ask(prompt, { cwd: expandedProject, timeout: 60000 });

  if (result.error) {
    if (outputEl) outputEl.textContent = "AI error: " + result.error;
  } else {
    editingContent = result.response;
    dirty = true;
    if (outputEl) outputEl.textContent = `Generated in ${(result.elapsed / 1000).toFixed(1)}s — review and save`;
    renderBody();
  }
  btn.disabled = false;
  btn.textContent = orig;
}

async function aiImprove(btn) {
  if (!editingContent.trim()) {
    const outputEl = panelEl.querySelector("#cm-ai-output");
    if (outputEl) outputEl.textContent = "Nothing to improve — write some content first or use Generate";
    return;
  }

  const outputEl = panelEl.querySelector("#cm-ai-output");
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = "\u2733 Improving...";
  if (outputEl) outputEl.textContent = `Asking ${ai.getAgentName()} (${ai.getModelName()})...`;

  const prompt = `Improve this CLAUDE.md file. Make it more specific, better organized, and more useful for an AI coding assistant. Keep the same structure but enhance the content with better details, clearer instructions, and practical guidance.

Current CLAUDE.md:
${editingContent.slice(0, 6000)}

Output ONLY the improved markdown content. No explanations.`;

  const result = await ai.ask(prompt, { cwd: expandedProject, timeout: 60000 });

  if (result.error) {
    if (outputEl) outputEl.textContent = "AI error: " + result.error;
  } else {
    editingContent = result.response;
    dirty = true;
    if (outputEl) outputEl.textContent = `Improved in ${(result.elapsed / 1000).toFixed(1)}s — review and save`;
    renderBody();
  }
  btn.disabled = false;
  btn.textContent = orig;
}
