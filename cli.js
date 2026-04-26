#!/usr/bin/env node
"use strict";

const { spawn, execSync } = require("child_process");
const path = require("path");

const args = process.argv.slice(2);
const command = args[0];

// Subcommands that always go through server.js
const subcommands = new Set(["help", "--help", "-h", "version", "--version", "-v", "set", "get", "update", "stop", "kill", "run"]);

// --web flag means web server mode
const isWeb = args.includes("--web");

// If it's a subcommand or --web, delegate directly to server.js
if (subcommands.has(command) || isWeb) {
  // Strip --web from args before passing to server.js
  const serverArgs = args.filter(a => a !== "--web");
  const child = spawn(process.execPath, [path.join(__dirname, "server.js"), ...serverArgs], {
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code) => process.exit(code || 0));
  child.on("error", (err) => { console.error("[agenv] " + err.message); process.exit(1); });
  return;
}

// Default mode: launch Electron (desktop app, no open port)
function tryElectron() {
  // Check if electron is available
  let electronPath;
  try {
    // Try to find electron in node_modules (devDependency)
    electronPath = require.resolve("electron/cli.js");
  } catch {
    try {
      // Try global electron
      const which = process.platform === "win32" ? "where electron" : "which electron";
      electronPath = execSync(which, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim().split(/\r?\n/)[0];
    } catch {
      return false;
    }
  }

  if (!electronPath) return false;

  const child = spawn(electronPath, [path.join(__dirname, "electron.js"), ...args], {
    stdio: "inherit",
    env: process.env,
    windowsHide: false,
  });
  child.on("exit", (code) => process.exit(code || 0));
  child.on("error", () => {
    console.log("[agenv] Electron failed to start, falling back to web mode...");
    fallbackWeb();
  });
  return true;
}

function fallbackWeb() {
  console.log("[agenv] Electron not found. Starting in web mode.");
  console.log("[agenv] Install Electron for the desktop app: npm install -g electron");
  console.log("[agenv] Or use: agenv --web\n");
  const child = spawn(process.execPath, [path.join(__dirname, "server.js"), ...args], {
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code) => process.exit(code || 0));
  child.on("error", (err) => { console.error("[agenv] " + err.message); process.exit(1); });
}

if (!tryElectron()) {
  fallbackWeb();
}
