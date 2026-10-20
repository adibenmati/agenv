// messages.js — Messages sidebar panel: what the running sessions said to each other, and a box to say something to one.
// Sessions send with `agenv send <name> <text>`; this panel only shows the log and sends as "you".

import { api, esc, ago } from "./util.js";

let panelEl = null;
let _toast = null;
let polling = false;
let eventTimer = null;
let log = [];
let peers = [];
let groups = [];
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
    const all = e.target.closest(".ms-pick-all");
    if (all) for (const b of panelEl.querySelectorAll(".ms-pick")) b.checked = all.checked;
    if (e.target.closest(".ms-run")) runInMany();
  });
  panelEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && e.target.closest(".ms-text")) { e.preventDefault(); send(); }
  });
}

async function refresh() {
  if (!panelEl) return;
  try {
    let sess;
    [log, peers, sess] = await Promise.all([request("/api/messages"), request("/api/messages/peers"), request("/api/sessions")]);
    const all = new Set();
    for (const s of sess) if (s.group) { const parts = s.group.split("/"); for (let i = 1; i <= parts.length; i++) all.add(parts.slice(0, i).join("/")); }
    groups = [...all].sort();
  } catch (e) {
    log = []; peers = []; groups = [];
    render(e.message);
    return;
  }
  render();
}

async function send() {
  if (busy) return;
  const text = panelEl.querySelector(".ms-text");
  const ids = [...panelEl.querySelectorAll(".ms-pick:checked")].map((b) => b.value);
  if (!text || ids.length === 0 || !text.value.trim()) { if (ids.length === 0) toast("Tick the sessions to message", "error"); return; }
  busy = true;
  try {
    const body = { to: ids, text: text.value };
    let res = await request("/api/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const unsure = res.filter((r) => r.status === "skipped" && r.code === "no-agent-cli");
    if (unsure.length && confirm("No agent CLI was detected in " + unsure.map((r) => r.name).join(", ") + ", so the message might run as a shell command. Send it there anyway?")) {
      const again = await request("/api/messages", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: unsure.map((r) => r.name), text: text.value, force: true }) });
      res = res.filter((r) => !unsure.includes(r)).concat(again);
    }
    const sent = res.filter((r) => r.status === "sent");
    const skipped = res.filter((r) => r.status === "skipped");
    if (sent.length) text.value = "";
    if (skipped.length) toast("Not sent to " + skipped.map((r) => r.name + " (" + r.reason + ")").join("; "), "error");
    else if (sent.some((r) => r.reason)) toast("Some sessions are busy; the message goes in as soon as they are idle", "info");
  } catch (e) {
    toast(e.message, "error");
  } finally {
    busy = false;
    refresh();
  }
}

async function runInMany() {
  if (busy) return;
  const target = panelEl.querySelector(".ms-target");
  const cmd = panelEl.querySelector(".ms-cmd");
  const agentsOnly = panelEl.querySelector(".ms-agents-only");
  if (!target || !cmd || !cmd.value.trim()) return;
  busy = true;
  try {
    const body = { command: cmd.value, agentsOnly: !!(agentsOnly && agentsOnly.checked) };
    if (target.value !== "__all__all") body.group = target.value;
    const res = await request("/api/messages/broadcast", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const sent = res.filter((r) => r.status === "sent").length;
    toast("Ran in " + sent + " session" + (sent === 1 ? "" : "s") + (res.length > sent ? ", skipped " + (res.length - sent) : ""), sent ? "info" : "error");
    cmd.value = "";
  } catch (e) {
    toast(e.message, "error");
  } finally {
    busy = false;
    refresh();
  }
}

function render(error) {
  if (!panelEl) return;
  const ticked = new Set([...panelEl.querySelectorAll(".ms-pick:checked")].map((b) => b.value));
  const draft = panelEl.querySelector(".ms-text");
  const draftText = draft ? draft.value : "";
  const cmdEl = panelEl.querySelector(".ms-cmd");
  const cmdText = cmdEl ? cmdEl.value : "";
  const tgtEl = panelEl.querySelector(".ms-target");
  const tgtVal = tgtEl ? tgtEl.value : "__all__all";
  const agOnlyEl = panelEl.querySelector(".ms-agents-only");
  const agOnly = agOnlyEl ? agOnlyEl.checked : true;
  const options = peers.filter((p) => p.live).map((p) =>
    `<label class="ms-peer"><input type="checkbox" class="ms-pick" value="${esc(String(p.id))}"${ticked.has(String(p.id)) ? " checked" : ""} /> <span>${esc(p.name || "session " + p.id)}</span> <em>${esc(p.tool)}, ${esc(p.state)}</em></label>`).join("");
  const groupOptions = ["<option value=\"__all__all\">All sessions</option>"].concat(groups.map((g) =>
    `<option value="${esc(g)}"${g === tgtVal ? " selected" : ""}>Group: ${esc(g)}</option>`)).join("");
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
      <div class="ms-peers">
        <label class="ms-peer ms-peer-all"><input type="checkbox" class="ms-pick-all" /> <span>All sessions</span></label>
        ${options || '<div class="ms-empty">No open sessions.</div>'}
      </div>
      <textarea class="ms-text" rows="2" placeholder="Message to the selected session (Enter to send)"></textarea>
      <button class="ms-send">Send</button>
    </div>
    <div class="ms-header"><span class="ms-title">Run a command in many sessions</span></div>
    <div class="ms-hint">Types it into each terminal and presses Enter, e.g. <code>/remote-control</code>.</div>
    <div class="ms-form">
      <select class="ms-target">${groupOptions}</select>
      <input class="ms-cmd" placeholder="/remote-control" />
      <label class="ms-check"><input type="checkbox" class="ms-agents-only"${agOnly ? " checked" : ""} /> only sessions running an agent CLI</label>
      <button class="ms-run">Run</button>
    </div>
    <div class="ms-list">${rows || '<div class="ms-empty">No messages yet.</div>'}</div>`;
  if (next === html) return;
  html = next;
  panelEl.innerHTML = next;
  const t = panelEl.querySelector(".ms-text");
  if (t) t.value = draftText;
  const c = panelEl.querySelector(".ms-cmd");
  if (c) c.value = cmdText;
}

function startPolling() { polling = true; }
function stopPolling() { polling = false; if (eventTimer) { clearTimeout(eventTimer); eventTimer = null; } }

function handleEvent(name) {
  if (name !== "messages-updated" || !polling || !panelEl) return;
  if (eventTimer) clearTimeout(eventTimer);
  eventTimer = setTimeout(() => { eventTimer = null; if (polling) refresh(); }, 200);
}

export const messagesPanel = { init, refresh, startPolling, stopPolling, handleEvent };
