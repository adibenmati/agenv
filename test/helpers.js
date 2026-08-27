// test/helpers.js — shared test utilities
"use strict";

const { spawn } = require("child_process");
const net = require("net");
const http = require("http");
const os = require("os");
const fs = require("fs");
const path = require("path");

const TOKEN = "test-token-" + Date.now();

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function waitForServer(port, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    function attempt() {
      const sock = net.createConnection({ port, host: "127.0.0.1" });
      sock.on("connect", () => { sock.destroy(); resolve(); });
      sock.on("error", () => {
        if (Date.now() - start > timeout) reject(new Error("Server did not start"));
        else setTimeout(attempt, 200);
      });
    }
    attempt();
  });
}

/**
 * Give the server its own HOME so tests never touch the developer's real
 * ~/.agenv-state.enc, ~/.agenv-scrollback/, ~/.agenv-history.enc, etc.
 */
function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agenv-test-home-"));
}

let _serverProc = null;
let _port = null;

/**
 * Start a server instance.
 *
 * opts.home  — reuse an existing temp HOME (for restart/restore tests)
 * opts.args  — extra CLI args
 * opts.env   — extra environment variables
 */
async function startServer(opts = {}) {
  const port = await findFreePort();
  const home = opts.home || makeTempHome();

  const proc = spawn(process.execPath, [
    path.join(__dirname, "..", "server.js"),
    "--port", String(port),
    "--host", "127.0.0.1",
    "--token", TOKEN,
    "--no-qr",
    ...(opts.args || []),
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOME: home,
      USERPROFILE: home,
      ...(opts.env || {}),
    },
    windowsHide: true,
  });

  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (d) => { stdout += d.toString(); });
  proc.stderr.on("data", (d) => { stderr += d.toString(); });
  proc.on("error", (err) => { console.error("Server process error:", err.message); });

  await waitForServer(port);

  const handle = {
    port, home, token: TOKEN, proc,
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    getStdout: () => stdout,
    getStderr: () => stderr,
    stop: () => stopProcess(proc),
  };

  // Module-level singleton so the bare get/post/put/del helpers keep working.
  _serverProc = proc;
  _port = port;
  return handle;
}

function stopProcess(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode != null) return resolve();
    const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 3000);
    proc.on("exit", () => { clearTimeout(timer); resolve(); });
    try { proc.kill("SIGTERM"); } catch { clearTimeout(timer); resolve(); }
  });
}

function stopServer() {
  const proc = _serverProc;
  _serverProc = null;
  return stopProcess(proc);
}

/**
 * Simple HTTP request helper (no external deps).
 * Returns { status, headers, body (parsed JSON or string) }
 */
function request(method, reqPath, { body, headers: extraHeaders, port } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(reqPath, `http://127.0.0.1:${port || _port}`);
    // Append token for auth
    if (!url.searchParams.has("token")) {
      url.searchParams.set("token", TOKEN);
    }

    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { ...extraHeaders },
    };

    if (body != null) {
      const payload = typeof body === "string" ? body : JSON.stringify(body);
      opts.headers["Content-Type"] = "application/json";
      opts.headers["Content-Length"] = Buffer.byteLength(payload);
    }

    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        let parsed = data;
        try { parsed = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });

    req.on("error", reject);
    if (body != null) {
      req.write(typeof body === "string" ? body : JSON.stringify(body));
    }
    req.end();
  });
}

// Shorthand methods
const get = (p, o) => request("GET", p, o);
const post = (p, body, o) => request("POST", p, { ...o, body });
const put = (p, body, o) => request("PUT", p, { ...o, body });
const del = (p, o) => request("DELETE", p, o);

/** Poll `fn` until it returns truthy, or throw after `timeout` ms. */
async function waitFor(fn, { timeout = 10000, interval = 100, message = "condition" } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

/**
 * Load the pure helpers out of server.js without booting it, by evaluating the
 * slice of source between two markers. Keeps server.js a single runnable file.
 */
function loadInternals(startMarker, endMarker, exportNames) {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const from = src.indexOf(startMarker);
  const to = src.indexOf(endMarker, from);
  if (from < 0 || to < 0) throw new Error(`markers not found: ${startMarker} .. ${endMarker}`);
  const mod = { exports: {} };
  const body = src.slice(from, to) + `\nmodule.exports={${exportNames.join(",")}};`;
  new Function("module", "exports", "require", "Buffer", body)(mod, mod.exports, require, Buffer);
  return mod.exports;
}

module.exports = {
  startServer, stopServer, stopProcess, makeTempHome,
  request, get, post, put, del,
  waitFor, loadInternals, TOKEN,
};
