#!/usr/bin/env node
"use strict";

const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const { execSync } = require("child_process");
const express = require("express");
const { WebSocketServer } = require("ws");
const pty = require("@lydell/node-pty");

// ---------------------------------------------------------------------------
// Config file (~/.termlinkrc.json)
// ---------------------------------------------------------------------------
const CONFIG_PATH = path.join(os.homedir(), ".termlinkrc.json");

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
const ENCRYPTION_KEY_PATH = path.join(os.homedir(), ".termlink.key");

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
// Command history (~/.termlink-history.enc)
// ---------------------------------------------------------------------------
const HISTORY_PATH = path.join(os.homedir(), ".termlink-history.enc");
const HISTORY_PATH_OLD = path.join(os.homedir(), ".termlink-history.json");
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
// Scrollback persistence (~/.termlink-scrollback/)
// ---------------------------------------------------------------------------
const SCROLLBACK_DIR = path.join(os.homedir(), ".termlink-scrollback");
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
// Session archive (~/.termlink-archive.enc) — closed session history
// ---------------------------------------------------------------------------
const ARCHIVE_PATH = path.join(os.homedir(), ".termlink-archive.enc");
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
// Favorites (~/.termlink-favorites.enc) — saved folder+command combos
// ---------------------------------------------------------------------------
const FAVORITES_PATH = path.join(os.homedir(), ".termlink-favorites.enc");

function loadFavorites() {
  try { const f = decryptJSON(fs.readFileSync(FAVORITES_PATH, "utf8")); return Array.isArray(f) ? f : []; }
  catch { return []; }
}
function saveFavorites(favs) { fs.writeFileSync(FAVORITES_PATH, encryptJSON(favs), "utf8"); }

// ---------------------------------------------------------------------------
// Session state (~/.termlink-state.enc)
// ---------------------------------------------------------------------------
const STATE_PATH = path.join(os.homedir(), ".termlink-state.enc");
const STATE_PATH_OLD = path.join(os.homedir(), ".termlink-state.json");

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

function saveState() {
  const state = { sessions: [] };
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

if (command === "set") {
  const key = args[1]; const value = args.slice(2).join(" ");
  if (!key || !value) { console.error("Usage: termlink set <key> <value>\n\nExamples:\n  termlink set auth.username admin\n  termlink set auth.password s3cret"); process.exit(1); }
  if (key === "auth.password") { setConfigValue(key, hashPassword(value)); console.log("[termlink] Password saved (hashed)."); }
  else { setConfigValue(key, value); console.log(`[termlink] ${key} = ${value}`); }
  process.exit(0);
}
if (command === "get") {
  const key = args[1];
  if (!key) { console.error("Usage: termlink get <key>"); process.exit(1); }
  const val = getConfigValue(key);
  if (val === undefined) { console.error(`[termlink] ${key} is not set`); process.exit(1); }
  console.log(key === "auth.password" ? "(hashed)" : val);
  process.exit(0);
}
if (command === "update") {
  const pkg = require(path.join(__dirname, "package.json"));
  console.log(`[termlink] Current version: ${pkg.version}\n[termlink] Checking for updates...`);
  try { execSync("npm install -g termlink@latest", { stdio: "inherit" }); console.log("[termlink] Update complete."); }
  catch { console.error("[termlink] Update failed. Try manually: npm install -g termlink@latest"); process.exit(1); }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Server mode — parse flags
// ---------------------------------------------------------------------------
function flag(name, fallback) { const i = args.indexOf(name); return (i === -1 || i + 1 >= args.length) ? fallback : args[i + 1]; }

const PORT = parseInt(flag("--port", "7681"), 10);
const HOST = flag("--host", "127.0.0.1");
const isWindows = os.platform() === "win32";
const defaultShell = isWindows ? "cmd.exe" : process.env.SHELL || "bash";
const SHELL = flag("--shell", defaultShell);
const TOKEN = flag("--token", crypto.randomBytes(16).toString("hex"));
const INITIAL_SESSIONS = Math.max(1, parseInt(flag("--sessions", "1"), 10));
const MAX_SESSIONS = Math.max(1, parseInt(flag("--max-sessions", "10"), 10));

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------
const config = loadConfig();
const useCredentials = !!(config.auth && config.auth.username && config.auth.password);
const cookieSessions = new Set();

if (useCredentials) console.log("[termlink] Auth mode: username/password");
else console.log("[termlink] Auth mode: token");

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
function appendScrollback(session, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  session.scrollback = Buffer.concat([session.scrollback, buf]);
  if (session.scrollback.length > MAX_SCROLLBACK)
    session.scrollback = session.scrollback.slice(session.scrollback.length - MAX_SCROLLBACK);
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
    for (const ws of session.clients) {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: "output", data }));
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    if (shuttingDown) return;
    console.log(`\n[termlink] Session ${id} exited (code ${exitCode})`);
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

// Spawn sessions — restore previous state
const savedState = loadState();
if (savedState && savedState.sessions && savedState.sessions.length > 0) {
  for (const s of savedState.sessions) {
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
  console.log(`[termlink] Restored ${savedState.sessions.length} session(s): ${SHELL} (${cols}x${rows})`);
} else {
  for (let i = 0; i < INITIAL_SESSIONS; i++) spawnSession(nextSessionId++, { restoreScrollback: false });
  console.log(`[termlink] ${INITIAL_SESSIONS} session(s) spawned: ${SHELL} (${cols}x${rows})`);
}
saveState();
console.log(useCredentials ? `[termlink] Access URL: http://${HOST}:${PORT}/` : `[termlink] Access URL: http://${HOST}:${PORT}/?token=${TOKEN}`);
console.log(`[termlink] Tip: run  ngrok http ${PORT}  to share from your phone`);
console.log("[termlink] Press Ctrl+C twice quickly to exit.\n");

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
app.use(express.json());

function apiAuth(req, res, next) {
  if (!isAuthenticated(req)) return res.status(401).json({ error: "Unauthorized" });
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
    });
  }
  res.json(list);
});

app.post("/api/sessions", apiAuth, (req, res) => {
  if (sessions.size >= MAX_SESSIONS) return res.status(400).json({ error: "Maximum sessions reached (" + MAX_SESSIONS + ")" });
  const id = nextSessionId++;
  const b = req.body || {};
  spawnSession(id, { cwd: b.cwd, name: b.name || "", runCommand: b.command || null, restoreScrollback: false });
  saveState();
  const s = sessions.get(id);
  console.log(`[termlink] Session ${id} created from browser in ${s.cwd} (${sessions.size} total)`);
  res.json({ id, name: s.name, cwd: s.cwd, tool: s.detectedTool, created: s.created });
});

app.put("/api/sessions/:id", apiAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const session = sessions.get(id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (req.body.name != null) { session.name = String(req.body.name).slice(0, 64); session.userNamed = true; }
  if (req.body.tool) { session.detectedTool = String(req.body.tool); session.lastCommand = req.body.lastCommand || session.lastCommand; }
  saveState();
  res.json({ ok: true });
});

app.delete("/api/sessions/:id", apiAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === 0) return res.status(400).json({ error: "Cannot close primary session" });
  const session = sessions.get(id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  session.pty.kill();
  console.log(`[termlink] Session ${id} closed from browser`);
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
app.get("/api/git/:action", apiAuth, (req, res) => {
  const sid = parseInt(req.query.session || "0", 10);
  const session = sessions.get(sid);
  const cwd = session ? session.cwd : process.cwd();
  const action = req.params.action;
  const cmds = {
    status: "git status --short",
    diff: "git diff",
    "diff-staged": "git diff --staged",
    log: "git log --oneline -20",
    branch: "git branch -a",
    stash: "git stash list",
  };
  const cmd = cmds[action];
  if (!cmd) return res.status(400).json({ error: "Unknown action" });
  try {
    const out = execSync(cmd, { cwd, encoding: "utf8", timeout: 10000, maxBuffer: 512 * 1024 });
    res.json({ ok: true, output: out, cwd });
  } catch (e) {
    res.json({ ok: false, output: e.stderr || e.message || "Error", cwd });
  }
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
      res.setHeader("Set-Cookie", `session=${sid}; HttpOnly; SameSite=Strict; Path=/`);
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
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 64 * 1024 });

function makeRateLimiter(limit = 200) {
  let count = 0, windowStart = Date.now();
  return function () { const now = Date.now(); if (now - windowStart >= 1000) { count = 0; windowStart = now; } return ++count <= limit; };
}

wss.on("connection", (ws, req) => {
  if (!isAuthenticated(req)) { ws.close(4401, "Unauthorized"); return; }
  const urlObj = new URL(req.url, "http://localhost");
  const sessionId = parseInt(urlObj.searchParams.get("session") || "0", 10);
  const session = sessions.get(sessionId);
  if (!session) { ws.close(4404, "Session not found"); return; }

  session.clients.add(ws);
  const rl = makeRateLimiter();
  console.log(`[termlink] Browser connected to session ${sessionId} (${session.clients.size} client(s))`);

  ws.send(JSON.stringify({ type: "resize", cols: session.pty.cols, rows: session.pty.rows }));
  if (session.scrollback.length > 0) ws.send(JSON.stringify({ type: "output", data: session.scrollback.toString("utf8") }));

  ws.on("message", (raw) => {
    if (!rl()) { ws.close(4429, "Too Many Requests"); return; }
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === "input" && typeof msg.data === "string") { if (msg.data.length <= 4096) session.pty.write(msg.data); }
    else if (msg.type === "resize") {
      session.pty.resize(
        Math.max(1, Math.min(Math.floor(Number(msg.cols)) || 80, 500)),
        Math.max(1, Math.min(Math.floor(Number(msg.rows)) || 24, 200))
      );
    }
  });
  ws.on("close", () => { session.clients.delete(ws); console.log(`[termlink] Browser disconnected from session ${sessionId} (${session.clients.size} client(s))`); });
});

// ---------------------------------------------------------------------------
// Start listening
// ---------------------------------------------------------------------------
server.listen(PORT, HOST, () => console.log(`[termlink] Listening on ${HOST}:${PORT}`));

// ---------------------------------------------------------------------------
// Graceful shutdown — save state on ALL exit paths
// ---------------------------------------------------------------------------
function gracefulShutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[termlink] ${reason} — saving state...`);
  try { saveState(); } catch {} try { saveAllScrollback(); } catch {}
  clearInterval(periodicSaveInterval);
  for (const s of sessions.values()) { try { s.pty.kill(); } catch {} }
  server.close();
  process.exit(0);
}

let ctrlCCount = 0, ctrlCTimer;
process.on("SIGINT", () => { ctrlCCount++; if (ctrlCCount >= 2) gracefulShutdown("Double Ctrl+C"); clearTimeout(ctrlCTimer); ctrlCTimer = setTimeout(() => { ctrlCCount = 0; }, 1000); });
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGHUP", () => gracefulShutdown("SIGHUP"));
process.on("exit", () => { if (!shuttingDown) { try { saveState(); } catch {} try { saveAllScrollback(); } catch {} } });

// ---------------------------------------------------------------------------
// HTML builders
// ---------------------------------------------------------------------------
function buildLoginPage(error) {
  return LOGIN_TEMPLATE.replace(/__ERROR__/g, error ? `<p class="error">${error}</p>` : "");
}

function buildPage(token) {
  const sessionList = Array.from(sessions.entries()).sort((a, b) => a[0] - b[0])
    .map(([id, s]) => ({ id, name: s.name || "", cwd: s.cwd, tool: s.detectedTool || "terminal", lastCommand: s.lastCommand || "", launchCommand: s.launchCommand || "", created: s.created, lastActivity: s.lastActivity }));
  const archive = loadArchive().reverse().slice(0, 30);
  const favorites = loadFavorites();
  const recentFolders = [];
  const folderMap = new Map();
  for (const s of sessions.values()) { if (s.cwd) folderMap.set(s.cwd, Math.max(folderMap.get(s.cwd) || 0, s.lastActivity)); }
  for (const a of archive) { if (a.cwd) folderMap.set(a.cwd, Math.max(folderMap.get(a.cwd) || 0, a.lastActivity || a.closed)); }
  for (const [cwd, ts] of folderMap) { try { if (fs.existsSync(cwd)) recentFolders.push({ cwd, lastActivity: ts }); } catch {} }
  recentFolders.sort((a, b) => b.lastActivity - a.lastActivity);

  return PAGE_TEMPLATE
    .replace(/__WS_TOKEN__/g, token)
    .replace(/__SESSION_LIST__/g, JSON.stringify(sessionList))
    .replace(/__ARCHIVE__/g, JSON.stringify(archive))
    .replace(/__FAVORITES__/g, JSON.stringify(favorites))
    .replace(/__RECENT_FOLDERS__/g, JSON.stringify(recentFolders.slice(0, 15)));
}

// ---------------------------------------------------------------------------
// Login page
// ---------------------------------------------------------------------------
const LOGIN_TEMPLATE = /* html */ `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width,initial-scale=1.0" /><title>TermLink — Login</title>
<style>*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}html,body{height:100%;background:#1e1e1e;color:#ccc;font-family:'Cascadia Code','Fira Code',Consolas,monospace;display:flex;align-items:center;justify-content:center}.card{background:#252526;border:1px solid #3c3c3c;border-radius:8px;padding:2rem 2.5rem;width:340px}h1{font-size:1.1rem;margin-bottom:1.5rem;color:#fff;text-align:center}label{display:block;font-size:.85rem;margin-bottom:.3rem;color:#999}input{width:100%;padding:8px 10px;margin-bottom:1rem;background:#1e1e1e;border:1px solid #3c3c3c;border-radius:4px;color:#fff;font-family:inherit;font-size:.9rem;outline:none}input:focus{border-color:#007acc}button{width:100%;padding:10px;background:#007acc;color:#fff;border:none;border-radius:4px;font-family:inherit;font-size:.9rem;cursor:pointer}button:hover{background:#005f9e}.error{color:#f44;font-size:.85rem;margin-bottom:1rem;text-align:center}</style></head>
<body><div class="card"><h1>TermLink</h1>__ERROR__<form method="POST" action="/login"><label for="username">Username</label><input type="text" id="username" name="username" autocomplete="username" autofocus required /><label for="password">Password</label><input type="password" id="password" name="password" autocomplete="current-password" required /><button type="submit">Sign In</button></form></div></body></html>`;

// ---------------------------------------------------------------------------
// Main page — Dashboard + Terminal
// ---------------------------------------------------------------------------
const PAGE_TEMPLATE = /* html */ `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no"/>
<title>TermLink</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css"/>
<style>
:root{--bg:#0d1117;--bg2:#161b22;--bg3:#1c2333;--border:#30363d;--text:#e6edf3;--text2:#8b949e;--text3:#484f58;--accent:#58a6ff;--accent2:#388bfd;--purple:#bc8cff;--green:#3fb950;--orange:#d29922;--red:#f85149;--radius:8px;--font:'Cascadia Code','Fira Code','Consolas','Monaco',monospace}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;background:var(--bg);color:var(--text);font-family:var(--font);overflow:hidden}
body{display:flex;flex-direction:column}

/* ===== DASHBOARD ===== */
#dashboard{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:0 0 80px}
#dashboard.hidden{display:none}
.dash-inner{max-width:600px;margin:0 auto;padding:20px 16px}
.dash-hero{padding:24px 0 16px;text-align:center}
.dash-hero h1{font-size:20px;font-weight:700;color:var(--text);letter-spacing:-.5px}
.dash-hero h1 span{color:var(--accent)}
.dash-hero p{font-size:11px;color:var(--text3);margin-top:6px}

.dash-section{margin-top:20px}
.dash-label{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.8px;color:var(--text3);margin-bottom:8px;padding-left:2px}

/* Action grid */
.act-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.act-btn{display:flex;align-items:center;gap:10px;padding:14px;background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius);cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation;transition:border-color .2s,background .2s}
.act-btn:hover,.act-btn:active{background:var(--bg3);border-color:var(--accent2)}
.act-btn .act-icon{width:36px;height:36px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0}
.act-btn .act-icon.claude{background:rgba(139,92,246,.15);color:#a78bfa}
.act-btn .act-icon.vertex{background:rgba(63,185,80,.12);color:var(--green)}
.act-btn .act-icon.terminal{background:rgba(88,166,255,.1);color:var(--accent)}
.act-btn .act-icon.folder{background:rgba(210,153,34,.1);color:var(--orange)}
.act-btn .act-text{min-width:0}
.act-btn .act-title{font-size:13px;font-weight:600;color:var(--text)}
.act-btn .act-sub{font-size:10px;color:var(--text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* Session cards */
.ses-list{display:flex;flex-direction:column;gap:6px}
.ses-card{display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius);cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation;transition:border-color .2s}
.ses-card:hover,.ses-card:active{border-color:var(--text3)}
.ses-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.ses-dot.live{background:var(--green)}
.ses-dot.dead{background:var(--text3)}
.ses-info{flex:1;min-width:0}
.ses-name{font-size:12px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ses-path{font-size:10px;color:var(--text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}
.ses-badge{font-size:9px;font-weight:700;padding:2px 6px;border-radius:4px;text-transform:uppercase;letter-spacing:.3px;flex-shrink:0}
.ses-badge.claude{background:rgba(139,92,246,.2);color:#c4b5fd}
.ses-badge.vertex{background:rgba(63,185,80,.15);color:#7ee787}
.ses-badge.ssh{background:rgba(210,153,34,.15);color:#e3b341}
.ses-time{font-size:10px;color:var(--text3);flex-shrink:0;min-width:24px;text-align:right}

.empty-msg{font-size:11px;color:var(--text3);padding:12px 4px}

/* ===== TERMINAL VIEW ===== */
#terminal-view{flex:1;display:flex;flex-direction:column}
#terminal-view.hidden{display:none}

/* Top bar */
#top-bar{display:flex;align-items:center;background:var(--bg2);border-bottom:1px solid var(--border);height:38px;flex-shrink:0}
.top-btn{display:flex;align-items:center;justify-content:center;width:38px;height:100%;background:none;border:none;color:var(--text2);font-size:16px;cursor:pointer;flex-shrink:0;font-family:var(--font)}
.top-btn:hover{color:var(--text);background:rgba(255,255,255,.04)}
#tab-bar{display:flex;flex:1;overflow-x:auto;height:100%;align-items:stretch;gap:0}
#tab-bar::-webkit-scrollbar{height:0}
.tab{display:flex;align-items:center;gap:5px;padding:0 12px;color:var(--text2);font-size:11px;cursor:pointer;border:none;background:none;border-bottom:2px solid transparent;white-space:nowrap;user-select:none;flex-shrink:0;transition:all .15s;font-family:var(--font);height:100%}
.tab:hover{color:var(--text);background:rgba(255,255,255,.03)}
.tab.active{color:var(--text);border-bottom-color:var(--accent);background:rgba(88,166,255,.04)}
.tab-icon{font-size:12px;opacity:.7}
.tab.active .tab-icon{opacity:1}
.tab-label{max-width:100px;overflow:hidden;text-overflow:ellipsis}
.tab-close{width:16px;height:16px;border-radius:3px;font-size:13px;line-height:16px;text-align:center;opacity:0;transition:opacity .1s}
.tab:hover .tab-close{opacity:.4}
.tab-close:hover{opacity:1!important;background:rgba(255,255,255,.1)}
.tab-rename{background:var(--bg);border:1px solid var(--accent);color:var(--text);font:11px/1 var(--font);padding:2px 4px;width:90px;outline:none;border-radius:3px}

/* Terminals */
#terminals{flex:1;position:relative}
.term-container{position:absolute;top:0;left:0;right:0;bottom:0}

/* Status bar */
#status-bar{display:flex;align-items:center;justify-content:space-between;background:var(--accent2);height:22px;padding:0 12px;font-size:10px;color:#fff;flex-shrink:0}
#status-bar.disconnected{background:var(--red)}
#status-bar .left,#status-bar .right{display:flex;align-items:center;gap:8px}

/* Autocomplete */
#ac-panel{position:fixed;z-index:100;background:var(--bg2);border:1px solid var(--border);border-radius:6px;max-height:240px;overflow-y:auto;min-width:200px;max-width:400px;display:none;box-shadow:0 8px 24px rgba(0,0,0,.5);padding:4px 0;font-size:12px}
.ac-item{padding:5px 10px;color:var(--text2);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center;gap:6px;margin:0 4px;border-radius:4px}
.ac-item.active{background:rgba(88,166,255,.15);color:var(--text)}
.ac-item:hover:not(.active){background:rgba(255,255,255,.04)}
.ac-match{color:var(--accent);font-weight:700}
.ac-icon{font-size:10px;opacity:.4;width:14px;text-align:center;flex-shrink:0}
.ac-label{font-size:9px;color:var(--text3);margin-left:auto;flex-shrink:0}

/* Mobile bottom bar */
#mobile-bar{display:none;flex-direction:column;background:var(--bg2);border-top:1px solid var(--border);flex-shrink:0}
@media(pointer:coarse){#mobile-bar{display:flex}}
#quick-cmds{display:flex;padding:6px 8px;gap:6px;overflow-x:auto;-webkit-overflow-scrolling:touch}
#quick-cmds::-webkit-scrollbar{display:none}
.qcmd{padding:8px 14px;background:var(--bg3);border:1px solid var(--border);border-radius:6px;color:var(--text2);font:11px/1 var(--font);cursor:pointer;white-space:nowrap;flex-shrink:0;touch-action:manipulation;-webkit-tap-highlight-color:transparent;transition:background .15s}
.qcmd:active{background:rgba(88,166,255,.15);border-color:var(--accent)}
#mobile-kb{display:flex;padding:4px 8px 6px;gap:4px;overflow-x:auto;-webkit-overflow-scrolling:touch}
#mobile-kb::-webkit-scrollbar{display:none}
.kb-key{min-width:32px;height:30px;padding:0 7px;background:var(--bg3);color:var(--text2);border:1px solid var(--border);border-radius:5px;font:12px/30px var(--font);text-align:center;cursor:pointer;user-select:none;-webkit-user-select:none;flex-shrink:0;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
.kb-key:active{background:rgba(255,255,255,.1)}
.kb-key.mod{background:var(--bg);color:var(--text3);font-size:10px;min-width:38px}
.kb-key.mod.on{background:var(--accent2);color:#fff;border-color:var(--accent2)}
.kb-key.arrow{font-size:14px;min-width:30px;padding:0 4px}

/* Context menu */
#ctx-menu{position:fixed;z-index:200;background:var(--bg2);border:1px solid var(--border);border-radius:8px;min-width:200px;max-width:320px;max-height:80vh;overflow-y:auto;padding:4px 0;display:none;box-shadow:0 8px 30px rgba(0,0,0,.7);font-size:12px}
.ctx-header{padding:4px 14px 3px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text3);user-select:none;margin-top:2px}
.ctx-item{padding:7px 14px;color:var(--text2);cursor:pointer;display:flex;align-items:center;gap:8px;transition:background .1s}
.ctx-item:hover{background:rgba(88,166,255,.12);color:var(--text)}
.ctx-item:active{background:rgba(88,166,255,.2)}
.ctx-item .ctx-key{margin-left:auto;font-size:10px;color:var(--text3);flex-shrink:0}
.ctx-item .ctx-ico{width:16px;text-align:center;font-size:13px;flex-shrink:0;opacity:.5}
.ctx-sep{height:1px;background:var(--border);margin:4px 0}
.ctx-item.danger:hover{background:rgba(248,81,73,.12);color:var(--red)}
.ctx-item.ai{color:var(--purple)}
.ctx-item.ai:hover{background:rgba(139,92,246,.12)}

/* Favorites */
.fav-star{width:28px;height:28px;border:none;background:none;color:var(--text3);font-size:16px;cursor:pointer;border-radius:4px;flex-shrink:0;display:flex;align-items:center;justify-content:center;transition:color .15s;-webkit-tap-highlight-color:transparent}
.fav-star:hover{color:var(--orange)}
.fav-star.on{color:var(--orange)}
.ses-cmd{font-size:10px;color:var(--accent);opacity:.7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px;font-style:italic}
.fav-rm{width:24px;height:24px;border:none;background:none;color:var(--text3);font-size:14px;cursor:pointer;border-radius:4px;flex-shrink:0;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .15s}
.ses-card:hover .fav-rm{opacity:.6}
.fav-rm:hover{opacity:1!important;color:var(--red)}

/* Mobile options panel */
#mobile-panel-overlay{position:fixed;inset:0;z-index:300;background:rgba(0,0,0,.5);display:none;-webkit-tap-highlight-color:transparent}
#mobile-panel-overlay.show{display:block}
#mobile-panel{position:fixed;left:0;right:0;bottom:0;z-index:301;max-height:75vh;background:var(--bg2);border-top:1px solid var(--border);border-radius:16px 16px 0 0;transform:translateY(100%);transition:transform .25s ease;overflow-y:auto;-webkit-overflow-scrolling:touch;padding-bottom:env(safe-area-inset-bottom,0)}
#mobile-panel.show{transform:translateY(0)}
.mp-handle{width:36px;height:4px;background:var(--border);border-radius:2px;margin:10px auto 6px}
.mp-section{padding:4px 12px 10px}
.mp-label{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text3);padding:6px 4px 4px}
.mp-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.mp-btn{display:flex;align-items:center;gap:8px;padding:12px;background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius);cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation}
.mp-btn:active{background:rgba(88,166,255,.12);border-color:var(--accent2)}
.mp-btn .mp-icon{width:28px;height:28px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;flex-shrink:0}
.mp-btn .mp-icon.ai{background:rgba(139,92,246,.15);color:#a78bfa}
.mp-btn .mp-icon.green{background:rgba(63,185,80,.12);color:var(--green)}
.mp-btn .mp-icon.blue{background:rgba(88,166,255,.1);color:var(--accent)}
.mp-btn .mp-icon.orange{background:rgba(210,153,34,.1);color:var(--orange)}
.mp-btn .mp-txt{min-width:0}
.mp-btn .mp-t1{font-size:12px;font-weight:600;color:var(--text)}
.mp-btn .mp-t2{font-size:9px;color:var(--text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}
.mp-pills{display:flex;flex-wrap:wrap;gap:5px;padding:4px 0}
.mp-pill{padding:8px 12px;background:var(--bg3);border:1px solid var(--border);border-radius:6px;color:var(--text2);font:11px/1 var(--font);cursor:pointer;white-space:nowrap;-webkit-tap-highlight-color:transparent;touch-action:manipulation}
.mp-pill:active{background:rgba(88,166,255,.15);border-color:var(--accent);color:var(--text)}
.mp-pill.sig{color:var(--orange);border-color:rgba(210,153,34,.3)}
.mp-pill.sig:active{background:rgba(210,153,34,.15);border-color:var(--orange)}
.mp-hist{display:flex;flex-direction:column;gap:2px;padding:4px 0;max-height:160px;overflow-y:auto}
.mp-hist-item{padding:7px 10px;color:var(--text2);font-size:11px;border-radius:5px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;-webkit-tap-highlight-color:transparent}
.mp-hist-item:active{background:rgba(88,166,255,.12);color:var(--text)}
.mp-row{display:flex;gap:5px;padding:4px 0;flex-wrap:wrap}
.mp-act{flex:1;min-width:60px;padding:10px 6px;background:var(--bg3);border:1px solid var(--border);border-radius:6px;color:var(--text2);font:11px/1 var(--font);text-align:center;cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation}
.mp-act:active{background:rgba(88,166,255,.15);border-color:var(--accent)}
.top-btn.opt-btn{font-size:18px;letter-spacing:-1px}

/* Git viewer overlay */
#git-overlay{position:fixed;inset:0;z-index:400;background:rgba(0,0,0,.6);display:none;align-items:flex-end;justify-content:center}
#git-overlay.show{display:flex}
#git-viewer{width:100%;max-width:700px;max-height:85vh;background:var(--bg);border:1px solid var(--border);border-radius:12px 12px 0 0;display:flex;flex-direction:column;overflow:hidden}
.gv-bar{display:flex;align-items:center;padding:10px 14px;background:var(--bg2);border-bottom:1px solid var(--border);gap:8px;flex-shrink:0}
.gv-title{font-size:13px;font-weight:700;color:var(--text);flex:1}
.gv-tab{padding:5px 10px;font:11px/1 var(--font);color:var(--text3);background:none;border:1px solid transparent;border-radius:5px;cursor:pointer}
.gv-tab.active{color:var(--text);background:var(--bg3);border-color:var(--border)}
.gv-tab:hover:not(.active){color:var(--text2)}
.gv-close{width:28px;height:28px;background:none;border:none;color:var(--text3);font-size:16px;cursor:pointer;border-radius:4px;display:flex;align-items:center;justify-content:center}
.gv-close:hover{color:var(--text);background:rgba(255,255,255,.06)}
.gv-body{flex:1;overflow:auto;-webkit-overflow-scrolling:touch;padding:0;font-size:12px;line-height:1.5}
.gv-body pre{margin:0;padding:10px 14px;white-space:pre-wrap;word-break:break-all;font-family:var(--font);color:var(--text2)}
.gv-line{display:block;padding:0 14px}
.gv-line.add{background:rgba(63,185,80,.1);color:#7ee787}
.gv-line.del{background:rgba(248,81,73,.1);color:#ffa198}
.gv-line.hunk{color:var(--purple);background:rgba(188,140,255,.06);font-weight:600;padding-top:8px;margin-top:4px;border-top:1px solid var(--border)}
.gv-line.meta{color:var(--text3);font-style:italic}
.gv-empty{padding:40px 20px;text-align:center;color:var(--text3);font-size:12px}
.gv-stat{display:flex;gap:6px;padding:8px 14px;background:var(--bg2);border-bottom:1px solid var(--border);font-size:11px;color:var(--text3);flex-shrink:0;flex-wrap:wrap}
.gv-stat span{padding:2px 6px;border-radius:3px;font-weight:600}
.gv-stat .s-add{background:rgba(63,185,80,.15);color:var(--green)}
.gv-stat .s-del{background:rgba(248,81,73,.15);color:var(--red)}
.gv-stat .s-file{color:var(--accent)}
</style></head>
<body>

<!-- DASHBOARD -->
<div id="dashboard">
<div class="dash-inner">
  <div class="dash-hero"><h1>Term<span>Link</span></h1><p>Remote dev terminal &mdash; phone, tablet, anywhere</p></div>

  <div class="dash-section"><div class="dash-label">Quick Actions</div>
    <div class="act-grid" id="actions"></div>
  </div>

  <div class="dash-section" id="fav-section" style="display:none"><div class="dash-label">Favorites</div>
    <div class="ses-list" id="fav-list"></div>
  </div>

  <div class="dash-section"><div class="dash-label">Active Sessions</div>
    <div class="ses-list" id="active-list"></div>
  </div>

  <div class="dash-section"><div class="dash-label">Recent Sessions</div>
    <div class="ses-list" id="archive-list"></div>
  </div>

  <div class="dash-section"><div class="dash-label">Recent Folders</div>
    <div class="ses-list" id="folder-list"></div>
  </div>
</div>
</div>

<!-- TERMINAL -->
<div id="terminal-view" class="hidden">
  <div id="top-bar">
    <button class="top-btn" id="home-btn" title="Home">&#8962;</button>
    <div id="tab-bar"></div>
    <button class="top-btn" id="add-tab" title="New tab">+</button>
    <button class="top-btn opt-btn" id="opt-btn" title="Options">&#8943;</button>
  </div>
  <div id="terminals"></div>
  <div id="ac-panel"></div>
  <div id="ctx-menu"></div>
  <div id="status-bar"><div class="left"><span id="sb-name">-</span><span style="opacity:.4">|</span><span id="sb-cwd">~</span></div><div class="right"><span id="sb-status">...</span></div></div>
  <div id="mobile-bar">
    <div id="quick-cmds"></div>
    <div id="mobile-kb"></div>
  </div>
</div>
<div id="mobile-panel-overlay"></div>
<div id="mobile-panel"><div class="mp-handle"></div><div id="mp-content"></div></div>
<div id="git-overlay"><div id="git-viewer"><div class="gv-bar"><span class="gv-title">Git</span><div id="gv-tabs"></div><button class="gv-close" id="gv-close">&times;</button></div><div class="gv-stat" id="gv-stat"></div><div class="gv-body" id="gv-body"></div></div></div>

<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-web-links@0.11.0/lib/addon-web-links.min.js"></script>
<script>
(function(){
  var TK = "__WS_TOKEN__";
  var SESSIONS = __SESSION_LIST__;
  var ARCHIVE = __ARCHIVE__;
  var FAVORITES = __FAVORITES__;
  var FOLDERS = __RECENT_FOLDERS__;

  var $ = document.getElementById.bind(document);
  var dash = $("dashboard"), tv = $("terminal-view");
  var tabBar = $("tab-bar"), terminalsEl = $("terminals"), acPanel = $("ac-panel");
  var sbName = $("sb-name"), sbCwd = $("sb-cwd"), sbStatus = $("sb-status"), statusBar = $("status-bar");

  var sMap = {}, activeId = null, cmdHistory = [];

  /* ---- Helpers ---- */
  function api(p) { return p + (p.indexOf("?") >= 0 ? "&" : "?") + "token=" + encodeURIComponent(TK); }
  function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function ago(ts) { if (!ts) return ""; var d = (Date.now() - ts) / 1000; if (d < 60) return "now"; if (d < 3600) return Math.floor(d/60) + "m"; if (d < 86400) return Math.floor(d/3600) + "h"; return Math.floor(d/86400) + "d"; }
  function short(p) { if (!p) return "~"; var s = p.replace(/\\\\/g, "/").split("/").filter(Boolean); return s.length > 2 ? "../" + s.slice(-2).join("/") : p; }
  function fname(p) { if (!p) return ""; return p.replace(/\\\\/g, "/").split("/").filter(Boolean).pop() || ""; }
  function tIcon(t) { return {claude:"C",vertex:"V",gcloud:"G",aws:"A",azure:"Az",ssh:"S",docker:"D",k8s:"K",python:"Py",node:"N",npm:"n",git:"G",terminal:">"}[t] || ">"; }

  /* ---- Favorites helpers ---- */
  function isFav(cwd, command) {
    return FAVORITES.some(function(f) { return f.cwd === (cwd||"") && f.command === (command||""); });
  }
  function addFav(name, cwd, command, tool) {
    fetch(api("/api/favorites"), { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({name:name,cwd:cwd,command:command,tool:tool}) })
      .then(function(r){return r.json()}).then(function() { refreshFavs(); }).catch(function(){});
  }
  function removeFav(idx) {
    fetch(api("/api/favorites/" + idx), { method: "DELETE" })
      .then(function(r){return r.json()}).then(function() { refreshFavs(); }).catch(function(){});
  }
  function refreshFavs() {
    fetch(api("/api/favorites")).then(function(r){return r.json()}).then(function(d){ if(Array.isArray(d)){FAVORITES=d;renderDash();} }).catch(function(){});
  }

  /* ---- Dashboard ---- */
  function renderDash() {
    /* Actions */
    var ag = $("actions");
    ag.innerHTML = "";
    var acts = [
      { title: "New Terminal", sub: "shell session", cls: "terminal", icon: ">_", fn: function() { addSession(); } },
      { title: "Claude", sub: "--continue", cls: "claude", icon: "C", fn: function() { launch("claude --continue", "claude"); } },
      { title: "New Claude", sub: "fresh session", cls: "claude", icon: "C+", fn: function() { launch("claude", "claude"); } },
      { title: "Vertex AI", sub: "gcloud session", cls: "vertex", icon: "V", fn: function() { launch("", "vertex"); } },
    ];
    acts.forEach(function(a) {
      var el = document.createElement("div"); el.className = "act-btn";
      el.innerHTML = '<div class="act-icon ' + a.cls + '">' + esc(a.icon) + '</div><div class="act-text"><div class="act-title">' + esc(a.title) + '</div><div class="act-sub">' + esc(a.sub) + '</div></div>';
      el.onclick = a.fn; ag.appendChild(el);
    });

    /* Favorites */
    var fs = $("fav-section"), fl2 = $("fav-list"); fl2.innerHTML = "";
    if (FAVORITES.length) {
      fs.style.display = "";
      FAVORITES.forEach(function(f, idx) {
        var el = document.createElement("div"); el.className = "ses-card";
        var icon = tIcon(f.tool || "terminal");
        var nm = f.name || fname(f.cwd) || f.command || "favorite";
        var cmdLine = f.command ? '<div class="ses-cmd">' + esc(f.command) + '</div>' : '';
        el.innerHTML = '<span class="ses-dot" style="background:var(--orange)"></span><div class="ses-info"><div class="ses-name">' + esc(nm) + '</div><div class="ses-path">' + esc(short(f.cwd)) + '</div>' + cmdLine + '</div><button class="fav-rm" data-fav-idx="' + idx + '" title="Remove">&times;</button>';
        el.onclick = function(e) { if (e.target.closest(".fav-rm")) return; launchAt(f.cwd, f.command, f.name || f.tool); };
        el.querySelector(".fav-rm").onclick = function(e) { e.stopPropagation(); removeFav(idx); };
        fl2.appendChild(el);
      });
    } else { fs.style.display = "none"; }

    /* Active sessions */
    var al = $("active-list"); al.innerHTML = "";
    if (!SESSIONS.length) { al.innerHTML = '<div class="empty-msg">No active sessions</div>'; }
    SESSIONS.forEach(function(s) {
      var el = document.createElement("div"); el.className = "ses-card";
      var badge = s.tool && s.tool !== "terminal" ? '<span class="ses-badge ' + s.tool + '">' + esc(s.tool) + '</span>' : '';
      var dn = s.name || fname(s.cwd) || "Session " + (s.id + 1);
      el.innerHTML = '<span class="ses-dot live"></span><div class="ses-info"><div class="ses-name">' + esc(dn) + '</div><div class="ses-path">' + esc(short(s.cwd)) + '</div></div>' + badge + '<span class="ses-time">' + ago(s.lastActivity) + '</span>';
      el.onclick = function() { showTerm(); switchSes(s.id); };
      al.appendChild(el);
    });

    /* Archive — show full launch command for LLM sessions */
    var rl = $("archive-list"); rl.innerHTML = "";
    var arch = ARCHIVE.filter(function(a) { return a.tool === "claude" || a.tool === "vertex" || a.tool === "ssh" || a.lastCommand; });
    if (!arch.length) { rl.innerHTML = '<div class="empty-msg">Run Claude, Vertex, or SSH to see history here</div>'; }
    arch.slice(0, 10).forEach(function(a) {
      var el = document.createElement("div"); el.className = "ses-card";
      var badge = a.tool && a.tool !== "terminal" ? '<span class="ses-badge ' + a.tool + '">' + esc(a.tool) + '</span>' : '';
      var nm = a.name || a.tool || "terminal";
      var relaunchCmd = a.launchCommand || a.lastCommand || "";
      var cmdLine = relaunchCmd ? '<div class="ses-cmd">' + esc(relaunchCmd) + '</div>' : '';
      var starred = isFav(a.cwd, relaunchCmd);
      var starHtml = relaunchCmd ? '<button class="fav-star' + (starred ? " on" : "") + '" title="' + (starred ? "Saved" : "Save to favorites") + '">&#9733;</button>' : '';
      el.innerHTML = '<span class="ses-dot dead"></span><div class="ses-info"><div class="ses-name">' + esc(nm) + '</div><div class="ses-path">' + esc(short(a.cwd)) + '</div>' + cmdLine + '</div>' + badge + starHtml + '<span class="ses-time">' + ago(a.closed || a.lastActivity) + '</span>';
      el.onclick = function(e) {
        if (e.target.closest(".fav-star")) {
          if (!starred) addFav(nm, a.cwd, relaunchCmd, a.tool);
          return;
        }
        launchAt(a.cwd, relaunchCmd, nm);
      };
      rl.appendChild(el);
    });

    /* Folders — with star button */
    var fl = $("folder-list"); fl.innerHTML = "";
    if (!FOLDERS.length) { fl.innerHTML = '<div class="empty-msg">No recent folders yet</div>'; }
    FOLDERS.slice(0, 8).forEach(function(f) {
      var el = document.createElement("div"); el.className = "ses-card";
      var starred = isFav(f.cwd, "");
      el.innerHTML = '<span class="ses-dot" style="background:var(--orange)"></span><div class="ses-info"><div class="ses-name">' + esc(fname(f.cwd)) + '</div><div class="ses-path">' + esc(f.cwd) + '</div></div><button class="fav-star' + (starred ? " on" : "") + '" title="' + (starred ? "Saved" : "Save to favorites") + '">&#9733;</button><span class="ses-time">' + ago(f.lastActivity) + '</span>';
      el.onclick = function(e) {
        if (e.target.closest(".fav-star")) {
          if (!starred) addFav(fname(f.cwd), f.cwd, "", "terminal");
          return;
        }
        launchAt(f.cwd, "", "");
      };
      fl.appendChild(el);
    });
  }

  function showDash() {
    dash.classList.remove("hidden"); tv.classList.add("hidden");
    fetch(api("/api/sessions")).then(function(r){return r.json()}).then(function(d){SESSIONS=d;renderDash()}).catch(function(){});
    fetch(api("/api/archive")).then(function(r){return r.json()}).then(function(d){ARCHIVE=Array.isArray(d)?d.reverse():d;renderDash()}).catch(function(){});
    fetch(api("/api/favorites")).then(function(r){return r.json()}).then(function(d){if(Array.isArray(d)){FAVORITES=d;renderDash();}}).catch(function(){});
  }

  function showTerm() {
    dash.classList.add("hidden"); tv.classList.remove("hidden");
    setTimeout(function() { if (activeId !== null && sMap[activeId]) { sMap[activeId].fitAddon.fit(); sMap[activeId].term.focus(); } }, 50);
  }

  function launch(cmd, name) {
    var cwd = (activeId !== null && sMap[activeId]) ? sMap[activeId].cwd : "";
    fetch(api("/api/quick-launch"), { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({command:cmd,name:name,cwd:cwd||undefined}) })
      .then(function(r){return r.json()}).then(function(d){ if(d.error){alert(d.error);return;} createSes(d.id,true,d); showTerm(); }).catch(function(e){alert(e.message)});
  }
  function launchAt(cwd, cmd, name) {
    fetch(api("/api/quick-launch"), { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({cwd:cwd,command:cmd,name:name}) })
      .then(function(r){return r.json()}).then(function(d){ if(d.error){alert(d.error);return;} createSes(d.id,true,d); showTerm(); }).catch(function(e){alert(e.message)});
  }

  /* ---- History ---- */
  fetch(api("/api/history")).then(function(r){return r.json()}).then(function(d){if(Array.isArray(d))cmdHistory=d}).catch(function(){});

  /* ---- Mobile mods ---- */
  var kbMods = { ctrl: false, alt: false };
  function updMods() { var bs = document.querySelectorAll(".kb-key[data-mod]"); for (var i = 0; i < bs.length; i++) bs[i].classList.toggle("on", !!kbMods[bs[i].getAttribute("data-mod")]); }

  /* ---- Autocomplete ---- */
  var acTimer = null;
  var BASE = ["cd","ls","pwd","clear","exit","git status","git add .","git commit","git push","git pull","git diff","git log --oneline -5","npm install","npm run","npm start","npm test","docker ps","docker run","python3","node","ssh","curl","mkdir","rm","cp","mv","grep","find","echo","export","claude","claude --continue","gcloud","aws","kubectl"];

  function acResults(q) {
    if (!q) return []; var ql = q.toLowerCase(), seen = {}, res = [];
    for (var i = cmdHistory.length - 1; i >= 0 && res.length < 16; i--) {
      var c = cmdHistory[i]; if (seen[c]) continue; var cl = c.toLowerCase(), sc = 0;
      if (cl.indexOf(ql) === 0) sc = 100 + (i / cmdHistory.length) * 15;
      else if (cl.indexOf(" " + ql) >= 0) sc = 60 + (i / cmdHistory.length) * 10;
      else if (cl.indexOf(ql) >= 0) sc = 40 + (i / cmdHistory.length) * 10;
      else { var qi = 0; for (var ci = 0; ci < cl.length && qi < ql.length; ci++) { if (cl[ci] === ql[qi]) qi++; } if (qi === ql.length) sc = 15; }
      if (sc > 0 && c !== q) { seen[c] = true; res.push({ cmd: c, sc: sc, src: "history" }); }
    }
    for (var j = 0; j < BASE.length && res.length < 16; j++) {
      if (!seen[BASE[j]] && BASE[j].toLowerCase().indexOf(ql) === 0 && BASE[j] !== q) { seen[BASE[j]] = true; res.push({ cmd: BASE[j], sc: 5, src: "base" }); }
    }
    res.sort(function(a, b) { return b.sc - a.sc; }); return res.slice(0, 8);
  }
  function hlM(t, q) {
    var i = t.toLowerCase().indexOf(q.toLowerCase());
    if (i >= 0) return esc(t.substring(0,i)) + '<span class="ac-match">' + esc(t.substring(i, i+q.length)) + '</span>' + esc(t.substring(i+q.length));
    var h = "", qi = 0, ql = q.toLowerCase();
    for (var x = 0; x < t.length; x++) { if (qi < ql.length && t[x].toLowerCase() === ql[qi]) { h += '<span class="ac-match">' + esc(t[x]) + '</span>'; qi++; } else h += esc(t[x]); }
    return h;
  }
  function showAc() {
    var s = sMap[activeId]; if (!s) return; var st = s.ac, q = st.buf;
    if (q.length < 1) { hideAc(); return; }
    var res = acResults(q); if (!res.length) { hideAc(); return; }
    st.items = res.map(function(r) { return r.cmd; }); st.visible = true; if (st.idx >= res.length) st.idx = 0;
    var h = "";
    for (var j = 0; j < res.length; j++) {
      h += '<div class="ac-item' + (j === st.idx ? " active" : "") + '" data-i="' + j + '"><span class="ac-icon">' + (res[j].src === "history" ? "&#8635;" : "&gt;") + '</span><span>' + hlM(res[j].cmd, q) + '</span>' + (res[j].src === "history" ? '<span class="ac-label">history</span>' : '') + '</div>';
    }
    acPanel.innerHTML = h; acPanel.style.display = "block"; posAc(s);
  }
  function hideAc() { acPanel.style.display = "none"; if (sMap[activeId]) { var st = sMap[activeId].ac; st.visible = false; st.items = []; st.idx = 0; } }
  function posAc(s) {
    var scr = s.container.querySelector(".xterm-screen"); if (!scr) return;
    var r = scr.getBoundingClientRect(), cw = r.width / s.term.cols, ch = r.height / s.term.rows;
    var l = r.left + s.term.buffer.active.cursorX * cw, tp = r.top + s.term.buffer.active.cursorY * ch, ph = acPanel.offsetHeight || 100;
    acPanel.style.top = (tp - ph > 0 ? tp - ph : tp + ch + 2) + "px";
    acPanel.style.left = Math.max(0, Math.min(l, innerWidth - 220)) + "px";
  }
  function navAc(d) { var s = sMap[activeId]; if (!s || !s.ac.visible) return; var st = s.ac; st.idx = (st.idx + d + st.items.length) % st.items.length; var els = acPanel.querySelectorAll(".ac-item"); for (var i = 0; i < els.length; i++) els[i].className = "ac-item" + (i === st.idx ? " active" : ""); if (els[st.idx]) els[st.idx].scrollIntoView({ block: "nearest" }); }
  function complAc(s) { var st = s.ac; if (!st.visible || !st.items.length) return; var r = st.items[st.idx].substring(st.buf.length); if (r && s.ws && s.ws.readyState === 1) s.ws.send(JSON.stringify({ type: "input", data: r })); st.buf = st.items[st.idx]; hideAc(); }

  function handleAc(ses, data) {
    var st = ses.ac;
    if (data === "\\r" || data === "\\n") { var cmd = st.buf.trim(); if (cmd) { if (!cmdHistory.length || cmdHistory[cmdHistory.length-1] !== cmd) { cmdHistory.push(cmd); if (cmdHistory.length > 1000) cmdHistory.splice(0, cmdHistory.length - 1000); } fetch(api("/api/history"), { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({command:cmd,sessionId:ses.id}) }).catch(function(){}); } st.buf = ""; hideAc(); return false; }
    if (data.length === 1 && data.charCodeAt(0) < 32 && data !== "\\t") { st.buf = ""; hideAc(); return false; }
    if (data === "\\t") { if (st.visible && st.items.length) { complAc(ses); return true; } return false; }
    if (data === "\\x1b") { if (st.visible) { hideAc(); return true; } return false; }
    if (data === "\\x1b[A") { if (st.visible) { navAc(-1); return true; } return false; }
    if (data === "\\x1b[B") { if (st.visible) { navAc(1); return true; } return false; }
    if (data === "\\x1b[C" || data === "\\x1b[D") { hideAc(); return false; }
    if (data === "\\x7f" || data === "\\b") { if (st.buf.length) st.buf = st.buf.slice(0, -1); clearTimeout(acTimer); acTimer = setTimeout(showAc, 60); return false; }
    if (data.length === 1 && data.charCodeAt(0) >= 32) { st.buf += data; clearTimeout(acTimer); acTimer = setTimeout(showAc, 60); return false; }
    if (data.length > 1 && data.charCodeAt(0) >= 32) { var nl = Math.max(data.lastIndexOf("\\r"), data.lastIndexOf("\\n")); st.buf = nl >= 0 ? data.substring(nl+1) : st.buf + data; clearTimeout(acTimer); acTimer = setTimeout(showAc, 60); return false; }
    return false;
  }
  function sendIn(ses, data) { if (handleAc(ses, data)) return; if (ses.ws && ses.ws.readyState === 1) ses.ws.send(JSON.stringify({ type: "input", data: data })); }

  acPanel.addEventListener("mousedown", function(e) { e.preventDefault(); });
  acPanel.addEventListener("click", function(e) { var el = e.target.closest(".ac-item"); if (!el) return; var s = sMap[activeId]; if (!s) return; s.ac.idx = parseInt(el.getAttribute("data-i"), 10); complAc(s); s.term.focus(); });

  /* ---- Status bar ---- */
  function updSB() {
    var s = sMap[activeId]; if (!s) return;
    sbName.textContent = s.name || ("Session " + (s.id + 1));
    sbCwd.textContent = short(s.cwd || "");
    var ok = s.ws && s.ws.readyState === 1;
    sbStatus.textContent = ok ? "connected" : "reconnecting...";
    statusBar.className = ok ? "" : "disconnected";
  }

  /* ---- Session management ---- */
  function createSes(id, sw, meta) {
    meta = meta || {};
    var ct = document.createElement("div"); ct.className = "term-container"; ct.style.display = "none"; terminalsEl.appendChild(ct);

    var dn = meta.name || fname(meta.cwd) || ("Session " + (id + 1));
    var tab = document.createElement("div"); tab.className = "tab"; tab.setAttribute("data-session", id); tab.title = meta.cwd || dn;
    var ti = document.createElement("span"); ti.className = "tab-icon"; ti.textContent = tIcon(meta.tool || "terminal"); tab.appendChild(ti);
    var lbl = document.createElement("span"); lbl.className = "tab-label"; lbl.textContent = dn; tab.appendChild(lbl);
    if (id !== 0) { var cb = document.createElement("span"); cb.className = "tab-close"; cb.setAttribute("data-session", id); cb.textContent = "\\u00d7"; tab.appendChild(cb); }
    tabBar.appendChild(tab);

    var term = new Terminal({ cursorBlink: true, fontSize: 14, fontFamily: "var(--font)", theme: { background: "#0d1117", foreground: "#e6edf3", cursor: "#58a6ff", selectionBackground: "rgba(88,166,255,.3)" }, scrollback: 10000, convertEol: false, allowProposedApi: true });
    var fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.loadAddon(new WebLinksAddon.WebLinksAddon()); term.open(ct);

    var ses = { id: id, term: term, fitAddon: fit, ws: null, container: ct, tabEl: tab, dead: false, name: meta.name || "", cwd: meta.cwd || "", tool: meta.tool || "terminal", userNamed: !!(meta.name), ac: { buf: "", visible: false, items: [], idx: 0 } };
    sMap[id] = ses;

    lbl.addEventListener("dblclick", function(e) { e.stopPropagation(); e.preventDefault(); startRename(ses); });

    term.attachCustomKeyEventHandler(function(ev) {
      if (ev.type !== "keydown") return true;
      if ((ev.ctrlKey || ev.metaKey) && ev.key === "k") { ev.preventDefault(); showDash(); return false; }
      if ((ev.ctrlKey || ev.metaKey) && ev.key === "t") { ev.preventDefault(); addSession(); return false; }
      if (kbMods.ctrl && !ev.ctrlKey && !ev.altKey && !ev.metaKey && ev.key.length === 1) { var c = ev.key.toLowerCase().charCodeAt(0); if (c >= 97 && c <= 122) { sendIn(ses, String.fromCharCode(c - 96)); kbMods.ctrl = false; updMods(); return false; } }
      if (kbMods.alt && !ev.ctrlKey && !ev.altKey && !ev.metaKey && ev.key.length === 1) { sendIn(ses, "\\x1b" + ev.key); kbMods.alt = false; updMods(); return false; }
      return true;
    });

    var rDelay = 500;
    function connect() {
      var ws = new WebSocket((location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host + "/ws?session=" + id + "&token=" + encodeURIComponent(TK));
      ses.ws = ws;
      ws.onopen = function() { rDelay = 500; updSB(); var d = fit.proposeDimensions(); if (d) ws.send(JSON.stringify({ type: "resize", cols: d.cols, rows: d.rows })); };
      ws.onmessage = function(ev) { var m; try { m = JSON.parse(ev.data); } catch(e) { return; }
        if (m.type === "output") term.write(m.data);
        else if (m.type === "resize") { term.resize(m.cols, m.rows); setTimeout(function() { fit.fit(); }, 50); }
        else if (m.type === "exit") { term.write("\\r\\n[exited " + m.code + "]\\r\\n"); ses.dead = true; }
        else if (m.type === "cwd") { ses.cwd = m.cwd; ses.tabEl.title = m.cwd; if (!ses.userNamed && ses.tool === "terminal") { var fn = fname(m.cwd); if (fn) { ses.name = fn; var lb = ses.tabEl.querySelector(".tab-label"); if (lb) lb.textContent = fn; } } updSB(); }
        else if (m.type === "event" && m.event === "archive-updated") { fetch(api("/api/archive")).then(function(r){return r.json()}).then(function(d){ARCHIVE=Array.isArray(d)?d.reverse():d}).catch(function(){}); }
      };
      ws.onclose = function(ev) { if (ses.dead) return; if (ev.code === 4401) { sbStatus.textContent = "unauthorized"; statusBar.className = "disconnected"; return; } updSB(); setTimeout(connect, rDelay); rDelay = Math.min(rDelay * 1.5, 5000); };
      ws.onerror = function() { ws.close(); };
    }
    connect();
    term.onData(function(d) { sendIn(ses, d); });
    term.onResize(function(sz) { if (ses.ws && ses.ws.readyState === 1) ses.ws.send(JSON.stringify({ type: "resize", cols: sz.cols, rows: sz.rows })); });
    if (sw) switchSes(id);
  }

  var renaming = false;
  function startRename(ses) {
    if (renaming) return;
    renaming = true;
    var lbl = ses.tabEl.querySelector(".tab-label");
    var inp = document.createElement("input"); inp.type = "text"; inp.className = "tab-rename"; inp.value = ses.name || lbl.textContent;
    lbl.style.display = "none"; ses.tabEl.insertBefore(inp, lbl);
    setTimeout(function() { inp.focus(); inp.select(); }, 50);
    var finished = false;
    function done() {
      if (finished) return; finished = true; renaming = false;
      var v = inp.value.trim();
      if (v) { ses.name = v; ses.userNamed = true; lbl.textContent = v; fetch(api("/api/sessions/" + ses.id), { method: "PUT", headers: {"Content-Type":"application/json"}, body: JSON.stringify({name:v}) }).catch(function(){}); }
      lbl.style.display = ""; if (inp.parentNode) inp.remove(); updSB();
    }
    inp.addEventListener("blur", done);
    inp.addEventListener("keydown", function(e) { if (e.key === "Enter") { e.preventDefault(); inp.blur(); } if (e.key === "Escape") { inp.value = lbl.textContent; inp.blur(); } });
  }

  function switchSes(id) {
    var s = sMap[id]; if (!s) return;
    if (activeId !== null && sMap[activeId]) { sMap[activeId].container.style.display = "none"; sMap[activeId].tabEl.classList.remove("active"); }
    activeId = id; hideAc(); s.container.style.display = ""; s.tabEl.classList.add("active");
    setTimeout(function() { s.fitAddon.fit(); if (!renaming) s.term.focus(); }, 20); updSB();
  }

  function closeSes(id) {
    if (id === 0) return; var s = sMap[id]; if (!s) return;
    s.dead = true; if (s.ws) s.ws.close(); s.term.dispose(); s.container.remove(); s.tabEl.remove(); delete sMap[id];
    if (activeId === id) { var ids = Object.keys(sMap).map(Number).sort(function(a,b){return a-b}); if (ids.length) switchSes(ids[0]); else showDash(); }
    fetch(api("/api/sessions/" + id), { method: "DELETE" });
  }

  function addSession() {
    fetch(api("/api/sessions"), { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({}) })
      .then(function(r){return r.json()}).then(function(d){ if(d.error){alert(d.error);return;} createSes(d.id,true,d); showTerm(); }).catch(function(e){alert(e.message)});
  }

  /* ---- Events ---- */
  $("home-btn").onclick = showDash;
  $("add-tab").onclick = addSession;
  tabBar.addEventListener("click", function(e) {
    if (e.target.classList.contains("tab-close")) { e.stopPropagation(); closeSes(parseInt(e.target.getAttribute("data-session"), 10)); return; }
    var tab = e.target.closest(".tab"); if (tab) switchSes(parseInt(tab.getAttribute("data-session"), 10));
  });
  document.addEventListener("keydown", function(e) { if ((e.ctrlKey || e.metaKey) && e.key === "k" && !tv.classList.contains("hidden")) { e.preventDefault(); showDash(); } });

  /* ---- Shared: send command to active session ---- */
  function runCmd(cmd, enter) {
    var s = sMap[activeId]; if (!s || !s.ws || s.ws.readyState !== 1) return;
    s.ws.send(JSON.stringify({ type: "input", data: cmd + (enter !== false ? "\\r" : "") }));
    s.term.focus();
  }
  function sendSig(sig) { var s = sMap[activeId]; if (s && s.ws && s.ws.readyState === 1) s.ws.send(JSON.stringify({ type: "input", data: sig })); }

  /* ---- AI preset commands ---- */
  var AI_PRESETS = [
    { label: "Claude --continue", cmd: "claude --continue", cls: "ai" },
    { label: "Claude Opus", cmd: "claude --model opus", cls: "ai" },
    { label: "Claude Sonnet", cmd: "claude --model sonnet", cls: "ai" },
    { label: "Claude Opus (skip perms)", cmd: "claude --model opus --dangerously-skip-permissions", cls: "ai" },
    { label: "Claude Sonnet (skip perms)", cmd: "claude --model sonnet --dangerously-skip-permissions", cls: "ai" },
    { label: "New Claude session", cmd: "claude", cls: "ai" },
    { label: "Vertex AI", cmd: "vertex", cls: "ai" },
  ];

  /* ---- Context menu ---- */
  var ctxMenu = $("ctx-menu"), ctxTarget = null;
  function showCtx(x, y, items) {
    var h = "";
    items.forEach(function(it) {
      if (it === "---") { h += '<div class="ctx-sep"></div>'; return; }
      if (it.header) { h += '<div class="ctx-header">' + esc(it.header) + '</div>'; return; }
      h += '<div class="ctx-item' + (it.cls ? " " + it.cls : "") + '" data-action="' + esc(it.action) + '"'
        + (it.cmd ? ' data-cmd="' + esc(it.cmd) + '"' : '')
        + '>' + (it.ico ? '<span class="ctx-ico">' + it.ico + '</span>' : '')
        + esc(it.label) + (it.key ? '<span class="ctx-key">' + esc(it.key) + '</span>' : '') + '</div>';
    });
    ctxMenu.innerHTML = h; ctxMenu.style.display = "block";
    var mw = ctxMenu.offsetWidth, mh = ctxMenu.offsetHeight;
    ctxMenu.style.left = Math.min(x, innerWidth - mw - 8) + "px";
    ctxMenu.style.top = Math.max(4, Math.min(y, innerHeight - mh - 8)) + "px";
  }
  function hideCtx() { ctxMenu.style.display = "none"; ctxTarget = null; }
  document.addEventListener("click", function(e) { if (!ctxMenu.contains(e.target)) hideCtx(); });
  document.addEventListener("contextmenu", function(e) { if (!ctxMenu.contains(e.target)) hideCtx(); });

  ctxMenu.addEventListener("click", function(e) {
    var el = e.target.closest(".ctx-item"); if (!el) return;
    var act = el.getAttribute("data-action"), cmd = el.getAttribute("data-cmd");
    var tgt = ctxTarget != null && sMap[ctxTarget] ? sMap[ctxTarget] : sMap[activeId];
    if (act === "run" && cmd) { runCmd(cmd); }
    else if (act === "run-no-enter" && cmd) { runCmd(cmd, false); }
    else if (act === "git-open" && cmd) { openGit("git-" + cmd); }
    else if (act === "copy" && tgt) { var sel = tgt.term.getSelection(); if (sel) navigator.clipboard.writeText(sel).catch(function(){}); }
    else if (act === "paste" && tgt) { navigator.clipboard.readText().then(function(t) { if (t && tgt.ws && tgt.ws.readyState === 1) tgt.ws.send(JSON.stringify({ type: "input", data: t })); }).catch(function(){}); }
    else if (act === "selectall" && tgt) { tgt.term.selectAll(); }
    else if (act === "clear" && tgt) { tgt.term.clear(); }
    else if (act === "sigint") sendSig("\\x03");
    else if (act === "sigeof") sendSig("\\x04");
    else if (act === "sigtstp") sendSig("\\x1a");
    else if (act === "clearline") sendSig("\\x15");
    else if (act === "rename" && tgt) startRename(tgt);
    else if (act === "copypath" && tgt) navigator.clipboard.writeText(tgt.cwd || "").catch(function(){});
    else if (act === "favorite" && tgt) addFav(tgt.name || fname(tgt.cwd), tgt.cwd || "", "", tgt.tool || "terminal");
    else if (act === "close" && tgt && tgt.id !== 0) closeSes(tgt.id);
    else if (act === "newtab") addSession();
    else if (act === "home") showDash();
    hideCtx();
  });

  /* Right-click on terminal */
  terminalsEl.addEventListener("contextmenu", function(e) {
    e.preventDefault(); var s = sMap[activeId]; if (!s) return;
    var items = [];
    /* clipboard */
    if (s.term.getSelection()) items.push({ label: "Copy", action: "copy", key: "Ctrl+C", ico: "\\u2702" });
    items.push({ label: "Paste", action: "paste", key: "Ctrl+V", ico: "\\u2398" });
    items.push({ label: "Select All", action: "selectall", ico: "\\u25A8" });
    items.push("---");
    /* signals & clear */
    items.push({ label: "Interrupt (Ctrl+C)", action: "sigint", key: "^C" });
    items.push({ label: "EOF / Exit (Ctrl+D)", action: "sigeof", key: "^D" });
    items.push({ label: "Clear Terminal", action: "clear" });
    items.push("---");
    /* git */
    items.push({ header: "Git" });
    items.push({ label: "View Diff", action: "git-open", cmd: "diff" });
    items.push({ label: "View Staged", action: "git-open", cmd: "diff-staged" });
    items.push({ label: "View Status", action: "git-open", cmd: "status" });
    items.push({ label: "View Log", action: "git-open", cmd: "log" });
    /* AI quick run */
    items.push({ header: "AI Quick Run" });
    AI_PRESETS.slice(0, 4).forEach(function(p) { items.push({ label: p.label, action: "run", cmd: p.cmd, cls: p.cls }); });
    /* recent history */
    if (cmdHistory.length) {
      items.push({ header: "Recent Commands" });
      var seen = {}, rc = [];
      for (var i = cmdHistory.length - 1; i >= 0 && rc.length < 5; i--) {
        if (!seen[cmdHistory[i]]) { seen[cmdHistory[i]] = true; rc.push(cmdHistory[i]); }
      }
      rc.forEach(function(c) { items.push({ label: c.length > 40 ? c.substring(0, 37) + "..." : c, action: "run", cmd: c }); });
    }
    items.push("---");
    /* session actions */
    items.push({ label: "Rename Session", action: "rename" });
    items.push({ label: "Copy Path", action: "copypath" });
    items.push({ label: "Add to Favorites", action: "favorite" });
    items.push({ label: "New Tab", action: "newtab" });
    if (s.id !== 0) items.push("---", { label: "Close Session", action: "close", cls: "danger" });
    showCtx(e.clientX, e.clientY, items);
  });

  /* Right-click on tab */
  tabBar.addEventListener("contextmenu", function(e) {
    var tab = e.target.closest(".tab"); if (!tab) return;
    e.preventDefault();
    var tid = parseInt(tab.getAttribute("data-session"), 10);
    ctxTarget = tid;
    var items = [
      { label: "Rename", action: "rename" },
      { label: "Copy Path", action: "copypath" },
      { label: "Add to Favorites", action: "favorite" },
    ];
    if (tid !== 0) items.push("---", { label: "Close", action: "close", cls: "danger" });
    showCtx(e.clientX, e.clientY, items);
  });

  /* ---- Init ---- */
  for (var i = 0; i < SESSIONS.length; i++) createSes(SESSIONS[i].id, false, SESSIONS[i]);
  if (SESSIONS.length) switchSes(SESSIONS[0].id);
  renderDash();

  /* ---- Resize ---- */
  function doFit() { if (activeId !== null && sMap[activeId] && !tv.classList.contains("hidden")) sMap[activeId].fitAddon.fit(); }
  window.addEventListener("resize", doFit);
  window.addEventListener("orientationchange", function() { setTimeout(doFit, 200); });
  terminalsEl.addEventListener("click", function() { if (sMap[activeId]) sMap[activeId].term.focus(); });

  /* ---- Mobile quick commands (horizontal bar) ---- */
  (function() {
    var qc = $("quick-cmds");
    var cmds = [
      ["\\u2630 Menu", null, "menu"],
      ["Ctrl+C","\\x03"],["claude --continue","claude --continue\\r"],["cd ..","cd ..\\r"],
      ["ls","ls\\r"],["git status","git status\\r"],["git pull","git pull\\r"],
      ["clear","clear\\r"],["pwd","pwd\\r"],["exit","exit\\r"],
      ["npm run","npm run "],["python3","python3 "],["Ctrl+D","\\x04"]
    ];
    cmds.forEach(function(c) {
      var b = document.createElement("div"); b.className = "qcmd";
      b.textContent = c[0];
      if (c[2] === "menu") { b.style.fontWeight = "700"; b.style.color = "var(--accent)"; b.onclick = function() { openPanel(); }; }
      else { b.onclick = function() { var s = sMap[activeId]; if (s && s.ws && s.ws.readyState === 1) { s.ws.send(JSON.stringify({ type: "input", data: c[1] })); s.term.focus(); } }; }
      qc.appendChild(b);
    });
  })();

  /* ---- Mobile keyboard ---- */
  (function() {
    var kb = $("mobile-kb"); if (!kb) return;
    [["Tab","\\t","mod"],["Esc","\\x1b","mod"],["Ctrl",null,"mod","ctrl"],["Alt",null,"mod","alt"],
     ["\\u2191","\\x1b[A","arrow"],["\\u2193","\\x1b[B","arrow"],["\\u2190","\\x1b[D","arrow"],["\\u2192","\\x1b[C","arrow"],
     ["|"],["/"],["\\\\"],["~"],["-"],["_"],["."],[":"],[";"],["'"],["\\\""],["\\u0060"],
     ["{"],["}"],["["],["]"],["("],[")"],["<"],[">"],[" ="],[" !"],[" @"],["#"],["$"],["&"],["*"],["^"],["+"]
    ].forEach(function(k) {
      var b = document.createElement("button"); b.className = "kb-key" + (k[2] ? " " + k[2] : ""); b.textContent = k[0];
      if (k[3]) b.setAttribute("data-mod", k[3]);
      else if (k[1]) b.setAttribute("data-send", k[1]);
      else b.setAttribute("data-char", k[0].trim());
      kb.appendChild(b);
    });
    kb.addEventListener("mousedown", function(e) { e.preventDefault(); });
    kb.addEventListener("click", function(e) {
      var btn = e.target.closest(".kb-key"); if (!btn) return; var s = sMap[activeId]; if (!s) return;
      var mod = btn.getAttribute("data-mod");
      if (mod) { kbMods[mod] = !kbMods[mod]; updMods(); return; }
      var data = btn.getAttribute("data-send") || btn.getAttribute("data-char"); if (!data) return;
      if (kbMods.ctrl && data.length === 1) { var c = data.toLowerCase().charCodeAt(0); if (c >= 97 && c <= 122) data = String.fromCharCode(c - 96); kbMods.ctrl = false; updMods(); }
      else if (kbMods.alt && data.length === 1) { data = "\\x1b" + data; kbMods.alt = false; updMods(); }
      sendIn(s, data); s.term.focus();
    });
  })();

  /* ---- Mobile options panel ---- */
  var mpOverlay = $("mobile-panel-overlay"), mpPanel = $("mobile-panel"), mpContent = $("mp-content");
  function openPanel() {
    renderPanel();
    mpOverlay.classList.add("show");
    mpPanel.classList.add("show");
  }
  function closePanel() {
    mpPanel.classList.remove("show");
    mpOverlay.classList.remove("show");
    var s = sMap[activeId]; if (s) s.term.focus();
  }
  mpOverlay.addEventListener("click", closePanel);
  mpPanel.querySelector(".mp-handle").addEventListener("click", closePanel);
  $("opt-btn").onclick = openPanel;

  function renderPanel() {
    var h = "";

    /* AI Quick Launch */
    h += '<div class="mp-section"><div class="mp-label">AI Quick Launch</div><div class="mp-grid">';
    var aiButtons = [
      { t1: "Claude", t2: "--continue", cmd: "claude --continue", ico: "ai" },
      { t1: "Claude Opus", t2: "--model opus", cmd: "claude --model opus", ico: "ai" },
      { t1: "Claude Sonnet", t2: "--model sonnet", cmd: "claude --model sonnet", ico: "ai" },
      { t1: "Opus + Auto", t2: "--dangerously-skip-permissions", cmd: "claude --model opus --dangerously-skip-permissions", ico: "ai" },
      { t1: "Sonnet + Auto", t2: "--dangerously-skip-permissions", cmd: "claude --model sonnet --dangerously-skip-permissions", ico: "ai" },
      { t1: "New Claude", t2: "fresh session", cmd: "claude", ico: "ai" },
      { t1: "Vertex AI", t2: "gcloud ai", cmd: "vertex", ico: "green" },
      { t1: "New Terminal", t2: "shell session", cmd: null, ico: "blue" },
    ];
    aiButtons.forEach(function(b) {
      h += '<div class="mp-btn" data-cmd="' + (b.cmd ? esc(b.cmd) : "") + '" data-newtab="' + (b.cmd === null ? "1" : "") + '">'
        + '<div class="mp-icon ' + b.ico + '">' + (b.ico === "ai" ? "C" : b.ico === "green" ? "V" : "&gt;") + '</div>'
        + '<div class="mp-txt"><div class="mp-t1">' + esc(b.t1) + '</div><div class="mp-t2">' + esc(b.t2) + '</div></div></div>';
    });
    h += '</div></div>';

    /* Git section */
    h += '<div class="mp-section"><div class="mp-label">Git</div><div class="mp-grid">';
    [{ t1: "Diff", t2: "view changes", act: "git-diff", ico: "orange" },
     { t1: "Staged", t2: "staged changes", act: "git-diff-staged", ico: "green" },
     { t1: "Status", t2: "file status", act: "git-status", ico: "blue" },
     { t1: "Log", t2: "recent commits", act: "git-log", ico: "blue" },
    ].forEach(function(b) {
      h += '<div class="mp-btn" data-gitact="' + b.act + '"><div class="mp-icon ' + b.ico + '">' + b.t1[0] + '</div>'
        + '<div class="mp-txt"><div class="mp-t1">' + esc(b.t1) + '</div><div class="mp-t2">' + esc(b.t2) + '</div></div></div>';
    });
    h += '</div><div class="mp-pills" style="margin-top:6px">';
    [["git pull","git pull"],["git push","git push"],["git add .","git add ."],["git commit","git commit -m \\\""],
     ["git stash","git stash"],["git stash pop","git stash pop"],["git checkout .","git checkout ."],["git branch","git branch"]
    ].forEach(function(c) { h += '<div class="mp-pill" data-cmd="' + esc(c[1]) + '">' + esc(c[0]) + '</div>'; });
    h += '</div></div>';

    /* Quick Commands */
    h += '<div class="mp-section"><div class="mp-label">Quick Commands</div><div class="mp-pills">';
    [["cd ..", "cd .."], ["ls", "ls"], ["ls -la", "ls -la"], ["pwd", "pwd"],
     ["npm install", "npm install"], ["npm start", "npm start"], ["npm test", "npm test"], ["npm run dev", "npm run dev"],
     ["docker ps", "docker ps"], ["python3", "python3"], ["clear", "clear"], ["exit", "exit"]
    ].forEach(function(c) { h += '<div class="mp-pill" data-cmd="' + esc(c[1]) + '">' + esc(c[0]) + '</div>'; });
    h += '</div></div>';

    /* Signals & Terminal Control */
    h += '<div class="mp-section"><div class="mp-label">Signals &amp; Control</div><div class="mp-pills">';
    [["Ctrl+C (stop)","\\x03"],["Ctrl+D (exit)","\\x04"],["Ctrl+Z (suspend)","\\x1a"],
     ["Ctrl+L (clear)","\\x0c"],["Ctrl+U (clear line)","\\x15"],["Ctrl+A (home)","\\x01"],["Ctrl+E (end)","\\x05"],["Ctrl+W (del word)","\\x17"]
    ].forEach(function(c) { h += '<div class="mp-pill sig" data-sig="' + esc(c[1]) + '">' + esc(c[0]) + '</div>'; });
    h += '</div></div>';

    /* Recent Commands */
    if (cmdHistory.length) {
      h += '<div class="mp-section"><div class="mp-label">Recent Commands</div><div class="mp-hist">';
      var seen = {}, rc = [];
      for (var i = cmdHistory.length - 1; i >= 0 && rc.length < 15; i--) {
        if (!seen[cmdHistory[i]]) { seen[cmdHistory[i]] = true; rc.push(cmdHistory[i]); }
      }
      rc.forEach(function(c) { h += '<div class="mp-hist-item" data-cmd="' + esc(c) + '">' + esc(c) + '</div>'; });
      h += '</div></div>';
    }

    /* Actions row */
    h += '<div class="mp-section"><div class="mp-label">Actions</div><div class="mp-row">';
    [["Copy","copy"],["Paste","paste"],["Select All","selectall"],["Clear","clear"],["Home","home"],["New Tab","newtab"],["Rename","rename"]
    ].forEach(function(a) { h += '<div class="mp-act" data-act="' + a[1] + '">' + esc(a[0]) + '</div>'; });
    h += '</div></div>';

    mpContent.innerHTML = h;
  }

  /* Panel click handler */
  mpContent.addEventListener("click", function(e) {
    /* Git viewer buttons */
    var gitBtn = e.target.closest("[data-gitact]");
    if (gitBtn) { closePanel(); openGit(gitBtn.getAttribute("data-gitact")); return; }
    /* AI grid buttons */
    var btn = e.target.closest(".mp-btn");
    if (btn) {
      var newtab = btn.getAttribute("data-newtab");
      if (newtab) { addSession(); closePanel(); return; }
      var cmd = btn.getAttribute("data-cmd");
      if (cmd) { closePanel(); launch(cmd, cmd.split(" ")[0]); return; }
    }
    /* Quick command pills */
    var pill = e.target.closest(".mp-pill");
    if (pill) {
      var sig = pill.getAttribute("data-sig");
      if (sig) { sendSig(sig); closePanel(); return; }
      var pc = pill.getAttribute("data-cmd");
      if (pc) { runCmd(pc); closePanel(); return; }
    }
    /* History items */
    var hist = e.target.closest(".mp-hist-item");
    if (hist) { runCmd(hist.getAttribute("data-cmd")); closePanel(); return; }
    /* Action buttons */
    var act = e.target.closest(".mp-act");
    if (act) {
      var a = act.getAttribute("data-act"), tgt = sMap[activeId];
      if (a === "copy" && tgt) { var sel = tgt.term.getSelection(); if (sel) navigator.clipboard.writeText(sel).catch(function(){}); }
      else if (a === "paste" && tgt) { navigator.clipboard.readText().then(function(t) { if (t && tgt.ws && tgt.ws.readyState === 1) tgt.ws.send(JSON.stringify({ type: "input", data: t })); }).catch(function(){}); }
      else if (a === "selectall" && tgt) tgt.term.selectAll();
      else if (a === "clear" && tgt) tgt.term.clear();
      else if (a === "home") showDash();
      else if (a === "newtab") addSession();
      else if (a === "rename" && tgt) startRename(tgt);
      closePanel();
    }
  });
  mpContent.addEventListener("mousedown", function(e) { if (e.target.closest(".mp-btn,.mp-pill,.mp-hist-item,.mp-act")) e.preventDefault(); });

  /* ---- Git viewer ---- */
  var gitOverlay = $("git-overlay"), gitViewer = $("git-viewer");
  var gvTabs = $("gv-tabs"), gvStat = $("gv-stat"), gvBody = $("gv-body");
  var gitActiveTab = "diff";

  function openGit(action) {
    gitActiveTab = action.replace("git-", "");
    renderGitTabs();
    gvBody.innerHTML = '<pre style="padding:20px;color:var(--text3)">Loading...</pre>';
    gvStat.innerHTML = "";
    gitOverlay.classList.add("show");
    fetchGit(action.replace("git-", ""));
  }
  function closeGit() { gitOverlay.classList.remove("show"); var s = sMap[activeId]; if (s) s.term.focus(); }
  $("gv-close").onclick = closeGit;
  gitOverlay.addEventListener("click", function(e) { if (e.target === gitOverlay) closeGit(); });

  function renderGitTabs() {
    var tabs = [["diff","Diff"],["diff-staged","Staged"],["status","Status"],["log","Log"],["branch","Branches"],["stash","Stashes"]];
    gvTabs.innerHTML = "";
    tabs.forEach(function(t) {
      var b = document.createElement("button"); b.className = "gv-tab" + (gitActiveTab === t[0] ? " active" : "");
      b.textContent = t[1]; b.setAttribute("data-tab", t[0]);
      b.onclick = function() { gitActiveTab = t[0]; renderGitTabs(); fetchGit(t[0]); };
      gvTabs.appendChild(b);
    });
  }

  function fetchGit(action) {
    var sid = activeId !== null ? activeId : 0;
    fetch(api("/api/git/" + action + "?session=" + sid))
      .then(function(r) { return r.json(); })
      .then(function(d) { renderGitOutput(action, d.output || "", d.cwd || ""); })
      .catch(function(e) { gvBody.innerHTML = '<pre style="padding:20px;color:var(--red)">' + esc(e.message) + '</pre>'; });
  }

  function renderGitOutput(action, output, cwd) {
    if (!output || !output.trim()) {
      gvBody.innerHTML = '<div class="gv-empty">No output &mdash; ' + (action === "diff" ? "working tree clean" : action === "diff-staged" ? "nothing staged" : "nothing to show") + '</div>';
      gvStat.innerHTML = '<span class="s-file">' + esc(fname(cwd)) + '</span>';
      return;
    }
    if (action === "diff" || action === "diff-staged") {
      renderDiff(output, cwd);
    } else {
      gvBody.innerHTML = '<pre>' + esc(output) + '</pre>';
      gvStat.innerHTML = '<span class="s-file">' + esc(fname(cwd)) + '</span>';
    }
  }

  function renderDiff(raw, cwd) {
    var lines = raw.split("\\n"), h = "", adds = 0, dels = 0, files = [];
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i], cls = "";
      if (ln.indexOf("diff --git") === 0) {
        var m = ln.match(/b\\/(.+)$/);
        if (m) files.push(m[1]);
        cls = "meta";
      } else if (ln.indexOf("index ") === 0 || ln.indexOf("---") === 0 || ln.indexOf("+++") === 0) {
        cls = "meta";
      } else if (ln.indexOf("@@") === 0) {
        cls = "hunk";
      } else if (ln.length > 0 && ln[0] === "+") {
        cls = "add"; adds++;
      } else if (ln.length > 0 && ln[0] === "-") {
        cls = "del"; dels++;
      }
      h += '<span class="gv-line' + (cls ? " " + cls : "") + '">' + esc(ln) + '</span>\\n';
    }
    gvBody.innerHTML = '<pre>' + h + '</pre>';
    var stat = '<span class="s-file">' + esc(fname(cwd)) + '</span>';
    stat += '<span class="s-add">+' + adds + '</span>';
    stat += '<span class="s-del">-' + dels + '</span>';
    if (files.length) stat += '<span>' + files.length + ' file' + (files.length > 1 ? "s" : "") + '</span>';
    gvStat.innerHTML = stat;
  }

  /* ---- Visual viewport ---- */
  if (window.visualViewport) { var vt; function hvr() { clearTimeout(vt); vt = setTimeout(function() { document.body.style.height = visualViewport.height + "px"; doFit(); }, 50); } visualViewport.addEventListener("resize", hvr); visualViewport.addEventListener("scroll", function() { document.body.style.height = visualViewport.height + "px"; }); }
})();
</script></body></html>`;
