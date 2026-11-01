// util.js — shared helpers

let _token = "";
export function setToken(t) { _token = t; }
export function getToken() { return _token; }

export function api(p) {
  return p + (p.indexOf("?") >= 0 ? "&" : "?") + "token=" + encodeURIComponent(_token);
}

export function esc(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function ago(ts) {
  if (!ts) return "";
  var d = (Date.now() - ts) / 1000;
  if (d < 60) return "now";
  if (d < 3600) return Math.floor(d / 60) + "m";
  if (d < 86400) return Math.floor(d / 3600) + "h";
  return Math.floor(d / 86400) + "d";
}

export function short(p) {
  if (!p) return "~";
  var s = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return s.length > 2 ? "../" + s.slice(-2).join("/") : p;
}

export function fname(p) {
  if (!p) return "";
  return p.replace(/\\/g, "/").split("/").filter(Boolean).pop() || "";
}

export function tIcon(t) {
  return { claude: "C", vertex: "V", gcloud: "G", aws: "A", azure: "Az", ssh: "S", docker: "D", k8s: "K", python: "Py", node: "N", npm: "n", git: "G", terminal: ">" }[t] || ">";
}

export function $(id) { return document.getElementById(id); }

let _nextId = 1;
export function uid(prefix) { return (prefix || "id") + "-" + (_nextId++); }

/**
 * In-app replacement for window.prompt(), which Electron doesn't implement
 * (it returns nothing, so every prompt-driven action silently did nothing).
 * Resolves to the entered string, or null if cancelled.
 */
export function askText(title, value = "", opts = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "ask-overlay";
    overlay.innerHTML = `<div class="ask-box" role="dialog" aria-modal="true">
      <div class="ask-title">${esc(title)}</div>
      ${opts.hint ? `<div class="ask-hint">${esc(opts.hint)}</div>` : ""}
      <input class="ask-input" type="text" spellcheck="false" />
      <div class="ask-actions">
        <button class="ask-btn" data-r="cancel">Cancel</button>
        <button class="ask-btn primary" data-r="ok">${esc(opts.okLabel || "OK")}</button>
      </div>
    </div>`;
    const input = overlay.querySelector(".ask-input");
    input.value = value || "";
    if (opts.placeholder) input.placeholder = opts.placeholder;
    const done = (v) => { overlay.remove(); resolve(v); };
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) done(null); });
    overlay.addEventListener("click", (e) => {
      const r = e.target.closest("[data-r]");
      if (r) done(r.dataset.r === "ok" ? input.value : null);
    });
    // Keep keystrokes away from the terminal / global shortcuts underneath.
    overlay.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); done(input.value); }
      else if (e.key === "Escape") { e.preventDefault(); done(null); }
    });
    document.body.appendChild(overlay);
    input.focus();
    input.select();
  });
}

/**
 * A dialog to pick several of the current sessions (checkboxes) and write a message to them.
 * `items` is [{ id, label, hint }]; resolves to { ids, text } or null when cancelled.
 */
export function askSessionsMessage(title, items, opts = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "ask-overlay";
    const rows = items.map((it) => `<label class="ask-pick"><input type="checkbox" value="${esc(String(it.id))}"${it.checked ? " checked" : ""} /> <span>${esc(it.label)}</span>${it.hint ? ` <em>${esc(it.hint)}</em>` : ""}</label>`).join("");
    overlay.innerHTML = `<div class="ask-box" role="dialog" aria-modal="true">
      <div class="ask-title">${esc(title)}</div>
      ${opts.hint ? `<div class="ask-hint">${esc(opts.hint)}</div>` : ""}
      <label class="ask-pick ask-pick-all"><input type="checkbox" class="ask-all" /> <span>Select all</span></label>
      <div class="ask-picks">${rows || '<div class="ask-hint">No other open sessions.</div>'}</div>
      <textarea class="ask-input ask-msg" rows="3" spellcheck="false" placeholder="${esc(opts.placeholder || "Message")}"></textarea>
      <div class="ask-actions">
        <button class="ask-btn" data-r="cancel">Cancel</button>
        <button class="ask-btn primary" data-r="ok">${esc(opts.okLabel || "Send")}</button>
      </div>
    </div>`;
    const boxes = () => [...overlay.querySelectorAll(".ask-picks input[type=checkbox]")];
    const msg = overlay.querySelector(".ask-msg");
    const done = (v) => { overlay.remove(); resolve(v); };
    const submit = () => {
      const ids = boxes().filter((b) => b.checked).map((b) => b.value);
      if (ids.length === 0 || !msg.value.trim()) return;
      done({ ids, text: msg.value });
    };
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) done(null); });
    overlay.addEventListener("click", (e) => {
      const r = e.target.closest("[data-r]");
      if (r) { if (r.dataset.r === "ok") submit(); else done(null); }
    });
    overlay.addEventListener("change", (e) => {
      if (e.target.classList.contains("ask-all")) for (const b of boxes()) b.checked = e.target.checked;
    });
    overlay.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
      else if (e.key === "Escape") { e.preventDefault(); done(null); }
    });
    document.body.appendChild(overlay);
    msg.focus();
  });
}

/**
 * Model and effort for a session's Claude. Resolves to { model, effort } or null. With `opts.batch` an empty field means
 * "leave as it is" (undefined) and the word "default" clears it; otherwise empty means Claude's default.
 */
export function askModelEffort(title, current = {}, opts = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "ask-overlay";
    const efforts = ["low", "medium", "high", "xhigh", "max"];
    const keep = opts.batch ? '<option value="~">keep as is</option>' : "";
    overlay.innerHTML = `<div class="ask-box" role="dialog" aria-modal="true">
      <div class="ask-title">${esc(title)}</div>
      ${opts.hint ? `<div class="ask-hint">${esc(opts.hint)}</div>` : ""}
      <label class="ask-field">Model
        <input class="ask-input ask-model" list="ask-models" type="text" spellcheck="false" placeholder="${opts.batch ? "keep as is (type default to clear)" : "default"}" />
      </label>
      <datalist id="ask-models"><option value="fable"><option value="opus"><option value="sonnet"><option value="haiku"><option value="opus[1m]"><option value="sonnet[1m]"></datalist>
      <label class="ask-field">Effort
        <select class="ask-input ask-effort">${keep}<option value="">default</option>${efforts.map((e) => `<option value="${e}">${e}</option>`).join("")}</select>
      </label>
      <div class="ask-hint">Used when agenv starts or resumes this session's Claude (Resume all, Continue, reopening). A Claude that is already running keeps what it has.</div>
      <div class="ask-actions">
        <button class="ask-btn" data-r="cancel">Cancel</button>
        <button class="ask-btn primary" data-r="ok">${esc(opts.okLabel || "Save")}</button>
      </div>
    </div>`;
    const model = overlay.querySelector(".ask-model");
    const effort = overlay.querySelector(".ask-effort");
    model.value = current.model || "";
    effort.value = opts.batch ? "~" : (current.effort || "");
    const done = (v) => { overlay.remove(); resolve(v); };
    const submit = () => {
      const m = model.value.trim();
      done({
        model: opts.batch ? (m === "" ? undefined : (m.toLowerCase() === "default" ? "" : m)) : m,
        effort: effort.value === "~" ? undefined : effort.value,
      });
    };
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) done(null); });
    overlay.addEventListener("click", (e) => {
      const r = e.target.closest("[data-r]");
      if (r) { if (r.dataset.r === "ok") submit(); else done(null); }
    });
    overlay.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); submit(); }
      else if (e.key === "Escape") { e.preventDefault(); done(null); }
    });
    document.body.appendChild(overlay);
    model.focus();
  });
}
