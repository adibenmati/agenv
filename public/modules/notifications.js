// notifications.js — command completion detection + toast notifications
//
// Monitors background pane output for shell prompt patterns to detect
// when long-running commands finish. Shows in-app toasts and optionally
// browser notifications.

import { $, esc } from "./util.js";

let toastContainer = null;
let notifCount = 0;
let onNotifCountChange = null;
let browserNotifPermission = "default";

// Prompt patterns that indicate a command has finished
// These match common shell prompts: $, >, #, PS1 patterns
const PROMPT_PATTERNS = [
  /[\$#>]\s*$/,               // ends with $, #, or >
  /\w+@[\w.-]+[:\s]/,        // user@host:
  /^\([\w.-]+\)\s/,          // (venv) prefix
  /^PS [A-Z]:\\/i,           // PowerShell prompt
  /^[A-Z]:\\[^>]*>/,         // Windows cmd prompt
];

// Track pane states for command completion detection
// paneId -> { lastOutput: timestamp, commandRunning: bool, lastPromptTime }
const paneStates = new Map();

// Minimum time a command must run to trigger notification (ms)
const MIN_COMMAND_DURATION = 3000;

export function init(els) {
  toastContainer = els.toastContainer || $("toast-container");
  onNotifCountChange = els.onNotifCountChange || null;

  // Request browser notification permission
  if ("Notification" in window) {
    browserNotifPermission = Notification.permission;
    if (browserNotifPermission === "default") {
      // Will request on first notification
    }
  }
}

/**
 * Called when a pane receives output. Detects prompt patterns
 * to infer command completion.
 */
export function onPaneOutput(paneId, data, isActive) {
  if (isActive) return; // Don't notify for the focused pane

  let state = paneStates.get(paneId);
  if (!state) {
    state = { lastOutput: Date.now(), commandStart: null, lastPromptTime: 0 };
    paneStates.set(paneId, state);
  }

  const now = Date.now();
  const text = typeof data === "string" ? data : "";

  // Check if this output contains a prompt pattern
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const lastLine = lines[lines.length - 1] || "";

  const isPrompt = PROMPT_PATTERNS.some(p => p.test(lastLine));

  if (isPrompt) {
    // A prompt appeared — command likely finished
    if (state.commandStart && (now - state.commandStart) >= MIN_COMMAND_DURATION) {
      const duration = Math.round((now - state.commandStart) / 1000);
      showToast(paneId, `Command completed (${formatDuration(duration)})`, "success");
    }
    state.commandStart = null;
    state.lastPromptTime = now;
  } else {
    // Non-prompt output — if we haven't seen recent output, a command may have started
    if (!state.commandStart && (now - state.lastPromptTime) > 500) {
      state.commandStart = now;
    }
  }

  state.lastOutput = now;
}

/**
 * Called when a pane's process exits.
 */
export function onPaneExit(paneId, code, isActive) {
  if (isActive) return;

  const label = code === 0 ? "Process exited" : `Process exited (code ${code})`;
  const type = code === 0 ? "info" : "error";
  showToast(paneId, label, type);

  paneStates.delete(paneId);
}

/**
 * Mark a command as started in a specific pane.
 */
export function markCommandStart(paneId) {
  let state = paneStates.get(paneId);
  if (!state) {
    state = { lastOutput: Date.now(), commandStart: Date.now(), lastPromptTime: 0 };
    paneStates.set(paneId, state);
  } else {
    state.commandStart = Date.now();
  }
}

/**
 * Clean up state for a destroyed pane.
 */
export function removePaneState(paneId) {
  paneStates.delete(paneId);
}

/**
 * Show a toast notification.
 */
let _onToastClick = null;
export function setToastClickHandler(fn) { _onToastClick = fn; }

export function showToast(paneId, message, type) {
  if (!toastContainer) return;

  notifCount++;
  if (onNotifCountChange) onNotifCountChange(notifCount);

  const toast = document.createElement("div");
  toast.className = "toast toast-" + (type || "info");
  toast.innerHTML = `<div class="toast-body"><span class="toast-msg">${esc(message)}</span></div>`;
  toast.dataset.paneId = paneId || "";

  toast.addEventListener("click", () => {
    toast.remove();
    notifCount = Math.max(0, notifCount - 1);
    if (onNotifCountChange) onNotifCountChange(notifCount);
    if (_onToastClick && paneId) _onToastClick(paneId);
  });

  toastContainer.appendChild(toast);

  // Auto-dismiss after 5 seconds
  setTimeout(() => {
    if (toast.parentNode) {
      toast.style.opacity = "0";
      toast.style.transform = "translateX(100%)";
      setTimeout(() => {
        if (toast.parentNode) {
          toast.remove();
          notifCount = Math.max(0, notifCount - 1);
          if (onNotifCountChange) onNotifCountChange(notifCount);
        }
      }, 300);
    }
  }, 5000);

  // Browser notification
  sendBrowserNotif(message);
}

/**
 * Show a toast with a progress bar. Returns a controller { update(pct), done(msg), error(msg) }.
 */
export function showProgressToast(message) {
  if (!toastContainer) return { update() {}, done() {}, error() {} };

  const toast = document.createElement("div");
  toast.className = "toast toast-progress";
  toast.innerHTML = `<div class="toast-body"><span class="toast-msg">${esc(message)}</span></div><div class="toast-progress-wrap"><div class="toast-progress-bar"><div class="toast-progress-fill"></div></div><span class="toast-pct">0%</span></div>`;
  toastContainer.appendChild(toast);

  const fill = toast.querySelector(".toast-progress-fill");
  const pctEl = toast.querySelector(".toast-pct");
  const msgEl = toast.querySelector(".toast-msg");

  function remove(delay) {
    setTimeout(() => {
      if (toast.parentNode) {
        toast.style.opacity = "0";
        toast.style.transform = "translateX(100%)";
        setTimeout(() => { if (toast.parentNode) toast.remove(); }, 300);
      }
    }, delay);
  }

  return {
    update(pct) {
      const p = Math.round(pct * 100);
      fill.style.width = p + "%";
      pctEl.textContent = p + "%";
    },
    done(msg) {
      msgEl.textContent = msg || "Done";
      fill.style.width = "100%";
      pctEl.textContent = "100%";
      toast.className = "toast toast-success";
      remove(1500);
    },
    error(msg) {
      msgEl.textContent = msg || "Failed";
      toast.className = "toast toast-error";
      remove(3000);
    },
  };
}

function sendBrowserNotif(message) {
  if (!("Notification" in window)) return;
  if (document.hasFocus()) return; // Don't notify if tab is focused

  if (Notification.permission === "default") {
    Notification.requestPermission().then(p => {
      browserNotifPermission = p;
      if (p === "granted") new Notification("Agenv", { body: message, silent: true });
    });
  } else if (Notification.permission === "granted") {
    new Notification("Agenv", { body: message, silent: true });
  }
}

export function getNotifCount() { return notifCount; }

export function clearNotifs() {
  if (toastContainer) toastContainer.innerHTML = "";
  notifCount = 0;
  if (onNotifCountChange) onNotifCountChange(0);
}

function formatDuration(seconds) {
  if (seconds < 60) return seconds + "s";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m + "m" + (s ? " " + s + "s" : "");
}
