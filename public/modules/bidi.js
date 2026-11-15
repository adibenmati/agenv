// bidi.js — right-to-left text (Hebrew, Arabic) in the terminal.
//
// xterm.js draws every character in its own fixed-width cell, left to right, and has no bidi support, so "שלום"
// came out mirrored ("םולש"). After xterm draws a row that contains right-to-left characters, the row's cells are
// put in visual order with a small version of the Unicode bidi algorithm (base direction left-to-right, like a
// terminal). Every cell keeps its width, so columns, box borders and the cursor stay where they were. Copying a
// selection still copies the text in its real (logical) order.

const RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const LETTER = /\p{L}/u;
const DIGIT = /[0-9\u0660-\u0669\u06F0-\u06F9]/;
const NUM_SEP = /^[.,:\/]$/;

function strongType(unit) {
  const c = unit.charAt(0);
  if (RTL.test(c)) return "R";
  if (DIGIT.test(c)) return "D";
  if (LETTER.test(c)) return "L";
  return "N";
}

/**
 * Visual order of a row's cells. `units` is one string per cell (a character with its combining marks); the result
 * lists the indices of `units` from left to right on screen.
 */
export function visualOrder(units) {
  const n = units.length;
  const t = units.map(strongType);
  // Digits after right-to-left text are an Arabic-style number (they stay with that text), otherwise left-to-right.
  let prevStrong = "L";
  for (let i = 0; i < n; i++) {
    if (t[i] === "R" || t[i] === "L") prevStrong = t[i];
    else if (t[i] === "D") t[i] = prevStrong === "R" ? "AN" : "L";
  }
  // A single separator between two such digits belongs to the number (1,000 or 12:30).
  for (let i = 1; i < n - 1; i++) {
    if (t[i] === "N" && t[i - 1] === "AN" && t[i + 1] === "AN" && NUM_SEP.test(units[i])) t[i] = "AN";
  }
  // Neutrals (spaces, punctuation) take the direction of the text on both sides when it agrees, else left-to-right.
  const rtlish = (x) => x === "R" || x === "AN";
  for (let i = 0; i < n; ) {
    if (t[i] !== "N") { i++; continue; }
    let j = i;
    while (j < n && t[j] === "N") j++;
    const before = i > 0 ? rtlish(t[i - 1]) : false;
    const after = j < n ? rtlish(t[j]) : false;
    const dir = before && after ? "R" : "L";
    for (let k = i; k < j; k++) t[k] = dir;
    i = j;
  }
  const levels = t.map((x) => (x === "AN" ? 2 : x === "R" ? 1 : 0));
  const order = units.map((_, i) => i);
  for (let level = 2; level >= 1; level--) {
    for (let i = 0; i < n; ) {
      if (levels[order[i]] < level) { i++; continue; }
      let j = i;
      while (j < n && levels[order[j]] >= level) j++;
      const part = order.slice(i, j).reverse();
      for (let k = i; k < j; k++) order[k] = part[k - i];
      i = j;
    }
  }
  return order;
}

/** Put one rendered xterm row (a div of spans) in visual order. Rows without right-to-left text are left alone. */
export function fixRow(row) {
  if (!row || !RTL.test(row.textContent || "")) return;
  const cells = [];
  for (const node of [...row.childNodes]) {
    const text = node.textContent || "";
    const parts = text.match(/\P{M}\p{M}*/gu) || [];
    if (node.nodeType !== 1 || node.children.length || parts.length <= 1) {
      if (node.nodeType === 3) {
        for (const p of parts) { const s = document.createElement("span"); s.textContent = p; cells.push({ el: s, text: p }); }
      } else {
        cells.push({ el: node, text: text || " " });
      }
      continue;
    }
    for (const p of parts) {
      const s = node.cloneNode(false);
      s.textContent = p;
      cells.push({ el: s, text: p });
    }
  }
  const order = visualOrder(cells.map((c) => c.text));
  row.replaceChildren(...order.map((i) => cells[i].el));
}

/** Keep a terminal's rows in visual order after every render. Returns the disposable. */
export function attachBidi(term) {
  return term.onRender(({ start, end }) => {
    const rows = term.element && term.element.querySelector(".xterm-rows");
    if (!rows) return;
    for (let i = start; i <= end; i++) {
      try { fixRow(rows.children[i]); } catch {}
    }
  });
}
