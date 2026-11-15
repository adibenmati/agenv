// compose.js — a writing box docked at the bottom of a terminal pane.
//
// Terminals have no real right-to-left support, so writing Hebrew (especially mixed with English) inside a prompt is
// clumsy: the cursor, selection and editing in the middle of a line all misbehave. This box is a normal browser text
// field, with the browser's own bidi: Hebrew, English and both together behave like any chat app. Enter sends the
// text to the session as a paste followed by Enter; Shift+Enter is a new line; Esc closes and keeps the draft.

import { getTerminal, pasteText, sendInput, focusTerminal } from "./terminal.js";

const drafts = new Map();   // paneId -> unsent text
const ENTER_DELAY_MS = 120; // let the program take the pasted text before Enter (Claude Code treats fast input as paste)

function paneLeaf(entry) {
  const m = entry && entry.term && entry.term.element;
  return (m && m.closest(".pane-leaf")) || (entry && entry.mountEl && entry.mountEl.closest(".pane-leaf")) || null;
}

export function isComposeOpen(paneId) {
  const entry = getTerminal(paneId);
  const leaf = paneLeaf(entry);
  return !!(leaf && leaf.querySelector(".compose-box"));
}

/** Open the box on a pane (or focus it if it is already open). */
export function openCompose(paneId) {
  const entry = getTerminal(paneId);
  const leaf = paneLeaf(entry);
  if (!entry || !leaf) return;
  const open = leaf.querySelector(".compose-box");
  if (open) { open.querySelector("textarea").focus(); return; }

  const box = document.createElement("div");
  box.className = "compose-box";
  box.innerHTML = `<textarea class="compose-input" dir="auto" rows="1" spellcheck="true"
      placeholder="כתבו כאן · Write here. Enter sends, Shift+Enter new line, Esc closes"></textarea>
    <div class="compose-actions">
      <button class="compose-btn compose-send" title="Send (Enter)">Send</button>
      <button class="compose-btn compose-close" title="Close (Esc), keeps the draft">&times;</button>
    </div>`;
  leaf.appendChild(box);
  const input = box.querySelector("textarea");
  input.value = drafts.get(paneId) || "";

  const grow = () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 220) + "px";
  };
  const close = (keepDraft) => {
    if (keepDraft && input.value) drafts.set(paneId, input.value); else drafts.delete(paneId);
    box.remove();
    focusTerminal(paneId);
  };
  const send = async () => {
    const text = input.value.replace(/\r\n/g, "\n").replace(/\s+$/, "");
    if (!text) return;
    await pasteText(paneId, text);
    setTimeout(() => sendInput(paneId, "\r"), ENTER_DELAY_MS);
    input.value = "";
    close(false);
  };

  input.addEventListener("input", grow);
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();   // the app's shortcuts must not act on keys typed here
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    else if (e.key === "Escape") { e.preventDefault(); close(true); }
  });
  input.addEventListener("blur", () => { if (box.isConnected && input.value) drafts.set(paneId, input.value); });
  box.querySelector(".compose-send").addEventListener("click", send);
  box.querySelector(".compose-close").addEventListener("click", () => close(true));
  box.addEventListener("mousedown", (e) => e.stopPropagation());

  grow();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

export function toggleCompose(paneId) {
  const entry = getTerminal(paneId);
  const leaf = paneLeaf(entry);
  const open = leaf && leaf.querySelector(".compose-box");
  if (open) open.querySelector(".compose-close").click();
  else openCompose(paneId);
}
