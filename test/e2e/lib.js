// test/e2e/lib.js — shared bits for the browser flows (run with `npm run test:e2e`; they are not part of `npm test`).
"use strict";
const fs = require("fs"), os = require("os"), path = require("path");

/** The repo to test: argv[2], else this checkout. */
const repoDir = () => path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));

/** Screenshots go to the temp folder, never into the repo. */
const shot = (name) => path.join(os.tmpdir(), "agenv-e2e-" + name);

/**
 * A Chromium to drive. AGENV_E2E_CHROME wins; otherwise the newest Chromium that playwright has downloaded
 * (`npx playwright-core install chromium`); otherwise undefined and playwright decides.
 */
function chromePath() {
  if (process.env.AGENV_E2E_CHROME) return process.env.AGENV_E2E_CHROME;
  const roots = [path.join(os.homedir(), "AppData", "Local", "ms-playwright"), path.join(os.homedir(), ".cache", "ms-playwright"), path.join(os.homedir(), "Library", "Caches", "ms-playwright")];
  const rel = { win32: ["chrome-win64", "chrome.exe"], darwin: ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"], linux: ["chrome-linux", "chrome"] }[process.platform];
  for (const root of roots) {
    let dirs; try { dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => parseInt(b.split("-")[1], 10) - parseInt(a.split("-")[1], 10)); } catch { continue; }
    for (const d of dirs) { const p = path.join(root, d, ...rel); if (fs.existsSync(p)) return p; }
  }
  return undefined;
}

module.exports = { repoDir, shot, chromePath };
