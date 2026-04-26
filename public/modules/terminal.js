// terminal.js — xterm.js instance management per pane

import { api, getToken } from "./util.js";
import { showToast, showProgressToast } from "./notifications.js";

// Map: paneId -> { term, fitAddon, ws, sessionId, mountEl, detachedEl }
const paneTerminals = new Map();

// Command history for autocomplete
let _commandHistory = [];
let _historyLoaded = false;

async function loadHistory() {
  if (_historyLoaded) return;
  _historyLoaded = true;
  try {
    const resp = await fetch(api("/api/history"));
    if (resp.ok) _commandHistory = await resp.json();
  } catch {}
}

function addToHistory(cmd) {
  if (!cmd || cmd.length < 2) return;
  // Avoid duplicates at the end
  if (_commandHistory.length > 0 && _commandHistory[_commandHistory.length - 1] === cmd) return;
  _commandHistory.push(cmd);
  // Persist to server
  fetch(api("/api/history"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: cmd }),
  }).catch(() => {});
}

function findSuggestion(prefix) {
  if (!prefix || prefix.length < 2) return "";
  const lower = prefix.toLowerCase();
  // Search from most recent backwards for a matching prefix
  for (let i = _commandHistory.length - 1; i >= 0; i--) {
    const h = _commandHistory[i];
    if (h.toLowerCase().startsWith(lower) && h.length > prefix.length) {
      return h.slice(prefix.length); // return only the suffix
    }
  }
  return "";
}

// Callbacks set by app.js
let _onPaneData = null;       // (paneId, data) => {}
let _onPaneCwd = null;        // (paneId, cwd) => {}
let _onPaneExit = null;       // (paneId, code) => {}
let _onPaneConnect = null;    // (paneId) => {}
let _onPaneDisconnect = null; // (paneId) => {}
let _onPaneOutput = null;     // (paneId, data) => {}
let _onEvent = null;          // (eventName) => {}
let _onStatus = null;         // (sessionId, status) => {}
let _onCommand = null;        // (paneId, command) => {}

export function setCallbacks(cbs) {
  _onPaneData = cbs.onData || null;
  _onPaneCwd = cbs.onCwd || null;
  _onPaneExit = cbs.onExit || null;
  _onPaneConnect = cbs.onConnect || null;
  _onPaneDisconnect = cbs.onDisconnect || null;
  _onPaneOutput = cbs.onOutput || null;
  _onEvent = cbs.onEvent || null;
  _onStatus = cbs.onStatus || null;
  _onCommand = cbs.onCommand || null;
}

const TERM_OPTIONS = {
  cursorBlink: true,
  fontSize: 14,
  fontFamily: "'Cascadia Code','Fira Code','Consolas','Monaco',monospace",
  theme: {
    background: "#0d1117",
    foreground: "#e6edf3",
    cursor: "#58a6ff",
    selectionBackground: "rgba(88,166,255,.3)",
  },
  scrollback: 10000,
  convertEol: false,
  allowProposedApi: true,
};

// ---------------------------------------------------------------------------
// Clipboard helpers
// ---------------------------------------------------------------------------
const PASTE_CHUNK_SIZE = 2048;
const PASTE_PROGRESS_THRESHOLD = 4096;

function clipboardCopy(text, termEl) {
  const done = () => showCopyBadge(termEl);
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => { fallbackCopy(text); done(); });
  } else {
    fallbackCopy(text);
    done();
  }
}

function fallbackCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;left:-9999px;top:-9999px";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); } catch {}
  ta.remove();
}

function showCopyBadge(termEl) {
  if (!termEl) return;
  const badge = document.createElement("div");
  badge.className = "term-copy-badge";
  badge.textContent = "Copied!";
  termEl.appendChild(badge);
  badge.addEventListener("animationend", () => badge.remove());
}

async function doPaste(entry) {
  let text;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    showToast(null, "Clipboard access denied — use Ctrl+Shift+V in some browsers", "error");
    return;
  }
  if (!text || !entry.ws || entry.ws.readyState !== 1) return;
  await sendPaste(entry, text);
}

async function sendPaste(entry, text) {
  if (!entry.ws || entry.ws.readyState !== 1) return;

  const isLarge = text.length > PASTE_PROGRESS_THRESHOLD;
  const isMultiline = /[\r\n]/.test(text);

  let progress = null;
  if (isLarge) {
    progress = showProgressToast("Pasting " + formatPasteSize(text.length) + "...");
  }

  try {
    if (isMultiline) {
      entry.ws.send(JSON.stringify({ type: "input", data: "\x1b[200~" }));
    }

    let sent = 0;
    while (sent < text.length) {
      const chunk = text.slice(sent, sent + PASTE_CHUNK_SIZE);
      entry.ws.send(JSON.stringify({ type: "input", data: chunk }));
      sent += chunk.length;
      if (progress) progress.update(sent / text.length);
      if (isLarge && sent < text.length) {
        await new Promise(r => setTimeout(r, 5));
      }
    }

    if (isMultiline) {
      entry.ws.send(JSON.stringify({ type: "input", data: "\x1b[201~" }));
    }

    if (progress) progress.done("Pasted " + formatPasteSize(text.length));
  } catch {
    if (progress) progress.error("Paste failed");
  }
}

function formatPasteSize(len) {
  if (len < 1024) return len + " chars";
  if (len < 1024 * 1024) return (len / 1024).toFixed(1) + " KB";
  return (len / (1024 * 1024)).toFixed(1) + " MB";
}

// ---------------------------------------------------------------------------
// Smart Paste — save clipboard content to a file, insert path into terminal
// ---------------------------------------------------------------------------
async function doSmartPaste(entry) {
  const progress = showProgressToast("Smart Paste — saving to file...");
  try {
    // Try reading all clipboard items (images, files, text)
    let handled = false;

    if (navigator.clipboard.read) {
      try {
        const clipItems = await navigator.clipboard.read();
        for (const item of clipItems) {
          // Prefer image types
          const imageType = item.types.find(t => t.startsWith("image/"));
          if (imageType) {
            const blob = await item.getType(imageType);
            const base64 = await blobToBase64(blob);
            const resp = await fetch(api("/api/clip"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sessionId: entry.sessionId, contentBase64: base64, mimeType: imageType }),
            });
            if (resp.ok) {
              const data = await resp.json();
              insertClipPath(entry, data.path, data.size);
              progress.done("Saved " + formatPasteSize(data.size) + " image");
            } else {
              const err = await resp.json().catch(() => ({}));
              progress.error(err.error || "Upload failed");
            }
            handled = true;
            break;
          }
        }
      } catch {
        // clipboard.read() not supported or permission denied — fall through to text
      }
    }

    // Fallback: text content
    if (!handled) {
      const text = await navigator.clipboard.readText();
      if (!text) { progress.error("Clipboard is empty"); return; }
      const resp = await fetch(api("/api/clip"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: entry.sessionId, content: text }),
      });
      if (resp.ok) {
        const data = await resp.json();
        insertClipPath(entry, data.path, data.size);
        progress.done("Saved " + formatPasteSize(data.size) + " to file");
      } else {
        const err = await resp.json().catch(() => ({}));
        progress.error(err.error || "Save failed");
      }
    }
  } catch (e) {
    progress.error("Smart Paste failed");
  }
}

function insertClipPath(entry, filePath, size) {
  if (!entry.ws || entry.ws.readyState !== 1) return;
  const p = filePath.includes(" ") ? `"${filePath}"` : filePath;
  entry.ws.send(JSON.stringify({ type: "input", data: p + " " }));
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      const idx = result.indexOf(",");
      resolve(idx >= 0 ? result.substring(idx + 1) : result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export async function smartPaste(paneId) {
  const entry = paneTerminals.get(paneId);
  if (entry) await doSmartPaste(entry);
}

export function createTerminal(paneId, sessionId, mountEl) {
  // Load history on first terminal creation
  loadHistory();

  const term = new Terminal(TERM_OPTIONS);
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon());
  term.open(mountEl);

  // Clipboard keyboard shortcuts
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    const ctrl = e.ctrlKey || e.metaKey;

    // Ctrl+C — copy if selection exists, else SIGINT (pass through)
    if (ctrl && !e.shiftKey && e.key === "c") {
      if (term.hasSelection()) {
        e.preventDefault();
        e.stopPropagation();
        clipboardCopy(term.getSelection(), term.element);
        term.clearSelection();
        return false;
      }
      return true;
    }

    // Ctrl+Shift+C — copy if selection, else let propagate (app.js handles Claude)
    if (ctrl && e.shiftKey && (e.key === "C" || e.key === "c")) {
      if (term.hasSelection()) {
        e.preventDefault();
        e.stopPropagation();
        clipboardCopy(term.getSelection(), term.element);
        term.clearSelection();
        return false;
      }
      return true;
    }

    // Ctrl+Shift+V — text-only paste via clipboard API (fallback)
    if (ctrl && e.shiftKey && (e.key === "V" || e.key === "v")) {
      e.preventDefault();
      e.stopPropagation();
      doPaste(entry);
      return false;
    }

    // Ctrl+Shift+B — Smart Paste (save to file, insert path)
    if (ctrl && e.shiftKey && (e.key === "B" || e.key === "b")) {
      e.preventDefault();
      e.stopPropagation();
      doSmartPaste(entry);
      return false;
    }

    // Ctrl+V — let browser fire paste event (handled by paste capture below)
    // Return true so xterm doesn't block it; our paste handler intercepts before xterm
    return true;
  });

  // Paste capture handler — intercepts paste events BEFORE xterm processes them.
  // For text-only clipboard: chunked paste with progress.
  // For images/files: let event propagate to document handler for upload.
  mountEl.addEventListener("paste", (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    let hasImage = false;
    let hasFile = false;
    let textData = null;

    for (const item of items) {
      if (item.type.startsWith("image/")) hasImage = true;
      if (item.kind === "file") hasFile = true;
      if (item.kind === "string" && item.type === "text/plain") {
        textData = e.clipboardData.getData("text/plain");
      }
    }

    // Images/files — let propagate to document handler for upload
    if (hasImage || hasFile) return;

    // Text only — handle with chunking, prevent xterm from also pasting
    if (textData) {
      e.preventDefault();
      e.stopPropagation();
      sendPaste(entry, textData);
    }
  }, { capture: true });

  // Create ghost suggestion overlay
  const ghostEl = document.createElement("span");
  ghostEl.className = "term-ghost";
  mountEl.style.position = "relative";
  mountEl.appendChild(ghostEl);

  const entry = {
    paneId, sessionId, term, fitAddon: fit, ws: null,
    mountEl, dead: false, detached: false, reconnectDelay: 500, inputBuffer: "",
    ghostEl, currentGhost: "", suppressResize: false,
  };
  paneTerminals.set(paneId, entry);

  // Connect WebSocket
  connectWs(entry);

  // Fit after DOM settles
  requestAnimationFrame(() => {
    try { fit.fit(); } catch {}
  });

  // Input handler
  term.onData((data) => {
    if (_onPaneData && _onPaneData(paneId, data)) return; // intercepted

    // Always scroll to bottom on user input (fixes Up arrow scrolling viewport instead of shell history)
    term.scrollToBottom();

    // Tab — accept ghost suggestion if one exists, otherwise pass through to shell
    if (data === "\t" && entry.currentGhost) {
      const ghost = entry.currentGhost;
      entry.inputBuffer += ghost;
      entry.currentGhost = "";
      ghostEl.textContent = "";
      ghostEl.style.display = "none";
      if (entry.ws && entry.ws.readyState === 1) {
        entry.ws.send(JSON.stringify({ type: "input", data: ghost }));
      }
      return;
    }
    // If Tab with no ghost, clear buffer (shell tab-complete makes buffer unreliable)
    if (data === "\t") {
      entry.inputBuffer = "";
    }

    // Hide ghost before any input
    if (entry.currentGhost) {
      entry.currentGhost = "";
      ghostEl.textContent = "";
      ghostEl.style.display = "none";
    }

    // Buffer input for command interception
    bufferInput(entry, data);

    if (entry.ws && entry.ws.readyState === 1) {
      entry.ws.send(JSON.stringify({ type: "input", data }));
    }

    // Show ghost suggestion after a tick (wait for terminal to echo the character)
    requestAnimationFrame(() => showGhost(entry));
  });

  // Resize handler — skip while detached to prevent sending 0x0 to server
  term.onResize(({ cols, rows }) => {
    if (entry.detached) return;
    if (entry.suppressResize) return; // Don't echo server-initiated resizes back
    if (cols < 2 || rows < 2) return; // Guard against invalid dimensions
    if (entry.ws && entry.ws.readyState === 1) {
      entry.ws.send(JSON.stringify({ type: "resize", cols, rows }));
    }
  });

  return entry;
}

function showGhost(entry) {
  const { term, ghostEl, inputBuffer } = entry;
  const suggestion = findSuggestion(inputBuffer);
  if (!suggestion) {
    entry.currentGhost = "";
    ghostEl.style.display = "none";
    return;
  }

  entry.currentGhost = suggestion;

  // Position ghost at cursor location
  const cursorX = term.buffer.active.cursorX;
  const cursorY = term.buffer.active.cursorY;

  // Get cell dimensions from the xterm element
  const xtermEl = entry.mountEl.querySelector(".xterm-screen");
  if (!xtermEl) { ghostEl.style.display = "none"; return; }
  const rect = xtermEl.getBoundingClientRect();
  const cellWidth = rect.width / term.cols;
  const cellHeight = rect.height / term.rows;

  ghostEl.textContent = suggestion;
  ghostEl.style.display = "block";
  ghostEl.style.left = (cursorX * cellWidth) + "px";
  ghostEl.style.top = (cursorY * cellHeight) + "px";
  ghostEl.style.fontSize = term.options.fontSize + "px";
  ghostEl.style.lineHeight = cellHeight + "px";
}

/**
 * Buffer user keystrokes and fire _onCommand when Enter is pressed.
 * Handles backspace, Ctrl+C (cancel), and escape sequences (clear buffer
 * since arrow keys / history navigation make the buffer unreliable).
 */
function bufferInput(entry, data) {
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    const code = ch.charCodeAt(0);

    if (ch === "\r") {
      // Enter — fire command callback with accumulated buffer
      const cmd = entry.inputBuffer.trim();
      if (cmd) {
        addToHistory(cmd);
        if (_onCommand) _onCommand(entry.paneId, cmd);
      }
      entry.inputBuffer = "";
    } else if (ch === "\x7f" || ch === "\x08") {
      // Backspace
      entry.inputBuffer = entry.inputBuffer.slice(0, -1);
    } else if (ch === "\x03") {
      // Ctrl+C — command cancelled
      entry.inputBuffer = "";
    } else if (ch === "\x1b") {
      // Escape sequence (arrows, tab-complete, history) — buffer is unreliable
      entry.inputBuffer = "";
      return;
    } else if (code >= 32) {
      // Printable character
      entry.inputBuffer += ch;
    }
  }
}

function connectWs(entry) {
  const { paneId, sessionId } = entry;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}/ws?session=${sessionId}&token=${encodeURIComponent(getToken())}`;

  const ws = new WebSocket(url);
  entry.ws = ws;

  ws.onopen = () => {
    entry.reconnectDelay = 500;
    if (_onPaneConnect) _onPaneConnect(paneId);
    // After initial resize+scrollback from server (sent immediately on connect),
    // fit the terminal to its actual DOM container and send correct size to server.
    // Small delay ensures the server's initial messages have been processed.
    setTimeout(() => {
      if (!entry.detached && !entry.dead) {
        try { entry.fitAddon.fit(); } catch {}
      }
    }, 150);
  };

  ws.onmessage = (ev) => {
    try {
      const m = JSON.parse(ev.data);
      if (m.type === "output" && m.data) {
        entry.term.write(m.data);
        if (_onPaneOutput) _onPaneOutput(paneId, m.data);
      } else if (m.type === "resize" && m.cols && m.rows) {
        // Server tells us the current PTY size — resize terminal to match
        // This arrives before scrollback, ensuring scrollback renders at correct dimensions
        const cols = Math.max(2, Math.min(m.cols, 500));
        const rows = Math.max(2, Math.min(m.rows, 200));
        if (entry.term.cols !== cols || entry.term.rows !== rows) {
          entry.suppressResize = true;
          entry.term.resize(cols, rows);
          entry.suppressResize = false;
        }
      } else if (m.type === "exit") {
        entry.term.write("\r\n[exited " + m.code + "]\r\n");
        entry.dead = true;
        if (_onPaneExit) _onPaneExit(paneId, m.code);
      } else if (m.type === "cwd" && m.cwd) {
        if (_onPaneCwd) _onPaneCwd(paneId, m.cwd);
      } else if (m.type === "status" && m.status) {
        if (_onStatus) _onStatus(m.sessionId, m.status);
      } else if (m.type === "event" && m.event) {
        if (_onEvent) _onEvent(m.event);
      }
    } catch {}
  };

  ws.onclose = (ev) => {
    if (entry.dead) return;
    if (ev.code === 4401) {
      if (_onPaneDisconnect) _onPaneDisconnect(paneId);
      return;
    }
    if (_onPaneDisconnect) _onPaneDisconnect(paneId);
    // Auto-reconnect
    setTimeout(() => {
      if (!entry.dead && paneTerminals.has(paneId)) connectWs(entry);
    }, entry.reconnectDelay);
    entry.reconnectDelay = Math.min(entry.reconnectDelay * 1.5, 5000);
  };

  ws.onerror = () => {};
}

export function destroyTerminal(paneId) {
  const entry = paneTerminals.get(paneId);
  if (!entry) return;
  entry.dead = true;
  if (entry.ws) { try { entry.ws.close(); } catch {} }
  try { entry.term.dispose(); } catch {}
  paneTerminals.delete(paneId);
}

export function focusTerminal(paneId) {
  const entry = paneTerminals.get(paneId);
  if (!entry) return;
  // Save scroll position — term.focus() scrolls viewport to the cursor
  const viewport = entry.term.element?.querySelector(".xterm-viewport");
  const scrollTop = viewport ? viewport.scrollTop : null;
  entry.term.focus();
  // Restore scroll position after focus
  if (scrollTop != null && viewport) {
    requestAnimationFrame(() => { viewport.scrollTop = scrollTop; });
  }
}

export function fitTerminal(paneId) {
  const entry = paneTerminals.get(paneId);
  if (entry && !entry.detached) {
    try { entry.fitAddon.fit(); } catch {}
  }
}

export function fitAllTerminals() {
  for (const entry of paneTerminals.values()) {
    if (entry.detached) continue; // Skip hidden terminals — prevents 0x0 resize
    try { entry.fitAddon.fit(); } catch {}
  }
}

export function getTerminal(paneId) {
  return paneTerminals.get(paneId) || null;
}

export function getAllPaneIds() {
  return [...paneTerminals.keys()];
}

export function sendInput(paneId, data) {
  const entry = paneTerminals.get(paneId);
  if (entry && entry.ws && entry.ws.readyState === 1) {
    entry.ws.send(JSON.stringify({ type: "input", data }));
  }
}

export async function pasteText(paneId, text) {
  const entry = paneTerminals.get(paneId);
  if (entry) await sendPaste(entry, text);
}

/**
 * Detach a terminal from its mount (for tab switching).
 * The terminal DOM element is preserved but moved to a hidden holder.
 * Saves viewport scroll position so it can be restored on reattach.
 */
export function detachTerminal(paneId, holderEl) {
  const entry = paneTerminals.get(paneId);
  if (!entry) return;
  entry.detached = true;
  // Save scroll position before detaching
  const viewport = entry.mountEl.querySelector(".xterm-viewport");
  entry.savedScrollTop = viewport ? viewport.scrollTop : null;
  // Hide ghost overlay
  if (entry.ghostEl) {
    entry.ghostEl.style.display = "none";
    entry.currentGhost = "";
  }
  // Store the xterm container element
  const xtermEl = entry.mountEl.querySelector(".xterm");
  if (xtermEl) {
    entry.detachedEl = xtermEl;
    holderEl.appendChild(xtermEl);
  }
}

/**
 * Re-attach a terminal to a new mount element.
 * Restores the viewport scroll position saved during detach.
 * Forces a full repaint to fix any rendering artifacts from the hidden holder.
 */
export function reattachTerminal(paneId, mountEl) {
  const entry = paneTerminals.get(paneId);
  if (!entry) return;
  entry.mountEl = mountEl;
  entry.detached = false;
  if (entry.detachedEl) {
    mountEl.appendChild(entry.detachedEl);
    entry.detachedEl = null;
  }
  // Re-parent ghost overlay (old mountEl was destroyed during workspace switch)
  if (entry.ghostEl) {
    mountEl.style.position = "relative";
    mountEl.appendChild(entry.ghostEl);
    entry.ghostEl.style.display = "none";
    entry.currentGhost = "";
  }
  const savedScroll = entry.savedScrollTop;
  requestAnimationFrame(() => {
    try {
      entry.fitAddon.fit();
      entry.term.refresh(0, entry.term.rows - 1);
      // Force glyph cache rebuild to fix color/rendering artifacts
      if (typeof entry.term.clearTextureAtlas === "function") {
        entry.term.clearTextureAtlas();
      }
    } catch {}
    // Restore scroll position after fit/refresh (which can reset it)
    if (savedScroll != null) {
      requestAnimationFrame(() => {
        const viewport = mountEl.querySelector(".xterm-viewport");
        if (viewport) viewport.scrollTop = savedScroll;
      });
    }
  });
}

export function isConnected(paneId) {
  const entry = paneTerminals.get(paneId);
  return entry && entry.ws && entry.ws.readyState === 1;
}

export function getCommandHistory() {
  return _commandHistory;
}
