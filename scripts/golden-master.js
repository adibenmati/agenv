// scripts/golden-master.js — usage: node scripts/golden-master.js <entryA> <entryB>
// Starts both servers on identical fresh temp homes, runs the scripted calls, diffs the normalized responses.
"use strict";
const { spawn, execFileSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http"), net = require("net");
const { calls } = require("./golden-master.calls");

const VOLATILE = new Set(["created", "lastActivity", "closed", "startTime", "duration", "uptime", "timestamp", "elapsed", "pid", "memUsed", "memFree", "memTotal", "memPercent", "cpu", "clients", "hostname", "started", "mtime", "modified", "ts", "time", "lastUsed"]);
const HASHY = new Set(["output", "diff", "stagedDiff", "recentCommits"]);   // git output carries commit/blob hashes that depend on commit time
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

function request(port, method, p, body) {
  return new Promise((resolve) => {
    const payload = body == null ? null : JSON.stringify(body);
    const sep = p.includes("?") ? "&" : "?";
    const headers = { Connection: "close" };
    if (payload) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = Buffer.byteLength(payload); }
    const req = http.request({ host: "127.0.0.1", port, method, path: p + sep + "token=T", headers, agent: false }, (r) => {
      let data = ""; r.on("data", (d) => (data += d));
      r.on("end", () => { let b = data; try { b = JSON.parse(data); } catch {} resolve({ status: r.statusCode, body: b }); });
    });
    req.on("error", (e) => resolve({ status: 0, body: String(e.message) }));
    req.end(payload || undefined);
  });
}

function fixture(home) {
  const repo = path.join(home, "repo");
  fs.mkdirSync(repo, { recursive: true });
  const git = (...a) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n"); git("add", "."); git("commit", "-qm", "init");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n");           // unstaged change
  fs.writeFileSync(path.join(repo, "b.txt"), "new\n");                // untracked
  const proj = path.join(home, ".claude", "projects", "proj");
  fs.mkdirSync(proj, { recursive: true });
  const line = (o) => JSON.stringify(o) + "\n";
  fs.writeFileSync(path.join(proj, "abc.jsonl"),
    line({ type: "user", timestamp: "2026-01-01T00:00:00Z", cwd: repo, sessionId: "abc", message: { role: "user", content: "refactor the parser" } }) +
    line({ type: "assistant", timestamp: "2026-01-01T00:00:01Z", message: { id: "msg_1", role: "assistant", model: "claude-sonnet-4", usage: { input_tokens: 100, output_tokens: 10 }, content: [{ type: "text", text: "ok" }] } }));
  return { home, repo };
}

async function run(entry) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agenv-gm-")));
  const ctx = { ...fixture(home), ids: {}, mask: [] };   // mask: random ids seen in responses (e.g. prompt ids)
  const port = await freePort();
  const proc = spawn(process.execPath, [path.resolve(entry), "--port", String(port), "--host", "127.0.0.1", "--token", "T", "--no-qr"],
    { cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home, NODE_ENV: "test", AGENV_USAGE_REFRESH_MS: "0" }, stdio: "ignore", windowsHide: true });
  try {
    for (let i = 0; i < 60 && (await request(port, "GET", "/api/stats")).status !== 200; i++) await sleep(250);
    const out = [];
    for (const c of calls) {
      const p = typeof c.path === "function" ? c.path(ctx) : c.path;
      const res = await request(port, c.method, p, c.body ? c.body(ctx) : undefined);
      if (c.after) c.after(res, ctx);
      out.push({ name: normalize(`${c.method} ${p}`, ctx), status: res.status, body: normalize(res.body, ctx) });
      if (c.settleMs) await sleep(c.settleMs);
    }
    return out;
  } finally { proc.kill(); await sleep(300); try { fs.rmSync(home, { recursive: true, force: true }); } catch {} }
}

function normalize(v, ctx, key) {
  if (typeof v === "string") {
    let t = v.split(ctx.home).join("<HOME>").split(ctx.home.replace(/\\/g, "/")).join("<HOME>")
      .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<ts>").replace(/agenv-gm-[A-Za-z0-9]+/g, "<tmp>")
      .replace(/-\d{13}(?=\.)/g, "-<ms>")                              // upload file names carry Date.now()
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/g, "<clip-ts>");   // clip file names carry a timestamp
    for (const m of ctx.mask) t = t.split(m).join("<id>");
    if (HASHY.has(key)) t = t.replace(/\b[0-9a-f]{7,40}\b/g, "<sha>");
    return t;
  }
  if (typeof v === "number" && VOLATILE.has(key)) return "<v>";
  if (Array.isArray(v)) return v.map((x) => normalize(x, ctx, key));
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, normalize(v[k], ctx, k)]));
  return v;
}

function diff(a, b, at, out) {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], at + "." + k, out);
  } else out.push(`${at}\n    A: ${JSON.stringify(a)}\n    B: ${JSON.stringify(b)}`);
}

(async () => {
  const [a, b] = process.argv.slice(2);
  if (!a || !b) { console.error("usage: golden-master.js <entryA> <entryB>"); process.exit(2); }
  const ra = await run(a), rb = await run(b);
  if (process.env.GM_VERBOSE) {   // proves the comparison is not trivially "identical" because everything failed
    const hist = {}; for (const r of ra) hist[r.status] = (hist[r.status] || 0) + 1;
    console.log("status histogram:", JSON.stringify(hist));
    for (const r of ra) console.log(String(r.status).padStart(3), r.name.slice(0, 70).padEnd(70), JSON.stringify(r.body).slice(0, 60));
  }
  const out = [];
  for (let i = 0; i < Math.max(ra.length, rb.length); i++) diff(ra[i], rb[i], `[${i}] ${(ra[i] || rb[i]).name}`, out);
  if (out.length) { console.error(out.slice(0, 40).join("\n")); console.error(`\n${out.length} difference(s)`); process.exit(1); }
  console.log(`identical (${ra.length} calls)`);
})();
