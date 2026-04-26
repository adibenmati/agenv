// extensions.js — Dedicated panel renderers for Cost Monitor and ngrok

import { api, esc, getToken } from "./util.js";

let costRefreshTimer = null;
let costFilter = "all"; // "all", "month", "cycle", "custom"
let costMonth = null; // "2026-04" format
let costFrom = null;
let costTo = null;
let costCycleDay = parseInt(localStorage.getItem("tl-cost-cycle-day") || "1", 10); // 1-28

// Plan & provider settings
const PLANS = {
  api:     { label: "API (Pay-per-token)", budget: 0 },
  pro:     { label: "Pro ($20/mo)",        budget: 20 },
  max100:  { label: "Max ($100/mo)",       budget: 100 },
  max200:  { label: "Max ($200/mo)",       budget: 200 },
};
const PROVIDERS = {
  auto:      { label: "Auto-detect" },
  anthropic: { label: "Anthropic API" },
  bedrock:   { label: "AWS Bedrock" },
  vertex:    { label: "Vertex AI" },
};
let costPlan = localStorage.getItem("tl-cost-plan") || "api";
let costProvider = localStorage.getItem("tl-cost-provider") || "auto";
let detectedProvider = null; // set from server response

// ---------------------------------------------------------------------------
// Cost Monitor Panel
// ---------------------------------------------------------------------------

export function initCostPanel() {
  renderCostPanel();
  startCostPolling();
}

export function destroyCostPanel() {
  stopCostPolling();
}

function startCostPolling() {
  stopCostPolling();
  costRefreshTimer = setInterval(refreshCostData, 60000); // 60s — data is cached server-side
}

function stopCostPolling() {
  if (costRefreshTimer) { clearInterval(costRefreshTimer); costRefreshTimer = null; }
}

/** Get the start date for the current billing cycle based on costCycleDay */
function getCycleStart(refDate, monthsBack) {
  const d = new Date(refDate.getFullYear(), refDate.getMonth() - monthsBack, costCycleDay);
  // If cycle day hasn't happened yet this month, go back one more month
  if (monthsBack === 0 && d > refDate) {
    d.setMonth(d.getMonth() - 1);
  }
  return d;
}

function getCycleEnd(cycleStart) {
  return new Date(cycleStart.getFullYear(), cycleStart.getMonth() + 1, costCycleDay);
}

/** Format date as YYYY-MM-DD for the server */
function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

function renderCostPanel() {
  const panel = document.getElementById("cost-panel");
  if (!panel) return;

  const now = new Date();

  let html = '<div class="panel-header"><span class="ph-icon">&#128176;</span><span class="ph-title">AI Cost Monitor</span></div>';

  // Plan & provider row
  html += '<div class="cost-filter" style="border-bottom:1px solid var(--border);gap:6px">';
  html += '<span style="font-size:9px;color:var(--text3)">Plan:</span>';
  html += '<select class="cost-date-input" id="cost-plan-select" style="width:auto;flex:1">';
  for (const [key, p] of Object.entries(PLANS)) {
    html += `<option value="${key}"${costPlan === key ? " selected" : ""}>${esc(p.label)}</option>`;
  }
  html += '</select>';
  html += '</div>';

  // Provider selector row
  html += '<div class="cost-filter" style="border-bottom:1px solid var(--border);gap:6px">';
  html += '<span style="font-size:9px;color:var(--text3)">Provider:</span>';
  html += '<select class="cost-date-input" id="cost-provider-select" style="width:auto;flex:1">';
  for (const [key, prov] of Object.entries(PROVIDERS)) {
    const label = key === "auto" && detectedProvider ? prov.label + " (" + (PROVIDERS[detectedProvider]?.label || detectedProvider) + ")" : prov.label;
    html += `<option value="${key}"${costProvider === key ? " selected" : ""}>${esc(label)}</option>`;
  }
  html += '</select>';
  html += '</div>';

  // Billing cycle setting
  html += '<div class="cost-filter" style="border-bottom:1px solid var(--border)">';
  html += '<span style="font-size:9px;color:var(--text3)">Cycle starts day:</span>';
  html += `<input type="number" class="cost-date-input" id="cost-cycle-day" value="${costCycleDay}" min="1" max="28" style="width:44px">`;
  html += '<span style="font-size:9px;color:var(--text3);flex:1"></span>';
  html += '</div>';

  // Filter bar — row 1: All Time + month quick picks
  html += '<div class="cost-filter">';
  html += `<button class="cost-filter-btn${costFilter === "all" ? " active" : ""}" data-filter="all">All Time</button>`;

  // Generate cycle-aware month buttons (last 6 cycles)
  for (let i = 0; i < 6; i++) {
    const cycleStart = getCycleStart(now, i);
    const val = fmtDate(cycleStart);
    const cycleEnd = getCycleEnd(cycleStart);
    // Label: show the month the cycle mostly falls in
    const label = cycleStart.toLocaleDateString("en", { month: "short", year: "numeric" });
    const active = costFilter === "cycle" && costFrom === val;
    html += `<button class="cost-filter-btn${active ? " active" : ""}" data-filter="cycle" data-from="${val}" data-to="${fmtDate(cycleEnd)}">${label}</button>`;
  }
  html += '</div>';

  // Filter bar — row 2: custom range
  html += '<div class="cost-filter" style="padding-top:0">';
  const customActive = costFilter === "custom";
  html += `<span style="font-size:9px;color:var(--text3)">Custom:</span>`;
  html += `<input type="date" class="cost-date-input" id="cost-from" value="${customActive && costFrom ? costFrom : ""}">`;
  html += '<span style="font-size:9px;color:var(--text3)">to</span>';
  html += `<input type="date" class="cost-date-input" id="cost-to" value="${customActive && costTo ? costTo : ""}">`;
  html += `<button class="cost-filter-btn${customActive ? " active" : ""}" id="cost-apply">Apply</button>`;
  html += '</div>';

  // Data body
  html += '<div id="cost-body"><div class="cost-empty">Loading...</div></div>';

  panel.innerHTML = html;

  // Wire plan selector
  const planSelect = document.getElementById("cost-plan-select");
  if (planSelect) {
    planSelect.addEventListener("change", () => {
      costPlan = planSelect.value;
      localStorage.setItem("tl-cost-plan", costPlan);
      refreshCostData();
    });
  }

  // Wire provider selector
  const provSelect = document.getElementById("cost-provider-select");
  if (provSelect) {
    provSelect.addEventListener("change", () => {
      costProvider = provSelect.value;
      localStorage.setItem("tl-cost-provider", costProvider);
      refreshCostData(); // provider param changes the server cache key automatically
    });
  }

  // Wire cycle day input
  const cycleDayInput = document.getElementById("cost-cycle-day");
  if (cycleDayInput) {
    cycleDayInput.addEventListener("change", () => {
      const v = Math.max(1, Math.min(28, parseInt(cycleDayInput.value, 10) || 1));
      costCycleDay = v;
      cycleDayInput.value = v;
      localStorage.setItem("tl-cost-cycle-day", String(v));
      renderCostPanel(); // re-render with updated cycle labels
    });
  }

  // Wire filter buttons (All Time + cycle months)
  for (const btn of panel.querySelectorAll(".cost-filter-btn[data-filter]")) {
    btn.addEventListener("click", () => {
      const f = btn.dataset.filter;
      if (f === "cycle") {
        costFilter = "cycle";
        costFrom = btn.dataset.from;
        costTo = btn.dataset.to;
      } else if (f === "all") {
        costFilter = "all";
        costFrom = null;
        costTo = null;
      }
      // Update active state visually without full re-render
      for (const b of panel.querySelectorAll(".cost-filter-btn")) b.classList.remove("active");
      btn.classList.add("active");
      refreshCostData();
    });
  }

  // Wire custom date Apply
  const applyBtn = document.getElementById("cost-apply");
  if (applyBtn) {
    applyBtn.addEventListener("click", () => {
      const fromVal = document.getElementById("cost-from")?.value;
      const toVal = document.getElementById("cost-to")?.value;
      if (!fromVal && !toVal) return; // need at least one date
      costFilter = "custom";
      costFrom = fromVal || null;
      // Make 'to' date inclusive: add 1 day so server's >= check includes the full day
      if (toVal) {
        const toDate = new Date(toVal);
        toDate.setDate(toDate.getDate() + 1);
        costTo = fmtDate(toDate);
      } else {
        costTo = null;
      }
      // Update active state
      for (const b of panel.querySelectorAll(".cost-filter-btn")) b.classList.remove("active");
      applyBtn.classList.add("active");
      refreshCostData();
    });
  }

  refreshCostData();
}

async function refreshCostData() {
  const body = document.getElementById("cost-body");
  if (!body) return;

  // Build query params
  let url = "/api/claude-usage";
  const params = [];
  if (costFilter === "cycle" && costFrom) {
    params.push("from=" + costFrom);
    if (costTo) params.push("to=" + costTo);
  } else if (costFilter === "custom" && (costFrom || costTo)) {
    if (costFrom) params.push("from=" + costFrom);
    if (costTo) params.push("to=" + costTo);
  }
  // Pass provider for server-side pricing calculation (empty = auto-detect per entry)
  if (costProvider && costProvider !== "auto") {
    params.push("provider=" + costProvider);
  }
  if (params.length > 0) url += "?" + params.join("&");

  try {
    const resp = await fetch(api(url));
    if (!resp.ok) {
      body.innerHTML = '<div class="cost-empty">Failed to load usage data</div>';
      return;
    }
    const data = await resp.json();

    // Auto-detect provider from response
    if (data.providers) {
      const counts = Object.entries(data.providers).sort((a, b) => b[1] - a[1]);
      const prev = detectedProvider;
      detectedProvider = counts.length > 0 ? counts[0][0] : null;
      // Re-render header if provider changed
      if (prev !== detectedProvider) {
        const badge = document.querySelector(".cost-provider-badge");
        if (!badge && detectedProvider && detectedProvider !== "anthropic") {
          renderCostPanel(); // need to re-render to show badge
          return;
        }
      }
    }

    renderCostData(body, data);
  } catch {
    body.innerHTML = '<div class="cost-empty">Failed to load usage data</div>';
  }
}

function renderCostData(body, data) {
  const t = data.totals;

  if (t.messages === 0) {
    body.innerHTML = '<div class="cost-empty">No Claude Code usage detected for this period.<br><br>' +
      'This reads from <code>~/.claude/projects/*.jsonl</code> files.<br>' +
      'Use Claude Code CLI to generate usage data.</div>';
    return;
  }

  const plan = PLANS[costPlan] || PLANS.api;
  let html = "";

  // Budget progress for subscription plans
  if (plan.budget > 0) {
    const pct = Math.min(100, (t.cost / plan.budget) * 100);
    const remaining = Math.max(0, plan.budget - t.cost);
    html += '<div class="cost-budget">';
    html += `<div class="cost-row"><span class="cost-label">${esc(plan.label)}</span><span class="cost-val cost-highlight">$${t.cost.toFixed(2)} / $${plan.budget}</span></div>`;
    html += `<div class="cost-session-bar" style="margin:4px 0 2px"><div class="cost-bar-fill${pct > 80 ? " warn" : ""}" style="width:${pct}%"></div></div>`;
    html += `<div class="cost-row"><span class="cost-label">${pct.toFixed(1)}% used</span><span class="cost-val">$${remaining.toFixed(2)} remaining</span></div>`;
    html += '</div>';
  }

  // Provider info
  if (data.providers && Object.keys(data.providers).length > 0) {
    const providerLabels = { anthropic: "Anthropic API", bedrock: "AWS Bedrock", vertex: "Vertex AI" };
    const provEntries = Object.entries(data.providers).sort((a, b) => b[1] - a[1]);
    const provStr = provEntries.map(([p, c]) => `${providerLabels[p] || p} (${c} msgs)`).join(", ");
    const pricingLabel = costProvider === "auto" ? "auto-detected per message" : (PROVIDERS[costProvider]?.label || costProvider);
    html += `<div style="padding:4px 8px;font-size:9px;color:var(--text3);border-bottom:1px solid var(--border)">`;
    html += `<div>Detected: ${esc(provStr)}</div>`;
    html += `<div>Pricing: ${esc(pricingLabel)}</div>`;
    html += `</div>`;
  }

  // Totals summary
  html += '<div class="cost-totals">';
  html += `<div class="cost-row"><span class="cost-label">${plan.budget > 0 ? "Equivalent API Cost" : "Total Cost"}</span><span class="cost-val cost-highlight">$${t.cost.toFixed(4)}</span></div>`;
  html += `<div class="cost-row"><span class="cost-label">Input Tokens</span><span class="cost-val">${fmtTok(t.input)}</span></div>`;
  html += `<div class="cost-row"><span class="cost-label">Output Tokens</span><span class="cost-val">${fmtTok(t.output)}</span></div>`;
  if (t.cacheCreate > 0) {
    html += `<div class="cost-row"><span class="cost-label">Cache Write</span><span class="cost-val">${fmtTok(t.cacheCreate)}</span></div>`;
  }
  if (t.cacheRead > 0) {
    html += `<div class="cost-row"><span class="cost-label">Cache Read</span><span class="cost-val">${fmtTok(t.cacheRead)}</span></div>`;
  }
  html += `<div class="cost-row"><span class="cost-label">Messages</span><span class="cost-val">${t.messages}</span></div>`;

  // Burn rate
  if (data.firstSeen && data.lastSeen) {
    const elapsed = (new Date(data.lastSeen) - new Date(data.firstSeen)) / 3600000;
    if (elapsed > 0.01) {
      const rate = t.cost / elapsed;
      html += `<div class="cost-row"><span class="cost-label">Burn Rate</span><span class="cost-val">$${rate.toFixed(2)}/hr</span></div>`;
    }
  }

  // Duration
  if (data.firstSeen) {
    html += `<div class="cost-row"><span class="cost-label">First Activity</span><span class="cost-val">${new Date(data.firstSeen).toLocaleDateString()}</span></div>`;
  }
  if (data.lastSeen) {
    html += `<div class="cost-row"><span class="cost-label">Last Activity</span><span class="cost-val">${new Date(data.lastSeen).toLocaleDateString()}</span></div>`;
  }
  html += "</div>";

  // Per-model breakdown
  const models = Object.entries(data.models || {});
  if (models.length > 0) {
    html += '<div class="cost-sessions">';
    html += '<div class="cost-section-title">Per Model</div>';
    for (const [modelId, m] of models.sort((a, b) => b[1].cost - a[1].cost)) {
      const pct = t.cost > 0 ? ((m.cost / t.cost) * 100).toFixed(0) : 0;
      const shortName = modelId.replace(/^claude-/, "").replace(/-\d{8}$/, "");
      html += `<div class="cost-session">`;
      html += `<div class="cost-session-hdr">`;
      html += `<span class="cost-session-name">${esc(shortName)}</span>`;
      html += `<span class="cost-session-tool">$${m.cost.toFixed(4)}</span>`;
      html += `</div>`;
      html += `<div class="cost-session-bar"><div class="cost-bar-fill" style="width:${Math.min(pct, 100)}%"></div></div>`;
      html += `<div class="cost-session-stats">`;
      html += `<span>${fmtTok(m.input)} in</span>`;
      html += `<span>${fmtTok(m.output)} out</span>`;
      if (m.cacheCreate > 0) html += `<span>${fmtTok(m.cacheCreate)} cache-w</span>`;
      if (m.cacheRead > 0) html += `<span>${fmtTok(m.cacheRead)} cache-r</span>`;
      html += `<span>${m.messages} msgs</span>`;
      html += `</div></div>`;
    }
    html += "</div>";
  }

  // Daily breakdown
  const daily = data.daily || {};
  const days = Object.entries(daily).sort((a, b) => b[0].localeCompare(a[0]));
  if (days.length > 0) {
    const maxDayCost = Math.max(...days.map(([, d]) => d.cost));
    html += '<div class="cost-daily">';
    html += '<div class="cost-section-title">Daily Breakdown</div>';
    for (const [date, d] of days.slice(0, 30)) {
      const pct = maxDayCost > 0 ? (d.cost / maxDayCost * 100) : 0;
      const shortDate = new Date(date + "T12:00:00").toLocaleDateString("en", { month: "short", day: "numeric" });
      html += '<div class="cost-day-row">';
      html += `<span class="cost-day-label">${shortDate}</span>`;
      html += `<div class="cost-day-bar"><div class="cost-day-fill" style="width:${pct}%"></div></div>`;
      html += `<span class="cost-day-val">$${d.cost.toFixed(2)}</span>`;
      html += '</div>';
    }
    html += "</div>";
  }

  body.innerHTML = html;
}

function fmtTok(n) {
  if (!n) return "0";
  if (n < 1000) return String(n);
  if (n < 1000000) return (n / 1000).toFixed(1) + "K";
  return (n / 1000000).toFixed(2) + "M";
}

// Status bar cost indicator
export async function getCostSummary() {
  try {
    let url = "/api/claude-usage";
    if (costProvider && costProvider !== "auto") url += "?provider=" + costProvider;
    const resp = await fetch(api(url));
    if (!resp.ok) return "";
    const data = await resp.json();
    const t = data.totals;
    if (t.cost > 0) {
      return `$${t.cost.toFixed(4)} | ${fmtTok(t.input)}/${fmtTok(t.output)} tok`;
    }
    if (t.input > 0 || t.output > 0) {
      return `${fmtTok(t.input)}/${fmtTok(t.output)} tok`;
    }
  } catch {}
  return "";
}

// ---------------------------------------------------------------------------
// ngrok Tunnel Panel
// ---------------------------------------------------------------------------

let ngrokStatus = null; // { url, pid }
let ngrokPollTimer = null;

export function initNgrokPanel() {
  renderNgrokPanel();
  refreshNgrokStatus();
  startNgrokPolling();
}

function startNgrokPolling() {
  if (ngrokPollTimer) clearInterval(ngrokPollTimer);
  // Poll slower when running (URL known), faster when state is uncertain
  const interval = ngrokStatus?.url ? 30000 : 5000;
  ngrokPollTimer = setInterval(refreshNgrokStatus, interval);
}

export function destroyNgrokPanel() {
  if (ngrokPollTimer) { clearInterval(ngrokPollTimer); ngrokPollTimer = null; }
}

async function refreshNgrokStatus() {
  try {
    const resp = await fetch(api("/api/ngrok/status"));
    if (resp.ok) {
      const data = await resp.json();
      const changed = !ngrokStatus !== !data.running || ngrokStatus?.url !== data.url;
      ngrokStatus = data.running ? { url: data.url, pid: data.pid } : null;
      if (changed) {
        renderNgrokPanel();
        startNgrokPolling(); // adjust interval based on new state
      }
    }
  } catch {}
}

function renderNgrokPanel() {
  const panel = document.getElementById("ngrok-panel");
  if (!panel) return;

  const token = getToken();
  let html = '<div class="panel-header"><span class="ph-icon">&#127760;</span><span class="ph-title">ngrok Tunnel</span></div>';

  // Security warning
  html += '<div class="ngrok-warning">';
  html += '<strong>&#9888; Security Warning</strong>';
  html += 'Exposing Agenv via ngrok gives anyone with the URL access to your terminal sessions. ';
  html += '<br>&#8226; Authentication is <strong>required</strong> — the URL includes your access token.<br>';
  html += '&#8226; Use IP allowlisting to restrict access to known addresses.<br>';
  html += '&#8226; Consider enabling <strong>read-only mode</strong> to prevent command execution.<br>';
  html += '&#8226; Only share the tunnel URL with people you fully trust.';
  html += '</div>';

  // Status
  html += '<div class="ngrok-section">';
  if (ngrokStatus && ngrokStatus.url) {
    html += `<div class="cost-row"><span class="cost-label">Status</span><span class="cost-val"><span class="ngrok-status-dot active"></span>Active</span></div>`;

    // URL with token
    const tunnelUrl = ngrokStatus.url + (ngrokStatus.url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
    html += '<div style="margin:8px 0">';
    html += `<div class="ngrok-url-box" id="ngrok-url-display" title="Click to copy">${esc(tunnelUrl)}</div>`;
    html += '</div>';
    html += '<div style="display:flex;gap:4px;margin:6px 0">';
    html += '<button class="ngrok-btn ngrok-btn-sm ngrok-copy" id="ngrok-copy-btn">Copy URL</button>';
    html += '<button class="ngrok-btn ngrok-btn-sm ngrok-stop" id="ngrok-stop-btn">Stop Tunnel</button>';
    html += '</div>';
  } else {
    html += `<div class="cost-row"><span class="cost-label">Status</span><span class="cost-val"><span class="ngrok-status-dot inactive"></span>Inactive</span></div>`;

    html += '<div class="ngrok-field">';
    html += '<label>Port</label>';
    html += '<input type="number" class="ngrok-input" id="ngrok-port" value="7685" min="1" max="65535">';
    html += '</div>';

    html += '<button class="ngrok-btn ngrok-start" id="ngrok-start-btn">Start HTTP Tunnel</button>';
  }
  html += '</div>';

  // Token management
  html += '<div class="ngrok-section">';
  html += '<div class="cost-section-title" style="padding:8px 0 4px">Access Token</div>';
  html += `<div class="cost-row"><span class="cost-label">Current</span><span class="cost-val" style="font-size:9px;word-break:break-all">${esc(token.slice(0, 8))}...${esc(token.slice(-4))}</span></div>`;
  html += '<button class="ngrok-btn ngrok-btn-sm ngrok-copy" id="ngrok-rotate-btn" style="margin:4px 0">Rotate Token</button>';
  html += '</div>';

  // IP Allowlist
  html += '<div class="ngrok-section">';
  html += '<div class="cost-section-title" style="padding:8px 0 4px">IP Allowlist</div>';
  html += '<div style="font-size:9px;color:var(--text3);margin-bottom:6px">When set, only these IPs can access via ngrok. Leave empty to allow all.</div>';
  html += '<div id="ngrok-ip-list" class="ngrok-ip-list"></div>';
  html += '<button class="ngrok-btn ngrok-btn-sm ngrok-copy" id="ngrok-add-ip">+ Add IP</button>';
  html += '</div>';

  // Read-only mode
  html += '<div class="ngrok-section">';
  html += '<div class="cost-section-title" style="padding:8px 0 4px">Read-Only Mode</div>';
  html += '<div style="font-size:9px;color:var(--text3);margin-bottom:6px">When enabled, ngrok clients can view terminals but cannot type commands.</div>';
  html += '<label style="display:flex;align-items:center;gap:8px;font-size:11px;cursor:pointer">';
  html += '<input type="checkbox" id="ngrok-readonly"> Enable read-only for tunnel connections';
  html += '</label>';
  html += '</div>';

  // Output
  html += '<div id="ngrok-output" class="ngrok-output"></div>';

  panel.innerHTML = html;

  // Load saved settings
  loadNgrokSettings();

  // Wire events
  wireNgrokEvents(panel);
}

function loadNgrokSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem("tl-ngrok") || "{}");
    const ipList = document.getElementById("ngrok-ip-list");
    const readonlyCheck = document.getElementById("ngrok-readonly");
    if (saved.ips && ipList) {
      for (const ip of saved.ips) addIpRow(ipList, ip);
    }
    if (readonlyCheck && saved.readonly) readonlyCheck.checked = true;
  } catch {}
}

function saveNgrokSettings() {
  const ips = [];
  for (const input of document.querySelectorAll("#ngrok-ip-list input")) {
    const v = input.value.trim();
    if (v) ips.push(v);
  }
  const readonly = document.getElementById("ngrok-readonly")?.checked || false;
  localStorage.setItem("tl-ngrok", JSON.stringify({ ips, readonly }));

  // Push settings to server
  fetch(api("/api/ngrok/settings"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ allowedIps: ips, readOnly: readonly }),
  }).catch(() => {});
}

function addIpRow(container, value) {
  const row = document.createElement("div");
  row.className = "ngrok-ip-row";
  row.innerHTML = `<input type="text" class="ngrok-input" placeholder="e.g. 203.0.113.50" value="${esc(value || "")}"><button class="ngrok-ip-remove" title="Remove">&times;</button>`;
  row.querySelector("input").addEventListener("change", saveNgrokSettings);
  row.querySelector(".ngrok-ip-remove").addEventListener("click", () => { row.remove(); saveNgrokSettings(); });
  container.appendChild(row);
}

function wireNgrokEvents(panel) {
  const startBtn = document.getElementById("ngrok-start-btn");
  const stopBtn = document.getElementById("ngrok-stop-btn");
  const copyBtn = document.getElementById("ngrok-copy-btn");
  const urlBox = document.getElementById("ngrok-url-display");
  const rotateBtn = document.getElementById("ngrok-rotate-btn");
  const addIpBtn = document.getElementById("ngrok-add-ip");
  const readonlyCheck = document.getElementById("ngrok-readonly");

  if (startBtn) {
    startBtn.addEventListener("click", async () => {
      const port = document.getElementById("ngrok-port")?.value || "7685";
      startBtn.disabled = true;
      startBtn.textContent = "Starting...";
      saveNgrokSettings();
      try {
        const resp = await fetch(api("/api/ngrok/start"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ port: parseInt(port, 10) }),
        });
        const data = await resp.json();
        if (data.ok) {
          ngrokStatus = { url: data.url, pid: data.pid };
          renderNgrokPanel();
        } else {
          showNgrokOutput(data.error || "Failed to start ngrok");
          startBtn.disabled = false;
          startBtn.textContent = "Start HTTP Tunnel";
        }
      } catch (e) {
        showNgrokOutput("Error: " + e.message);
        startBtn.disabled = false;
        startBtn.textContent = "Start HTTP Tunnel";
      }
    });
  }

  if (stopBtn) {
    stopBtn.addEventListener("click", async () => {
      stopBtn.disabled = true;
      stopBtn.textContent = "Stopping...";
      try {
        await fetch(api("/api/ngrok/stop"), { method: "POST" });
        ngrokStatus = null;
        renderNgrokPanel();
      } catch {
        stopBtn.disabled = false;
        stopBtn.textContent = "Stop Tunnel";
      }
    });
  }

  function copyUrl() {
    if (!ngrokStatus?.url) return;
    const token = getToken();
    const tunnelUrl = ngrokStatus.url + (ngrokStatus.url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
    navigator.clipboard.writeText(tunnelUrl).catch(() => {});
    if (copyBtn) { copyBtn.textContent = "Copied!"; setTimeout(() => { copyBtn.textContent = "Copy URL"; }, 1500); }
  }

  if (copyBtn) copyBtn.addEventListener("click", copyUrl);
  if (urlBox) urlBox.addEventListener("click", copyUrl);

  if (rotateBtn) {
    rotateBtn.addEventListener("click", async () => {
      if (!confirm("Rotate token? This will invalidate all existing URLs and disconnect current clients.")) return;
      rotateBtn.disabled = true;
      rotateBtn.textContent = "Rotating...";
      try {
        const resp = await fetch(api("/api/token/rotate"), { method: "POST" });
        const data = await resp.json();
        if (data.ok) {
          window.location.href = "/?token=" + encodeURIComponent(data.token);
        } else {
          showNgrokOutput(data.error || "Failed to rotate token");
        }
      } catch (e) {
        showNgrokOutput("Error: " + e.message);
      }
      rotateBtn.disabled = false;
      rotateBtn.textContent = "Rotate Token";
    });
  }

  if (addIpBtn) {
    addIpBtn.addEventListener("click", () => {
      const list = document.getElementById("ngrok-ip-list");
      if (list) addIpRow(list, "");
    });
  }

  if (readonlyCheck) {
    readonlyCheck.addEventListener("change", saveNgrokSettings);
  }
}

function showNgrokOutput(msg) {
  const out = document.getElementById("ngrok-output");
  if (out) out.textContent = msg;
}

export function destroy() {
  stopCostPolling();
  destroyNgrokPanel();
}
