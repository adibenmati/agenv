// contextmenu.js — right-click context menu system

import { esc } from "./util.js";

let menuEl = null;
let _cleanup = null;
let _subTimer = null;

export function init() {
  menuEl = document.createElement("div");
  menuEl.className = "ctx-menu hidden";
  document.body.appendChild(menuEl);

  // Close on click outside, scroll, or escape
  document.addEventListener("click", hide);
  window.addEventListener("blur", hide);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hide();
  });
}

function renderItems(items, prefix) {
  let html = "";
  items.forEach((item, i) => {
    if (item.separator) { html += '<div class="ctx-sep"></div>'; return; }
    const id = prefix + i;
    const dis = item.disabled ? " disabled" : "";
    const label = item.text != null ? esc(item.text) : item.label;
    if (item.submenu && item.submenu.length) {
      html += `<div class="ctx-item has-sub${dis}" data-idx="${id}">${label}<span class="ctx-arrow">&#9654;</span>`;
      html += `<div class="ctx-submenu">${renderItems(item.submenu, id + ".")}</div></div>`;
      return;
    }
    const sc = item.shortcut ? `<span class="ctx-sc">${item.shortcut}</span>` : "";
    html += `<div class="ctx-item${dis}" data-idx="${id}">${label}${sc}</div>`;
  });
  return html;
}

function itemAt(items, idx) {
  let list = items, item = null;
  for (const part of idx.split(".")) {
    item = list && list[Number(part)];
    list = item && item.submenu;
  }
  return item;
}

/**
 * Show context menu at (x, y) with a list of items.
 * Each item: { label | text, action?, shortcut?, handler, disabled?, separator?, submenu? }
 * `label` is HTML; `text` is escaped (use it for user-provided names).
 * `submenu` is a nested item list, opened on hover.
 * separator items: { separator: true }
 */
export function show(x, y, items) {
  if (!menuEl) return;

  menuEl.innerHTML = renderItems(items, "");

  // Show and position
  menuEl.classList.remove("hidden");
  menuEl.style.left = x + "px";
  menuEl.style.top = y + "px";

  // Clamp to viewport
  requestAnimationFrame(() => {
    const r = menuEl.getBoundingClientRect();
    if (r.right > window.innerWidth - 4) {
      menuEl.style.left = Math.max(4, x - r.width) + "px";
    }
    if (r.bottom > window.innerHeight - 4) {
      menuEl.style.top = Math.max(4, y - r.height) + "px";
    }
    // Open submenus to the left when there's no room on the right
    const flip = menuEl.getBoundingClientRect().right + 200 > window.innerWidth;
    menuEl.querySelectorAll(".ctx-submenu").forEach((el) => el.classList.toggle("flip", flip));
  });

  // Submenus open on hover but close only after a short delay, so moving the
  // pointer diagonally toward a submenu entry (across a sibling item) doesn't
  // snap it shut before the pointer arrives.
  menuEl.onmouseover = (e) => {
    const item = e.target.closest(".ctx-item");
    if (!item) return;
    const openSibs = [...item.parentElement.children].filter((c) => c !== item && c.classList.contains("open"));
    clearTimeout(_subTimer);
    if (item.classList.contains("has-sub") && !item.classList.contains("disabled")) {
      openSibs.forEach((c) => c.classList.remove("open"));
      item.classList.add("open");
    } else if (openSibs.length) {
      _subTimer = setTimeout(() => openSibs.forEach((c) => c.classList.remove("open")), 300);
    }
  };

  // Wire click handlers
  menuEl.onclick = (e) => {
    const el = e.target.closest(".ctx-item:not(.disabled)");
    if (!el) return;
    const match = itemAt(items, el.dataset.idx);
    // Clicking a submenu parent opens it (touch) and keeps the menu open
    if (!match || (match.submenu && match.submenu.length)) { el.classList.add("open"); e.stopPropagation(); return; }
    if (match.handler) match.handler();
    hide();
  };
}

export function hide() {
  if (menuEl) menuEl.classList.add("hidden");
}
