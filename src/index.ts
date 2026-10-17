// Entry point: process lifecycle only. Every object is created in runtime.ts; this file starts the server,
// restores sessions, prints the banner, and makes sure state is saved however the process ends.
import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn as spawnPty } from "@lydell/node-pty";
import { printBanner } from "./banner";
import { PID_FILE, PKG_VERSION, runCommand } from "./cli/commands";
import { Config } from "./core/Config";
import { buildRuntime } from "./runtime";
import type { IPty, PtyFactory } from "./sessions/pty";

function main(): void {
  const homedir = os.homedir();
  const config = Config.fromArgv(process.argv.slice(2), process.env, homedir);

  // help, version, set, get, update, stop, kill — handled without starting a server
  const exitCode = runCommand(config);
  if (exitCode !== null) process.exit(exitCode);

  const ptyFactory: PtyFactory = (o) => spawnPty(o.file, o.args, {
    name: "xterm-256color", cols: o.cols, rows: o.rows, cwd: o.cwd, env: o.env as { [key: string]: string },
  }) as unknown as IPty;

  let shuttingDown = false;
  /** Set when startup fails (e.g. the port is taken): the exit hooks must not save this process's stale state. */
  let startupFailed = false;

  const runtime = buildRuntime({
    config, homedir, ptyFactory,
    publicDir: path.join(__dirname, "..", "public"),
    watchPage: process.env.NODE_ENV !== "production",
    onShutdownRequest: (reason) => gracefulShutdown(reason),
  });
  const { sessions, stateStore, gateway, bus } = runtime;
  const pidPath = path.join(homedir, PID_FILE);
  // Nothing is saved until the server is really listening: a launch that fails (port taken) must not touch the
  // state of the agenv that is running.
  stateStore.hold();

  console.log(runtime.auth.useCredentials ? "[agenv] Auth mode: username/password" : "[agenv] Auth mode: token");

  // ---- sessions: start the one `agenv run` asked for, restore the last run's tabs, or open fresh shells ----
  const saved = runtime.savedState;
  if (config.runCommand) {
    // "agenv run <cmd>" — start fresh with a single session running the command
    const runName = config.runName || config.runCommand.split(/\s+/)[0];
    sessions.create({ cwd: process.cwd(), name: runName, runCommand: config.runCommand, restoreScrollback: false }, { enforceLimit: false });
  } else if (saved && saved.sessions && saved.sessions.length > 0) {
    // Restore every tab the workspace layout referenced, but as a record only — no shell is spawned until the tab is
    // actually attached to. Startup stays instant and a restored window costs no processes until it's used.
    const restored = sessions.restore(saved.sessions, runtime.layout.sessionIds());
    console.log(`[agenv] Restoring ${restored} of ${saved.sessions.length} saved tabs (shells start on open)`);
  } else {
    for (let i = 0; i < config.initialSessions; i++) sessions.create({ restoreScrollback: false }, { enforceLimit: false });
  }

  // ---- startup banner, QR code, browser ----
  const accessUrl = runtime.auth.useCredentials
    ? `http://${config.host}:${config.port}/`
    : `http://${config.host}:${config.port}/?token=${config.token}`;
  let qr: { generate(text: string, opts: { small?: boolean }, cb: (qr: string) => void): void } | undefined;
  try { qr = require("qrcode-terminal"); } catch {}
  printBanner({
    version: PKG_VERSION, accessUrl, runCommand: config.runCommand || undefined, sessions: sessions.size,
    restored: !!(saved && saved.sessions), shell: config.shell, showQr: config.showQr, qr,
  });

  if (config.autoOpen) {
    try {
      const openCmd = process.platform === "win32" ? `start ""  "${accessUrl}"` : (os.platform() === "darwin" ? `open "${accessUrl}"` : `xdg-open "${accessUrl}"`);
      execSync(openCmd, { stdio: "ignore", timeout: 5000 });
    } catch {}
  }

  // Periodic save (every 30 seconds)
  const periodicSave = setInterval(() => { stateStore.save(); sessions.saveAllScrollback(); }, 30000);

  // ---- the launching terminal ----
  // Forward local stdin -> session 0 only when its output is mirrored back; otherwise keystrokes would land in a
  // shell the user can't see.
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  if (config.mirror) {
    process.stdin.on("data", (data) => { const s = sessions.get(0); if (s) sessions.write(s, String(data)); });
    bus.on("output", (s, data) => { if (s.id === 0) process.stdout.write(data); });
    // When the mirrored shell ends there is nothing left to show: leave with its exit code. A session closed from
    // the browser (API delete) is announced with -1 and must not stop the server.
    bus.on("deleted", (s, code) => {
      if (s.id !== 0 || code === -1) return;
      stateStore.saveNow(); sessions.saveAllScrollback();
      process.exit(code);
    });
  }
  process.stdout.on("resize", () => {
    const s = sessions.get(0);
    if (!s) return;
    sessions.resize(s, process.stdout.columns, process.stdout.rows);
    gateway.broadcast(0, { type: "resize", cols: s.cols, rows: s.rows });
  });

  // ---- shutdown: save state on ALL exit paths ----
  function removePidFile(): void {
    // Only our own: a second agenv that failed to start must not delete the PID file of the one that is running.
    try {
      if (JSON.parse(fs.readFileSync(pidPath, "utf8")).pid === process.pid) fs.unlinkSync(pidPath);
    } catch {}
  }

  function gracefulShutdown(reason: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[agenv] ${reason} — saving state...`);
    try { stateStore.saveNow(); } catch {}
    clearInterval(periodicSave);
    removePidFile();
    try { sessions.shutdown(); } catch {}          // saves every scrollback, then kills the shells
    void runtime.dispose().then(() => {
      console.log("[agenv] Server closed.");
      process.exit(0);
    });
    // Force exit after 3s if the server hangs on close
    setTimeout(() => process.exit(0), 3000).unref();
  }

  // Signal handling — works on both Windows and Unix
  let ctrlCCount = 0;
  let ctrlCTimer: NodeJS.Timeout | undefined;
  process.on("SIGINT", () => {
    ctrlCCount++;
    if (ctrlCCount >= 2) gracefulShutdown("Double Ctrl+C");
    else console.log("\n[agenv] Press Ctrl+C again to exit (or run 'agenv stop')");
    clearTimeout(ctrlCTimer);
    ctrlCTimer = setTimeout(() => { ctrlCCount = 0; }, 2000);
  });
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGHUP", () => gracefulShutdown("SIGHUP"));
  // Windows: handle Ctrl+Break
  if (process.platform === "win32") process.on("SIGBREAK", () => gracefulShutdown("Ctrl+Break"));
  process.on("exit", () => {
    if (!shuttingDown && !startupFailed) { try { stateStore.saveNow(); } catch {} try { sessions.saveAllScrollback(true); } catch {} }
    removePidFile();
  });

  // ---- listen ----
  runtime.server.on("error", (e: NodeJS.ErrnoException) => {
    startupFailed = true;
    if (e.code === "EADDRINUSE") {
      console.error(`[agenv] Port ${config.port} is already in use on ${config.host}. Stop the other agenv ('agenv stop') or choose another port with --port.`);
    } else {
      console.error(`[agenv] Server error: ${e.message}`);
    }
    process.exit(1);
  });
  runtime.server.listen(config.port, config.host, () => {
    console.log(`[agenv] Listening on ${config.host}:${config.port}`);
    stateStore.release();   // the port is ours: save the restored/initial sessions now
    // Routines only run in the process that owns the port: close runs a dead server left active, apply catch-up, then tick.
    try { runtime.scheduler.startup(); } catch (e) { console.error(`[agenv] Routine catch-up failed: ${(e as Error).message}`); }
    try { runtime.scheduler.start(); } catch (e) { console.error(`[agenv] Routine scheduler failed to start: ${(e as Error).message}`); }
    // Write PID file so 'agenv stop/kill' can find us
    try { fs.writeFileSync(pidPath, JSON.stringify({ pid: process.pid, port: config.port, host: config.host, started: Date.now() })); } catch {}
  });
}

main();
