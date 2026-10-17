// npm run test:e2e [repoDir] — runs each browser flow in turn; exits non-zero if any prints FAIL or crashes.
// Needs `playwright-core` (a dev dependency) and a Chromium: set AGENV_E2E_CHROME, or `npx playwright-core install chromium`.
"use strict";
const path = require("path");
const { spawnSync } = require("child_process");

const flows = ["hibernate", "groups", "claude-link", "agents"];
const extra = process.argv.slice(2);
let failed = 0;
for (const name of flows) {
  console.log(`\n=== ${name} ===`);
  const r = spawnSync(process.execPath, [path.join(__dirname, name + ".e2e.js"), ...extra], { encoding: "utf8" });
  process.stdout.write(r.stdout || ""); process.stderr.write(r.stderr || "");
  const fails = ((r.stdout || "").match(/^FAIL /gm) || []).length;
  if (r.status !== 0 || fails > 0) { failed++; console.log(`>>> ${name}: ${fails} failed check(s), exit ${r.status}`); }
}
console.log(failed ? `\n${failed} flow(s) failed` : "\nall flows passed");
process.exit(failed ? 1 : 0);
