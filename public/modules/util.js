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
