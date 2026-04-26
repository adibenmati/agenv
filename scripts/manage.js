#!/usr/bin/env node
"use strict";

const { execSync } = require("child_process");
const action = process.argv[2];
const port = process.argv[3] || process.env.PORT || "7681";

function run(cmd) {
  try { return execSync(cmd, { encoding: "utf8", windowsHide: true, timeout: 5000 }); }
  catch (e) { return e.stdout || e.stderr || ""; }
}

function getPids() {
  const out = run("cmd.exe /c netstat -ano");
  const pids = [];
  for (const line of out.split(/\r?\n/)) {
    if (line.includes(":" + port) && /LISTENING/i.test(line)) {
      const m = line.match(/(\d+)\s*$/);
      if (m && m[1] !== "0") pids.push(m[1]);
    }
  }
  return [...new Set(pids)];
}

function kill(pids) {
  for (const pid of pids) {
    const out = run("cmd.exe /c taskkill /F /T /PID " + pid);
    if (/SUCCESS/i.test(out)) {
      process.stdout.write("[agenv] Killed PID " + pid + "\n");
    } else {
      process.stdout.write("[agenv] Could not kill PID " + pid + "\n");
    }
  }
}

if (action === "stop" || action === "destroy") {
  const pids = getPids();
  if (!pids.length) {
    process.stdout.write("[agenv] Nothing on port " + port + "\n");
  } else {
    kill(pids);
  }
} else if (action === "status") {
  const pids = getPids();
  if (pids.length) {
    process.stdout.write("[agenv] Running on port " + port + " (PID " + pids.join(", ") + ")\n");
  } else {
    process.stdout.write("[agenv] Not running\n");
  }
} else {
  process.stdout.write("Usage: node scripts/manage.js <stop|destroy|status> [port]\n");
}
