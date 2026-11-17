// sessioninfo.js — the live "working on" line under each session in the sidebar, and the info panel it opens.
//
// The line comes from the server (session.activity): the task an agent writes in the terminal title (Claude Code
// does), or the last thing typed in the session. While the session works, the text scrolls left to right; when it is
// done or idle it stands still. Clicking it opens a panel with the details, the recent activity and the latest output.

import { api, esc, ago, short } from "./util.js";
import { getScreenLines } from "./terminal.js";

const PX_PER_SEC = 45;   // marquee speed
const REFRESH_MS = 3000; // info panel refresh while open

/** True while the session is working on its activity. */
export function isWorking(s) {
  if (!s || s.live === false) return false;
  const a = s.activity;
  if (a && a.busy != null) return a.busy;
  return s.status === "running";
}

/** The activity line of a session card ("" when it has none yet). */
export function renderActivityLine(s) {
  const a = s.activity;
  if (!a || !a.text) return "";
  const working = isWorking(s);
  const text = (a.source === "input" ? "› " : "") + a.text;
  // Same speed for every line; a negative delay keeps the text where it was when the list is drawn again.
  const dur = Math.max(6, (text.length * 6.5 + 220) / PX_PER_SEC);
  const delay = -((Date.now() / 1000) % dur);
  const tip = (working ? "Working on: " : "Last: ") + a.text + "\nClick for details";
  return `<div class="sp-activity${working ? " working" : ""}" data-act="session-info" data-sid="${s.id}" title="${esc(tip)}" role="button" tabindex="0">`
    + `<span class="sp-act-text" dir="auto" style="animation-duration:${dur.toFixed(1)}s;animation-delay:${delay.toFixed(2)}s">${esc(text)}</span></div>`;
}

let openPanel = null; // { sid, overlay, timer }

export function closeSessionInfo() {
  if (!openPanel) return;
  clearInterval(openPanel.timer);
  document.removeEventListener("keydown", openPanel.onKey, true);
  openPanel.overlay.remove();
  openPanel = null;
}

/**
 * Show the info panel for a session. `getSession()` returns its latest list entry (the sidebar keeps it fresh);
 * `onOpen(sid)` opens the session in a pane.
 */
export function showSessionInfo(sid, getSession, onOpen) {
  closeSessionInfo();
  const overlay = document.createElement("div");
  overlay.className = "si-overlay";
  overlay.innerHTML = `<div class="si-box" role="dialog" aria-modal="true" aria-label="Session details"></div>`;
  const box = overlay.querySelector(".si-box");
  let detail = null;
  let inFlight = false;

  const draw = () => {
    const s = getSession();
    if (!s) { closeSessionInfo(); return; }
    box.innerHTML = renderPanel(s, detail);
  };
  const load = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const r = await fetch(api("/api/sessions/" + sid + "/activity"));
      if (r.ok) detail = await r.json();
      else if (r.status === 404) { closeSessionInfo(); return; }
    } catch {} finally { inFlight = false; }
    if (openPanel && openPanel.overlay === overlay) draw();
  };

  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) closeSessionInfo(); });
  overlay.addEventListener("click", (e) => {
    const b = e.target.closest("[data-si]");
    if (!b) return;
    if (b.dataset.si === "close") closeSessionInfo();
    else if (b.dataset.si === "open") { closeSessionInfo(); if (onOpen) onOpen(sid); }
  });
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeSessionInfo(); } };
  document.addEventListener("keydown", onKey, true);

  document.body.appendChild(overlay);
  openPanel = { sid, overlay, onKey, timer: setInterval(load, REFRESH_MS) };
  draw();
  load();
  const btn = box.querySelector("[data-si='open']");
  if (btn) btn.focus();
}

function renderPanel(s, detail) {
  const a = (detail && detail.activity) || s.activity;
  const working = isWorking({ ...s, activity: a });
  const state = s.live === false ? "asleep" : (s.status || "idle");
  const an = s.analytics || {};

  let h = `<div class="si-head">`;
  h += `<span class="sp-status ${esc(state)}"></span>`;
  h += `<span class="si-name" dir="auto">${esc(s.name || "Session " + s.id)}</span>`;
  if (s.tool && s.tool !== "terminal") h += `<span class="sp-badge ${esc(s.tool)}">${esc(s.tool)}</span>`;
  h += `<span class="sp-status-label ${esc(state)}">${esc(state)}</span>`;
  h += `<button class="si-x" data-si="close" title="Close (Esc)">&times;</button>`;
  h += `</div>`;

  h += `<div class="si-now${working ? " working" : ""}">`;
  h += `<div class="si-label">${working ? "Working on" : a ? "Last activity" : "Activity"}</div>`;
  if (a) {
    h += `<div class="si-now-text" dir="auto">${esc(a.text)}</div>`;
    h += `<div class="si-sub">${a.source === "task" ? "Task the agent reported" : "Typed in the session"} · ${esc(agoLong(a.at))}${a.busy === false ? " · done" : ""}</div>`;
  } else {
    h += `<div class="si-sub">Nothing yet. It shows what an agent reports it is doing, or the last command typed here.</div>`;
  }
  h += `</div>`;

  const facts = [
    ["Folder", short(s.cwd || "")],
    ["Running for", s.created ? agoLong(s.created, true) : ""],
    ["Last output", s.lastActivity ? agoLong(s.lastActivity) : ""],
    ["Model", [s.model, s.effort].filter(Boolean).join(" · ")],
    ["Cost", an.estimatedCost > 0 ? "$" + an.estimatedCost.toFixed(an.estimatedCost < 1 ? 3 : 2) : ""],
    ["Viewers", s.clients > 0 ? String(s.clients) : ""],
    ["Claude", s.claudeSessionId || ""],
  ].filter(([, v]) => v);
  h += `<div class="si-facts">`;
  for (const [k, v] of facts) h += `<div class="si-k">${esc(k)}</div><div class="si-v" title="${esc(v)}">${esc(v)}</div>`;
  h += `</div>`;

  const hist = (detail && detail.history) || [];
  if (hist.length > 1) {
    h += `<div class="si-label">Recent activity</div><ul class="si-hist">`;
    for (const it of hist.slice(0, 10)) {
      h += `<li><span class="si-hist-t">${esc(agoShort(it.at))}</span><span class="si-hist-i">${it.source === "task" ? "✦" : "›"}</span><span class="si-hist-x" dir="auto">${esc(it.text)}</span></li>`;
    }
    h += `</ul>`;
  }

  // The screen as the terminal shows it when the session is open here; otherwise the end of its output, which is
  // only readable for plain commands (agents redraw the screen in place).
  let lines = getScreenLines(s.id, 14);
  if (!lines && s.tool === "terminal" && detail && detail.tail) lines = detail.tail.slice(-14);
  h += `<div class="si-label">Latest output</div>`;
  if (lines && lines.length) h += `<pre class="si-out">${esc(lines.join("\n"))}</pre>`;
  else h += `<div class="si-sub">${s.live === false ? "Not started yet." : "Open the session to see its screen."}</div>`;

  h += `<div class="si-actions"><button class="ask-btn primary" data-si="open">Open session</button></div>`;
  return h;
}

function agoShort(ts) {
  const a = ago(ts);
  return a === "now" ? "now" : a + " ago";
}

function agoLong(ts, plain) {
  if (!ts) return "";
  const d = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  let t;
  if (d < 60) t = d + "s";
  else if (d < 3600) t = Math.floor(d / 60) + "m " + (d % 60) + "s";
  else if (d < 86400) t = Math.floor(d / 3600) + "h " + Math.floor((d % 3600) / 60) + "m";
  else t = Math.floor(d / 86400) + "d " + Math.floor((d % 86400) / 3600) + "h";
  return plain ? t : t + " ago";
}
