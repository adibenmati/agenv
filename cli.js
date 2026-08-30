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

// How long Electron must stay alive before we call the launch a success. A
// non-zero exit inside this window means no window ever appeared, so we fall
// back to web mode instead of forwarding the crash to the user.
const PROBE_MS = parseInt(process.env.AGENV_ELECTRON_PROBE_MS || "4000", 10);

// If it's a subcommand or --web, delegate directly to server.js
if (subcommands.has(command) || isWeb) {
  const serverArgs = args.filter(a => a !== "--web");
  const child = spawn(process.execPath, [path.join(__dirname, "server.js"), ...serverArgs], {
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code) => process.exit(code || 0));
  child.on("error", (err) => { console.error("[agenv] " + err.message); process.exit(1); });
  return;
}

// .cmd/.bat shims can only be started through a shell.
function needsShell(bin) {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);
}

// Locate an Electron binary. Resolution only — never spawns, so a failure to
// launch can't be mistaken for a failure to find.
function resolveElectron() {
  // Explicit override: point agenv at a specific (e.g. signed) Electron build.
  const override = process.env.AGENV_ELECTRON_BIN;
  if (override) return override;

  // require("electron") returns the path to the actual binary
  try {
    const bin = require("electron");
    if (typeof bin === "string" && bin) return bin;
  } catch {}

  // Otherwise fall back to whatever is on PATH
  try {
    const which = process.platform === "win32" ? "where electron" : "which electron";
    const lines = execSync(which, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] })
      .trim().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (process.platform === "win32") {
      return lines.find(l => /\.(exe|cmd|bat)$/i.test(l)) || lines[0] || null;
    }
    return lines[0] || null;
  } catch {}

  return null;
}

// Turn a spawn failure into something actionable instead of a Node stack trace.
function explainFailure(text) {
  const t = String(text || "");
  if (/spawn UNKNOWN|-4094|Application Control|blocked this file/i.test(t)) {
    return "Windows blocked the Electron binary (Smart App Control / Application Control policy). " +
      "Electron's prebuilt binary is unsigned, so the policy refuses to run it.";
  }
  if (/ENOENT|not recognized|No such file/i.test(t)) {
    return "The Electron binary could not be found or executed.";
  }
  if (/EACCES|Permission denied/i.test(t)) {
    return "The Electron binary is not executable.";
  }
  return null;
}

function launchElectron(bin) {
  const electronArgs = [path.join(__dirname, "electron.js"), ...args];
  const startedAt = Date.now();
  let settled = false;
  let holding = true;
  let held = [];
  let child;

  // Hold Electron's stderr during the probe window so a crash we're about to
  // recover from doesn't spew a stack trace at the user. Flush it once the
  // launch looks real.
  const flush = () => {
    holding = false;
    for (const chunk of held) process.stderr.write(chunk);
    held = [];
  };

  const giveUp = (detail) => {
    const why = explainFailure(detail);
    if (why) console.log("[agenv] " + why);
    console.log("[agenv] Starting in web mode instead. Use `agenv --web` to skip this next time.\n");
    startServer();
  };

  try {
    child = spawn(bin, electronArgs, {
      stdio: ["inherit", "inherit", "pipe"],
      env: process.env,
      windowsHide: false,
      shell: needsShell(bin),
    });
  } catch (err) {
    // Windows reports some spawn failures synchronously rather than via 'error'.
    giveUp(err && err.message);
    return;
  }

  child.stderr.on("data", (chunk) => {
    if (holding) held.push(chunk);
    else process.stderr.write(chunk);
  });

  const probe = setTimeout(flush, PROBE_MS);
  if (probe.unref) probe.unref();

  child.on("error", (err) => {
    if (settled) return;
    settled = true;
    clearTimeout(probe);
    giveUp((err && err.message) + " " + Buffer.concat(held).toString());
  });

  child.on("exit", (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(probe);
    if (code !== 0 && Date.now() - startedAt < PROBE_MS) {
      giveUp(Buffer.concat(held).toString());
      return;
    }
    flush();
    process.exit(code || 0);
  });
}

function startServer() {
  const child = spawn(process.execPath, [path.join(__dirname, "server.js"), ...args], {
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code) => process.exit(code || 0));
  child.on("error", (err) => { console.error("[agenv] " + err.message); process.exit(1); });
}

const electronBin = resolveElectron();
if (electronBin) {
  launchElectron(electronBin);
} else {
  console.log("[agenv] Electron not found. Starting in web mode.");
  console.log("[agenv] Install Electron for the desktop app: npm install -g electron");
  console.log("[agenv] Or use: agenv --web\n");
  startServer();
}
