// contextmenu.js — right-click context menu system

let menuEl = null;
let _cleanup = null;

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

/**
 * Show context menu at (x, y) with a list of items.
 * Each item: { label, action, shortcut?, handler, disabled?, separator? }
 * separator items: { separator: true }
 */
export function show(x, y, items) {
  if (!menuEl) return;

  let html = "";
  for (const item of items) {
    if (item.separator) {
      html += '<div class="ctx-sep"></div>';
      continue;
    }
    const dis = item.disabled ? " disabled" : "";
    const sc = item.shortcut ? `<span class="ctx-sc">${item.shortcut}</span>` : "";
    html += `<div class="ctx-item${dis}" data-action="${item.action || ""}">${item.label}${sc}</div>`;
  }
  menuEl.innerHTML = html;

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
  });

  // Wire click handlers
  menuEl.onclick = (e) => {
    const el = e.target.closest(".ctx-item:not(.disabled)");
    if (!el) return;
    const action = el.dataset.action;
    const match = items.find((i) => i.action === action);
    if (match && match.handler) match.handler();
    hide();
  };
}

export function hide() {
  if (menuEl) menuEl.classList.add("hidden");
}
