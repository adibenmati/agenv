const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { pathToFileURL } = require("url");

let visualOrder;
before(async () => {
  ({ visualOrder } = await import(pathToFileURL(path.join(__dirname, "../../public/modules/bidi.js")).href));
});

const cells = (s) => s.match(/\P{M}\p{M}*/gu) || [];
const shown = (s) => { const u = cells(s); return visualOrder(u).map((i) => u[i]).join(""); };

describe("terminal bidi: right-to-left text in visual order", () => {
  it("leaves left-to-right text alone", () => {
    assert.equal(shown("echo hello 123 | grep -v x"), "echo hello 123 | grep -v x");
  });

  it("shows a Hebrew word right to left", () => {
    assert.equal(shown("שלום"), "םולש");
  });

  it("keeps the words of a Hebrew phrase in reading order, with English around it untouched", () => {
    assert.equal(shown("echo שלום עולם hello"), "echo םלוע םולש hello");
  });

  it("keeps numbers left to right inside Hebrew text", () => {
    assert.equal(shown("שלום 123"), "123 םולש");
    assert.equal(shown("יש 1,000 שורות"), "תורוש 1,000 שי");
  });

  it("keeps box borders and trailing spaces where they are", () => {
    assert.equal(shown("│ > שלום עולם     │"), "│ > םלוע םולש     │");
  });

  it("moves a letter together with its vowel marks", () => {
    assert.equal(shown("שָלוֹם"), "םוֹלשָ");
  });

  it("draws the cursor at the left edge of Hebrew being typed, where the next letter goes", () => {
    const u = cells("echo שלום  ");
    const v = visualOrder(u, { cursor: 9 }).map((i) => (i === 9 ? "|" : u[i])).join("");
    assert.equal(v, "echo |םולש ");
  });

  it("leaves the cursor alone after English, or when it sits on a letter", () => {
    const a = cells("echo hello  ");
    assert.deepEqual(visualOrder(a, { cursor: 10 }), a.map((_, i) => i));
    const b = cells("שלום");
    assert.deepEqual(visualOrder(b, { cursor: 2 }), [3, 2, 1, 0]);
  });

  it("returns every cell exactly once", () => {
    const u = cells("a שלום 12 b עולם, c");
    assert.deepEqual([...visualOrder(u)].sort((a, b) => a - b), u.map((_, i) => i));
  });
});
