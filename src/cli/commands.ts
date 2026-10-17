import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Config } from "../core/Config";
import { hashPassword } from "../core/password";

// dist/cli/commands.js → package.json two levels up
export const PKG_VERSION: string = require(path.join(__dirname, "..", "..", "package.json")).version;

const HELP = `
  Agenv v${PKG_VERSION} — The agent development environment

  Usage:
    agenv                        Launch desktop app (default)
    agenv --web                  Start web server mode
    agenv run <command...>       Start & auto-run a command
    agenv stop                   Stop running server
    agenv kill                   Force-kill running server
    agenv set <key> <value>      Set a config value
    agenv get <key>              Get a config value
    agenv update                 Update to latest version
    agenv help                   Show this help

  Run examples:
    agenv run claude --model opus --dangerously-skip-permissions
    agenv run vertex --model gemini-2.5-pro
    agenv run ssh user@server
    agenv run python3

  Web mode flags (use with --web):
    --port <n>          Port number (default: 7681)
    --host <addr>       Bind address (default: 127.0.0.1)
    --shell <shell>     Shell command (default: cmd.exe / bash)
    --token <tok>       Custom auth token
    --sessions <n>      Initial sessions (default: 1)
    --max-sessions <n>  Max sessions (default: 10)
    --open              Open browser on startup
    --qr                Show QR code (default: on)
    --no-qr             Hide QR code
    --name <name>       Session name (used with 'run')
    --mirror            Echo session 0 into this terminal (off by default)

  Config:
    agenv set auth.username admin
    agenv set auth.password s3cret
`;

export const PID_FILE = ".agenv.pid";

/**
 * Handles the non-server subcommands (help, version, set, get, update, stop, kill, and `run` without a command).
 * Returns the process exit code when the command was handled, or null when the server should start.
 */
export function runCommand(config: Config): number | null {
  const args = config.args;
  const command = config.command;

  if (command === "help" || command === "--help" || command === "-h") { console.log(HELP); return 0; }
  if (command === "version" || command === "--version" || command === "-v") { console.log(`agenv v${PKG_VERSION}`); return 0; }

  if (command === "set") {
    const key = args[1];
    const value = args.slice(2).join(" ");
    if (!key || !value) {
      console.error("Usage: agenv set <key> <value>\n\nExamples:\n  agenv set auth.username admin\n  agenv set auth.password s3cret");
      return 1;
    }
    if (key === "auth.password") { config.set(key, hashPassword(value)); console.log("[agenv] Password saved (hashed)."); }
    else { config.set(key, value); console.log(`[agenv] ${key} = ${value}`); }
    return 0;
  }

  if (command === "get") {
    const key = args[1];
    if (!key) { console.error("Usage: agenv get <key>"); return 1; }
    const val = config.get(key);
    if (val === undefined) { console.error(`[agenv] ${key} is not set`); return 1; }
    console.log(key === "auth.password" ? "(hashed)" : val);
    return 0;
  }

  if (command === "update") {
    console.log(`[agenv] Current version: ${PKG_VERSION}\n[agenv] Checking for updates...`);
    try { execSync("npm install -g @adibenmatdev/agenv@latest", { stdio: "inherit" }); console.log("[agenv] Update complete."); }
    catch { console.error("[agenv] Update failed. Try manually: npm install -g @adibenmatdev/agenv@latest"); return 1; }
    return 0;
  }

  if (command === "kill" || command === "stop") { stopServer(command); return 0; }

  if (command === "run" && !config.runCommand) {
    console.error("Usage: agenv run <command...>\n\nExamples:\n  agenv run claude --model opus\n  agenv run vertex --model gemini-2.5-pro\n  agenv run ssh user@server");
    return 1;
  }

  return null;
}

function stopServer(command: "kill" | "stop"): void {
  const pidPath = path.join(os.homedir(), PID_FILE);
  try {
    const pidData = JSON.parse(fs.readFileSync(pidPath, "utf8"));
    const pid = pidData.pid;
    console.log(`[agenv] Stopping server (PID ${pid}, port ${pidData.port || "?"})...`);
    try {
      process.kill(pid, command === "kill" ? "SIGKILL" : "SIGTERM");
      console.log(`[agenv] Sent ${command === "kill" ? "SIGKILL" : "SIGTERM"} to PID ${pid}`);
    } catch (e: any) {
      if (e.code === "ESRCH") {
        console.log("[agenv] Process not running (stale PID file). Cleaning up.");
      } else if (process.platform === "win32") {
        // On Windows, process.kill with SIGTERM may not work; use taskkill
        try {
          execSync(`taskkill /PID ${pid} /F`, { stdio: "pipe" });
          console.log(`[agenv] Killed PID ${pid} via taskkill`);
        } catch {
          console.error(`[agenv] Failed to kill PID ${pid}: ${e.message}`);
        }
      } else {
        console.error(`[agenv] Failed to kill PID ${pid}: ${e.message}`);
      }
    }
    try { fs.unlinkSync(pidPath); } catch {}
  } catch {
    console.error("[agenv] No running server found (no PID file at " + pidPath + ")");
    // Fallback: try to find by port
    console.log("[agenv] Tip: you can also use 'taskkill /PID <pid> /F' or 'kill <pid>' manually.");
  }
}
