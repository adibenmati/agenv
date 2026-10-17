// test/golden-coverage.test.js
"use strict";
const { it } = require("node:test");
const assert = require("node:assert/strict");
const inventory = require("./routes.inventory.json");
const { calls, SKIPPED } = require("../scripts/golden-master.calls");

const AUTH_PAGES = new Set(["GET /login", "POST /login", "GET /"]); // covered by the auth tests (Task 9)
it("every route is compared or has a documented reason to skip", () => {
  const covered = new Set(calls.map((c) => c.route));
  const missing = inventory.map((r) => `${r.method} ${r.path}`)
    .filter((k) => !AUTH_PAGES.has(k) && !covered.has(k) && !SKIPPED[k]);
  assert.deepEqual(missing, [], "routes with no golden-master call or SKIPPED reason");
  for (const [k, why] of Object.entries(SKIPPED)) assert.ok(why && why.length > 8, `SKIPPED ${k} needs a reason`);
  for (const k of covered) assert.ok(inventory.some((r) => `${r.method} ${r.path}` === k), `${k} is not in the inventory`);
});
