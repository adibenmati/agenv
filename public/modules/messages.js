// messages.js — Messages sidebar panel: what the running sessions said to each other, and a box to say something to one.
// Sessions send with `agenv send <name> <text>`; this panel only shows the log and sends as "you".

import { api, esc, ago } from "./util.js";

let panelEl = null;
let _toast = null;
let polling = false;
let eventTimer = null;
let log = [];
let peers = [];
let busy = false;
let html = null;

async function request(path, opts) {
  let resp;
  try { resp = await fetch(api(path), opts); } catch (e) { throw new Error("Network error: " + e.message); }
  let data = null;
  try { data = await resp.json(); } catch {}
  if (!resp.ok) throw new Error((data && data.error) || "Request failed (" + resp.status + ")");
  return data;
}

const toast = (msg, type) => { if (_toast) _toast(msg, type || "info"); };

function init(o) {
  panelEl = o.panel;
  _toast = o.showToast;
  panelEl.addEventListener("click", (e) => {
    if (e.target.closest(".ms-send")) send();
  });
  panelEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && e.target.closest(".ms-text")) { e.preventDefault(); send(); }
  });
}

async function refresh() {
  if (!panelEl) return;
  try {
    [log, peers] = await Promise.all([request("/api/messages"), request("/api/messages/peers")]);
  } catch (e) {
    log = []; peers = [];
    render(e.message);
    return;
  }
  render();
}

async function send() {
  if (busy) return;
  const to = panelEl.querySelector(".ms-to");
  const text = panelEl.querySelector(".ms-text");
  if (!to || !text || !to.value || !text.value.trim()) return;
  busy = true;
  try {
    const m = await request("/api/messages", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: to.value, text: text.value }),
    });
    text.value = "";
    if (m.status === "queued") toast(m.to + " is busy; the message goes in as soon as it is idle", "info");
  } catch (e) {
    toast(e.message, "error");
  } finally {
    busy = false;
    refresh();
  }
}

function render(error) {
  if (!panelEl) return;
  const sel = panelEl.querySelector(".ms-to");
  const chosen = sel ? sel.value : "";
  const draft = panelEl.querySelector(".ms-text");
  const draftText = draft ? draft.value : "";
  const options = peers.filter((p) => p.live).map((p) =>
    `<option value="${esc(p.name || String(p.id))}"${(p.name || String(p.id)) === chosen ? " selected" : ""}>${esc(p.name || "session " + p.id)} (${esc(p.tool)}, ${esc(p.state)})</option>`).join("");
  const rows = log.slice().reverse().slice(0, 100).map((m) => `
    <div class="ms-row ms-${esc(m.status)}">
      <div class="ms-meta"><b>${esc(m.from)}</b> &rarr; <b>${esc(m.to)}</b> <span class="ms-when">${esc(ago(m.ts))}</span>
        <span class="ms-status">${esc(m.status === "failed" ? "failed: " + (m.error || "") : m.status)}</span></div>
      <div class="ms-body">${esc(m.text)}</div>
    </div>`).join("");
  const next = `
    <div class="ms-header"><span class="ms-title">Messages</span></div>
    <div class="ms-hint">Sessions message each other with <code>agenv send &lt;name&gt; &lt;text&gt;</code> (Claude, Codex, Gemini, anything that runs commands).</div>
    ${error ? `<div class="ms-err">${esc(error)}</div>` : ""}
    <div class="ms-form">
      <select class="ms-to">${options || '<option value="">no agent sessions open</option>'}</select>
      <textarea class="ms-text" rows="2" placeholder="Message to the selected session (Enter to send)"></textarea>
      <button class="ms-send">Send</button>
    </div>
    <div class="ms-list">${rows || '<div class="ms-empty">No messages yet.</div>'}</div>`;
  if (next === html) return;
  html = next;
  panelEl.innerHTML = next;
  const t = panelEl.querySelector(".ms-text");
  if (t) t.value = draftText;
}

function startPolling() { polling = true; }
function stopPolling() { polling = false; if (eventTimer) { clearTimeout(eventTimer); eventTimer = null; } }

function handleEvent(name) {
  if (name !== "messages-updated" || !polling || !panelEl) return;
  if (eventTimer) clearTimeout(eventTimer);
  eventTimer = setTimeout(() => { eventTimer = null; if (polling) refresh(); }, 200);
}

export const messagesPanel = { init, refresh, startPolling, stopPolling, handleEvent };
