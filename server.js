#!/usr/bin/env node
"use strict";

const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const { execSync, spawn } = require("child_process");
const express = require("express");
const { WebSocketServer } = require("ws");
const pty = require("@lydell/node-pty");

// ---------------------------------------------------------------------------
// Config file (~/.agenvrc.json)
// ---------------------------------------------------------------------------
const CONFIG_PATH = path.join(os.homedir(), ".agenvrc.json");

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch { return {}; }
}
function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
}
function getConfigValue(key) {
  const parts = key.split(".");
  let obj = loadConfig();
  for (const p of parts) { if (obj == null || typeof obj !== "object") return undefined; obj = obj[p]; }
  return obj;
}
function setConfigValue(key, value) {
  const config = loadConfig();
  const parts = key.split(".");
  let obj = config;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!obj[parts[i]] || typeof obj[parts[i]] !== "object") obj[parts[i]] = {};
    obj = obj[parts[i]];
  }
  obj[parts[parts.length - 1]] = value;
  saveConfig(config);
}

// ---------------------------------------------------------------------------
// Encryption (AES-256-GCM)
// ---------------------------------------------------------------------------
const ENCRYPTION_KEY_PATH = path.join(os.homedir(), ".agenv.key");

function getEncryptionKey() {
  try {
    const hex = fs.readFileSync(ENCRYPTION_KEY_PATH, "utf8").trim();
    if (hex.length !== 64) throw new Error("bad key");
    return Buffer.from(hex, "hex");
  } catch {
    const key = crypto.randomBytes(32);
    fs.writeFileSync(ENCRYPTION_KEY_PATH, key.toString("hex"), { mode: 0o600 });
    return key;
  }
}

function encryptJSON(obj) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  let enc = cipher.update(JSON.stringify(obj), "utf8", "base64");
  enc += cipher.final("base64");
  return JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: enc });
}

function decryptJSON(raw) {
  const parsed = JSON.parse(raw);
  if (!parsed.v) return parsed;
  const key = getEncryptionKey();
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(parsed.iv, "base64"));
  d.setAuthTag(Buffer.from(parsed.tag, "base64"));
  let dec = d.update(parsed.data, "base64", "utf8");
  dec += d.final("utf8");
  return JSON.parse(dec);
}

// ---------------------------------------------------------------------------
// Command history (~/.agenv-history.enc)
// ---------------------------------------------------------------------------
const HISTORY_PATH = path.join(os.homedir(), ".agenv-history.enc");
const HISTORY_PATH_OLD = path.join(os.homedir(), ".agenv-history.json");
const MAX_HISTORY = 1000;

function loadHistory() {
  try { return decryptJSON(fs.readFileSync(HISTORY_PATH, "utf8")); }
  catch {
    try {
      const old = JSON.parse(fs.readFileSync(HISTORY_PATH_OLD, "utf8"));
      if (Array.isArray(old) && old.length) { saveHistory(old); try { fs.unlinkSync(HISTORY_PATH_OLD); } catch {} return old; }
    } catch {}
    return [];
  }
}
function saveHistory(history) { fs.writeFileSync(HISTORY_PATH, encryptJSON(history), "utf8"); }

// ---------------------------------------------------------------------------
// Scrollback persistence (~/.agenv-scrollback/)
// ---------------------------------------------------------------------------
const SCROLLBACK_DIR = path.join(os.homedir(), ".agenv-scrollback");
function ensureScrollbackDir() { try { fs.mkdirSync(SCROLLBACK_DIR, { recursive: true }); } catch {} }
function saveScrollback(session) {
  if (!session.scrollback || session.scrollback.length === 0) return;
  ensureScrollbackDir();
  try { fs.writeFileSync(path.join(SCROLLBACK_DIR, `session-${session.id}.enc`), encryptJSON(session.scrollback.toString("utf8")), "utf8"); } catch {}
}
function loadScrollback(id) {
  try { return Buffer.from(decryptJSON(fs.readFileSync(path.join(SCROLLBACK_DIR, `session-${id}.enc`), "utf8"))); } catch { return null; }
}
function clearScrollbackFile(id) { try { fs.unlinkSync(path.join(SCROLLBACK_DIR, `session-${id}.enc`)); } catch {} }
function saveAllScrollback() { for (const s of sessions.values()) saveScrollback(s); }

// ---------------------------------------------------------------------------
// Session archive (~/.agenv-archive.enc) — closed session history
// ---------------------------------------------------------------------------
const ARCHIVE_PATH = path.join(os.homedir(), ".agenv-archive.enc");
const MAX_ARCHIVE = 100;

function loadArchive() {
  try { const a = decryptJSON(fs.readFileSync(ARCHIVE_PATH, "utf8")); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
function saveArchive(archive) { fs.writeFileSync(ARCHIVE_PATH, encryptJSON(archive), "utf8"); }

function archiveSession(session) {
  const archive = loadArchive();
  archive.push({
    name: session.name || "",
    cwd: session.cwd,
    tool: session.detectedTool || "terminal",
    lastCommand: session.lastCommand || "",
    launchCommand: session.launchCommand || "",
    created: session.created,
    lastActivity: session.lastActivity,
    closed: Date.now(),
  });
  if (archive.length > MAX_ARCHIVE) archive.splice(0, archive.length - MAX_ARCHIVE);
  saveArchive(archive);
}

// ---------------------------------------------------------------------------
// Favorites (~/.agenv-favorites.enc) — saved folder+command combos
// ---------------------------------------------------------------------------
const FAVORITES_PATH = path.join(os.homedir(), ".agenv-favorites.enc");

function loadFavorites() {
  try { const f = decryptJSON(fs.readFileSync(FAVORITES_PATH, "utf8")); return Array.isArray(f) ? f : []; }
  catch { return []; }
}
function saveFavorites(favs) { fs.writeFileSync(FAVORITES_PATH, encryptJSON(favs), "utf8"); }

// ---------------------------------------------------------------------------
// Session state (~/.agenv-state.enc)
// ---------------------------------------------------------------------------
const STATE_PATH = path.join(os.homedir(), ".agenv-state.enc");
const STATE_PATH_OLD = path.join(os.homedir(), ".agenv-state.json");

function loadState() {
  try { return decryptJSON(fs.readFileSync(STATE_PATH, "utf8")); }
  catch {
    try {
      const old = JSON.parse(fs.readFileSync(STATE_PATH_OLD, "utf8"));
      if (old && old.sessions) { fs.writeFileSync(STATE_PATH, encryptJSON(old), "utf8"); try { fs.unlinkSync(STATE_PATH_OLD); } catch {} return old; }
    } catch {}
    return null;
  }
}

let _workspaceLayout = null; // saved by client via API

function saveState() {
  const state = { sessions: [], workspaceLayout: _workspaceLayout || null };
  for (const [id, session] of sessions) {
    state.sessions.push({
      id, name: session.name || "", cwd: session.cwd,
      tool: session.detectedTool || "terminal",
      lastCommand: session.lastCommand || "",
      launchCommand: session.launchCommand || "",
      userNamed: session.userNamed || false,
      created: session.created || Date.now(),
      lastActivity: session.lastActivity || Date.now(),
    });
  }
  fs.writeFileSync(STATE_PATH, encryptJSON(state), "utf8");
}

// ---------------------------------------------------------------------------
// Tool detection — identify what's running in a session
// ---------------------------------------------------------------------------
const TOOL_PATTERNS = [
  { re: /^claude\b/i, tool: "claude" },
  { re: /^vertex\b/i, tool: "vertex" },
  { re: /^gcloud\s+ai\b/i, tool: "vertex" },
  { re: /^gcloud\b/i, tool: "gcloud" },
  { re: /^aws\b/i, tool: "aws" },
  { re: /^az\b/i, tool: "azure" },
  { re: /^ssh\b/i, tool: "ssh" },
  { re: /^docker\b/i, tool: "docker" },
  { re: /^kubectl\b/i, tool: "k8s" },
  { re: /^python3?\b/i, tool: "python" },
  { re: /^node\b/i, tool: "node" },
  { re: /^npm\b/i, tool: "npm" },
  { re: /^git\b/i, tool: "git" },
];

function detectTool(command) {
  const trimmed = command.trim();
  for (const p of TOOL_PATTERNS) {
    if (p.re.test(trimmed)) return p.tool;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Password hashing (scrypt)
// ---------------------------------------------------------------------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return salt + ":" + crypto.scryptSync(password, salt, 64).toString("hex");
}
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  try { return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(crypto.scryptSync(password, salt, 64).toString("hex"), "hex")); }
  catch { return false; }
}

// ---------------------------------------------------------------------------
// CLI handling
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const command = args[0];

// ---------------------------------------------------------------------------
// QR code display (using qrcode-terminal)
// ---------------------------------------------------------------------------
let qrcodeTerminal;
try { qrcodeTerminal = require("qrcode-terminal"); } catch {}

// ---------------------------------------------------------------------------
// CLI subcommands
// ---------------------------------------------------------------------------
const PKG_VERSION = require(path.join(__dirname, "package.json")).version;

if (command === "help" || command === "--help" || command === "-h") {
  console.log(`
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

  Config:
    agenv set auth.username admin
    agenv set auth.password s3cret
`);
  process.exit(0);
}

if (command === "version" || command === "--version" || command === "-v") {
  console.log(`agenv v${PKG_VERSION}`);
  process.exit(0);
}

if (command === "set") {
  const key = args[1]; const value = args.slice(2).join(" ");
  if (!key || !value) { console.error("Usage: agenv set <key> <value>\n\nExamples:\n  agenv set auth.username admin\n  agenv set auth.password s3cret"); process.exit(1); }
  if (key === "auth.password") { setConfigValue(key, hashPassword(value)); console.log("[agenv] Password saved (hashed)."); }
  else { setConfigValue(key, value); console.log(`[agenv] ${key} = ${value}`); }
  process.exit(0);
}
if (command === "get") {
  const key = args[1];
  if (!key) { console.error("Usage: agenv get <key>"); process.exit(1); }
  const val = getConfigValue(key);
  if (val === undefined) { console.error(`[agenv] ${key} is not set`); process.exit(1); }
  console.log(key === "auth.password" ? "(hashed)" : val);
  process.exit(0);
}
if (command === "update") {
  console.log(`[agenv] Current version: ${PKG_VERSION}\n[agenv] Checking for updates...`);
  try { execSync("npm install -g @adibenmatdev/agenv@latest", { stdio: "inherit" }); console.log("[agenv] Update complete."); }
  catch { console.error("[agenv] Update failed. Try manually: npm install -g @adibenmatdev/agenv@latest"); process.exit(1); }
  process.exit(0);
}

const PID_PATH = path.join(os.homedir(), ".agenv.pid");

if (command === "kill" || command === "stop") {
  try {
    const pidData = JSON.parse(fs.readFileSync(PID_PATH, "utf8"));
    const pid = pidData.pid;
    console.log(`[agenv] Stopping server (PID ${pid}, port ${pidData.port || "?"})...`);
    try {
      process.kill(pid, command === "kill" ? "SIGKILL" : "SIGTERM");
      console.log(`[agenv] Sent ${command === "kill" ? "SIGKILL" : "SIGTERM"} to PID ${pid}`);
    } catch (e) {
      if (e.code === "ESRCH") {
        console.log("[agenv] Process not running (stale PID file). Cleaning up.");
      } else {
        // On Windows, process.kill with SIGTERM may not work; use taskkill
        if (process.platform === "win32") {
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
    }
    try { fs.unlinkSync(PID_PATH); } catch {}
  } catch {
    console.error("[agenv] No running server found (no PID file at " + PID_PATH + ")");
    // Fallback: try to find by port
    console.log("[agenv] Tip: you can also use 'taskkill /PID <pid> /F' or 'kill <pid>' manually.");
  }
  process.exit(0);
}

// "run" subcommand — collect everything after "run" as the command (excluding flags)
let RUN_COMMAND = "";
let RUN_NAME = "";
if (command === "run") {
  // Collect command parts: everything after "run" that isn't a --flag or its value
  const runArgs = args.slice(1);
  const cmdParts = [];
  let skipNext = false;
  const flagsWithValue = new Set(["--port", "--host", "--shell", "--token", "--sessions", "--max-sessions", "--name"]);
  const flagsNoValue = new Set(["--open", "--qr", "--no-qr"]);
  for (let i = 0; i < runArgs.length; i++) {
    if (skipNext) { skipNext = false; continue; }
    if (flagsWithValue.has(runArgs[i])) { skipNext = true; continue; }
    if (flagsNoValue.has(runArgs[i])) continue;
    cmdParts.push(runArgs[i]);
  }
  RUN_COMMAND = cmdParts.join(" ");
  if (!RUN_COMMAND) {
    console.error("Usage: agenv run <command...>\n\nExamples:\n  agenv run claude --model opus\n  agenv run vertex --model gemini-2.5-pro\n  agenv run ssh user@server");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Server mode — parse flags
// ---------------------------------------------------------------------------
function flag(name, fallback) { const i = args.indexOf(name); return (i === -1 || i + 1 >= args.length) ? fallback : args[i + 1]; }
function hasFlag(name) { return args.includes(name); }

const PORT = parseInt(flag("--port", process.env.PORT || "7681"), 10);
let HOST = flag("--host", process.env.HOST || "127.0.0.1");

// Electron safety: force localhost binding
if (process.env.ELECTRON === "1" && HOST !== "127.0.0.1" && HOST !== "localhost") {
  console.warn(`[agenv] Electron mode: overriding HOST ${HOST} → 127.0.0.1 for security`);
  HOST = "127.0.0.1";
}
const isWindows = os.platform() === "win32";
const defaultShell = isWindows ? "cmd.exe" : process.env.SHELL || "bash";
const SHELL = flag("--shell", defaultShell);
let TOKEN = flag("--token", loadConfig().token || crypto.randomBytes(16).toString("hex"));
const INITIAL_SESSIONS = Math.max(1, parseInt(flag("--sessions", "1"), 10));
const MAX_SESSIONS = Math.max(1, parseInt(flag("--max-sessions", "20"), 10));
const AUTO_OPEN = hasFlag("--open");
const SHOW_QR = !hasFlag("--no-qr");
RUN_NAME = flag("--name", RUN_NAME);

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------
const config = loadConfig();
const useCredentials = !!(config.auth && config.auth.username && config.auth.password);
const cookieSessions = new Set();

if (useCredentials) console.log("[agenv] Auth mode: username/password");
else console.log("[agenv] Auth mode: token");

function parseCookies(req) {
  const cookies = {};
  (req.headers.cookie || "").split(";").forEach((c) => {
    const idx = c.indexOf("=");
    if (idx > 0) cookies[c.substring(0, idx).trim()] = decodeURIComponent(c.substring(idx + 1).trim());
  });
  return cookies;
}
function isAuthenticated(req) {
  const cookies = parseCookies(req);
  if (cookies.session && cookieSessions.has(cookies.session)) return true;
  const url = new URL(req.url, "http://localhost");
  if (url.searchParams.get("token") === TOKEN) return true;
  if (req.query && req.query.token === TOKEN) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Scrollback ring-buffer
// ---------------------------------------------------------------------------
const MAX_SCROLLBACK = 100 * 1024;
// Reset sequence prepended after truncation to neutralize any partial ANSI state:
// \x1b[0m = reset attributes, \x1b[?25h = show cursor
const SCROLLBACK_RESET = Buffer.from("\x1b[0m\x1b[?25h");

function appendScrollback(session, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  session.scrollback = Buffer.concat([session.scrollback, buf]);
  if (session.scrollback.length > MAX_SCROLLBACK) {
    let start = session.scrollback.length - MAX_SCROLLBACK;
    // Skip any UTF-8 continuation bytes (10xxxxxx) so we don't start mid-character
    while (start < session.scrollback.length && (session.scrollback[start] & 0xC0) === 0x80) {
      start++;
    }
    // Try to find a newline within 2KB for a clean line boundary
    const searchEnd = Math.min(start + 2048, session.scrollback.length);
    for (let i = start; i < searchEnd; i++) {
      if (session.scrollback[i] === 0x0A) { // \n
        start = i + 1;
        break;
      }
    }
    // Prepend a reset sequence to neutralize any cut ANSI state (colors, modes, etc.)
    session.scrollback = Buffer.concat([SCROLLBACK_RESET, session.scrollback.slice(start)]);
  }
}

// ---------------------------------------------------------------------------
// PTY session management
// ---------------------------------------------------------------------------
const shellParts = SHELL.match(/(?:[^\s"]+|"[^"]*")+/g) || [SHELL];
const shellCmd = shellParts[0];
const shellArgs = shellParts.slice(1).map((a) => a.replace(/^"|"$/g, ""));
const cols = process.stdout.columns || 120;
const rows = process.stdout.rows || 30;
const sessions = new Map();
let nextSessionId = 0;
let shuttingDown = false;

// ---------------------------------------------------------------------------
// Session status detection — pattern matching on PTY output
// ---------------------------------------------------------------------------
const STATUS_PATTERNS = {
  // Prompt patterns → idle (waiting for user input in shell)
  idle: [
    /[\$#>]\s*$/,                    // bash/zsh prompt
    /^PS [A-Z]:\\/i,                 // PowerShell
    /^[A-Z]:\\[^>]*>/,               // cmd.exe
    /^\([\w.-]+\)\s.*[\$#>]\s*$/,    // venv prompt
  ],
  // Waiting patterns → agent needs human input
  waiting: [
    /\? .*[:：]\s*$/,                // interactive prompt
    /\(y\/n\)/i,                     // yes/no
    /\[Y\/n\]/i,                     // default yes
    /\[yes\/no\]/i,
    /Press Enter/i,
    /waiting for.*input/i,
    /Do you want to/i,
    /\(yes\/no\/\[fingerprint\]\)/,  // SSH
    /Enter passphrase/i,
    /Password:/i,
    /approve this tool/i,            // Claude Code
    /Do you want to proceed/i,
  ],
  // Error patterns
  error: [
    /error[:\s]/i,
    /Error:/,
    /FAILED/,
    /panic:/,
    /Traceback \(most recent/,
    /SyntaxError/,
    /TypeError/,
    /fatal:/i,
    /ENOENT/,
    /EACCES/,
    /command not found/,
  ],
  // Busy patterns → agent is actively working
  busy: [
    /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/,      // spinner
    /\.\.\.\s*$/,                    // trailing dots
    /Compiling|Building|Installing/i,
    /Downloading|Fetching/i,
    /Running|Executing/i,
    /Thinking|Generating/i,
    /\[\d+\/\d+\]/,                  // progress [3/10]
    /\d+%/,                          // percentage
  ],
};

// Cost tracking patterns (Claude Code, Vertex, OpenAI Codex, Gemini)
// Claude Code outputs: "Total cost: $X.XX" and "Input tokens: N, Output tokens: N"
// Also: "Session cost: $X.XX" or lines like "$0.1234 cost"
const COST_PATTERNS = [
  // "$X.XX" standalone or "cost: $X.XX" or "total: $X.XX" or "session cost: $X.XX"
  { type: "cost", pattern: /(?:cost|total|session|spent)[:\s]*\$?([\d]+\.[\d]+)/i },
  // "X input tokens ... Y output tokens"
  { type: "tokens_io", pattern: /(\d[\d,]*)\s*input\s*tokens?.*?(\d[\d,]*)\s*output\s*tokens?/i },
  // "Input: N tokens" lines
  { type: "input_tokens", pattern: /input[:\s]*(\d[\d,]*)\s*tokens?/i },
  // "Output: N tokens" lines
  { type: "output_tokens", pattern: /output[:\s]*(\d[\d,]*)\s*tokens?/i },
  // "N tokens" generic
  { type: "generic_tokens", pattern: /(\d[\d,]+)\s*tokens?\s*(?:used|consumed|total)/i },
  // Claude Code summary: "⏺ Total cost: $X.XX"
  { type: "cost", pattern: /\$(\d+\.[\d]+)/i },
];

function detectSessionStatus(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const lastLine = lines[lines.length - 1] || "";
  const last3 = lines.slice(-3).join("\n");

  // Check waiting first (highest priority)
  for (const p of STATUS_PATTERNS.waiting) {
    if (p.test(lastLine) || p.test(last3)) return "waiting";
  }
  // Check busy
  for (const p of STATUS_PATTERNS.busy) {
    if (p.test(lastLine) || p.test(last3)) return "running";
  }
  // Check error (only on last line)
  for (const p of STATUS_PATTERNS.error) {
    if (p.test(lastLine)) return "error";
  }
  // Check idle
  for (const p of STATUS_PATTERNS.idle) {
    if (p.test(lastLine)) return "idle";
  }
  return null; // unknown
}

function parseTokenInfo(text) {
  const info = {};
  for (const { type, pattern } of COST_PATTERNS) {
    const m = text.match(pattern);
    if (!m) continue;
    if (type === "cost") {
      const c = parseFloat(m[1]);
      if (c > 0 && c < 1000) info.cost = c; // sanity check
    } else if (type === "tokens_io") {
      info.inputTokens = parseInt(m[1].replace(/,/g, ""), 10);
      info.outputTokens = parseInt(m[2].replace(/,/g, ""), 10);
    } else if (type === "input_tokens") {
      info.inputTokens = parseInt(m[1].replace(/,/g, ""), 10);
    } else if (type === "output_tokens") {
      info.outputTokens = parseInt(m[1].replace(/,/g, ""), 10);
    } else if (type === "generic_tokens" && !info.inputTokens) {
      info.inputTokens = parseInt(m[1].replace(/,/g, ""), 10);
    }
  }
  return Object.keys(info).length ? info : null;
}

// System stats
function getSystemStats() {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  // CPU usage: average across cores (idle vs total)
  let totalIdle = 0, totalTick = 0;
  for (const cpu of cpus) {
    for (const type in cpu.times) totalTick += cpu.times[type];
    totalIdle += cpu.times.idle;
  }
  const cpuUsage = Math.round(100 - (totalIdle / totalTick * 100));
  return {
    cpu: cpuUsage,
    memUsed: usedMem,
    memTotal: totalMem,
    memPercent: Math.round(usedMem / totalMem * 100),
    platform: os.platform(),
    hostname: os.hostname(),
    uptime: os.uptime(),
    cores: cpus.length,
  };
}

function spawnSession(id, opts) {
  const o = typeof opts === "string" ? { cwd: opts } : (opts || {});
  const sessionCwd = o.cwd || process.cwd();
  const ptyProcess = pty.spawn(shellCmd, shellArgs, {
    name: "xterm-256color", cols, rows, cwd: sessionCwd,
    env: Object.assign({}, process.env, { TERM: "xterm-256color" }),
  });

  const now = Date.now();
  const session = {
    id, name: o.name || "", cwd: sessionCwd,
    created: o.created || now, lastActivity: o.lastActivity || now,
    detectedTool: o.tool || "terminal", lastCommand: o.lastCommand || "",
    launchCommand: o.runCommand || o.launchCommand || "",
    userNamed: !!(o.userNamed),
    // New fields for agent-deck style features
    status: "idle",           // idle | running | waiting | error
    group: o.group || "",     // session group name
    note: o.note || "",       // session notes
    analytics: {
      inputTokens: 0, outputTokens: 0, estimatedCost: 0,
      commandCount: 0, turnCount: 0, startTime: now,
    },
    pty: ptyProcess, scrollback: Buffer.alloc(0), clients: new Set(),
    pendingCommand: o.runCommand || null,
  };

  if (o.restoreScrollback !== false) {
    const saved = loadScrollback(id);
    if (saved) session.scrollback = saved;
  }

  sessions.set(id, session);

  // Send pending command once the shell is ready (small delay for shell init)
  if (session.pendingCommand) {
    setTimeout(() => {
      if (session.pty) {
        session.pty.write(session.pendingCommand + "\r");
        session.lastCommand = session.pendingCommand;
        const t = detectTool(session.pendingCommand);
        if (t) session.detectedTool = t;
        session.pendingCommand = null;
        saveState();
      }
    }, 500);
  }

  ptyProcess.onData((data) => {
    session.lastActivity = Date.now();
    const osc7Match = data.match(/\x1b\]7;file:\/\/[^/]*([^\x07\x1b]*?)(?:\x07|\x1b\\)/);
    if (osc7Match) { try { const newCwd = decodeURIComponent(osc7Match[1]); if (newCwd !== session.cwd) { session.cwd = newCwd; saveState(); const cwdMsg = JSON.stringify({ type: "cwd", cwd: newCwd }); for (const ws of session.clients) { if (ws.readyState === 1) ws.send(cwdMsg); } } } catch {} }
    if (id === 0) process.stdout.write(data);
    appendScrollback(session, data);

    // CWD detection from Windows/PowerShell prompts
    const plain = data.replace(/\x1b\[[0-9;?]*[a-zA-Z~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Z]/g, "");
    if (process.platform === "win32") {
      // cmd.exe prompt: ends with "C:\path>" at end of a line/string
      const cmdMatch = plain.match(/([a-zA-Z]:\\[^>\r\n]*?)>\s*$/m);
      // PowerShell prompt: "PS C:\path>" at end of a line/string
      const psMatch = plain.match(/PS\s+([a-zA-Z]:\\[^\r\n>]*?)>\s*$/m);
      const detected = (psMatch && psMatch[1]) || (cmdMatch && cmdMatch[1]);
      if (detected && detected !== session.cwd) {
        try {
          const resolved = path.resolve(detected);
          if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
            session.cwd = resolved;
            const cwdMsg = JSON.stringify({ type: "cwd", cwd: resolved });
            for (const ws of session.clients) { if (ws.readyState === 1) ws.send(cwdMsg); }
          }
        } catch {}
      }
    }

    // Status detection
    const newStatus = detectSessionStatus(plain);
    if (newStatus && newStatus !== session.status) {
      session.status = newStatus;
      const statusMsg = JSON.stringify({ type: "status", status: newStatus, sessionId: id });
      for (const ws of session.clients) {
        if (ws.readyState === 1) ws.send(statusMsg);
      }
    }

    // Token/cost parsing for AI tools
    if (session.detectedTool !== "terminal") {
      const tokenInfo = parseTokenInfo(plain);
      if (tokenInfo) {
        if (tokenInfo.inputTokens) session.analytics.inputTokens += tokenInfo.inputTokens;
        if (tokenInfo.outputTokens) session.analytics.outputTokens += tokenInfo.outputTokens;
        if (tokenInfo.cost) session.analytics.estimatedCost += tokenInfo.cost;
        session.analytics.turnCount++;
      }
    }

    for (const ws of session.clients) {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: "output", data }));
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    if (shuttingDown) return;
    console.log(`\n[agenv] Session ${id} exited (code ${exitCode})`);
    archiveSession(session);
    for (const ws of session.clients) {
      if (ws.readyState === 1) { ws.send(JSON.stringify({ type: "exit", code: exitCode })); ws.close(); }
    }
    sessions.delete(id);
    clearScrollbackFile(id);
    if (id === 0) { saveState(); saveAllScrollback(); process.exit(exitCode); }
    saveState();
    // Broadcast archive update to all connected clients
    broadcastEvent("archive-updated");
  });

  return session;
}

function broadcastEvent(event) {
  for (const s of sessions.values()) {
    for (const ws of s.clients) {
      if (ws.readyState === 1) {
        try { ws.send(JSON.stringify({ type: "event", event })); } catch {}
      }
    }
  }
}

// Spawn sessions — restore previous state OR create from run command
const savedState = loadState();
if (savedState && savedState.workspaceLayout) _workspaceLayout = savedState.workspaceLayout;
if (RUN_COMMAND) {
  // "agenv run <cmd>" — start fresh with a single session running the command
  const runName = RUN_NAME || RUN_COMMAND.split(/\s+/)[0];
  spawnSession(nextSessionId++, {
    cwd: process.cwd(), name: runName, runCommand: RUN_COMMAND, restoreScrollback: false,
  });
} else if (savedState && savedState.sessions && savedState.sessions.length > 0) {
  // Only restore sessions that are in the workspace layout (visible tabs)
  // This prevents spawning dozens of dead PTYs on restart
  let neededIds = new Set();
  if (_workspaceLayout && Array.isArray(_workspaceLayout)) {
    const collectIds = (node) => {
      if (!node) return;
      if (node.type === "leaf" && node.sessionId != null) neededIds.add(node.sessionId);
      if (node.children) node.children.forEach(collectIds);
    };
    for (const ws of _workspaceLayout) { if (ws.rootNode) collectIds(ws.rootNode); }
  }

  let toRestore;
  if (neededIds.size > 0) {
    // Restore only sessions referenced in workspace layout
    toRestore = savedState.sessions.filter(s => neededIds.has(s.id));
  } else {
    // No layout saved — restore only the most recent session
    const sorted = [...savedState.sessions].sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
    toRestore = sorted.slice(0, 1);
  }

  console.log(`[agenv] Restoring ${toRestore.length} of ${savedState.sessions.length} saved sessions`);
  for (const s of toRestore) {
    const cwdOk = s.cwd && fs.existsSync(s.cwd);
    const id = s.id != null ? s.id : nextSessionId;
    if (id >= nextSessionId) nextSessionId = id + 1;
    spawnSession(id, {
      cwd: cwdOk ? s.cwd : process.cwd(),
      name: s.name || "", tool: s.tool || "terminal", lastCommand: s.lastCommand || "",
      launchCommand: s.launchCommand || "", userNamed: s.userNamed || false,
      created: s.created, lastActivity: s.lastActivity, restoreScrollback: true,
    });
  }
} else {
  for (let i = 0; i < INITIAL_SESSIONS; i++) spawnSession(nextSessionId++, { restoreScrollback: false });
}
saveState();

// ---------------------------------------------------------------------------
// Startup banner
// ---------------------------------------------------------------------------
const ACCESS_URL = useCredentials ? `http://${HOST}:${PORT}/` : `http://${HOST}:${PORT}/?token=${TOKEN}`;

function printBanner() {
  // Compute width based on longest content line
  const urlLine = `URL:      ${ACCESS_URL}`;
  const cmdLine = RUN_COMMAND ? `Command:  ${RUN_COMMAND}` : "";
  const contentWidth = Math.max(urlLine.length, cmdLine.length, 40) + 4;
  const w = Math.min(Math.max(contentWidth, process.stdout.columns || 60), 100);
  const line = "─".repeat(w);
  const pad = (s) => { const p = w - 2 - s.length; return "│ " + s + " ".repeat(Math.max(0, p)) + "│"; };

  console.log("");
  console.log(`┌${line}┐`);
  console.log(pad(`Agenv v${PKG_VERSION}`));
  console.log(`├${line}┤`);
  if (RUN_COMMAND) {
    console.log(pad(`Command:  ${RUN_COMMAND}`));
    console.log(pad(`Folder:   ${process.cwd()}`));
  } else {
    const ct = sessions.size;
    console.log(pad(`Sessions: ${ct} (${savedState && savedState.sessions ? "restored" : "new"})`));
    console.log(pad(`Shell:    ${SHELL}`));
  }
  console.log(pad(`URL:      ${ACCESS_URL}`));
  console.log(pad(""));
  console.log(pad("Scan QR or open URL on any device."));
  console.log(pad("Tip: ngrok tunneling is supported in web mode (--web)."));
  console.log(pad("Press Ctrl+C twice to exit."));
  console.log(`└${line}┘`);

  // QR code
  if (SHOW_QR && qrcodeTerminal) {
    console.log("");
    qrcodeTerminal.generate(ACCESS_URL, { small: true }, (qr) => {
      if (qr) console.log(qr);
    });
  }
}
printBanner();

// Auto-open browser
if (AUTO_OPEN) {
  try {
    const openCmd = isWindows ? `start ""  "${ACCESS_URL}"` : (os.platform() === "darwin" ? `open "${ACCESS_URL}"` : `xdg-open "${ACCESS_URL}"`);
    execSync(openCmd, { stdio: "ignore", timeout: 5000 });
  } catch {}
}

// Periodic save (every 30 seconds)
const periodicSaveInterval = setInterval(() => { saveState(); saveAllScrollback(); }, 30000);

// ---------------------------------------------------------------------------
// Forward local stdin -> session 0 PTY
// ---------------------------------------------------------------------------
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (data) => { const s = sessions.get(0); if (s) s.pty.write(data); });
process.stdout.on("resize", () => {
  const c = process.stdout.columns, r = process.stdout.rows, s = sessions.get(0);
  if (!s) return;
  s.pty.resize(c, r);
  for (const ws of s.clients) { if (ws.readyState === 1) ws.send(JSON.stringify({ type: "resize", cols: c, rows: r })); }
});

// ---------------------------------------------------------------------------
// Express + HTTP server
// ---------------------------------------------------------------------------
const app = express();
const server = http.createServer(app);
app.use(express.json({ limit: "50mb" }));

// Security headers
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net; connect-src 'self' ws: wss:; img-src 'self' data: blob:; worker-src 'self' blob:");
  next();
});

// API rate limiter — 600 req/min per IP
const _rateBuckets = new Map();
function apiRateLimit(req, res, next) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";
  const now = Date.now();
  let bucket = _rateBuckets.get(ip);
  if (!bucket || now - bucket.windowStart > 60000) {
    bucket = { count: 0, windowStart: now };
    _rateBuckets.set(ip, bucket);
  }
  bucket.count++;
  if (bucket.count > 600) {
    return res.status(429).json({ error: "Rate limit exceeded. Try again later." });
  }
  next();
}
// Clean up stale buckets every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 120000;
  for (const [ip, b] of _rateBuckets) {
    if (b.windowStart < cutoff) _rateBuckets.delete(ip);
  }
}, 300000);
app.use("/api", apiRateLimit);

app.use("/public", express.static(path.join(__dirname, "public")));

function isNgrokRequest(req) {
  // ngrok sets x-forwarded-for and ngrok-specific headers
  return !!(req.headers["x-forwarded-for"] || req.headers["ngrok-skip-browser-warning"]);
}

function getClientIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "";
}

function apiAuth(req, res, next) {
  if (!isAuthenticated(req)) return res.status(401).json({ error: "Unauthorized" });

  // ngrok IP allowlist check
  if (isNgrokRequest(req) && ngrokSettings.allowedIps.length > 0) {
    const clientIp = getClientIp(req);
    if (!ngrokSettings.allowedIps.includes(clientIp)) {
      return res.status(403).json({ error: "IP not in allowlist: " + clientIp });
    }
  }

  // ngrok read-only mode: block write operations
  if (isNgrokRequest(req) && ngrokSettings.readOnly) {
    const method = req.method.toUpperCase();
    const writePaths = ["/api/sessions", "/api/git/stage", "/api/git/commit", "/api/git/push",
      "/api/git/checkout", "/api/git/unstage", "/api/git/discard", "/api/git/stash",
      "/api/git/stash-pop", "/api/git/worktree-add",
      "/api/file", "/api/upload", "/api/clip", "/api/shutdown", "/api/quick-launch"];
    if ((method === "POST" || method === "PUT" || method === "DELETE") &&
        writePaths.some(p => req.path.startsWith(p))) {
      return res.status(403).json({ error: "Read-only mode: write operations disabled via tunnel" });
    }
  }
  next();
}

// ---- Session APIs ----
app.get("/api/sessions", apiAuth, (req, res) => {
  const list = [];
  for (const [id, session] of sessions) {
    list.push({
      id, name: session.name || "", cwd: session.cwd, tool: session.detectedTool || "terminal",
      lastCommand: session.lastCommand || "", launchCommand: session.launchCommand || "",
      created: session.created, lastActivity: session.lastActivity, clients: session.clients.size,
      status: session.status || "idle", group: session.group || "",
      note: session.note || "", analytics: session.analytics || {},
    });
  }
  res.json(list);
});

app.post("/api/sessions", apiAuth, (req, res) => {
  if (sessions.size >= MAX_SESSIONS) return res.status(400).json({ error: "Maximum sessions reached (" + MAX_SESSIONS + ")" });
  const id = nextSessionId++;
  const b = req.body || {};
  spawnSession(id, { cwd: b.cwd, name: b.name || "", group: b.group || "", runCommand: b.command || null, restoreScrollback: false });
  saveState();
  const s = sessions.get(id);
  console.log(`[agenv] Session ${id} created from browser in ${s.cwd} (${sessions.size} total)`);
  res.json({ id, name: s.name, cwd: s.cwd, tool: s.detectedTool, created: s.created, status: s.status, group: s.group });
});

app.put("/api/sessions/:id", apiAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const session = sessions.get(id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (req.body.name != null) { session.name = String(req.body.name).slice(0, 64); session.userNamed = true; }
  if (req.body.tool) { session.detectedTool = String(req.body.tool); session.lastCommand = req.body.lastCommand || session.lastCommand; }
  if (req.body.note != null) session.note = String(req.body.note).slice(0, 2000);
  if (req.body.group != null) session.group = String(req.body.group).slice(0, 64);
  saveState();
  res.json({ ok: true });
});

app.delete("/api/sessions/:id", apiAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const session = sessions.get(id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  try { session.pty.kill(); } catch {} // safe even if already exited
  // Notify all connected clients
  for (const ws of session.clients) {
    try { ws.send(JSON.stringify({ type: "exit", code: -1 })); } catch {}
  }
  sessions.delete(id);
  console.log(`[agenv] Session ${id} closed from browser`);
  res.json({ ok: true });
});

app.post("/api/sessions/:id/restart", apiAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const session = sessions.get(id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  // Kill the old PTY
  try { session.pty.kill(); } catch {}
  // Create a new PTY with the same settings
  const cwd = session.cwd || process.cwd();
  const shell = session.launchCommand || SHELL;
  try {
    const newPty = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols: session.pty.cols || 80,
      rows: session.pty.rows || 24,
      cwd,
      env: { ...process.env, TERM: "xterm-256color" },
    });
    // Replace the PTY
    session.pty = newPty;
    session.status = "idle";
    session.scrollback = Buffer.alloc(0);
    session.lastActivity = Date.now();
    // Re-wire PTY output to clients
    newPty.onData((data) => {
      // Update scrollback
      const buf = Buffer.from(data, "utf8");
      session.scrollback = Buffer.concat([session.scrollback, buf]);
      if (session.scrollback.length > 100 * 1024) {
        session.scrollback = session.scrollback.slice(-80 * 1024);
      }
      session.lastActivity = Date.now();
      // Broadcast to clients
      const msg = JSON.stringify({ type: "output", data });
      for (const ws of session.clients) {
        try { if (ws.readyState === 1) ws.send(msg); } catch {}
      }
    });
    newPty.onExit(({ exitCode }) => {
      session.status = "exited";
      const msg = JSON.stringify({ type: "exit", code: exitCode });
      for (const ws of session.clients) {
        try { if (ws.readyState === 1) ws.send(msg); } catch {}
      }
    });
    // Clear scrollback on clients so they see a fresh terminal
    const clearMsg = JSON.stringify({ type: "output", data: "\x1b[2J\x1b[H" });
    for (const ws of session.clients) {
      try { if (ws.readyState === 1) ws.send(clearMsg); } catch {}
    }
    console.log(`[agenv] Session ${id} restarted`);
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: "Failed to restart: " + e.message });
  }
});

// Get real CWD for a session by probing the PTY process
app.get("/api/sessions/:id/cwd", apiAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const session = sessions.get(id);
  if (!session) return res.status(404).json({ error: "Session not found" });

  // Try to get the real CWD from the PTY child process
  const winShell = (process.env.SystemRoot || "C:\\Windows") + "\\System32\\cmd.exe";
  if (session.pty && session.pty.pid) {
    try {
      const { spawnSync } = require("child_process");
      if (process.platform === "win32") {
        // Use wmic or PowerShell to get process CWD — but that's unreliable
        // Instead, use the tracked CWD which is updated from prompt detection
      } else {
        // On Linux/Mac, read /proc/PID/cwd
        const r = spawnSync("readlink", ["-f", `/proc/${session.pty.pid}/cwd`], { encoding: "utf8", timeout: 2000 });
        if (r.stdout && r.stdout.trim()) {
          const cwd = r.stdout.trim();
          if (cwd !== session.cwd) {
            session.cwd = cwd;
            const cwdMsg = JSON.stringify({ type: "cwd", cwd });
            for (const ws of session.clients) { if (ws.readyState === 1) ws.send(cwdMsg); }
          }
        }
      }
    } catch {}
  }
  res.json({ cwd: session.cwd, sessionId: id });
});

// ---- Workspace layout persistence ----
app.get("/api/workspace-layout", apiAuth, (req, res) => {
  res.json({ layout: _workspaceLayout || null });
});

app.post("/api/workspace-layout", apiAuth, (req, res) => {
  _workspaceLayout = req.body.layout || null;
  saveState();
  res.json({ ok: true });
});

// ---- History & suggestions APIs ----
app.get("/api/history", apiAuth, (req, res) => res.json(loadHistory()));

app.post("/api/history", apiAuth, (req, res) => {
  const { command, sessionId } = req.body;
  if (!command || typeof command !== "string") return res.status(400).json({ error: "Invalid" });
  const trimmed = command.trim();
  if (!trimmed) return res.json({ ok: true });
  const history = loadHistory();
  if (history.length === 0 || history[history.length - 1] !== trimmed) history.push(trimmed);
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  saveHistory(history);
  // Update session tool detection
  if (sessionId != null) {
    const s = sessions.get(parseInt(sessionId, 10));
    if (s) {
      s.lastCommand = trimmed;
      const t = detectTool(trimmed);
      if (t) {
        s.detectedTool = t;
        if (!s.name) s.name = t;
        if (!s.launchCommand) s.launchCommand = trimmed;
      }
      // Detect cd commands and update cwd (essential on Windows where OSC7 is absent)
      const cdMatch = trimmed.match(/^cd\s+(.+)/i);
      if (cdMatch) {
        const target = cdMatch[1].replace(/^["']|["']$/g, "").trim();
        if (target) {
          try {
            const resolved = path.resolve(s.cwd, target);
            if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
              s.cwd = resolved;
              // Auto-rename plain terminal sessions to folder name
              if (!s.userNamed && s.detectedTool === "terminal") {
                s.name = path.basename(resolved);
              }
              const cwdMsg = JSON.stringify({ type: "cwd", cwd: s.cwd });
              for (const ws of s.clients) { if (ws.readyState === 1) ws.send(cwdMsg); }
            }
          } catch {}
        }
      }
      saveState();
    }
  }
  res.json({ ok: true });
});

// ---- Archive API ----
app.get("/api/archive", apiAuth, (req, res) => res.json(loadArchive()));

// ---- Favorites API ----
app.get("/api/favorites", apiAuth, (req, res) => res.json(loadFavorites()));

app.post("/api/favorites", apiAuth, (req, res) => {
  const b = req.body || {};
  if (!b.cwd && !b.command) return res.status(400).json({ error: "Need cwd or command" });
  const favs = loadFavorites();
  // Prevent duplicates
  const dup = favs.find(f => f.cwd === (b.cwd || "") && f.command === (b.command || ""));
  if (dup) return res.json({ ok: true, msg: "Already saved" });
  favs.push({
    name: b.name || "",
    cwd: b.cwd || "",
    command: b.command || "",
    tool: b.tool || "terminal",
    created: Date.now(),
  });
  saveFavorites(favs);
  res.json({ ok: true });
});

app.delete("/api/favorites/:index", apiAuth, (req, res) => {
  const idx = parseInt(req.params.index, 10);
  const favs = loadFavorites();
  if (idx < 0 || idx >= favs.length) return res.status(404).json({ error: "Not found" });
  favs.splice(idx, 1);
  saveFavorites(favs);
  res.json({ ok: true });
});

// ---- Quick-launch API ----
app.post("/api/quick-launch", apiAuth, (req, res) => {
  if (sessions.size >= MAX_SESSIONS) return res.status(400).json({ error: "Max sessions reached" });
  const b = req.body || {};
  const cwd = b.cwd || process.cwd();
  const cmd = b.command || "";
  const name = b.name || "";
  const id = nextSessionId++;
  spawnSession(id, { cwd, name, runCommand: cmd, restoreScrollback: false });
  saveState();
  const s = sessions.get(id);
  res.json({ id, name: s.name, cwd: s.cwd, tool: s.detectedTool, created: s.created });
});

// ---- Recent folders API ----
app.get("/api/recent-folders", apiAuth, (req, res) => {
  const folders = new Map(); // cwd -> lastActivity
  // From active sessions
  for (const s of sessions.values()) {
    if (s.cwd) folders.set(s.cwd, Math.max(folders.get(s.cwd) || 0, s.lastActivity));
  }
  // From archive
  for (const a of loadArchive()) {
    if (a.cwd) folders.set(a.cwd, Math.max(folders.get(a.cwd) || 0, a.lastActivity || a.closed));
  }
  const list = [...folders.entries()]
    .map(([cwd, ts]) => ({ cwd, lastActivity: ts }))
    .filter(f => { try { return fs.existsSync(f.cwd); } catch { return false; } })
    .sort((a, b) => b.lastActivity - a.lastActivity)
    .slice(0, 20);
  res.json(list);
});

// ---- Git API ----
// Discover git repos in/around a directory (supports monorepos)
app.get("/api/git/repos", apiAuth, (req, res) => {
  const dir = req.query.dir || process.cwd();
  const repos = [];
  const { spawnSync } = require("child_process");
  const winShell = (process.env.SystemRoot || "C:\\Windows") + "\\System32\\cmd.exe";

  // Check if dir itself is inside a git repo
  const topLevel = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: dir, encoding: "utf8", timeout: 5000,
    shell: process.platform === "win32" ? winShell : true,
  });
  if (topLevel.status === 0 && topLevel.stdout.trim()) {
    repos.push({ path: path.resolve(topLevel.stdout.trim()), name: path.basename(topLevel.stdout.trim()), relation: "current" });
  }

  // Scan immediate subdirectories for .git folders (monorepo detection)
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const subDir = path.join(dir, entry.name);
      try {
        const gitDir = path.join(subDir, ".git");
        if (fs.existsSync(gitDir)) {
          // It's a git repo (or worktree — .git can be a file pointing to worktree)
          const repoPath = path.resolve(subDir);
          if (!repos.find(r => r.path === repoPath)) {
            repos.push({ path: repoPath, name: entry.name, relation: "child" });
          }
        }
      } catch {}
    }
  } catch {}

  // Also check for git worktrees (linked worktrees point to main repo)
  if (repos.length > 0 && repos[0].relation === "current") {
    try {
      const wt = spawnSync("git", ["worktree", "list", "--porcelain"], {
        cwd: repos[0].path, encoding: "utf8", timeout: 5000,
        shell: process.platform === "win32" ? winShell : true,
      });
      if (wt.status === 0 && wt.stdout) {
        const lines = wt.stdout.split("\n");
        for (const line of lines) {
          if (line.startsWith("worktree ")) {
            const wtPath = line.slice(9).trim();
            if (wtPath && !repos.find(r => r.path === path.resolve(wtPath))) {
              repos.push({ path: path.resolve(wtPath), name: path.basename(wtPath), relation: "worktree" });
            }
          }
        }
      }
    } catch {}
  }

  res.json({ repos, dir });
});

app.get("/api/git/diff-file", apiAuth, (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: "Missing path" });
  const cwd = req.query.cwd || process.cwd();
  const winShell = (process.env.SystemRoot || "C:\\Windows") + "\\System32\\cmd.exe";
  try {
    const { spawnSync } = require("child_process");
    const r = spawnSync("git", ["diff", "--", filePath], {
      cwd, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024,
      shell: process.platform === "win32" ? winShell : true,
    });
    const out = (r.stdout || "").trim();
    if (!out) {
      const r2 = spawnSync("git", ["diff", "HEAD", "--", filePath], {
        cwd, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024,
        shell: process.platform === "win32" ? winShell : true,
      });
      const out2 = (r2.stdout || "").trim();
      if (!out2) return res.json({ ok: true, diff: "", message: "No changes" });
      return res.json({ ok: true, diff: out2 });
    }
    res.json({ ok: true, diff: out });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Combined diff endpoint for AI features — returns staged diff, full diff, and recent commits
app.get("/api/git/diff-for-ai", apiAuth, (req, res) => {
  const dir = req.query.dir || process.cwd();
  const winShell = (process.env.SystemRoot || "C:\\Windows") + "\\System32\\cmd.exe";
  const { spawnSync } = require("child_process");
  const opts = { cwd: dir, encoding: "utf8", timeout: 10000, maxBuffer: 2 * 1024 * 1024, shell: isWindows ? winShell : true };

  let diff = "", stagedDiff = "", recentCommits = "";
  try { diff = (spawnSync("git", ["diff"], opts).stdout || "").trim(); } catch {}
  try { stagedDiff = (spawnSync("git", ["diff", "--cached"], opts).stdout || "").trim(); } catch {}
  try { recentCommits = (spawnSync("git", ["log", "--oneline", "-10"], opts).stdout || "").trim(); } catch {}

  res.json({ diff, stagedDiff, recentCommits });
});

app.get("/api/git/:action", apiAuth, (req, res) => {
  const sid = parseInt(req.query.session || "0", 10);
  const session = sessions.get(sid);
  const cwd = req.query.dir || (session ? session.cwd : process.cwd());
  const action = req.params.action;
  const cmds = {
    status: ["git", "status", "--porcelain"],
    diff: ["git", "diff"],
    "diff-staged": ["git", "diff", "--staged"],
    log: ["git", "log", "--oneline", "-20"],
    branch: ["git", "branch", "-a"],
    stash: ["git", "stash", "list"],
  };
  const args = cmds[action];
  if (!args) return res.status(400).json({ error: "Unknown action" });
  try {
    const { spawnSync } = require("child_process");
    const winShell = (process.env.SystemRoot || "C:\\Windows") + "\\System32\\cmd.exe";
    const r = spawnSync(args[0], args.slice(1), { cwd, encoding: "utf8", timeout: 10000, maxBuffer: 512 * 1024, shell: process.platform === "win32" ? winShell : true });
    const out = (r.stdout || "") + (r.stderr || "");
    res.json({ ok: r.status === 0, output: out.trim(), cwd });
  } catch (e) {
    res.json({ ok: false, output: e.message || "Error", cwd });
  }
});

// ---- Git commit/push APIs ----
app.post("/api/git/stage", apiAuth, (req, res) => {
  const { dir, files } = req.body;
  const cwd = dir || process.cwd();
  const { spawnSync } = require("child_process");
  const winShell = (process.env.SystemRoot || "C:\\Windows") + "\\System32\\cmd.exe";
  // files can be array of paths, or "." for all
  const args = ["git", "add", ...(Array.isArray(files) ? files : ["."])];
  try {
    const r = spawnSync(args[0], args.slice(1), { cwd, encoding: "utf8", timeout: 10000, shell: process.platform === "win32" ? winShell : true });
    res.json({ ok: r.status === 0, output: ((r.stdout || "") + (r.stderr || "")).trim() });
  } catch (e) {
    res.json({ ok: false, output: e.message });
  }
});

app.post("/api/git/commit", apiAuth, (req, res) => {
  const { dir, message } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ ok: false, output: "Commit message required" });
  const cwd = dir || process.cwd();
  const { spawnSync } = require("child_process");
  const winShell = (process.env.SystemRoot || "C:\\Windows") + "\\System32\\cmd.exe";
  try {
    const r = spawnSync("git", ["commit", "-m", message.trim()], {
      cwd, encoding: "utf8", timeout: 30000, maxBuffer: 512 * 1024,
      shell: process.platform === "win32" ? winShell : true,
    });
    const out = ((r.stdout || "") + (r.stderr || "")).trim();
    res.json({ ok: r.status === 0, output: out });
  } catch (e) {
    res.json({ ok: false, output: e.message });
  }
});

app.post("/api/git/push", apiAuth, (req, res) => {
  const { dir, remote, branch } = req.body;
  const cwd = dir || process.cwd();
  const { spawnSync } = require("child_process");
  const winShell = (process.env.SystemRoot || "C:\\Windows") + "\\System32\\cmd.exe";
  const args = ["git", "push"];
  if (remote) args.push(remote);
  if (branch) args.push(branch);
  try {
    const r = spawnSync(args[0], args.slice(1), {
      cwd, encoding: "utf8", timeout: 60000, maxBuffer: 512 * 1024,
      shell: process.platform === "win32" ? winShell : true,
    });
    const out = ((r.stdout || "") + (r.stderr || "")).trim();
    res.json({ ok: r.status === 0, output: out });
  } catch (e) {
    res.json({ ok: false, output: e.message });
  }
});

app.post("/api/git/checkout", apiAuth, (req, res) => {
  const { dir, branch } = req.body;
  if (!branch || !branch.trim()) return res.status(400).json({ ok: false, output: "Branch name required" });
  const cwd = dir || process.cwd();
  const { spawnSync } = require("child_process");
  const winShell = (process.env.SystemRoot || "C:\\Windows") + "\\System32\\cmd.exe";
  // Strip "remotes/origin/" prefix if present (for checking out remote branches)
  let target = branch.trim();
  if (target.startsWith("remotes/")) target = target.replace(/^remotes\/[^/]+\//, "");
  try {
    const r = spawnSync("git", ["checkout", target], {
      cwd, encoding: "utf8", timeout: 30000, maxBuffer: 512 * 1024,
      shell: process.platform === "win32" ? winShell : true,
    });
    const out = ((r.stdout || "") + (r.stderr || "")).trim();
    res.json({ ok: r.status === 0, output: out });
  } catch (e) {
    res.json({ ok: false, output: e.message });
  }
});

app.post("/api/git/unstage", apiAuth, (req, res) => {
  const { dir, files } = req.body;
  const cwd = dir || process.cwd();
  const { spawnSync } = require("child_process");
  const winShell = (process.env.SystemRoot || "C:\\Windows") + "\\System32\\cmd.exe";
  const args = ["git", "reset", "HEAD", ...(Array.isArray(files) ? files : ["."])];
  try {
    const r = spawnSync(args[0], args.slice(1), { cwd, encoding: "utf8", timeout: 10000, shell: process.platform === "win32" ? winShell : true });
    res.json({ ok: r.status === 0, output: ((r.stdout || "") + (r.stderr || "")).trim() });
  } catch (e) {
    res.json({ ok: false, output: e.message });
  }
});

app.post("/api/git/discard", apiAuth, (req, res) => {
  const { dir, files } = req.body;
  if (!files || !Array.isArray(files) || files.length === 0) return res.status(400).json({ ok: false, output: "Files required" });
  const cwd = dir || process.cwd();
  const { spawnSync } = require("child_process");
  const winShell = (process.env.SystemRoot || "C:\\Windows") + "\\System32\\cmd.exe";
  try {
    const r = spawnSync("git", ["checkout", "--", ...files], {
      cwd, encoding: "utf8", timeout: 10000, shell: process.platform === "win32" ? winShell : true,
    });
    res.json({ ok: r.status === 0, output: ((r.stdout || "") + (r.stderr || "")).trim() });
  } catch (e) {
    res.json({ ok: false, output: e.message });
  }
});

app.post("/api/git/stash", apiAuth, (req, res) => {
  const { dir, message } = req.body;
  const cwd = dir || process.cwd();
  const { spawnSync } = require("child_process");
  const winShell = (process.env.SystemRoot || "C:\\Windows") + "\\System32\\cmd.exe";
  const args = ["git", "stash", "push"];
  if (message && message.trim()) args.push("-m", message.trim());
  args.push("--include-untracked");
  try {
    const r = spawnSync(args[0], args.slice(1), {
      cwd, encoding: "utf8", timeout: 30000, maxBuffer: 512 * 1024,
      shell: process.platform === "win32" ? winShell : true,
    });
    const out = ((r.stdout || "") + (r.stderr || "")).trim();
    res.json({ ok: r.status === 0, output: out });
  } catch (e) {
    res.json({ ok: false, output: e.message });
  }
});

app.post("/api/git/stash-pop", apiAuth, (req, res) => {
  const { dir } = req.body;
  const cwd = dir || process.cwd();
  const { spawnSync } = require("child_process");
  const winShell = (process.env.SystemRoot || "C:\\Windows") + "\\System32\\cmd.exe";
  try {
    const r = spawnSync("git", ["stash", "pop"], {
      cwd, encoding: "utf8", timeout: 30000, maxBuffer: 512 * 1024,
      shell: process.platform === "win32" ? winShell : true,
    });
    const out = ((r.stdout || "") + (r.stderr || "")).trim();
    res.json({ ok: r.status === 0, output: out });
  } catch (e) {
    res.json({ ok: false, output: e.message });
  }
});

app.post("/api/git/worktree-add", apiAuth, (req, res) => {
  const { dir, branch } = req.body;
  if (!branch || !branch.trim()) return res.status(400).json({ ok: false, error: "Branch name required" });
  const cwd = dir || process.cwd();
  const { spawnSync } = require("child_process");
  const winShell = (process.env.SystemRoot || "C:\\Windows") + "\\System32\\cmd.exe";
  const branchName = branch.trim().replace(/[^a-zA-Z0-9_\-/.]/g, "");
  const wtPath = path.join(cwd, "..", path.basename(cwd) + "-" + branchName.replace(/\//g, "-"));
  try {
    const r = spawnSync("git", ["worktree", "add", "-b", branchName, wtPath], {
      cwd, encoding: "utf8", timeout: 30000, maxBuffer: 512 * 1024,
      shell: process.platform === "win32" ? winShell : true,
    });
    const out = ((r.stdout || "") + (r.stderr || "")).trim();
    if (r.status === 0) {
      res.json({ ok: true, output: out, path: wtPath, branch: branchName });
    } else {
      res.json({ ok: false, output: out });
    }
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ---- File explorer APIs ----
app.get("/api/files", apiAuth, (req, res) => {
  const dir = req.query.dir || process.cwd();
  const resolved = path.resolve(dir);
  try {
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const items = [];
    for (const e of entries) {
      if (e.name.startsWith(".") && !req.query.hidden) continue;
      const full = path.join(resolved, e.name);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      items.push({
        name: e.name,
        path: full,
        isDir: e.isDirectory(),
        size: e.isDirectory() ? 0 : stat.size,
        mtime: stat.mtimeMs,
      });
    }
    items.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    res.json({ dir: resolved, parent: path.dirname(resolved), items });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/file", apiAuth, (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: "Missing path" });
  const resolved = path.resolve(filePath);
  try {
    const stat = fs.statSync(resolved);
    if (stat.size > 2 * 1024 * 1024) return res.status(400).json({ error: "File too large (>2MB)" });
    const content = fs.readFileSync(resolved, "utf8");
    res.json({ path: resolved, name: path.basename(resolved), content, size: stat.size });
  } catch (e) {
    if (e.code === "ENOENT") {
      return res.status(404).json({ error: "File not found", code: "ENOENT", path: resolved });
    }
    res.status(400).json({ error: e.message });
  }
});

// ---- File save API ----
app.put("/api/file", apiAuth, (req, res) => {
  const filePath = req.body.path;
  const content = req.body.content;
  if (!filePath) return res.status(400).json({ error: "Missing path" });
  if (content == null) return res.status(400).json({ error: "Missing content" });
  const resolved = path.resolve(filePath);
  // Safety: don't write outside of known directories
  try {
    fs.writeFileSync(resolved, content, "utf8");
    const stat = fs.statSync(resolved);
    res.json({ ok: true, path: resolved, size: stat.size });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- Search APIs ----
function fuzzyMatch(query, text) {
  let qi = 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

const SEARCH_SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", ".next", "target", ".cache", "coverage"]);
const SEARCH_TEXT_EXTS = new Set(["js","ts","jsx","tsx","py","go","rs","rb","java","c","h","cpp","cc","cxx","hpp","cs","swift","kt","php","sh","bash","zsh","ps1","json","yaml","yml","toml","xml","html","htm","css","scss","less","sql","md","txt","dockerfile","makefile","r","lua","perl","pl","zig","dart","env","ini","cfg","conf","gitignore","lock","csv","svg","mjs","cjs","psm1"]);

app.get("/api/search/files", apiAuth, (req, res) => {
  const dir = req.query.dir || process.cwd();
  const query = (req.query.q || "").trim();
  const maxResults = Math.min(parseInt(req.query.limit || "100", 10), 500);
  const resolved = path.resolve(dir);
  const results = [];

  function walk(d, depth) {
    if (depth > 10 || results.length >= maxResults) return;
    try {
      const entries = fs.readdirSync(d, { withFileTypes: true });
      for (const e of entries) {
        if (results.length >= maxResults) return;
        if (e.name.startsWith(".") && e.name !== ".env" && e.name !== ".gitignore") continue;
        if (SEARCH_SKIP_DIRS.has(e.name)) continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          walk(full, depth + 1);
        } else {
          const rel = path.relative(resolved, full).replace(/\\/g, "/");
          if (!query || rel.toLowerCase().includes(query.toLowerCase()) || fuzzyMatch(query, rel)) {
            results.push({ path: full, relative: rel, name: e.name });
          }
        }
      }
    } catch {}
  }

  walk(resolved, 0);

  // Sort: exact name matches first, then substring matches, then fuzzy by length
  if (query) {
    const ql = query.toLowerCase();
    results.sort((a, b) => {
      const aName = a.name.toLowerCase().includes(ql) ? 0 : 1;
      const bName = b.name.toLowerCase().includes(ql) ? 0 : 1;
      if (aName !== bName) return aName - bName;
      const aRel = a.relative.toLowerCase().includes(ql) ? 0 : 1;
      const bRel = b.relative.toLowerCase().includes(ql) ? 0 : 1;
      if (aRel !== bRel) return aRel - bRel;
      return a.relative.length - b.relative.length;
    });
  }

  res.json({ results: results.slice(0, maxResults), dir: resolved });
});

app.get("/api/search/text", apiAuth, (req, res) => {
  const dir = req.query.dir || process.cwd();
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: "Missing query" });
  const maxResults = Math.min(parseInt(req.query.limit || "100", 10), 200);
  const resolved = path.resolve(dir);
  const results = [];
  const ql = query.toLowerCase();

  function walk(d, depth) {
    if (depth > 8 || results.length >= maxResults) return;
    try {
      const entries = fs.readdirSync(d, { withFileTypes: true });
      for (const e of entries) {
        if (results.length >= maxResults) return;
        if (e.name.startsWith(".") && e.name !== ".env" && e.name !== ".gitignore") continue;
        if (SEARCH_SKIP_DIRS.has(e.name)) continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          walk(full, depth + 1);
        } else {
          const ext = e.name.split(".").pop().toLowerCase();
          const baseName = e.name.toLowerCase();
          if (!SEARCH_TEXT_EXTS.has(ext) && !baseName.match(/^(dockerfile|makefile|readme|license|changelog)$/)) continue;
          try {
            const stat = fs.statSync(full);
            if (stat.size > 512 * 1024 || stat.size === 0) continue;
          } catch { continue; }
          try {
            const content = fs.readFileSync(full, "utf8");
            const lines = content.split("\n");
            for (let i = 0; i < lines.length && results.length < maxResults; i++) {
              if (lines[i].toLowerCase().includes(ql)) {
                results.push({
                  file: path.relative(resolved, full).replace(/\\/g, "/"),
                  fullPath: full,
                  line: i + 1,
                  text: lines[i].substring(0, 200),
                });
              }
            }
          } catch {}
        }
      }
    } catch {}
  }

  walk(resolved, 0);
  res.json({ results, dir: resolved });
});

// ---- File/image upload API (for drag-drop and clipboard paste) ----
const UPLOAD_DIR = path.join(os.tmpdir(), "agenv-uploads");
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch {}

app.post("/api/upload", apiAuth, (req, res) => {
  const { filename, data, type } = req.body;
  if (!data) return res.status(400).json({ error: "Missing data" });

  const ext = filename
    ? path.extname(filename)
    : (type === "image/png" ? ".png" : type === "image/jpeg" ? ".jpg" : type === "image/gif" ? ".gif" : ".bin");
  const baseName = filename
    ? path.basename(filename, path.extname(filename))
    : "upload";
  const safeName = baseName.replace(/[^a-zA-Z0-9._-]/g, "_") + "-" + Date.now() + ext;
  const filePath = path.join(UPLOAD_DIR, safeName);

  try {
    const buf = Buffer.from(data, "base64");
    if (buf.length > 50 * 1024 * 1024) return res.status(400).json({ error: "File too large (>50MB)" });
    fs.writeFileSync(filePath, buf);
    res.json({ ok: true, path: filePath, name: safeName, size: buf.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Smart Paste / Clip API ----
// Saves clipboard content to a file in the session's CWD and returns the path.
// This lets LLMs read the content from a file path instead of inline paste.
app.post("/api/clip", apiAuth, (req, res) => {
  const { sessionId, content, contentBase64, mimeType, filename } = req.body;
  if (!content && !contentBase64) return res.status(400).json({ error: "Missing content" });

  // Determine save directory — session CWD if available, else UPLOAD_DIR
  let saveDir = UPLOAD_DIR;
  if (sessionId) {
    const session = sessions.get(Number(sessionId));
    if (session && session.cwd) {
      saveDir = path.join(session.cwd, ".clips");
    }
  }
  try { fs.mkdirSync(saveDir, { recursive: true }); } catch {}

  // Determine extension and name
  let ext = ".txt";
  if (filename) {
    ext = path.extname(filename) || ext;
  } else if (mimeType) {
    if (mimeType.startsWith("image/png")) ext = ".png";
    else if (mimeType.startsWith("image/jpeg")) ext = ".jpg";
    else if (mimeType.startsWith("image/gif")) ext = ".gif";
    else if (mimeType.startsWith("image/webp")) ext = ".webp";
    else if (mimeType.startsWith("image/svg")) ext = ".svg";
    else if (mimeType === "text/html") ext = ".html";
    else if (mimeType === "text/csv") ext = ".csv";
    else if (mimeType === "application/json") ext = ".json";
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const baseName = filename ? path.basename(filename, path.extname(filename)).replace(/[^a-zA-Z0-9._-]/g, "_") : "clip";
  const safeName = `${baseName}-${ts}${ext}`;
  const filePath = path.join(saveDir, safeName);

  try {
    if (contentBase64) {
      const buf = Buffer.from(contentBase64, "base64");
      if (buf.length > 50 * 1024 * 1024) return res.status(400).json({ error: "Content too large (>50MB)" });
      fs.writeFileSync(filePath, buf);
      res.json({ ok: true, path: filePath, name: safeName, size: buf.length });
    } else {
      if (content.length > 50 * 1024 * 1024) return res.status(400).json({ error: "Content too large (>50MB)" });
      fs.writeFileSync(filePath, content, "utf8");
      res.json({ ok: true, path: filePath, name: safeName, size: Buffer.byteLength(content, "utf8") });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- System stats API (cached) ----
let _statsCache = null;
let _statsCacheTs = 0;
app.get("/api/stats", apiAuth, (req, res) => {
  const now = Date.now();
  if (!_statsCache || now - _statsCacheTs > 3000) {
    _statsCache = getSystemStats();
    _statsCacheTs = now;
  }
  res.json(_statsCache);
});

// ---- Shutdown API ----
app.post("/api/shutdown", apiAuth, (req, res) => {
  res.json({ ok: true, message: "Server shutting down..." });
  setTimeout(() => gracefulShutdown("Shutdown via API"), 500);
});

// ---- Session analytics API ----
app.get("/api/analytics", apiAuth, (req, res) => {
  const result = { sessions: {}, totals: { inputTokens: 0, outputTokens: 0, estimatedCost: 0, sessionCount: sessions.size } };
  for (const [id, s] of sessions) {
    const a = s.analytics || {};
    result.sessions[id] = {
      name: s.name || "Session " + id, tool: s.detectedTool || "terminal",
      status: s.status, duration: Date.now() - (a.startTime || s.created),
      inputTokens: a.inputTokens || 0, outputTokens: a.outputTokens || 0,
      estimatedCost: a.estimatedCost || 0, turnCount: a.turnCount || 0,
      commandCount: a.commandCount || 0,
    };
    result.totals.inputTokens += a.inputTokens || 0;
    result.totals.outputTokens += a.outputTokens || 0;
    result.totals.estimatedCost += a.estimatedCost || 0;
  }
  res.json(result);
});

// ---- Claude Code Usage API (reads ~/.claude/projects/*.jsonl) ----
// Pricing per 1M tokens, per provider.
// Anthropic API: cache_create = 1.25x input, cache_read = 0.1x input
// AWS Bedrock:   cache_create = 1x input (no markup), cache_read = 0.1x input; Haiku priced higher
// Vertex AI:     same as Anthropic API rates
// Effective pricing for Claude Code with ephemeral caching ($/M tokens)
// Cache writes are FREE (ephemeral 5-min), cache reads ~1% of input rate
const PRICING_TABLES = {
  anthropic: {
    opus:   { input: 15,   output: 40,   cache_create: 0, cache_read: 0.10  },
    sonnet: { input: 3,    output: 8,    cache_create: 0, cache_read: 0.02  },
    haiku:  { input: 0.25, output: 0.65, cache_create: 0, cache_read: 0.002 },
  },
  bedrock: {
    opus:   { input: 15,   output: 40,   cache_create: 0, cache_read: 0.10  },
    sonnet: { input: 3,    output: 8,    cache_create: 0, cache_read: 0.02  },
    haiku:  { input: 0.80, output: 4,    cache_create: 0, cache_read: 0.008 },
  },
  vertex: {
    opus:   { input: 15,   output: 40,   cache_create: 0, cache_read: 0.10  },
    sonnet: { input: 3,    output: 8,    cache_create: 0, cache_read: 0.02  },
    haiku:  { input: 0.25, output: 0.65, cache_create: 0, cache_read: 0.002 },
  },
};

function getModelPricing(modelId, provider) {
  const table = PRICING_TABLES[provider] || PRICING_TABLES.anthropic;
  if (!modelId) return table.sonnet;
  const lower = modelId.toLowerCase();
  if (lower.includes("opus")) return table.opus;
  if (lower.includes("haiku")) return table.haiku;
  return table.sonnet; // default to sonnet
}

/** Detect provider from message ID patterns in JSONL entries */
function detectProvider(msgId) {
  if (!msgId) return null;
  if (msgId.startsWith("msg_bdrk_")) return "bedrock";
  if (msgId.startsWith("msg_vrtx_")) return "vertex";
  return "anthropic";
}

function extractTokens(usage) {
  if (!usage) return null;
  // Handle multiple field name formats
  const input = usage.inputTokens || usage.input_tokens || usage.prompt_tokens || 0;
  const output = usage.outputTokens || usage.output_tokens || usage.completion_tokens || 0;
  const cacheCreate = usage.cacheCreationInputTokens || usage.cache_creation_input_tokens || 0;
  const cacheRead = usage.cacheReadInputTokens || usage.cache_read_input_tokens || 0;
  return { input, output, cacheCreate, cacheRead };
}

const _usageCache = new Map(); // key → { data, ts }
app.get("/api/claude-usage", apiAuth, (req, res) => {
  const providerOverride = req.query.provider || ""; // "anthropic", "bedrock", "vertex", or "" (auto)
  const cacheKey = (req.query.from || "") + "|" + (req.query.to || "") + "|" + providerOverride;
  const cached = _usageCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 30000) return res.json(cached.data);

  const claudeDir = path.join(os.homedir(), ".claude", "projects");
  const fromDate = req.query.from ? new Date(req.query.from) : null;
  const toDate = req.query.to ? new Date(req.query.to) : null;

  const result = {
    models: {},
    totals: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0, messages: 0 },
    daily: {},
    sessions: [],
    providers: {}, // auto-detected: { anthropic: count, bedrock: count, vertex: count }
    firstSeen: null,
    lastSeen: null,
  };

  try {
    if (!fs.existsSync(claudeDir)) {
      return res.json(result);
    }

    // Recursively find all .jsonl files
    const jsonlFiles = [];
    function findJsonl(dir, depth) {
      if (depth > 5) return;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            findJsonl(full, depth + 1);
          } else if (e.name.endsWith(".jsonl")) {
            jsonlFiles.push(full);
          }
        }
      } catch {}
    }
    findJsonl(claudeDir, 0);

    // Parse each JSONL file
    for (const filePath of jsonlFiles) {
      try {
        const content = fs.readFileSync(filePath, "utf8");
        const lines = content.split("\n").filter(l => l.trim());
        let sessionInfo = { file: path.basename(filePath), messages: 0, cost: 0 };

        for (const line of lines) {
          try {
            const entry = JSON.parse(line);

            // Track timestamps
            const ts = entry.timestamp || entry.created_at || entry.ts;
            let entryDate = null;
            if (ts) {
              entryDate = new Date(ts);
              // Apply date filter
              if (fromDate && entryDate < fromDate) continue;
              if (toDate && entryDate >= toDate) continue;
              if (!result.firstSeen || entryDate < result.firstSeen) result.firstSeen = entryDate;
              if (!result.lastSeen || entryDate > result.lastSeen) result.lastSeen = entryDate;
            }

            // Extract usage data — could be at top level or nested in response/message
            let usage = entry.usage || entry.response?.usage || entry.message?.usage;
            let model = entry.model || entry.response?.model || entry.message?.model;

            // Auto-detect provider from message ID
            const msgId = entry.message?.id || entry.response?.id || entry.id || "";
            let entryProvider = null;
            if (msgId) {
              entryProvider = detectProvider(msgId);
              if (entryProvider && usage) {
                result.providers[entryProvider] = (result.providers[entryProvider] || 0) + 1;
              }
            }

            if (usage) {
              const tokens = extractTokens(usage);
              if (tokens) {
                // Use override provider if set, otherwise auto-detected, otherwise anthropic
                const pricingProvider = providerOverride || entryProvider || "anthropic";
                const pricing = getModelPricing(model, pricingProvider);
                const cost =
                  (tokens.input * pricing.input / 1000000) +
                  (tokens.output * pricing.output / 1000000) +
                  (tokens.cacheCreate * pricing.cache_create / 1000000) +
                  (tokens.cacheRead * pricing.cache_read / 1000000);

                // Aggregate per model
                const modelKey = model || "unknown";
                if (!result.models[modelKey]) {
                  result.models[modelKey] = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0, messages: 0 };
                }
                result.models[modelKey].input += tokens.input;
                result.models[modelKey].output += tokens.output;
                result.models[modelKey].cacheCreate += tokens.cacheCreate;
                result.models[modelKey].cacheRead += tokens.cacheRead;
                result.models[modelKey].cost += cost;
                result.models[modelKey].messages += 1;

                // Aggregate totals
                result.totals.input += tokens.input;
                result.totals.output += tokens.output;
                result.totals.cacheCreate += tokens.cacheCreate;
                result.totals.cacheRead += tokens.cacheRead;
                result.totals.cost += cost;
                result.totals.messages += 1;

                // Daily breakdown
                if (entryDate) {
                  const dayKey = entryDate.toISOString().slice(0, 10);
                  if (!result.daily[dayKey]) {
                    result.daily[dayKey] = { input: 0, output: 0, cost: 0, messages: 0 };
                  }
                  result.daily[dayKey].input += tokens.input;
                  result.daily[dayKey].output += tokens.output;
                  result.daily[dayKey].cost += cost;
                  result.daily[dayKey].messages += 1;
                }

                sessionInfo.messages += 1;
                sessionInfo.cost += cost;
              }
            }
          } catch {} // skip malformed lines
        }

        if (sessionInfo.messages > 0) {
          result.sessions.push(sessionInfo);
        }
      } catch {} // skip unreadable files
    }

    // Sort sessions by cost descending
    result.sessions.sort((a, b) => b.cost - a.cost);
    result.sessions = result.sessions.slice(0, 20);

    // Convert dates to ISO strings
    if (result.firstSeen) result.firstSeen = result.firstSeen.toISOString();
    if (result.lastSeen) result.lastSeen = result.lastSeen.toISOString();

    _usageCache.set(cacheKey, { data: result, ts: Date.now() });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- ngrok tunnel API ----
let ngrokProcess = null;
let ngrokUrl = null;
let ngrokSettings = { allowedIps: [], readOnly: false };

app.post("/api/ngrok/start", apiAuth, (req, res) => {
  if (ngrokProcess) {
    return res.json({ ok: true, url: ngrokUrl, pid: ngrokProcess.pid, message: "Already running" });
  }
  const port = req.body.port || PORT;
  const { spawn } = require("child_process");
  try {
    const proc = spawn("ngrok", ["http", String(port)], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });
    ngrokProcess = proc;

    let started = false;
    const timeout = setTimeout(() => {
      if (!started) {
        // Try to get the URL from ngrok's local API
        fetchNgrokUrl().then(url => {
          if (url) {
            ngrokUrl = url;
            res.json({ ok: true, url, pid: proc.pid });
          } else {
            res.json({ ok: false, error: "ngrok started but could not determine tunnel URL. Check ngrok dashboard." });
          }
        }).catch(() => {
          res.json({ ok: false, error: "ngrok started but tunnel URL not available yet. Check http://localhost:4040" });
        });
        started = true;
      }
    }, 3000);

    proc.on("error", (err) => {
      clearTimeout(timeout);
      ngrokProcess = null;
      if (!started) {
        started = true;
        res.json({ ok: false, error: "Failed to start ngrok: " + err.message + ". Is ngrok installed? (npm i -g ngrok or https://ngrok.com/download)" });
      }
    });

    proc.on("exit", (code) => {
      ngrokProcess = null;
      ngrokUrl = null;
    });

  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

async function fetchNgrokUrl() {
  // ngrok exposes a local API at port 4040
  return new Promise((resolve, reject) => {
    const req = http.get("http://127.0.0.1:4040/api/tunnels", (res) => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          const tunnel = (data.tunnels || []).find(t => t.proto === "https") || data.tunnels?.[0];
          resolve(tunnel ? tunnel.public_url : null);
        } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(2000, () => { req.destroy(); resolve(null); });
  });
}

app.post("/api/ngrok/stop", apiAuth, (req, res) => {
  if (ngrokProcess) {
    try { ngrokProcess.kill(); } catch {}
    ngrokProcess = null;
    ngrokUrl = null;
  }
  res.json({ ok: true });
});

app.get("/api/ngrok/status", apiAuth, async (req, res) => {
  if (!ngrokProcess) return res.json({ running: false });
  // Only fetch URL from ngrok API if we don't have it yet
  if (!ngrokUrl) {
    try {
      const url = await fetchNgrokUrl();
      if (url) ngrokUrl = url;
    } catch {}
    if (!ngrokProcess) return res.json({ running: false });
  }
  res.json({ running: true, url: ngrokUrl, pid: ngrokProcess.pid });
});

app.post("/api/ngrok/settings", apiAuth, (req, res) => {
  const { allowedIps, readOnly } = req.body;
  if (Array.isArray(allowedIps)) ngrokSettings.allowedIps = allowedIps.filter(ip => ip && typeof ip === "string");
  if (typeof readOnly === "boolean") ngrokSettings.readOnly = readOnly;
  res.json({ ok: true, settings: ngrokSettings });
});

app.get("/api/ngrok/settings", apiAuth, (req, res) => {
  res.json(ngrokSettings);
});

// ---- Token rotation API ----
app.post("/api/token/rotate", apiAuth, (req, res) => {
  try {
    const newToken = crypto.randomBytes(24).toString("hex");
    TOKEN = newToken;
    const cfg = loadConfig();
    cfg.token = newToken;
    saveConfig(cfg);
    res.json({ ok: true, token: newToken });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ---- Groups API ----
app.get("/api/groups", apiAuth, (req, res) => {
  const groups = new Map();
  for (const s of sessions.values()) {
    const g = s.group || "ungrouped";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s.id);
  }
  res.json(Object.fromEntries(groups));
});

// ---- AI Assistant (rides on user's configured CLI agent) ----
// Spawns the user's agent CLI in one-shot mode to power AI features
// in git, CLAUDE.md manager, prompts, etc. No extra API key needed.
app.post("/api/ai/ask", apiAuth, express.json({ limit: "2mb" }), (req, res) => {
  const { prompt, agent, model, cwd, timeout: userTimeout } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt required" });

  const cli = agent || "claude";
  const mdl = model || "sonnet";
  const timeoutMs = Math.min(userTimeout || 90000, 120000);
  const workDir = cwd || process.cwd();

  // Build command args based on agent type
  let cmd, args;
  if (cli === "claude") {
    cmd = "claude";
    args = ["-p", "--model", mdl, "--output-format", "text"];
  } else if (cli === "gemini") {
    cmd = "gemini";
    args = ["-p"];
  } else if (cli === "codex") {
    cmd = "codex";
    args = ["-p"];
  } else {
    cmd = cli;
    args = ["-p"];
  }

  const start = Date.now();
  const chunks = [];
  const errChunks = [];

  const winShell = (process.env.SystemRoot || "C:\\Windows") + "\\System32\\cmd.exe";
  const child = spawn(cmd, args, {
    cwd: workDir,
    env: { ...process.env },
    shell: isWindows ? winShell : true,
    timeout: timeoutMs,
    windowsHide: true,
  });

  child.stdout.on("data", (d) => chunks.push(d));
  child.stderr.on("data", (d) => errChunks.push(d));

  // Pipe prompt to stdin then close
  child.stdin.write(prompt);
  child.stdin.end();

  const timer = setTimeout(() => {
    try { child.kill(); } catch {}
  }, timeoutMs);

  child.on("close", (code) => {
    clearTimeout(timer);
    const response = Buffer.concat(chunks).toString("utf8").trim();
    const stderr = Buffer.concat(errChunks).toString("utf8").trim();
    const elapsed = Date.now() - start;

    if (code !== 0 && !response) {
      return res.status(500).json({ error: stderr || `Process exited with code ${code}`, elapsed });
    }
    res.json({ response, agent: cli, model: mdl, elapsed });
  });

  child.on("error", (err) => {
    clearTimeout(timer);
    res.status(500).json({ error: `Failed to spawn ${cli}: ${err.message}` });
  });
});

// ---- Claude Session Index (search & reuse past agent conversations) ----
const CLAUDE_HOME = path.join(os.homedir(), ".claude");
const CLAUDE_PROJECTS_DIR = path.join(CLAUDE_HOME, "projects");
const CLAUDE_INDEX_PATH = path.join(CLAUDE_HOME, "agenv-session-index.json");

let claudeIndex = null;
let claudeIndexBuiltAt = 0;

const STOP_WORDS = new Set("the a an is are was were be been being have has had do does did will would could should may might can shall it its i me my we our you your he she they them their this that these those what which who whom where when why how all each every both few more most other some such no not only own same so than too very just because but and or if then else for of to from in on at by with about against between into through during before after above below up down out off over under again further once here there also need want like make use used using get got let please now still well dont file code add change update fix look check think know see new way work thing something anything".split(" "));

function decodeClaudeProjectPath(dirName) {
  // "C--Projects-remotecontrol" → "C:\Projects\remotecontrol"
  // Drive letter followed by -- encodes the colon-backslash
  // Remaining hyphens encode path separators (ambiguous with real hyphens, best-effort)
  return dirName.replace(/^([A-Za-z])--/, "$1:\\").replace(/-/g, "\\");
}

function extractKeywords(text, bag) {
  const words = text.toLowerCase().replace(/[^a-z0-9\-_.]/g, " ").split(/\s+/)
    .filter(w => w.length > 2 && w.length < 30 && !STOP_WORDS.has(w));
  for (const w of words) bag.set(w, (bag.get(w) || 0) + 1);
  // Bigrams
  const parts = text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim()
    .split(" ").filter(w => w.length > 2 && !STOP_WORDS.has(w));
  for (let i = 0; i < parts.length - 1; i++) {
    const bg = parts[i] + " " + parts[i + 1];
    if (bg.length > 5 && bg.length < 40) bag.set(bg, (bag.get(bg) || 0) + 1);
  }
}

async function indexConversationFile(filePath, fileId, projDir) {
  const content = await fs.promises.readFile(filePath, "utf8");
  const lines = content.trim().split("\n");
  if (!lines.length) return null;

  let firstTs = null, lastTs = null, slug = null, model = null, branch = null;
  let cwd = null, entrypoint = null, sessionId = null;
  let msgCount = 0, userMsgCount = 0, freshInTok = 0, cacheWriteTok = 0, cacheReadTok = 0, outTok = 0;
  const kwBag = new Map();
  const filesEdited = new Set();
  const cmds = new Set();
  const userMsgs = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }

    if (e.timestamp) { if (!firstTs) firstTs = e.timestamp; lastTs = e.timestamp; }
    if (!slug && e.slug) slug = e.slug;
    if (!branch && e.gitBranch && e.gitBranch !== "HEAD") branch = e.gitBranch;
    if (!cwd && e.cwd) cwd = e.cwd;
    if (!entrypoint && e.entrypoint) entrypoint = e.entrypoint;
    if (!sessionId && e.sessionId) sessionId = e.sessionId;

    if (e.type === "user" && e.message?.role === "user") {
      msgCount++;
      const c = e.message.content;
      if (typeof c === "string") {
        userMsgCount++;
        if (userMsgCount <= 25) { userMsgs.push(c); extractKeywords(c, kwBag); }
      }
      if (e.toolUseResult?.filePath) {
        filesEdited.add(e.toolUseResult.filePath.replace(/\\/g, "/").split("/").pop());
      }
    }

    if (e.type === "assistant" && e.message) {
      msgCount++;
      const u = e.message.usage;
      if (u) {
        freshInTok += u.input_tokens || 0;
        cacheWriteTok += u.cache_creation_input_tokens || 0;
        cacheReadTok += u.cache_read_input_tokens || 0;
        outTok += u.output_tokens || 0;
      }
      if (!model && e.message.model) model = e.message.model;
      if (Array.isArray(e.message.content)) {
        for (const b of e.message.content) {
          if (b.type === "tool_use" && b.name === "Bash" && b.input?.command) {
            cmds.add(b.input.command.split("\n")[0].trim().slice(0, 60));
          }
          // Index text blocks from assistant for richer keyword extraction
          if (b.type === "text" && typeof b.text === "string" && userMsgCount <= 25) {
            // Only extract from first ~200 chars of each response to avoid noise
            extractKeywords(b.text.slice(0, 200), kwBag);
          }
        }
      }
    }
  }

  if (userMsgCount === 0) return null;

  const sortedKw = [...kwBag.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([w]) => w);

  // Cost estimate — effective rates for Claude Code with ephemeral caching
  // Cache writes are free (ephemeral 5-min), cache reads ~1% input, output discounted
  let cIn = 15, cCacheRead = 0.10, cOut = 40; // opus $/M (effective)
  if (model?.includes("sonnet")) { cIn = 3; cCacheRead = 0.02; cOut = 8; }
  if (model?.includes("haiku")) { cIn = 0.25; cCacheRead = 0.002; cOut = 0.65; }
  const cost = Math.round((
    (freshInTok / 1e6 * cIn) +           // fresh (uncached) input at full rate
    (cacheReadTok / 1e6 * cCacheRead) +   // cache reads at ~1% of input (ephemeral)
    (outTok / 1e6 * cOut)                  // output at full rate
  ) * 100) / 100;
  const totalInTok = freshInTok + cacheWriteTok + cacheReadTok;

  return {
    id: fileId,
    project: projDir,
    projectPath: decodeClaudeProjectPath(projDir),
    slug: slug || fileId.slice(0, 8),
    model: model || "unknown",
    branch: branch || "",
    cwd: cwd || "",
    entrypoint: entrypoint || "cli",
    firstMessage: firstTs,
    lastMessage: lastTs,
    messageCount: msgCount,
    userMessageCount: userMsgCount,
    totalInputTokens: totalInTok,
    totalOutputTokens: outTok,
    estimatedCost: cost,
    keywords: sortedKw,
    filesEdited: [...filesEdited].slice(0, 25),
    commands: [...cmds].slice(0, 20),
    summary: userMsgs.slice(0, 3).join(" | ").slice(0, 250),
  };
}

async function buildClaudeIndex(force) {
  if (!force && claudeIndex && Date.now() - claudeIndexBuiltAt < 60000) return claudeIndex;

  // Try disk cache
  if (!force) {
    try {
      const cached = JSON.parse(await fs.promises.readFile(CLAUDE_INDEX_PATH, "utf8"));
      if (cached.timestamp && Date.now() - cached.timestamp < 300000) {
        claudeIndex = cached.sessions;
        claudeIndexBuiltAt = cached.timestamp;
        return claudeIndex;
      }
    } catch {}
  }

  const result = [];
  try {
    const dirs = await fs.promises.readdir(CLAUDE_PROJECTS_DIR);
    for (const d of dirs) {
      const dp = path.join(CLAUDE_PROJECTS_DIR, d);
      let stat; try { stat = await fs.promises.stat(dp); } catch { continue; }
      if (!stat.isDirectory()) continue;
      let files; try { files = await fs.promises.readdir(dp); } catch { continue; }
      for (const f of files.filter(x => x.endsWith(".jsonl"))) {
        try {
          const s = await indexConversationFile(path.join(dp, f), f.replace(".jsonl", ""), d);
          if (s && s.messageCount > 0) result.push(s);
        } catch {}
      }
    }
  } catch {}

  result.sort((a, b) => new Date(b.lastMessage) - new Date(a.lastMessage));
  claudeIndex = result;
  claudeIndexBuiltAt = Date.now();

  try { await fs.promises.writeFile(CLAUDE_INDEX_PATH, JSON.stringify({ timestamp: Date.now(), sessions: result })); } catch {}
  return result;
}

app.get("/api/claude/sessions", apiAuth, async (_req, res) => {
  try { res.json(await buildClaudeIndex(_req.query.refresh === "1")); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/claude/search", apiAuth, async (req, res) => {
  try {
    const q = (req.query.q || "").toLowerCase().trim();
    if (!q) return res.json([]);
    const idx = await buildClaudeIndex();
    const terms = q.split(/\s+/);
    const scored = idx.map(s => {
      let score = 0;
      for (const t of terms) {
        if (s.keywords.some(k => k.includes(t))) score += 10;
        if (s.summary.toLowerCase().includes(t)) score += 5;
        if (s.filesEdited.some(f => f.toLowerCase().includes(t))) score += 3;
        if (s.commands.some(c => c.toLowerCase().includes(t))) score += 3;
        if (s.project.toLowerCase().includes(t)) score += 2;
        if (s.branch.toLowerCase().includes(t)) score += 2;
        if (s.slug.toLowerCase().includes(t)) score += 1;
      }
      return { ...s, score };
    }).filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 50);
    res.json(scored);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/claude/sessions/:id", apiAuth, async (req, res) => {
  try {
    const idx = await buildClaudeIndex();
    const s = idx.find(x => x.id === req.params.id);
    if (!s) return res.status(404).json({ error: "Not found" });
    // Return conversation entries (user messages + assistant text only, skip binary/tool noise)
    const content = await fs.promises.readFile(path.join(CLAUDE_PROJECTS_DIR, s.project, s.id + ".jsonl"), "utf8");
    const entries = [];
    for (const line of content.trim().split("\n")) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.type === "user" && typeof e.message?.content === "string") {
        entries.push({ type: "user", text: e.message.content, ts: e.timestamp });
      } else if (e.type === "assistant" && Array.isArray(e.message?.content)) {
        const texts = e.message.content.filter(b => b.type === "text").map(b => b.text).join("\n");
        if (texts) entries.push({ type: "assistant", text: texts.slice(0, 500), ts: e.timestamp, model: e.message.model });
      }
    }
    res.json({ ...s, entries: entries.slice(0, 100) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/claude/reindex", apiAuth, async (_req, res) => {
  try {
    const idx = await buildClaudeIndex(true);
    res.json({ ok: true, count: idx.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- CLAUDE.md Manager ----
// Resolve real project path from encoded dir name by reading the first JSONL entry's cwd
function resolveProjectPath(projDir) {
  try {
    const dp = path.join(CLAUDE_PROJECTS_DIR, projDir);
    const files = fs.readdirSync(dp).filter(f => f.endsWith(".jsonl"));
    for (const f of files) {
      const first = fs.readFileSync(path.join(dp, f), "utf8").split("\n")[0];
      const e = JSON.parse(first);
      if (e.cwd) return e.cwd.replace(/\//g, path.sep);
    }
  } catch {}
  return decodeClaudeProjectPath(projDir);
}

let projectPathCache = null;
function getProjectPaths() {
  if (projectPathCache) return projectPathCache;
  const result = [];
  try {
    const dirs = fs.readdirSync(CLAUDE_PROJECTS_DIR);
    for (const d of dirs) {
      try {
        if (!fs.statSync(path.join(CLAUDE_PROJECTS_DIR, d)).isDirectory()) continue;
        const resolved = resolveProjectPath(d);
        result.push({ dir: d, path: resolved, name: path.basename(resolved) });
      } catch {}
    }
  } catch {}
  projectPathCache = result;
  setTimeout(() => { projectPathCache = null; }, 60000);
  return result;
}

const CLAUDEMD_TEMPLATES = {
  basic: `# Project Guidelines

## Overview
Brief description of the project.

## Architecture
Key architecture decisions and patterns.

## Code Style
- Prefer X over Y
- Follow existing patterns in the codebase

## Testing
How to run tests, what to test.

## Important Notes
Things to remember when working on this project.
`,
  webdev: `# Web Project Guidelines

## Stack
- Frontend: [framework]
- Backend: [framework]
- Database: [database]

## Development
\`\`\`bash
npm install
npm run dev
\`\`\`

## Code Style
- Use TypeScript strict mode
- Components in PascalCase
- Utilities in camelCase

## API Conventions
- RESTful endpoints at /api/
- Always validate input
- Return consistent error shapes

## Testing
\`\`\`bash
npm test
npm run test:e2e
\`\`\`

## Deployment
- Branch: main → production
- PRs require review
`,
  cli: `# CLI Tool Guidelines

## Overview
What this CLI does and who uses it.

## Development
\`\`\`bash
npm install
npm link  # for local testing
\`\`\`

## Architecture
- Entry point: src/index.ts
- Commands in src/commands/
- Shared utils in src/lib/

## Adding Commands
1. Create file in src/commands/
2. Export handler function
3. Register in src/index.ts

## Testing
\`\`\`bash
npm test
\`\`\`
`,
  python: `# Python Project Guidelines

## Setup
\`\`\`bash
python -m venv venv
source venv/bin/activate  # or venv\\Scripts\\activate on Windows
pip install -r requirements.txt
\`\`\`

## Code Style
- Follow PEP 8
- Type hints on all public functions
- Docstrings on classes and public methods

## Testing
\`\`\`bash
pytest
pytest --cov
\`\`\`

## Project Structure
- src/ — main source code
- tests/ — test files
- scripts/ — utility scripts
`,
};

app.get("/api/claudemd/list", apiAuth, (_req, res) => {
  const projects = getProjectPaths();
  const result = [];
  for (const p of projects) {
    const claudemdPath = path.join(p.path, "CLAUDE.md");
    const localSettingsPath = path.join(p.path, ".claude", "settings.local.json");
    const memoryDir = path.join(CLAUDE_PROJECTS_DIR, p.dir);
    let memoryFiles = [];
    // Check for memory dir — could be directly under project dir or nested in a session subdir
    try {
      const directMem = path.join(memoryDir, "memory");
      if (fs.existsSync(directMem) && fs.statSync(directMem).isDirectory()) {
        memoryFiles = fs.readdirSync(directMem).filter(f => f.endsWith(".md"));
      } else {
        const sub = fs.readdirSync(memoryDir).find(f => {
          try { return fs.statSync(path.join(memoryDir, f)).isDirectory() && fs.existsSync(path.join(memoryDir, f, "memory")); } catch { return false; }
        });
        if (sub) {
          memoryFiles = fs.readdirSync(path.join(memoryDir, sub, "memory")).filter(f => f.endsWith(".md"));
        }
      }
    } catch {}

    let hasClaude = false, size = 0;
    try { const st = fs.statSync(claudemdPath); hasClaude = true; size = st.size; } catch {}

    result.push({
      dir: p.dir,
      path: p.path,
      name: p.name,
      hasClaude,
      size,
      hasLocalSettings: fs.existsSync(localSettingsPath),
      memoryFiles,
    });
  }
  // Sort: projects with CLAUDE.md first, then alphabetical
  result.sort((a, b) => (b.hasClaude ? 1 : 0) - (a.hasClaude ? 1 : 0) || a.name.localeCompare(b.name));
  res.json(result);
});

app.get("/api/claudemd/read", apiAuth, (req, res) => {
  const projectPath = req.query.path;
  if (!projectPath) return res.status(400).json({ error: "path required" });
  const claudemdPath = path.join(projectPath, "CLAUDE.md");
  try {
    const content = fs.readFileSync(claudemdPath, "utf8");
    res.json({ content, path: claudemdPath });
  } catch {
    res.json({ content: "", path: claudemdPath, exists: false });
  }
});

app.put("/api/claudemd/write", apiAuth, express.json({ limit: "1mb" }), (req, res) => {
  const projectPath = req.body.path;
  const content = req.body.content;
  if (!projectPath || content == null) return res.status(400).json({ error: "path and content required" });
  const claudemdPath = path.join(projectPath, "CLAUDE.md");
  try {
    fs.writeFileSync(claudemdPath, content, "utf8");
    res.json({ ok: true, path: claudemdPath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/claudemd/templates", apiAuth, (_req, res) => {
  res.json(Object.entries(CLAUDEMD_TEMPLATES).map(([id, content]) => ({ id, name: id.charAt(0).toUpperCase() + id.slice(1), content })));
});

app.get("/api/claudemd/memory", apiAuth, (req, res) => {
  const projDir = req.query.dir;
  if (!projDir) return res.status(400).json({ error: "dir required" });
  const memBase = path.join(CLAUDE_PROJECTS_DIR, projDir);
  try {
    // Check direct memory/ dir first, then nested session subdirs
    const directMem = path.join(memBase, "memory");
    let memDir = null;
    if (fs.existsSync(directMem) && fs.statSync(directMem).isDirectory()) {
      memDir = directMem;
    } else {
      const subdirs = fs.readdirSync(memBase).filter(f => {
        try { return fs.statSync(path.join(memBase, f)).isDirectory(); } catch { return false; }
      });
      for (const sd of subdirs) {
        const candidate = path.join(memBase, sd, "memory");
        if (fs.existsSync(candidate)) { memDir = candidate; break; }
      }
    }
    if (memDir) {
      const files = fs.readdirSync(memDir).filter(f => f.endsWith(".md"));
      const memories = files.map(f => {
        const content = fs.readFileSync(path.join(memDir, f), "utf8");
        return { file: f, content };
      });
      return res.json({ memories, path: memDir });
    }
    res.json({ memories: [], path: null });
  } catch { res.json({ memories: [], path: null }); }
});

// ---- Prompt Library ----
const PROMPTS_FILE = path.join(CLAUDE_HOME, "agenv-prompts.json");

function loadPrompts() {
  try { return JSON.parse(fs.readFileSync(PROMPTS_FILE, "utf8")); }
  catch { return []; }
}
function savePrompts(prompts) {
  fs.writeFileSync(PROMPTS_FILE, JSON.stringify(prompts, null, 2));
}

app.get("/api/prompts", apiAuth, (_req, res) => {
  res.json(loadPrompts());
});

app.post("/api/prompts", apiAuth, express.json(), (req, res) => {
  const { title, content, category, tags } = req.body;
  if (!title || !content) return res.status(400).json({ error: "title and content required" });
  const prompts = loadPrompts();
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const prompt = { id, title, content, category: category || "general", tags: tags || [], created: Date.now(), used: 0 };
  prompts.push(prompt);
  savePrompts(prompts);
  res.json(prompt);
});

app.put("/api/prompts/:id", apiAuth, express.json(), (req, res) => {
  const prompts = loadPrompts();
  const idx = prompts.findIndex(p => p.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: "Not found" });
  Object.assign(prompts[idx], req.body, { id: req.params.id });
  savePrompts(prompts);
  res.json(prompts[idx]);
});

app.delete("/api/prompts/:id", apiAuth, (req, res) => {
  let prompts = loadPrompts();
  prompts = prompts.filter(p => p.id !== req.params.id);
  savePrompts(prompts);
  res.json({ ok: true });
});

app.post("/api/prompts/:id/use", apiAuth, (req, res) => {
  const prompts = loadPrompts();
  const p = prompts.find(p => p.id === req.params.id);
  if (p) { p.used = (p.used || 0) + 1; p.lastUsed = Date.now(); savePrompts(prompts); }
  res.json({ ok: true });
});

// ---- Auth routes ----
if (useCredentials) {
  app.get("/login", (req, res) => {
    if (isAuthenticated(req)) return res.redirect("/");
    res.type("html").send(buildLoginPage());
  });
  app.post("/login", express.urlencoded({ extended: false }), (req, res) => {
    const { username, password } = req.body;
    const cfg = loadConfig();
    if (cfg.auth && cfg.auth.username === username && cfg.auth.password && verifyPassword(password, cfg.auth.password)) {
      const sid = crypto.randomBytes(32).toString("hex");
      cookieSessions.add(sid);
      const secure = (req.secure || req.headers["x-forwarded-proto"] === "https") ? "; Secure" : "";
      res.setHeader("Set-Cookie", `session=${sid}; HttpOnly; SameSite=Strict; Path=/${secure}`);
      res.redirect("/");
    } else {
      res.status(401).type("html").send(buildLoginPage("Invalid username or password."));
    }
  });
  app.get("/", (req, res) => {
    if (!isAuthenticated(req)) return res.redirect("/login");
    res.type("html").send(buildPage(""));
  });
} else {
  app.get("/", (req, res) => {
    if (req.query.token !== TOKEN) {
      return res.status(401).type("html").send(
        `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>401</title><style>body{font-family:monospace;background:#1e1e1e;color:#f44;padding:2rem}</style></head><body><h2>401 Unauthorized</h2><p>Missing or invalid token.</p></body></html>`
      );
    }
    res.type("html").send(buildPage(TOKEN));
  });
}

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 16 * 1024 * 1024 });

function makeRateLimiter(limit = 200) {
  let count = 0, windowStart = Date.now();
  return function () { const now = Date.now(); if (now - windowStart >= 1000) { count = 0; windowStart = now; } return ++count <= limit; };
}

wss.on("connection", (ws, req) => {
  if (!isAuthenticated(req)) { ws.close(4401, "Unauthorized"); return; }

  // ngrok IP allowlist check for WebSocket
  const isNgrok = !!(req.headers["x-forwarded-for"] || req.headers["ngrok-skip-browser-warning"]);
  if (isNgrok && ngrokSettings.allowedIps.length > 0) {
    const clientIp = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (!ngrokSettings.allowedIps.includes(clientIp)) {
      ws.close(4403, "IP not in allowlist"); return;
    }
  }
  const wsReadOnly = isNgrok && ngrokSettings.readOnly;

  const urlObj = new URL(req.url, "http://localhost");
  const sessionId = parseInt(urlObj.searchParams.get("session") || "0", 10);
  const session = sessions.get(sessionId);
  if (!session) { ws.close(4404, "Session not found"); return; }

  session.clients.add(ws);
  const rl = makeRateLimiter();
  console.log(`[agenv] Browser connected to session ${sessionId} (${session.clients.size} client(s))${wsReadOnly ? " [read-only]" : ""}`);

  ws.send(JSON.stringify({ type: "resize", cols: session.pty.cols, rows: session.pty.rows }));
  if (session.scrollback.length > 0) ws.send(JSON.stringify({ type: "output", data: session.scrollback.toString("utf8") }));

  ws.on("message", (raw) => {
    if (!rl()) { ws.close(4429, "Too Many Requests"); return; }
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === "input" && typeof msg.data === "string") { if (wsReadOnly) return; if (msg.data.length <= 262144) session.pty.write(msg.data); }
    else if (msg.type === "resize") {
      session.pty.resize(
        Math.max(1, Math.min(Math.floor(Number(msg.cols)) || 80, 500)),
        Math.max(1, Math.min(Math.floor(Number(msg.rows)) || 24, 200))
      );
    }
  });
  ws.on("close", () => { session.clients.delete(ws); console.log(`[agenv] Browser disconnected from session ${sessionId} (${session.clients.size} client(s))`); });
});

// ---------------------------------------------------------------------------
// Start listening
// ---------------------------------------------------------------------------
server.listen(PORT, HOST, () => {
  console.log(`[agenv] Listening on ${HOST}:${PORT}`);
  // Write PID file so 'agenv stop/kill' can find us
  try {
    fs.writeFileSync(PID_PATH, JSON.stringify({ pid: process.pid, port: PORT, host: HOST, started: Date.now() }));
  } catch {}
});

// ---------------------------------------------------------------------------
// Graceful shutdown — save state on ALL exit paths
// ---------------------------------------------------------------------------
function gracefulShutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[agenv] ${reason} — saving state...`);
  try { saveState(); } catch {}
  try { saveAllScrollback(); } catch {}
  clearInterval(periodicSaveInterval);
  // Clean up PID file
  try { fs.unlinkSync(PID_PATH); } catch {}
  // Kill all PTY processes
  for (const s of sessions.values()) { try { s.pty.kill(); } catch {} }
  server.close(() => {
    console.log("[agenv] Server closed.");
    process.exit(0);
  });
  // Force exit after 3s if server.close() hangs
  setTimeout(() => process.exit(0), 3000).unref();
}

// Signal handling — works on both Windows and Unix
let ctrlCCount = 0, ctrlCTimer;
process.on("SIGINT", () => {
  ctrlCCount++;
  if (ctrlCCount >= 2) {
    gracefulShutdown("Double Ctrl+C");
  } else {
    console.log("\n[agenv] Press Ctrl+C again to exit (or run 'agenv stop')");
  }
  clearTimeout(ctrlCTimer);
  ctrlCTimer = setTimeout(() => { ctrlCCount = 0; }, 2000);
});
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGHUP", () => gracefulShutdown("SIGHUP"));
// Windows: handle Ctrl+Break
if (process.platform === "win32") {
  process.on("SIGBREAK", () => gracefulShutdown("Ctrl+Break"));
}
process.on("exit", () => {
  if (!shuttingDown) { try { saveState(); } catch {} try { saveAllScrollback(); } catch {} }
  try { fs.unlinkSync(PID_PATH); } catch {}
});

// Windows: enable raw stdin so Ctrl+C is received by Node, not swallowed by PTY
if (process.platform === "win32" && process.stdin.isTTY) {
  try {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (data) => {
      // Ctrl+C = 0x03
      if (data[0] === 3) {
        ctrlCCount++;
        if (ctrlCCount >= 2) {
          gracefulShutdown("Double Ctrl+C");
        } else {
          console.log("\n[agenv] Press Ctrl+C again to exit (or run 'agenv stop')");
          clearTimeout(ctrlCTimer);
          ctrlCTimer = setTimeout(() => { ctrlCCount = 0; }, 2000);
        }
      }
      // 'q' or 'Q' to quit (only when not piped)
      if (data[0] === 113 || data[0] === 81) {
        gracefulShutdown("Quit (q pressed)");
      }
    });
  } catch {}
}

// ---------------------------------------------------------------------------
// HTML builders
// ---------------------------------------------------------------------------
function buildLoginPage(error) {
  return LOGIN_TEMPLATE.replace(/__ERROR__/g, error ? `<p class="error">${error}</p>` : "");
}

let _pageCache = null;
function getPageTemplate() {
  if (!_pageCache) _pageCache = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
  return _pageCache;
}
// Invalidate cache when files change in dev
if (process.env.NODE_ENV !== "production") {
  try { fs.watch(path.join(__dirname, "public", "index.html"), () => { _pageCache = null; }); } catch {}
}

function buildPage(token) {
  const sessionList = Array.from(sessions.entries()).sort((a, b) => a[0] - b[0])
    .map(([id, s]) => ({ id, name: s.name || "", cwd: s.cwd, tool: s.detectedTool || "terminal", lastCommand: s.lastCommand || "", launchCommand: s.launchCommand || "", created: s.created, lastActivity: s.lastActivity, status: s.status || "idle", group: s.group || "", note: s.note || "", analytics: s.analytics || {} }));
  const archive = loadArchive().reverse().slice(0, 30);
  const favorites = loadFavorites();
  const recentFolders = [];
  const folderMap = new Map();
  for (const s of sessions.values()) { if (s.cwd) folderMap.set(s.cwd, Math.max(folderMap.get(s.cwd) || 0, s.lastActivity)); }
  for (const a of archive) { if (a.cwd) folderMap.set(a.cwd, Math.max(folderMap.get(a.cwd) || 0, a.lastActivity || a.closed)); }
  for (const [cwd, ts] of folderMap) { try { if (fs.existsSync(cwd)) recentFolders.push({ cwd, lastActivity: ts }); } catch {} }
  recentFolders.sort((a, b) => b.lastActivity - a.lastActivity);

  const runtimeData = JSON.stringify({
    token, sessions: sessionList, archive, favorites, recentFolders: recentFolders.slice(0, 15),
    workspaceLayout: _workspaceLayout || null,
  });
  const runtimeScript = `window.__RUNTIME__ = ${runtimeData};`;

  return getPageTemplate().replace("/*__RUNTIME_DATA__*/", runtimeScript);
}

// ---------------------------------------------------------------------------
// Login page
// ---------------------------------------------------------------------------
const LOGIN_TEMPLATE = /* html */ `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width,initial-scale=1.0" /><title>Agenv — Login</title>
<style>*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}html,body{height:100%;background:#1e1e1e;color:#ccc;font-family:'Cascadia Code','Fira Code',Consolas,monospace;display:flex;align-items:center;justify-content:center}.card{background:#252526;border:1px solid #3c3c3c;border-radius:8px;padding:2rem 2.5rem;width:340px}h1{font-size:1.1rem;margin-bottom:1.5rem;color:#fff;text-align:center}label{display:block;font-size:.85rem;margin-bottom:.3rem;color:#999}input{width:100%;padding:8px 10px;margin-bottom:1rem;background:#1e1e1e;border:1px solid #3c3c3c;border-radius:4px;color:#fff;font-family:inherit;font-size:.9rem;outline:none}input:focus{border-color:#007acc}button{width:100%;padding:10px;background:#007acc;color:#fff;border:none;border-radius:4px;font-family:inherit;font-size:.9rem;cursor:pointer}button:hover{background:#005f9e}.error{color:#f44;font-size:.85rem;margin-bottom:1rem;text-align:center}</style></head>
<body><div class="card"><h1>Agenv</h1>__ERROR__<form method="POST" action="/login"><label for="username">Username</label><input type="text" id="username" name="username" autocomplete="username" autofocus required /><label for="password">Password</label><input type="password" id="password" name="password" autocomplete="current-password" required /><button type="submit">Sign In</button></form></div></body></html>`;

