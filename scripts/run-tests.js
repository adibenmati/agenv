// scripts/run-tests.js — runs every test/**/*.test.js (except test/e2e and test/fixtures) with node --test.
// Portable on purpose: no shell globbing, no fs.readdirSync({recursive}) (Node >=18.17 only).
"use strict";
const fs = require("fs"), path = require("path");
const { spawnSync } = require("child_process");
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== "e2e" && e.name !== "fixtures") walk(p); }
    else if (e.name.endsWith(".test.js")) files.push(p);
  }
})(path.join(__dirname, "..", "test"));
// One file at a time: several suites (cli electron-launch probes, ws timing) assert wall-clock windows that
// fail intermittently when files run in parallel and starve each other of CPU.
const r = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files.sort()], { stdio: "inherit" });
process.exit(r.status == null ? 1 : r.status);
