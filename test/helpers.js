// test/helpers.js — shared test utilities
"use strict";

const { spawn } = require("child_process");
const net = require("net");
const http = require("http");

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

let _serverProc = null;
let _port = null;

async function startServer() {
  _port = await findFreePort();
  _serverProc = spawn(process.execPath, [
    require("path").join(__dirname, "..", "server.js"),
    "--port", String(_port),
    "--host", "127.0.0.1",
    "--token", TOKEN,
    "--no-qr",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "test" },
    windowsHide: true,
  });

  // Collect output for debugging
  let output = "";
  _serverProc.stdout.on("data", (d) => { output += d.toString(); });
  _serverProc.stderr.on("data", (d) => { output += d.toString(); });
  _serverProc.on("error", (err) => {
    console.error("Server process error:", err.message);
  });

  await waitForServer(_port);
  return { port: _port, token: TOKEN, baseUrl: `http://127.0.0.1:${_port}` };
}

function stopServer() {
  if (_serverProc) {
    _serverProc.kill("SIGTERM");
    // Force kill after 3 seconds
    const timer = setTimeout(() => {
      try { _serverProc.kill("SIGKILL"); } catch {}
    }, 3000);
    _serverProc.on("exit", () => clearTimeout(timer));
    _serverProc = null;
  }
}

/**
 * Simple HTTP request helper (no external deps).
 * Returns { status, headers, body (parsed JSON or string) }
 */
function request(method, path, { body, headers: extraHeaders } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, `http://127.0.0.1:${_port}`);
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
const get = (path) => request("GET", path);
const post = (path, body) => request("POST", path, { body });
const put = (path, body) => request("PUT", path, { body });
const del = (path) => request("DELETE", path);

module.exports = { startServer, stopServer, request, get, post, put, del, TOKEN };
