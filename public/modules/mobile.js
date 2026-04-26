// mobile.js — Mobile bottom bar (quick commands + virtual keyboard) and options panel
// Only visible on touch/coarse-pointer devices via CSS @media(pointer:coarse)

import { esc } from "./util.js";

let _sendInput = null;     // (data) => {} — send raw data to active terminal
let _getHistory = null;    // () => string[]
let _onLaunchAgent = null; // (cmd, name) => {}
let _onNewTab = null;      // () => {}
let _onCopy = null;        // () => {}
let _onPaste = null;       // () => {}
let _onSmartPaste = null;  // () => {}
let _onSelectAll = null;   // () => {}
let _onClear = null;       // () => {}
let _onHome = null;        // () => {}
let _getAgentCommand = null; // () => string
let _onStartSTT = null;    // () => {}
let _onStopSTT = null;     // () => {}
let _isSTTListening = null; // () => boolean

// DOM refs
let quickCmdsEl, mobileKbEl, mpOverlay, mpPanel, mpContent;

// Keyboard modifier state
const kbMods = { ctrl: false, alt: false };

function updMods() {
  const btns = document.querySelectorAll(".kb-key[data-mod]");
  for (const btn of btns) {
    btn.classList.toggle("on", !!kbMods[btn.getAttribute("data-mod")]);
  }
}

export function init(opts) {
  _sendInput = opts.sendInput || null;
  _getHistory = opts.getHistory || (() => []);
  _onLaunchAgent = opts.onLaunchAgent || null;
  _onNewTab = opts.onNewTab || null;
  _onCopy = opts.onCopy || null;
  _onPaste = opts.onPaste || null;
  _onSmartPaste = opts.onSmartPaste || null;
  _onSelectAll = opts.onSelectAll || null;
  _onClear = opts.onClear || null;
  _onHome = opts.onHome || null;
  _getAgentCommand = opts.getAgentCommand || (() => "claude");
  _onStartSTT = opts.onStartSTT || null;
  _onStopSTT = opts.onStopSTT || null;
  _isSTTListening = opts.isSTTListening || (() => false);

  quickCmdsEl = document.getElementById("quick-cmds");
  mobileKbEl = document.getElementById("mobile-kb");
  mpOverlay = document.getElementById("mobile-panel-overlay");
  mpPanel = document.getElementById("mobile-panel");
  mpContent = document.getElementById("mp-content");

  if (!quickCmdsEl || !mobileKbEl) return;

  initQuickCmds();
  initKeyboard();
  initPanel();
}

/* ---- Quick Commands Bar ---- */
function initQuickCmds() {
  const cmds = [
    ["\u2630 Menu", null, "menu"],
    ["Ctrl+C", "\x03"], ["claude --continue", "claude --continue\r"], ["cd ..", "cd ..\r"],
    ["ls", "ls\r"], ["git status", "git status\r"], ["git pull", "git pull\r"],
    ["clear", "clear\r"], ["pwd", "pwd\r"], ["exit", "exit\r"],
    ["npm run", "npm run "], ["python3", "python3 "], ["Ctrl+D", "\x04"],
  ];
  for (const c of cmds) {
    const b = document.createElement("div");
    b.className = "qcmd";
    b.textContent = c[0];
    if (c[2] === "menu") {
      b.style.fontWeight = "700";
      b.style.color = "var(--accent)";
      b.onclick = () => openPanel();
    } else {
      b.onclick = () => { if (_sendInput) _sendInput(c[1]); };
    }
    quickCmdsEl.appendChild(b);
  }
}

/* ---- Virtual Keyboard ---- */
function initKeyboard() {
  const keys = [
    ["Tab", "\t", "mod"], ["Esc", "\x1b", "mod"], ["Ctrl", null, "mod", "ctrl"], ["Alt", null, "mod", "alt"],
    ["\u2191", "\x1b[A", "arrow"], ["\u2193", "\x1b[B", "arrow"], ["\u2190", "\x1b[D", "arrow"], ["\u2192", "\x1b[C", "arrow"],
    ["|"], ["/"], ["\\"], ["~"], ["-"], ["_"], ["."], [":"], [";"], ["'"], ['"'], ["`"],
    ["{"], ["}"], ["["], ["]"], ["("], [")"], ["<"], [">"], ["="], ["!"], ["@"], ["#"], ["$"], ["&"], ["*"], ["^"], ["+"],
  ];
  for (const k of keys) {
    const b = document.createElement("button");
    b.className = "kb-key" + (k[2] ? " " + k[2] : "");
    b.textContent = k[0];
    if (k[3]) b.setAttribute("data-mod", k[3]);
    else if (k[1]) b.setAttribute("data-send", k[1]);
    else b.setAttribute("data-char", k[0].trim());
    mobileKbEl.appendChild(b);
  }

  // Prevent focus stealing from terminal (mousedown for desktop, touchend for mobile)
  mobileKbEl.addEventListener("mousedown", (e) => e.preventDefault());

  // Use touchend instead of click — on mobile, preventDefault on touchstart
  // can suppress the click event entirely, making buttons unresponsive.
  // Track touch start target to ensure we only fire on clean taps.
  let touchTarget = null;
  mobileKbEl.addEventListener("touchstart", (e) => {
    const btn = e.target.closest(".kb-key");
    if (btn) {
      e.preventDefault(); // prevent focus steal + scroll
      touchTarget = btn;
    }
  }, { passive: false });

  mobileKbEl.addEventListener("touchend", (e) => {
    const btn = e.target.closest(".kb-key");
    if (btn && btn === touchTarget) {
      e.preventDefault();
      handleKeyPress(btn);
    }
    touchTarget = null;
  });

  // Desktop fallback — click only fires if touchend didn't handle it
  mobileKbEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".kb-key");
    if (!btn) return;
    handleKeyPress(btn);
  });
}

function handleKeyPress(btn) {
  if (!_sendInput) return;

  const mod = btn.getAttribute("data-mod");
  if (mod) {
    kbMods[mod] = !kbMods[mod];
    updMods();
    return;
  }

  let data = btn.getAttribute("data-send") || btn.getAttribute("data-char");
  if (!data) return;

  if (kbMods.ctrl && data.length === 1) {
    const c = data.toLowerCase().charCodeAt(0);
    if (c >= 97 && c <= 122) data = String.fromCharCode(c - 96);
    kbMods.ctrl = false;
    updMods();
  } else if (kbMods.alt && data.length === 1) {
    data = "\x1b" + data;
    kbMods.alt = false;
    updMods();
  }

  _sendInput(data);
}

/* ---- Options Panel ---- */
function initPanel() {
  if (!mpOverlay || !mpPanel || !mpContent) return;

  mpOverlay.addEventListener("click", closePanel);
  const handle = mpPanel.querySelector(".mp-handle");
  if (handle) handle.addEventListener("click", closePanel);

  mpContent.addEventListener("click", (e) => {
    // AI grid buttons
    const btn = e.target.closest(".mp-btn");
    if (btn) {
      const newtab = btn.getAttribute("data-newtab");
      if (newtab) { if (_onNewTab) _onNewTab(); closePanel(); return; }
      const cmd = btn.getAttribute("data-cmd");
      if (cmd) {
        closePanel();
        if (_onLaunchAgent) _onLaunchAgent(cmd, cmd.split(" ")[0]);
        return;
      }
    }

    // Quick command pills
    const pill = e.target.closest(".mp-pill");
    if (pill) {
      const sig = pill.getAttribute("data-sig");
      if (sig) { if (_sendInput) _sendInput(sig); closePanel(); return; }
      const pc = pill.getAttribute("data-cmd");
      if (pc) {
        if (_sendInput) _sendInput(pc + "\r");
        closePanel();
        return;
      }
    }

    // History items
    const hist = e.target.closest(".mp-hist-item");
    if (hist) {
      if (_sendInput) _sendInput(hist.getAttribute("data-cmd") + "\r");
      closePanel();
      return;
    }

    // Action buttons
    const act = e.target.closest(".mp-act");
    if (act) {
      const a = act.getAttribute("data-act");
      if (a === "copy" && _onCopy) _onCopy();
      else if (a === "paste" && _onPaste) _onPaste();
      else if (a === "smartpaste" && _onSmartPaste) _onSmartPaste();
      else if (a === "selectall" && _onSelectAll) _onSelectAll();
      else if (a === "clear" && _onClear) _onClear();
      else if (a === "home" && _onHome) _onHome();
      else if (a === "newtab" && _onNewTab) _onNewTab();
      else if (a === "stt") {
        if (_isSTTListening && _isSTTListening()) {
          if (_onStopSTT) _onStopSTT();
        } else {
          if (_onStartSTT) _onStartSTT();
        }
        // Re-render to update button state
        setTimeout(() => renderPanel(), 100);
        return; // Don't close panel
      }
      closePanel();
    }
  });

  mpContent.addEventListener("mousedown", (e) => {
    if (e.target.closest(".mp-btn,.mp-pill,.mp-hist-item,.mp-act")) e.preventDefault();
  });
}

function openPanel() {
  renderPanel();
  mpOverlay.classList.add("show");
  mpPanel.classList.add("show");
}

function closePanel() {
  mpPanel.classList.remove("show");
  mpOverlay.classList.remove("show");
}

function renderPanel() {
  let h = "";

  /* AI Quick Launch */
  h += '<div class="mp-section"><div class="mp-label">AI Quick Launch</div><div class="mp-grid">';
  const aiButtons = [
    { t1: "Claude", t2: "--continue", cmd: "claude --continue", ico: "ai" },
    { t1: "Claude Opus", t2: "--model opus", cmd: "claude --model opus", ico: "ai" },
    { t1: "Claude Sonnet", t2: "--model sonnet", cmd: "claude --model sonnet", ico: "ai" },
    { t1: "Opus + Auto", t2: "--dangerously-skip-permissions", cmd: "claude --model opus --dangerously-skip-permissions", ico: "ai" },
    { t1: "Sonnet + Auto", t2: "--dangerously-skip-permissions", cmd: "claude --model sonnet --dangerously-skip-permissions", ico: "ai" },
    { t1: "New Claude", t2: "fresh session", cmd: "claude", ico: "ai" },
    { t1: "Vertex AI", t2: "gcloud ai", cmd: "vertex", ico: "green" },
    { t1: "New Terminal", t2: "shell session", cmd: null, ico: "blue", newtab: true },
  ];
  for (const b of aiButtons) {
    const icon = b.ico === "ai" ? "C" : b.ico === "green" ? "V" : "&gt;";
    h += `<div class="mp-btn" ${b.cmd ? `data-cmd="${esc(b.cmd)}"` : ""} ${b.newtab ? 'data-newtab="1"' : ""}>`;
    h += `<div class="mp-icon ${b.ico}">${icon}</div>`;
    h += `<div class="mp-txt"><div class="mp-t1">${esc(b.t1)}</div><div class="mp-t2">${esc(b.t2)}</div></div></div>`;
  }
  h += "</div></div>";

  /* Git section */
  h += '<div class="mp-section"><div class="mp-label">Git</div><div class="mp-pills">';
  const gitCmds = [
    ["git pull", "git pull"], ["git push", "git push"], ["git add .", "git add ."], ["git commit", 'git commit -m "'],
    ["git stash", "git stash"], ["git stash pop", "git stash pop"], ["git checkout .", "git checkout ."],
    ["git branch", "git branch"], ["git status", "git status"], ["git log --oneline", "git log --oneline -10"],
    ["git diff", "git diff"], ["git diff --staged", "git diff --staged"],
  ];
  for (const c of gitCmds) {
    h += `<div class="mp-pill" data-cmd="${esc(c[1])}">${esc(c[0])}</div>`;
  }
  h += "</div></div>";

  /* Quick Commands */
  h += '<div class="mp-section"><div class="mp-label">Quick Commands</div><div class="mp-pills">';
  const quickCmds = [
    ["cd ..", "cd .."], ["ls", "ls"], ["ls -la", "ls -la"], ["pwd", "pwd"],
    ["npm install", "npm install"], ["npm start", "npm start"], ["npm test", "npm test"], ["npm run dev", "npm run dev"],
    ["docker ps", "docker ps"], ["python3", "python3"], ["clear", "clear"], ["exit", "exit"],
  ];
  for (const c of quickCmds) {
    h += `<div class="mp-pill" data-cmd="${esc(c[1])}">${esc(c[0])}</div>`;
  }
  h += "</div></div>";

  /* Signals & Terminal Control */
  h += '<div class="mp-section"><div class="mp-label">Signals &amp; Control</div><div class="mp-pills">';
  const signals = [
    ["Ctrl+C (stop)", "\x03"], ["Ctrl+D (exit)", "\x04"], ["Ctrl+Z (suspend)", "\x1a"],
    ["Ctrl+L (clear)", "\x0c"], ["Ctrl+U (clear line)", "\x15"], ["Ctrl+A (home)", "\x01"],
    ["Ctrl+E (end)", "\x05"], ["Ctrl+W (del word)", "\x17"],
  ];
  for (const c of signals) {
    h += `<div class="mp-pill sig" data-sig="${esc(c[1])}">${esc(c[0])}</div>`;
  }
  h += "</div></div>";

  /* Speech to Text */
  const sttActive = _isSTTListening && _isSTTListening();
  h += '<div class="mp-section"><div class="mp-label">Voice Input</div><div class="mp-row">';
  h += `<div class="mp-act${sttActive ? " active" : ""}" data-act="stt">${sttActive ? "\u23F9 Stop Recording" : "\u{1F3A4} Start Recording"}</div>`;
  h += "</div></div>";

  /* Recent Commands */
  const history = _getHistory ? _getHistory() : [];
  if (history.length) {
    h += '<div class="mp-section"><div class="mp-label">Recent Commands</div><div class="mp-hist">';
    const seen = new Set();
    const rc = [];
    for (let i = history.length - 1; i >= 0 && rc.length < 15; i--) {
      if (!seen.has(history[i])) {
        seen.add(history[i]);
        rc.push(history[i]);
      }
    }
    for (const c of rc) {
      h += `<div class="mp-hist-item" data-cmd="${esc(c)}">${esc(c)}</div>`;
    }
    h += "</div></div>";
  }

  /* Actions row */
  h += '<div class="mp-section"><div class="mp-label">Actions</div><div class="mp-row">';
  const actions = [
    ["Copy", "copy"], ["Paste", "paste"], ["Smart Paste", "smartpaste"],
    ["Select All", "selectall"], ["Clear", "clear"], ["Home", "home"], ["New Tab", "newtab"],
  ];
  for (const a of actions) {
    h += `<div class="mp-act" data-act="${a[1]}">${esc(a[0])}</div>`;
  }
  h += "</div></div>";

  mpContent.innerHTML = h;
}

export { openPanel, closePanel };
