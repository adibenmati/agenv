# agenv TypeScript / OOP Backend Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 3,514-line `server.js` with a TypeScript, class-based backend (`src/` → `dist/`) that behaves identically.

**Architecture:** Classes wired by one composition root (`src/index.ts`, manual constructor injection). A typed event bus decouples `Session` from the WebSocket gateway, output analysis, Claude linking and persistence. Persistence is a `JsonStore<T>` Repository over the existing encrypted files. Plain `tsc` build; `server.js` becomes a 3-line loader.

**Tech Stack:** TypeScript (strict, ES2020, CommonJS), Node >=16, Express 4, ws 8, `@lydell/node-pty`, `node:test`. Dev deps only: `typescript`, `@types/node`, `@types/express`, `@types/ws`, later `playwright-core`.

**Spec:** `docs/superpowers/specs/2026-10-17-typescript-migration-design.md`

## Global Constraints

- **Behavior frozen:** HTTP API (72 route declarations, 71 unique), WebSocket protocol, on-disk file formats, CLI flags, and `public/` (frontend) are unchanged.
- **File names/locations unchanged:** `~/.agenv-state.enc`, `~/.agenv-history.enc`, `~/.agenv-archive.enc`, `~/.agenv-favorites.enc`, `~/.agenv-scrollback/session-<id>.enc`, `~/.agenvrc.json`, `~/.agenv.key`, `~/.agenv.pid`, and the legacy plain-JSON migrations (`*.json`).
- **No new runtime dependencies.** `typescript` and `@types/*` are devDependencies only. `dist/` stays gitignored (already is).
- **Node `engines` stays `>=16`;** compile target ES2020.
- **One-way deps:** routes → services → core. Services never import Express. Nothing imports `src/index.ts`. Only `src/index.ts` calls `new` on services.
- **Only deliberate behavior-preserving change:** git operations become async (no `spawnSync`). Everything else is ported as-is; questionable code found is appended to `docs/superpowers/follow-ups.md`, not changed.
- **Events (refinement of spec §4):** `exit` and `deleted` are merged. A session only ends by being deleted, and `deleted(session, exitCode)` carries the code (`-1` for an API delete).
- **No publishing** (`npm publish`, tags, pushes to `main`) without explicit user approval. This plan ends before release.
- **Commits** end with the attribution trailer given in the session's system reminder. Do not mix CRLF/LF within a file (repo uses `core.autocrlf=true`).
- **Baseline line numbers** in this plan refer to `git show pre-ts:server.js` (tag created in Task 1). Section boundaries are within a few lines; the **function names are authoritative**.

## Resume protocol (read first in every new session)

1. `git log --oneline -15` and `git status --short` on branch `refactor/typescript`.
2. Open this file; the first unchecked `- [ ]` is where to resume. Check boxes and commit this file at the end of every task (`docs: tick Task N`).
3. Run `npm test` (after Task 4) and `node scripts/golden-master.js pre-ts-entry dist/index.js` (after Task 17). If red, fix before continuing.
4. The baseline for any comparison is `git worktree add ../agenv-pre-ts pre-ts` (read-only reference; `npm install` is not needed if you copy `node_modules` or junction it).

## Review Focus

Failure modes the spec implies that no single feature test covers; each has a pinning test in the owning task.

1. **Existing install data must load** (files written by the old `encryptJSON`, legacy `.json` migration, `group`/`note` fields) — fixtures in Task 5, restore test in Task 3/17.
2. **Windows specifics:** shell string with quoted args (`"C:\Program Files\...\pwsh.exe" -NoLogo`), cwd detection from `PS C:\x>` / `C:\x>` prompts — Task 7 (analyzer) and Task 8 (shell parsing).
3. **Shutdown:** `POST /api/shutdown`/SIGTERM must save state + scrollback, kill shells, remove the PID file and exit within the 3 s guard — Task 17.
4. **Malformed or hostile WebSocket input** (non-JSON, oversize input, unknown message type, input to a session deleted mid-connection) must not crash the process — Task 10.
5. **Restore keeps id allocation and sleeping tabs:** saved ids `[3,7]` → next id is `8`; restored tabs spawn no shell until attached — Task 8.
6. **A throwing event subscriber must not break pty output** for other subscribers — Task 5 (`TypedEmitter`), Task 8.

---

## Phase A — Safety net (nothing is rewritten until this phase is done)

### Task 1: Baseline tag, switchable entry point, route inventory

**Files:**
- Create: `scripts/extract-routes.js`, `test/routes.inventory.json`, `test/routes.test.js`
- Modify: `test/helpers.js` (entry switch)

**Interfaces:**
- Produces: tag `pre-ts`; env var `AGENV_ENTRY` (repo-relative path of the server entry; default `server.js`) honored by `startServer()`; `test/routes.inventory.json` = `[{ "method": "GET", "path": "/api/sessions" }, ...]` (71 unique entries).

- [ ] **Step 1: Create branch state and tag**

```bash
git checkout refactor/typescript
git tag pre-ts            # baseline = current server.js
git worktree add ../agenv-pre-ts pre-ts
cmd //c mklink //J "..\\agenv-pre-ts\\node_modules" "node_modules"     # Windows; on Linux/macOS: ln -s "$PWD/node_modules" ../agenv-pre-ts/node_modules
```
Expected: tag exists (`git tag | grep pre-ts`), `../agenv-pre-ts/server.js` exists, and `node ../agenv-pre-ts/server.js --version` prints the version (proves the baseline can run).

- [ ] **Step 2: Entry switch in tests** — in `test/helpers.js` `startServer`, replace the hard-coded path:

```js
const entry = path.join(__dirname, "..", process.env.AGENV_ENTRY || "server.js");
const proc = spawn(process.execPath, [
  entry,
  "--port", String(port),
```

- [ ] **Step 3: Write the extraction script**

```js
// scripts/extract-routes.js — usage: node scripts/extract-routes.js <server.js> > test/routes.inventory.json
"use strict";
const fs = require("fs");
const src = fs.readFileSync(process.argv[2], "utf8");
const re = /^\s*app\.(get|post|put|delete)\(\s*"([^"]+)"/gm;
const all = []; let m;
while ((m = re.exec(src))) all.push({ method: m[1].toUpperCase(), path: m[2] });
const seen = new Set(), unique = [];
for (const r of all) { const k = r.method + " " + r.path; if (!seen.has(k)) { seen.add(k); unique.push(r); } }
if (all.length !== 72 || unique.length !== 71) { console.error(`expected 72 declarations / 71 unique, got ${all.length}/${unique.length}`); process.exit(1); }
console.log(JSON.stringify(unique, null, 1));
```

- [ ] **Step 4: Generate the inventory from the baseline**

Run: `git show pre-ts:server.js > "$TMPDIR/baseline-server.js" && node scripts/extract-routes.js "$TMPDIR/baseline-server.js" > test/routes.inventory.json`
Expected: file written, no error (72/71 check passes).

- [ ] **Step 5: Write the routes test** (the four auth-page declarations `GET /login`, `POST /login`, `GET /` are registered conditionally on credentials mode and are covered in Task 9)

```js
// test/routes.test.js — every baseline route must still exist (anything but 404 when unauthenticated)
"use strict";
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { startServer } = require("./helpers");
const inventory = require("./routes.inventory.json");

const AUTH_PAGES = new Set(["GET /login", "POST /login", "GET /"]); // Task 9
const concrete = (p) => p.replace(/:action/, "status").replace(/:[a-zA-Z]+/g, "1");

function status(port, method, p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: { "Content-Type": "application/json" } }, (r) => { r.resume(); resolve(r.statusCode); });
    req.on("error", reject);
    req.end(method === "GET" ? undefined : "{}");
  });
}

describe("Route inventory", () => {
  let server;
  before(async () => { server = await startServer(); }, { timeout: 30000 });
  after(() => server.stop());

  for (const { method, path: p } of inventory) {
    if (AUTH_PAGES.has(method + " " + p)) continue;
    it(`${method} ${p} exists`, async () => {
      assert.notEqual(await status(server.port, method, concrete(p)), 404);
    });
  }
});
```

- [ ] **Step 6: Run against the baseline**

Run: `node --test test/routes.test.js`
Expected: all PASS (68 tests: 71 minus the 3 auth-page entries).

- [ ] **Step 7: Commit**

```bash
git add scripts/extract-routes.js test/routes.inventory.json test/routes.test.js test/helpers.js
git commit -m "test: baseline tag, switchable server entry, route inventory"
```

### Task 2: Golden-master harness

**Files:**
- Create: `scripts/golden-master.js`, `scripts/golden-master.calls.js`, `test/golden-coverage.test.js`

**Interfaces:**
- Produces: `node scripts/golden-master.js <entryA> <entryB>` — starts both servers on identical fresh temp homes, runs `calls`, prints `identical` (exit 0) or the differing paths (exit 1). `golden-master.calls.js` exports `{ calls, SKIPPED }` where each call is `{ route: "METHOD /path", method, path(ctx), body?(ctx), after?(res, ctx) }` and `SKIPPED` maps an inventory route string to a reason.

- [ ] **Step 1: Write the harness**

```js
// scripts/golden-master.js
"use strict";
const { spawn, execFileSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http"), net = require("net");
const { calls } = require("./golden-master.calls");

const VOLATILE = new Set(["created", "lastActivity", "closed", "startTime", "duration", "uptime", "timestamp", "elapsed", "pid", "memUsed", "memFree", "memTotal", "memPercent", "cpu", "clients", "hostname", "started", "mtime", "modified", "ts", "time"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

function request(port, method, p, body) {
  return new Promise((resolve) => {
    const payload = body == null ? null : JSON.stringify(body);
    const sep = p.includes("?") ? "&" : "?";
    const req = http.request({ host: "127.0.0.1", port, method, path: p + sep + "token=T", headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {} }, (r) => {
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenv-gm-"));
  const ctx = { ...fixture(home), ids: {}, vars: {} };
  const port = await freePort();
  const proc = spawn(process.execPath, [path.resolve(entry), "--port", String(port), "--host", "127.0.0.1", "--token", "T", "--no-qr"],
    { env: { ...process.env, HOME: home, USERPROFILE: home, NODE_ENV: "test", AGENV_USAGE_REFRESH_MS: "0" }, stdio: "ignore", windowsHide: true });
  try {
    for (let i = 0; i < 60 && (await request(port, "GET", "/api/stats")).status !== 200; i++) await sleep(250);
    const out = [];
    for (const c of calls) {
      const res = await request(port, c.method, typeof c.path === "function" ? c.path(ctx) : c.path, c.body ? c.body(ctx) : undefined);
      if (c.after) c.after(res, ctx);
      out.push({ name: `${c.method} ${typeof c.path === "function" ? c.path(ctx) : c.path}`, status: res.status, body: normalize(res.body, ctx) });
      if (c.settleMs) await sleep(c.settleMs);
    }
    return out;
  } finally { proc.kill(); await sleep(300); try { fs.rmSync(home, { recursive: true, force: true }); } catch {} }
}

function normalize(v, ctx, key) {
  if (typeof v === "string") {
    return v.split(ctx.home).join("<HOME>").split(ctx.home.replace(/\\/g, "/")).join("<HOME>")
      .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<ts>").replace(/agenv-gm-[A-Za-z0-9]+/g, "<tmp>");
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
  const out = [];
  for (let i = 0; i < Math.max(ra.length, rb.length); i++) diff(ra[i], rb[i], `[${i}] ${(ra[i] || rb[i]).name}`, out);
  if (out.length) { console.error(out.slice(0, 40).join("\n")); console.error(`\n${out.length} difference(s)`); process.exit(1); }
  console.log(`identical (${ra.length} calls)`);
})();
```

- [ ] **Step 2: Write the calls file for the routes whose parameters are known**

```js
// scripts/golden-master.calls.js — each route in test/routes.inventory.json is covered here or in SKIPPED.
"use strict";
const J = (o) => () => o;

const calls = [
  { route: "GET /api/stats", method: "GET", path: "/api/stats" },
  { route: "GET /api/sessions", method: "GET", path: "/api/sessions" },
  { route: "POST /api/sessions", method: "POST", path: "/api/sessions", body: J({ name: "alpha", group: " p1 / dev//api " }), after: (r, c) => { c.ids.a = r.body.id; } },
  { route: "POST /api/sessions", method: "POST", path: "/api/sessions", body: J({ name: "beta" }), after: (r, c) => { c.ids.b = r.body.id; } },
  { route: "PUT /api/sessions/:id", method: "PUT", path: (c) => `/api/sessions/${c.ids.a}`, body: J({ note: "hello", group: "p1/dev" }) },
  { route: "PUT /api/sessions/:id", method: "PUT", path: (c) => `/api/sessions/${c.ids.b}`, body: J({ name: "beta2" }) },
  { route: "GET /api/sessions", method: "GET", path: "/api/sessions" },
  { route: "GET /api/session-groups", method: "GET", path: "/api/session-groups" },
  { route: "PUT /api/session-groups", method: "PUT", path: "/api/session-groups", body: J({ groups: [{ path: "x/y/z", color: "#fff" }] }) },
  { route: "POST /api/session-groups/rename", method: "POST", path: "/api/session-groups/rename", body: J({ from: "p1/dev", to: "p1/ops" }) },
  { route: "POST /api/session-groups/rename", method: "POST", path: "/api/session-groups/rename", body: J({ from: "p1", to: "p1/ops/in" }) },
  { route: "GET /api/session-groups", method: "GET", path: "/api/session-groups" },
  { route: "POST /api/session-groups/delete", method: "POST", path: "/api/session-groups/delete", body: J({ path: "p1/ops" }) },
  { route: "GET /api/groups", method: "GET", path: "/api/groups" },
  { route: "GET /api/workspace-layout", method: "GET", path: "/api/workspace-layout" },
  { route: "POST /api/workspace-layout", method: "POST", path: "/api/workspace-layout", body: J({ layout: [{ id: "w1", name: "W", rootNode: { type: "leaf", sessionId: 0 } }] }) },
  { route: "GET /api/workspace-layout", method: "GET", path: "/api/workspace-layout" },
  { route: "POST /api/history", method: "POST", path: "/api/history", body: (c) => ({ command: "echo hi", sessionId: c.ids.a }) },
  { route: "POST /api/history", method: "POST", path: "/api/history", body: J({ command: "   " }) },
  { route: "POST /api/history", method: "POST", path: "/api/history", body: J({}) },
  { route: "GET /api/history", method: "GET", path: "/api/history" },
  { route: "POST /api/favorites", method: "POST", path: "/api/favorites", body: J({ name: "f", cwd: "/x", command: "ls" }) },
  { route: "POST /api/favorites", method: "POST", path: "/api/favorites", body: J({ cwd: "/x", command: "ls" }) },
  { route: "POST /api/favorites", method: "POST", path: "/api/favorites", body: J({}) },
  { route: "GET /api/favorites", method: "GET", path: "/api/favorites" },
  { route: "DELETE /api/favorites/:index", method: "DELETE", path: "/api/favorites/9" },
  { route: "DELETE /api/favorites/:index", method: "DELETE", path: "/api/favorites/0" },
  { route: "DELETE /api/sessions/:id", method: "DELETE", path: (c) => `/api/sessions/${c.ids.b}`, settleMs: 300 },
  { route: "DELETE /api/sessions/:id", method: "DELETE", path: "/api/sessions/9999" },
  { route: "GET /api/archive", method: "GET", path: "/api/archive" },
  { route: "POST /api/archive/remove", method: "POST", path: "/api/archive/remove", body: J({}) },
  { route: "GET /api/analytics", method: "GET", path: "/api/analytics" },
  { route: "GET /api/claude-usage", method: "GET", path: "/api/claude-usage" },
  { route: "GET /api/claude-usage", method: "GET", path: "/api/claude-usage?from=2026-01-01&to=2026-06-01&provider=bedrock" },
  { route: "GET /api/claude/sessions", method: "GET", path: "/api/claude/sessions?refresh=1" },
  { route: "GET /api/claude/search", method: "GET", path: "/api/claude/search?q=parser" },
  { route: "GET /api/claude/sessions/:id", method: "GET", path: "/api/claude/sessions/abc" },
  { route: "POST /api/claude/reindex", method: "POST", path: "/api/claude/reindex" },
  { route: "GET /api/claude/conversation/:id", method: "GET", path: "/api/claude/conversation/00000000-0000-4000-8000-000000000000" },
  { route: "GET /api/claudemd/list", method: "GET", path: "/api/claudemd/list" },
  { route: "GET /api/claudemd/templates", method: "GET", path: "/api/claudemd/templates" },
  { route: "GET /api/prompts", method: "GET", path: "/api/prompts" },
  { route: "GET /api/ngrok/status", method: "GET", path: "/api/ngrok/status" },
  { route: "GET /api/ngrok/settings", method: "GET", path: "/api/ngrok/settings" },
];

// Routes that can't be compared deterministically; reason required.
const SKIPPED = {
  "POST /api/shutdown": "ends the process (covered by the shutdown test in Task 17)",
  "POST /api/token/rotate": "changes the token mid-run (covered in Task 9)",
  "POST /api/ngrok/start": "needs the ngrok binary and network",
  "POST /api/ngrok/stop": "needs a running tunnel",
  "POST /api/ai/ask": "spawns the user's agent CLI",
};

module.exports = { calls, SKIPPED };
```

- [ ] **Step 3: Cover the remaining routes by reading their handlers.** Routes still uncovered after Step 2 are listed by the coverage test in Step 4. For each, open the handler in `../agenv-pre-ts/server.js` at the baseline line below, add a call (using the fixture repo `ctx.repo` / `ctx.home` so output is deterministic) **or** add a `SKIPPED` entry with a reason. Baseline lines: git `1508–1800` (13 routes), files `1802–1864` (`/api/files`, `/api/file` GET/PUT), search `1879,1926`, upload/clip `1981,2007`, `/api/sessions/:id/cwd` `1344`, `/api/sessions/:id/restart` `1313`, `/api/quick-launch` `1474`, `/api/recent-folders` `1488`, `/api/claudemd/read|write|memory` `3171,3183,3200`, `/api/prompts` POST/PUT/DELETE/use `3246–3273`, `/api/ngrok/settings` POST `2626`. Mutating git calls (commit/push/checkout/discard/stash/worktree-add) must run only inside `ctx.repo`.

- [ ] **Step 4: Write the coverage test** (fails until every inventory route is covered or skipped with a reason)

```js
// test/golden-coverage.test.js
"use strict";
const { it } = require("node:test");
const assert = require("node:assert/strict");
const inventory = require("./routes.inventory.json");
const { calls, SKIPPED } = require("../scripts/golden-master.calls");

const AUTH_PAGES = new Set(["GET /login", "POST /login", "GET /"]); // Task 9
it("every route is compared or has a documented reason to skip", () => {
  const covered = new Set(calls.map((c) => c.route));
  const missing = inventory.map((r) => `${r.method} ${r.path}`)
    .filter((k) => !AUTH_PAGES.has(k) && !covered.has(k) && !SKIPPED[k]);
  assert.deepEqual(missing, [], "routes with no golden-master call or SKIPPED reason");
  for (const [k, why] of Object.entries(SKIPPED)) assert.ok(why && why.length > 8, `SKIPPED ${k} needs a reason`);
  for (const k of covered) assert.ok(inventory.some((r) => `${r.method} ${r.path}` === k), `${k} is not in the inventory`);
});
```

Run: `node --test test/golden-coverage.test.js`
Expected after Step 3: PASS.

- [ ] **Step 5: Prove the harness is deterministic (baseline vs baseline)**

Run: `node scripts/golden-master.js ../agenv-pre-ts/server.js ../agenv-pre-ts/server.js` (run it **three times**)
Expected: `identical (N calls)` every time. If any run differs, extend `VOLATILE`/`normalize` for the differing field (and re-run) until three consecutive runs are identical. A flaky harness invalidates every later comparison.

- [ ] **Step 6: Commit**

```bash
git add scripts/golden-master.js scripts/golden-master.calls.js test/golden-coverage.test.js
git commit -m "test: golden-master harness comparing two server entries"
```

### Task 3: Existing-data compatibility check

**Files:**
- Create: `scripts/compat-check.js`

**Interfaces:**
- Produces: `node scripts/compat-check.js <entry>` — copies `~/.agenv-*` (state, history, archive, favorites, key, scrollback dir) from `AGENV_COMPAT_HOME` (default: real home) into a temp home, starts `<entry>`, prints counts of restored sessions/groups/notes/history/archive, exits non-zero if the server fails to start or restores fewer sessions than the state file lists. Never writes to the source home.

- [ ] **Step 1: Write the script**

```js
// scripts/compat-check.js
"use strict";
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http"), net = require("net");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const entry = process.argv[2];
const src = process.env.AGENV_COMPAT_HOME || os.homedir();
const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenv-compat-"));
for (const f of fs.readdirSync(src)) {
  if (!/^\.agenv(-|\.key|rc\.json)/.test(f) || f === ".agenv.pid") continue;
  fs.cpSync(path.join(src, f), path.join(home, f), { recursive: true });
}
const get = (port, p) => new Promise((res) => http.get(`http://127.0.0.1:${port}${p}${p.includes("?") ? "&" : "?"}token=T`, (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => { try { res(JSON.parse(b)); } catch { res(null); } }); }).on("error", () => res(null)));
(async () => {
  const port = await new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
  const proc = spawn(process.execPath, [path.resolve(entry), "--port", String(port), "--host", "127.0.0.1", "--token", "T", "--no-qr"],
    { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: "ignore", windowsHide: true });
  let sessions = null;
  for (let i = 0; i < 60 && !sessions; i++) { await sleep(300); sessions = await get(port, "/api/sessions"); }
  const [hist, arch, groups] = await Promise.all([get(port, "/api/history"), get(port, "/api/archive"), get(port, "/api/session-groups")]);
  proc.kill(); await sleep(300); fs.rmSync(home, { recursive: true, force: true });
  if (!sessions) { console.error("FAIL: server did not start / answer"); process.exit(1); }
  const summary = { sessions: sessions.length, withGroup: sessions.filter((s) => s.group).length, withNote: sessions.filter((s) => s.note).length, history: (hist || []).length, archive: (arch || []).length, groups: (groups || []).length };
  console.log(JSON.stringify(summary));
})();
```

- [ ] **Step 2: Run on the baseline and save the result**

Run: `node scripts/compat-check.js ../agenv-pre-ts/server.js | tee "$TMPDIR/compat-baseline.json"`
Expected: one JSON line with plausible counts. Later (Task 17) the new entry must print the **identical** line (sessions restored by the baseline may differ from live ones; compare the two outputs from the same moment).

- [ ] **Step 3: Commit**

```bash
git add scripts/compat-check.js
git commit -m "test: compat-check script restores real user data into a temp home"
```

---

## Phase B — Foundations

### Task 4: TypeScript toolchain, build, test runner, CI

**Files:**
- Create: `tsconfig.json`, `src/index.ts` (stub), `src/types/shims.d.ts`, `scripts/run-tests.js`
- Modify: `package.json`, `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `npm run build` (tsc → `dist/`), `npm test` (= build + `scripts/run-tests.js`, which runs every `test/**/*.test.js` except `test/e2e/`), `prepublishOnly` (build + tests). Unit tests `require("../../dist/<path>")`.

- [ ] **Step 1: Install dev deps**

Run: `npm i -D typescript@5 @types/node@20 @types/express@4 @types/ws@8`
Expected: `package.json` devDependencies updated; `dependencies` unchanged.

- [ ] **Step 2: `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "sourceMap": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Stub + shims**

`src/index.ts`: `export {};` (replaced in Task 17).
`src/types/shims.d.ts`:
```ts
declare module "qrcode-terminal" {
  export function generate(text: string, opts: { small?: boolean }, cb: (qr: string) => void): void;
}
```

- [ ] **Step 4: Test runner** (portable; no shell globbing)

```js
// scripts/run-tests.js
"use strict";
const fs = require("fs"), path = require("path");
const { spawnSync } = require("child_process");
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== "e2e" && e.name !== "fixtures") walk(p); }
    else if (e.name.endsWith(".test.js")) files.push(p);
  }
})(path.join(__dirname, "..", "test"));
const r = spawnSync(process.execPath, ["--test", ...files.sort()], { stdio: "inherit" });
process.exit(r.status == null ? 1 : r.status);
```

- [ ] **Step 5: `package.json` scripts and files**

```json
"build": "tsc",
"pretest": "npm run build",
"test": "node scripts/run-tests.js",
"prepublishOnly": "npm run build && node scripts/run-tests.js"
```
Add `"dist/"` to both `files` arrays (top-level `files` and `build.files` as `"dist/**/*"`). Leave `main`, `bin` untouched.

- [ ] **Step 6: CI** — in `.github/workflows/ci.yml`, after `npm install` add `- name: Build` / `run: npm run build`; replace the syntax-check step's file list with `['server.js','electron.js','preload.js']` unchanged (still valid; the loader is plain JS).

- [ ] **Step 7: Verify**

Run: `npm test`
Expected: build succeeds with no TS errors and every existing test file plus `routes`/`golden-coverage` PASS (all previous 69 + new).

- [ ] **Step 8: Commit**

```bash
git add tsconfig.json src scripts/run-tests.js package.json package-lock.json .github/workflows/ci.yml
git commit -m "build: TypeScript toolchain, portable test runner, CI build step"
```

### Task 5: Core — shared types, Config, CLI args, Crypto, HttpError, TypedEmitter

**Files:**
- Create: `src/core/types.ts`, `src/core/TypedEmitter.ts`, `src/core/HttpError.ts`, `src/core/Crypto.ts`, `src/core/Config.ts`, `src/cli/args.ts`
- Test: `test/unit/core.test.js`, `test/fixtures/crypto/{key,cipher.json,plain.json}`

**Interfaces:**
- Produces (used by every later task):

```ts
// src/core/types.ts
export type SessionStatus = "idle" | "running" | "waiting" | "error";
export interface Analytics { inputTokens: number; outputTokens: number; estimatedCost: number; commandCount: number; turnCount: number; startTime: number }
export interface GroupDef { path: string; color: string }
export interface PersistedSession { id: number; name: string; cwd: string; tool: string; lastCommand: string; launchCommand: string; userNamed: boolean; group: string; note: string; claudeSessionId: string | null; created: number; lastActivity: number }
export interface PersistedState { sessions: PersistedSession[]; workspaceLayout: unknown | null; sessionGroups: GroupDef[] }
export interface ArchiveEntry { name: string; cwd: string; tool: string; lastCommand: string; launchCommand: string; group: string; claudeSessionId: string | null; created: number; lastActivity: number; closed: number }
export interface Favorite { name: string; cwd: string; command: string; tool: string; created: number }

// src/core/TypedEmitter.ts
export class TypedEmitter<E extends { [K in keyof E]: (...a: any[]) => void }> {
  on<K extends keyof E & string>(ev: K, fn: E[K]): this;
  off<K extends keyof E & string>(ev: K, fn: E[K]): this;
  emit<K extends keyof E & string>(ev: K, ...a: Parameters<E[K]>): void; // a throwing listener is caught + console.error'd; other listeners still run
}

// src/core/HttpError.ts
export class HttpError extends Error { constructor(public status: number, message: string) }

// src/core/Crypto.ts
export class Crypto { constructor(keyPath: string); encryptJSON(obj: unknown): string; decryptJSON<T = unknown>(raw: string): T }

// src/core/Config.ts
export class Config {
  static fromArgv(argv: string[], env: NodeJS.ProcessEnv, homedir: string): Config;
  readonly port: number; host: string; readonly shell: string; token: string; readonly initialSessions: number; readonly maxSessions: number;
  readonly autoOpen: boolean; readonly showQr: boolean; readonly mirror: boolean; readonly command: string | undefined;
  readonly runCommand: string; readonly runName: string; readonly configPath: string;
  get(key: string): unknown; set(key: string, value: unknown): void;   // ~/.agenvrc.json, dotted keys ("auth.password")
}
```

- [ ] **Step 1: Capture crypto fixtures from the baseline** (so new `Crypto` is proven compatible with files the old code wrote)

Run in `../agenv-pre-ts`: load `encryptJSON` via the old slicing helper and write fixtures:
```bash
node -e '
const fs=require("fs"),path=require("path"),crypto=require("crypto");
const src=fs.readFileSync("../agenv-pre-ts/server.js","utf8");
const a=src.indexOf("function getEncryptionKey"), b=src.indexOf("// Command history");
const os=require("os");
const dir="test/fixtures/crypto"; fs.mkdirSync(dir,{recursive:true});
const keyPath=path.resolve(dir,"key");
const body=src.slice(src.lastIndexOf("const ENCRYPTION_KEY_PATH",a)>-1?src.lastIndexOf("const ENCRYPTION_KEY_PATH",a):a,b).replace(/const ENCRYPTION_KEY_PATH[^\n]*\n/,"const ENCRYPTION_KEY_PATH="+JSON.stringify(keyPath)+";\n");
const m={exports:{}};new Function("module","require","fs","path","os","crypto",body+"\nmodule.exports={encryptJSON,decryptJSON};")(m,require,fs,path,os,crypto);
const plain={hello:"wörld",n:[1,2,3],nested:{a:null}};
fs.writeFileSync(path.join(dir,"plain.json"),JSON.stringify(plain));
fs.writeFileSync(path.join(dir,"cipher.json"),m.exports.encryptJSON(plain));
console.log("fixtures written", fs.readdirSync(dir));'
```
Expected: `key`, `plain.json`, `cipher.json` in `test/fixtures/crypto/`. If the slice markers don't match the baseline text, open `git show pre-ts:server.js | sed -n '38,86p'` and adjust the two `indexOf` anchors to the encryption block (`ENCRYPTION_KEY_PATH` … `decryptJSON`).

- [ ] **Step 2: Write the failing tests**

```js
// test/unit/core.test.js
"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { Crypto } = require("../../dist/core/Crypto");
const { Config } = require("../../dist/core/Config");
const { TypedEmitter } = require("../../dist/core/TypedEmitter");
const fx = path.join(__dirname, "..", "fixtures", "crypto");

describe("Crypto", () => {
  it("decrypts what the old server wrote", () => {
    const c = new Crypto(path.join(fx, "key"));
    assert.deepEqual(c.decryptJSON(fs.readFileSync(path.join(fx, "cipher.json"), "utf8")), JSON.parse(fs.readFileSync(path.join(fx, "plain.json"), "utf8")));
  });
  it("round-trips and creates a missing key file", () => {
    const keyPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agenv-k-")), "k");
    const c = new Crypto(keyPath);
    assert.deepEqual(c.decryptJSON(c.encryptJSON({ a: 1 })), { a: 1 });
    assert.ok(fs.existsSync(keyPath));
  });
  it("throws on garbage", () => {
    assert.throws(() => new Crypto(path.join(fx, "key")).decryptJSON("not-encrypted"));
  });
});

describe("Config", () => {
  const home = () => fs.mkdtempSync(path.join(os.tmpdir(), "agenv-c-"));
  it("applies flags and defaults", () => {
    const c = Config.fromArgv(["--port", "9000", "--max-sessions", "3", "--no-qr", "--token", "T"], {}, home());
    assert.equal(c.port, 9000); assert.equal(c.maxSessions, 3); assert.equal(c.showQr, false); assert.equal(c.token, "T");
    assert.equal(c.host, "127.0.0.1"); assert.equal(c.initialSessions, 1); assert.equal(c.mirror, false);
  });
  it("forces localhost under Electron", () => {
    assert.equal(Config.fromArgv(["--host", "0.0.0.0"], { ELECTRON: "1" }, home()).host, "127.0.0.1");
  });
  it("collects the run command and skips flags + their values", () => {
    const c = Config.fromArgv(["run", "claude", "--port", "1", "--model", "opus", "--name", "x"], {}, home());
    assert.equal(c.runCommand, "claude --model opus"); assert.equal(c.runName, "x");
  });
  it("persists dotted keys to ~/.agenvrc.json", () => {
    const h = home(); const c = Config.fromArgv([], {}, h);
    c.set("auth.username", "bob");
    assert.equal(Config.fromArgv([], {}, h).get("auth.username"), "bob");
  });
});

describe("TypedEmitter", () => {
  it("a throwing listener does not stop the others or the emitter", () => {
    const e = new TypedEmitter(); const seen = [];
    const origErr = console.error; console.error = () => {};
    try { e.on("x", () => { throw new Error("boom"); }); e.on("x", (v) => seen.push(v)); e.emit("x", 1); }
    finally { console.error = origErr; }
    assert.deepEqual(seen, [1]);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npm test 2>&1 | tail -20`
Expected: build FAILS (modules missing) — that is the red state.

- [ ] **Step 4: Implement** by porting from the baseline:
  - `Crypto` ← `getEncryptionKey/encryptJSON/decryptJSON` (L41–86; key file `~/.agenv.key` via the `keyPath` arg, mode `0o600` on creation).
  - `Config` + `cli/args.ts` ← `loadConfig/saveConfig/getConfigValue/setConfigValue` (L14–35), flag parsing and defaults (L405–432), `run` collection (L380–400), subcommand handling `help/version/set/get/update/stop/kill` (L255–372). `Config.fromArgv` parses only; the subcommand side effects (`stop`, `kill`, `update`, `set`, `get`, `help`, `version` printing/process exit) live in `src/cli/commands.ts` as `runCommand(config): boolean` returning `true` if it handled the command (the caller then exits). The password hash helpers `hashPassword/verifyPassword` (L247–253) move to `AuthService` (Task 9), but `set auth.password` needs hashing → import a shared `src/core/password.ts` exporting `hashPassword`/`verifyPassword` (create it in this task, port L247–253 verbatim).
  - `TypedEmitter`: wraps `events.EventEmitter`; `emit` wraps each listener call in try/catch → `console.error("[agenv] listener error:", e)`.
  - `HttpError`, `types.ts` exactly as in **Interfaces**.

- [ ] **Step 5: Verify**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: all PASS, `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src test/unit/core.test.js test/fixtures
git commit -m "feat(ts): core types, Config, CLI commands, Crypto (old-file compatible), TypedEmitter"
```

### Task 6: Persistence — JsonStore and the file-backed stores

**Files:**
- Create: `src/core/JsonStore.ts`, `src/persistence/StateStore.ts`, `src/persistence/HistoryStore.ts`, `src/persistence/ArchiveStore.ts`, `src/persistence/FavoritesStore.ts`, `src/persistence/ScrollbackStore.ts`
- Test: `test/unit/persistence.test.js`

**Interfaces:**
- Consumes: `Crypto`, types from Task 5.
- Produces:

```ts
export class JsonStore<T> { constructor(o: { path: string; crypto: Crypto; fallback: () => T; legacyPath?: string }); load(): T; save(v: T): void }
// load(): decrypt file; on failure try legacyPath (plain JSON) → save encrypted + unlink legacy → return it; else fallback().
export class StateStore { constructor(store: JsonStore<PersistedState | null>, snapshot: () => PersistedState, debounceMs?: number /*1000*/); load(): PersistedState | null; save(): void /*write now, then coalesce 1s; trailing write if requested meanwhile*/; saveNow(): void }
export class HistoryStore { constructor(store: JsonStore<string[]>); list(): string[]; add(cmd: string): void /* trim, skip empty, skip consecutive dup, cap 1000 */ }
export class ArchiveStore { constructor(store: JsonStore<ArchiveEntry[]>); list(): ArchiveEntry[]; add(e: ArchiveEntry): void /* cap 100 */; remove(closed: number): void }
export class FavoritesStore { constructor(store: JsonStore<Favorite[]>); list(): Favorite[]; add(f: Omit<Favorite,"created">): boolean /* false if duplicate cwd+command */; removeAt(i: number): boolean }
export class ScrollbackStore { constructor(dir: string, crypto: Crypto); load(id: number): Buffer | null; save(id: number, data: Buffer): void; clear(id: number): void }
```

- [ ] **Step 1: Failing tests** (use `node:test` mock timers for the debounce)

```js
// test/unit/persistence.test.js
"use strict";
const { describe, it, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { Crypto } = require("../../dist/core/Crypto");
const { JsonStore } = require("../../dist/core/JsonStore");
const { StateStore } = require("../../dist/persistence/StateStore");
const { HistoryStore } = require("../../dist/persistence/HistoryStore");
const { ArchiveStore } = require("../../dist/persistence/ArchiveStore");
const { FavoritesStore } = require("../../dist/persistence/FavoritesStore");
const { ScrollbackStore } = require("../../dist/persistence/ScrollbackStore");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "agenv-p-"));
const mk = (dir) => new Crypto(path.join(dir, "key"));

describe("JsonStore", () => {
  it("saves encrypted and loads back", () => {
    const d = tmp(); const s = new JsonStore({ path: path.join(d, "a.enc"), crypto: mk(d), fallback: () => [] });
    s.save([1, 2]); assert.deepEqual(s.load(), [1, 2]);
    assert.ok(!fs.readFileSync(path.join(d, "a.enc"), "utf8").includes("[1,2]"));
  });
  it("returns the fallback for a missing or corrupt file", () => {
    const d = tmp(); const p = path.join(d, "a.enc");
    const s = new JsonStore({ path: p, crypto: mk(d), fallback: () => ["fb"] });
    assert.deepEqual(s.load(), ["fb"]); fs.writeFileSync(p, "garbage"); assert.deepEqual(s.load(), ["fb"]);
  });
  it("migrates a legacy plain-JSON file and deletes it", () => {
    const d = tmp(); const legacy = path.join(d, "a.json"); fs.writeFileSync(legacy, JSON.stringify(["old"]));
    const s = new JsonStore({ path: path.join(d, "a.enc"), crypto: mk(d), fallback: () => [], legacyPath: legacy });
    assert.deepEqual(s.load(), ["old"]); assert.ok(!fs.existsSync(legacy)); assert.deepEqual(s.load(), ["old"]);
  });
});

describe("StateStore debounce", () => {
  it("writes immediately, coalesces for the window, then writes the latest once", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      let writes = 0, n = 0;
      const store = { load: () => null, save: () => { writes++; } };
      const st = new StateStore(store, () => ({ sessions: [], workspaceLayout: n++, sessionGroups: [] }), 1000);
      st.save(); assert.equal(writes, 1);
      st.save(); st.save(); assert.equal(writes, 1);
      mock.timers.tick(1000); assert.equal(writes, 2);
      mock.timers.tick(1000); assert.equal(writes, 2);
    } finally { mock.timers.reset(); }
  });
});

describe("History/Archive/Favorites", () => {
  const stores = () => { const d = tmp(), c = mk(d); const j = (n, f) => new JsonStore({ path: path.join(d, n), crypto: c, fallback: f }); return { h: new HistoryStore(j("h", () => [])), a: new ArchiveStore(j("a", () => [])), f: new FavoritesStore(j("f", () => [])) }; };
  it("history: trims, skips empty and consecutive duplicates, caps at 1000", () => {
    const { h } = stores(); h.add("  ls "); h.add("ls"); h.add(""); assert.deepEqual(h.list(), ["ls"]);
    for (let i = 0; i < 1100; i++) h.add("c" + i); assert.equal(h.list().length, 1000); assert.equal(h.list().at(-1), "c1099");
  });
  it("archive: caps at 100 and removes by closed timestamp", () => {
    const { a } = stores(); const e = (i) => ({ name: "n" + i, cwd: "/", tool: "terminal", lastCommand: "", launchCommand: "", group: "", claudeSessionId: null, created: 1, lastActivity: 1, closed: i });
    for (let i = 1; i <= 120; i++) a.add(e(i));
    assert.equal(a.list().length, 100); a.remove(120); assert.ok(!a.list().some((x) => x.closed === 120));
  });
  it("favorites: rejects duplicates, removes by index", () => {
    const { f } = stores(); assert.equal(f.add({ name: "a", cwd: "/x", command: "ls", tool: "terminal" }), true);
    assert.equal(f.add({ name: "b", cwd: "/x", command: "ls", tool: "terminal" }), false);
    assert.equal(f.removeAt(5), false); assert.equal(f.removeAt(0), true); assert.equal(f.list().length, 0);
  });
});

describe("ScrollbackStore", () => {
  it("round-trips, returns null for unknown ids, clears", () => {
    const d = tmp(); const s = new ScrollbackStore(path.join(d, "sb"), mk(d));
    assert.equal(s.load(1), null); s.save(1, Buffer.from("héllo")); assert.equal(s.load(1).toString(), "héllo");
    s.clear(1); assert.equal(s.load(1), null);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test 2>&1 | tail -15` — Expected: build fails (modules missing).

- [ ] **Step 3: Implement** by porting: `JsonStore` ← the common shape of `loadHistory/loadArchive/loadFavorites/loadState` fallbacks and legacy migrations (L87–101, L127–131, L155–160, L165–182); `StateStore.save/saveNow` ← `saveState/saveStateNow` debounce (L184–215; the timer is `unref()`ed); `HistoryStore` ← history logic in `POST /api/history` (L1387–1400: trim, consecutive-dup skip, `MAX_HISTORY = 1000`); `ArchiveStore` ← `archiveSession` list handling (L127–154, `MAX_ARCHIVE = 100`) plus `POST /api/archive/remove` (L1436); `FavoritesStore` ← L1444–1472; `ScrollbackStore` ← L102–125 (`.agenv-scrollback/session-<id>.enc`, content is `encryptJSON(string)`; **`load` returns a `Buffer` of the decrypted string**, as the baseline does).

- [ ] **Step 4: Verify**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"` — Expected: `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src test/unit/persistence.test.js
git commit -m "feat(ts): JsonStore repository and state/history/archive/favorites/scrollback stores"
```

---

## Phase C — Sessions

### Task 7: Scrollback ring and OutputAnalyzer

**Files:**
- Create: `src/sessions/Scrollback.ts`, `src/sessions/OutputAnalyzer.ts`, `src/sessions/events.ts`
- Modify: `test/session.test.js` (the `Scrollback ring buffer` block, baseline L83–125 of that file)
- Test: `test/unit/analyzer.test.js`

**Interfaces:**
- Produces:

```ts
// src/sessions/events.ts
import type { Session } from "./Session";
import type { SessionStatus } from "../core/types";
export interface SessionEvents {
  created: (s: Session) => void;
  output: (s: Session, data: string) => void;
  status: (s: Session, status: SessionStatus) => void;
  cwd: (s: Session, cwd: string) => void;
  command: (s: Session, cmd: string) => void;
  changed: (s: Session) => void;
  deleted: (s: Session, exitCode: number) => void;
}
export type SessionBus = TypedEmitter<SessionEvents>;

// src/sessions/Scrollback.ts
export const MAX_SCROLLBACK = 100 * 1024;
export class Scrollback { constructor(initial?: Buffer); append(data: string | Buffer): void; read(): Buffer; get bytes(): number; dirty: boolean }
// OutputAnalyzer: subscribes to bus "output"; per session a ≤8192-char tail and a 250 ms timer
export function detectSessionStatus(text: string): SessionStatus | null;
export function parseTokenInfo(text: string): { inputTokens?: number; outputTokens?: number; cost?: number } | null;
export class OutputAnalyzer { constructor(bus: SessionBus, isRealDir: (p: string) => boolean, platform?: NodeJS.Platform); dispose(): void }
```
`OutputAnalyzer` on each round mutates `session.cwd`/`session.status`/`session.analytics` and emits `cwd`, `status`, `changed` on the bus (as `setSessionCwd`/`runDetection` do).

- [ ] **Step 1: Convert the Scrollback tests** — in `test/session.test.js` replace the `loadInternals(...)` setup with:

```js
const { Scrollback, MAX_SCROLLBACK } = require("../dist/sessions/Scrollback");
const rb = { MAX_SCROLLBACK, appendScrollback: (s, c) => (s.sb || (s.sb = new Scrollback())).append(c), getScrollback: (s) => (s.sb || (s.sb = new Scrollback())).read() };
```
(the three existing `it` bodies stay unchanged — they call `rb.appendScrollback/getScrollback(session, …)`). Remove `loadInternals` from that file's import list.

- [ ] **Step 2: Failing analyzer tests**

```js
// test/unit/analyzer.test.js
"use strict";
const { describe, it, mock } = require("node:test");
const assert = require("node:assert/strict");
const { TypedEmitter } = require("../../dist/core/TypedEmitter");
const { OutputAnalyzer, detectSessionStatus, parseTokenInfo } = require("../../dist/sessions/OutputAnalyzer");

describe("detectSessionStatus", () => {
  it("waiting beats busy beats error beats idle", () => {
    assert.equal(detectSessionStatus("Do you want to proceed? (y/n)"), "waiting");
    assert.equal(detectSessionStatus("Downloading... 40%"), "running");
    assert.equal(detectSessionStatus("fatal: not a git repository"), "error");
    assert.equal(detectSessionStatus("user@host:~$ "), "idle");
    assert.equal(detectSessionStatus("just some text"), null);
  });
});
describe("parseTokenInfo", () => {
  it("reads cost and token counts", () => {
    assert.deepEqual(parseTokenInfo("Total cost: $1.25"), { cost: 1.25 });
    assert.deepEqual(parseTokenInfo("1,200 input tokens and 300 output tokens"), { inputTokens: 1200, outputTokens: 300 });
    assert.equal(parseTokenInfo("nothing here"), null);
  });
});
describe("OutputAnalyzer", () => {
  const mkSession = () => ({ id: 1, cwd: "C:\\old", status: "idle", detectedTool: "claude", analytics: { inputTokens: 0, outputTokens: 0, estimatedCost: 0, commandCount: 0, turnCount: 0, startTime: 0 } });
  it("detects the cwd from a Windows PowerShell prompt and emits cwd + changed (batched at 250ms)", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const bus = new TypedEmitter(); const s = mkSession(); const ev = [];
      bus.on("cwd", (_s, c) => ev.push(["cwd", c])); bus.on("changed", () => ev.push(["changed"]));
      new OutputAnalyzer(bus, () => true, "win32");
      bus.emit("output", s, "PS C:\\Users\\me\\proj> ");
      assert.deepEqual(ev, []);                                   // nothing until the timer fires
      mock.timers.tick(250);
      assert.equal(s.cwd, "C:\\Users\\me\\proj"); assert.deepEqual(ev[0], ["cwd", "C:\\Users\\me\\proj"]);
    } finally { mock.timers.reset(); }
  });
  it("ignores a prompt path that is not a real directory", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const bus = new TypedEmitter(); const s = mkSession();
      new OutputAnalyzer(bus, () => false, "win32");
      bus.emit("output", s, "C:\\nope>"); mock.timers.tick(250); assert.equal(s.cwd, "C:\\old");
    } finally { mock.timers.reset(); }
  });
  it("accumulates cost for agent sessions only, and emits status changes", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const bus = new TypedEmitter(); const s = mkSession(); const st = [];
      bus.on("status", (_s, v) => st.push(v)); new OutputAnalyzer(bus, () => true, "linux");
      bus.emit("output", s, "Thinking...\n"); mock.timers.tick(250);
      assert.deepEqual(st, ["running"]); assert.equal(s.status, "running");
      bus.emit("output", s, "Total cost: $0.50\n"); mock.timers.tick(250);
      assert.equal(s.analytics.estimatedCost, 0.5); assert.equal(s.analytics.turnCount, 1);
      const t = { ...mkSession(), detectedTool: "terminal" };
      bus.emit("output", t, "Total cost: $9.99\n"); mock.timers.tick(250); assert.equal(t.analytics.estimatedCost, 0);
    } finally { mock.timers.reset(); }
  });
});
```

- [ ] **Step 3: Run to verify failure** — `npm test 2>&1 | tail -15` → build fails.

- [ ] **Step 4: Implement** — `Scrollback` ← `newScrollback/appendScrollback/getScrollback` (L458–516; keep the chunk-list ring, `SCROLLBACK_CAP`, truncation realignment and reset prefix exactly; `dirty` replaces `rb.dirty`). `OutputAnalyzer`, `detectSessionStatus`, `parseTokenInfo` ← `STATUS_PATTERNS`, `COST_PATTERNS`, `detectSessionStatus`, `parseTokenInfo` (L536–653) and the analysis block (L747–843: `STRIP_ANSI`, `OSC7_CWD`, `CMD_PROMPT`, `PS_PROMPT`, `noteForDetection`, `runDetection`, `setSessionCwd` minus `saveState` which becomes the `changed` event). When resolving a detected prompt path use `path.win32.resolve` if `platform === "win32"` (identical to `path.resolve` on Windows; keeps the Windows-prompt tests passing on Linux CI). `isRealDir` is injected (the real implementation with its 500-entry `_knownDirs` cache moves to `src/core/fsUtil.ts` — create it here, port L763–774).

- [ ] **Step 5: Verify** — `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"` → `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src test
git commit -m "feat(ts): Scrollback ring, OutputAnalyzer, session event types"
```

### Task 8: Session, SessionManager, GroupRegistry

**Files:**
- Create: `src/sessions/Session.ts`, `src/sessions/SessionManager.ts`, `src/sessions/GroupRegistry.ts`, `src/sessions/pty.ts`, `src/sessions/shell.ts`
- Test: `test/unit/sessions.test.js`

**Interfaces:**
- Consumes: `SessionBus`, `Scrollback`, `ScrollbackStore`, `StateStore`, `ArchiveStore`, types.
- Produces:

```ts
// src/sessions/pty.ts
export interface IPty { pid: number; cols: number; rows: number; onData(cb: (d: string) => void): void; onExit(cb: (e: { exitCode: number }) => void): void; write(d: string): void; resize(c: number, r: number): void; kill(): void }
export type PtyFactory = (o: { file: string; args: string[]; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv }) => IPty;
// src/sessions/shell.ts
export function parseShell(shell: string): { file: string; args: string[] };   // L521–525 behavior: quoted segments kept whole, outer quotes stripped
// src/sessions/Session.ts
export interface SessionInit { id: number; name?: string; cwd: string; group?: string; note?: string; claudeSessionId?: string | null; tool?: string; lastCommand?: string; launchCommand?: string; userNamed?: boolean; created?: number; lastActivity?: number; runCommand?: string | null; cols: number; rows: number; scrollback?: Scrollback }
export class Session {
  readonly id: number; name: string; cwd: string; group: string; note: string; claudeSessionId: string | null; claudeRunning: boolean;
  detectedTool: string; lastCommand: string; launchCommand: string; userNamed: boolean; status: SessionStatus;
  created: number; lastActivity: number; analytics: Analytics; scrollback: Scrollback; pendingCommand: string | null;
  cols: number; rows: number; live: boolean; pty: IPty | null;
  toPersisted(): PersistedSession; toListItem(clients: number): Record<string, unknown>;   // GET /api/sessions shape (L1170–1185)
}
// src/sessions/SessionManager.ts
export class SessionManager {
  constructor(o: { bus: SessionBus; ptyFactory: PtyFactory; shell: string; maxSessions: number; defaultCols: number; defaultRows: number; scrollbackStore: ScrollbackStore; archive: ArchiveStore; isRealDir: (p: string) => boolean; env?: NodeJS.ProcessEnv });
  get(id: number): Session | undefined; all(): Session[]; get size(): number; nextId: number;
  create(o: { cwd?: string; name?: string; group?: string; runCommand?: string | null; restoreScrollback?: boolean }): Session;   // spawns a shell; throws HttpError(400, "Maximum sessions reached (N)") at the limit
  restore(records: PersistedSession[], neededIds?: Set<number>): void;                // sleeping tabs (live=false); nextId = max(id)+1
  wake(s: Session): void;                                                             // spawn the shell for a sleeping record (idempotent)
  restart(id: number): Session; delete(id: number, exitCode?: number): void;          // delete archives, kills shell, emits deleted
  write(s: Session, data: string): void; resize(s: Session, cols: number, rows: number): void;
  noteCommand(s: Session, cmd: string): void;                                         // lastCommand, tool detection (detectTool), emits command + changed
  saveAllScrollback(force?: boolean): void; shutdown(): void;                         // shutdown: save scrollback, kill all shells
}
// src/sessions/GroupRegistry.ts
export class GroupRegistry {
  constructor(o: { sessions: () => Iterable<Session>; emitChanged: () => void; defs?: GroupDef[] });
  static normalize(p: unknown): string;                       // normalizeGroupPath (L1233): trim segments, drop empties, ≤64 chars each, ≤8 deep
  list(): GroupDef[]; replace(groups: unknown[]): GroupDef[]; rename(from: string, to: string): GroupDef[] /* throws HttpError(400) on move-into-self or missing args */; remove(path: string): GroupDef[];
  get defs(): GroupDef[];
}
```

- [ ] **Step 1: Failing tests** (fake pty; no real shells)

```js
// test/unit/sessions.test.js
"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { TypedEmitter } = require("../../dist/core/TypedEmitter");
const { Crypto } = require("../../dist/core/Crypto");
const { JsonStore } = require("../../dist/core/JsonStore");
const { ArchiveStore } = require("../../dist/persistence/ArchiveStore");
const { ScrollbackStore } = require("../../dist/persistence/ScrollbackStore");
const { SessionManager } = require("../../dist/sessions/SessionManager");
const { GroupRegistry } = require("../../dist/sessions/GroupRegistry");
const { parseShell } = require("../../dist/sessions/shell");

function rig(over = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "agenv-s-")); const crypto = new Crypto(path.join(d, "key"));
  const bus = new TypedEmitter(); const spawned = []; const events = [];
  for (const ev of ["created", "output", "changed", "deleted", "command", "cwd", "status"]) bus.on(ev, (...a) => events.push([ev, ...a.slice(1)]));
  const ptyFactory = (o) => { const handlers = {}; const p = { pid: 1000 + spawned.length, cols: o.cols, rows: o.rows, written: [], killed: false,
    onData: (cb) => (handlers.data = cb), onExit: (cb) => (handlers.exit = cb), write: (x) => p.written.push(x), resize: (c, r) => { p.cols = c; p.rows = r; }, kill: () => { p.killed = true; }, emit: (x) => handlers.data(x), exit: (c) => handlers.exit({ exitCode: c }), opts: o }; spawned.push(p); return p; };
  const archive = new ArchiveStore(new JsonStore({ path: path.join(d, "arch"), crypto, fallback: () => [] }));
  const m = new SessionManager({ bus, ptyFactory, shell: 'cmd.exe', maxSessions: over.max || 3, defaultCols: 120, defaultRows: 30, scrollbackStore: new ScrollbackStore(path.join(d, "sb"), crypto), archive, isRealDir: () => true });
  return { m, bus, spawned, events, archive, d };
}
const rec = (id, extra = {}) => ({ id, name: "n" + id, cwd: "/tmp", tool: "terminal", lastCommand: "", launchCommand: "", userNamed: false, group: "", note: "", claudeSessionId: null, created: 1, lastActivity: 1, ...extra });

describe("parseShell", () => {
  it("keeps quoted segments whole and strips the quotes", () => {
    assert.deepEqual(parseShell('"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo -NoProfile'), { file: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", args: ["-NoLogo", "-NoProfile"] });
    assert.deepEqual(parseShell("bash"), { file: "bash", args: [] });
  });
});

describe("SessionManager", () => {
  it("restore keeps ids, allocates the next id after the max, and spawns no shells", () => {
    const { m, spawned } = rig(); m.restore([rec(3), rec(7)]);
    assert.deepEqual(m.all().map((s) => s.id).sort(), [3, 7]); assert.equal(m.nextId, 8); assert.equal(spawned.length, 0);
    assert.equal(m.get(3).live, false);
  });
  it("wake spawns once (idempotent) and a stale pty's output is ignored after restart", () => {
    const { m, spawned, events } = rig(); m.restore([rec(1)]); const s = m.get(1);
    m.wake(s); m.wake(s); assert.equal(spawned.length, 1);
    const first = spawned[0]; m.restart(1); assert.ok(first.killed); assert.equal(spawned.length, 2);
    first.emit("stale"); spawned[1].emit("fresh");
    const outs = events.filter((e) => e[0] === "output").map((e) => e[1]); assert.deepEqual(outs, ["fresh"]);
  });
  it("enforces the session limit with a 400", () => {
    const { m } = rig({ max: 1 }); m.create({});
    assert.throws(() => m.create({}), (e) => e.status === 400 && /Maximum sessions reached \(1\)/.test(e.message));
  });
  it("delete archives with group + claude link, kills the shell, emits deleted(-1)", () => {
    const { m, spawned, events, archive } = rig(); const s = m.create({ name: "x", group: "p/q" }); s.claudeSessionId = "cid";
    m.delete(s.id);
    assert.ok(spawned[0].killed); assert.equal(m.get(s.id), undefined);
    const a = archive.list().at(-1); assert.equal(a.group, "p/q"); assert.equal(a.claudeSessionId, "cid");
    assert.deepEqual(events.find((e) => e[0] === "deleted"), ["deleted", -1]);
  });
  it("a shell that exits by itself is archived and deleted with its exit code", () => {
    const { m, spawned, events, archive } = rig(); m.create({ name: "y" }); spawned[0].exit(7);
    assert.equal(m.size, 0); assert.equal(archive.list().length, 1); assert.deepEqual(events.find((e) => e[0] === "deleted"), ["deleted", 7]);
  });
  it("a throwing subscriber does not stop pty output reaching other subscribers", () => {
    const { m, bus, spawned } = rig(); const seen = []; const orig = console.error; console.error = () => {};
    try { bus.on("output", () => { throw new Error("bad"); }); bus.on("output", (_s, d) => seen.push(d)); m.create({}); spawned[0].emit("hi"); }
    finally { console.error = orig; }
    assert.deepEqual(seen, ["hi"]);
  });
  it("noteCommand records the command, detects the tool and emits command", () => {
    const { m, events } = rig(); const s = m.create({}); m.noteCommand(s, "claude --model opus");
    assert.equal(s.lastCommand, "claude --model opus"); assert.equal(s.detectedTool, "claude");
    assert.ok(events.some((e) => e[0] === "command" && e[1] === "claude --model opus"));
  });
  it("shutdown saves scrollback and kills every shell", () => {
    const { m, spawned } = rig(); m.create({}); m.create({}); m.shutdown(); assert.ok(spawned.every((p) => p.killed));
  });
});

describe("GroupRegistry", () => {
  const mk = (sessions = []) => { let changed = 0; const r = new GroupRegistry({ sessions: () => sessions, emitChanged: () => changed++ }); return { r, sessions, changed: () => changed }; };
  it("normalizes paths", () => {
    assert.equal(GroupRegistry.normalize(" a / b//c "), "a/b/c"); assert.equal(GroupRegistry.normalize(null), "");
    assert.equal(GroupRegistry.normalize("x/".repeat(20)).split("/").length, 8);
  });
  it("lists stored folders, session folders and all ancestors", () => {
    const { r } = mk([{ group: "p/q/r" }]); r.replace([{ path: "z/y", color: "#fff" }]);
    const paths = r.list().map((g) => g.path); for (const p of ["p", "p/q", "p/q/r", "z", "z/y"]) assert.ok(paths.includes(p), p);
    assert.equal(r.list().find((g) => g.path === "z/y").color, "#fff");
  });
  it("rename moves sessions and stored folders; a shared prefix stays put; self-move is a 400", () => {
    const a = { group: "p/dev" }, b = { group: "px" }; const { r } = mk([a, b]); r.replace([{ path: "p/dev/x", color: "" }]);
    r.rename("p/dev", "p/ops"); assert.equal(a.group, "p/ops"); assert.equal(b.group, "px");
    assert.ok(r.list().some((g) => g.path === "p/ops/x"));
    assert.throws(() => r.rename("p", "p/ops/in"), (e) => e.status === 400);
  });
  it("remove moves sessions to the parent and drops the subtree", () => {
    const a = { group: "p/q/r" }; const { r } = mk([a]); r.replace([{ path: "p/q/r/s", color: "" }]);
    r.remove("p/q"); assert.equal(a.group, "p"); assert.ok(!r.list().some((g) => g.path.startsWith("p/q")));
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npm test 2>&1 | tail -15` → build fails.

- [ ] **Step 3: Implement** — ports:
  - `parseShell` ← L521–525.
  - `Session` ← `createSession` record (L844–880) + the list/persist shapes (`GET /api/sessions` L1170–1185, `saveStateNow` item shape L184–200).
  - `SessionManager` ← `startSession/spawnSession/destroySession` (L880–958), `POST /api/sessions` limit (L1187–1197), restart logic (L1313–1343), delete logic (L1298–1312), restore + id allocation (L961–1015, including `neededIds` layout filtering, the `MAX_SESSIONS` most-recent fallback and the `RUN_COMMAND` single-session start — the *caller* `index.ts` decides which; the manager exposes `restore(records, neededIds?)`), `pendingCommand` 500 ms delayed write (L886–898), `noteCommand` (history route logic L1400–1428 for `lastCommand`/`detectTool`/auto-name/`cd` cwd tracking, **minus** the HTTP parts), `detectTool` + `TOOL_PATTERNS` (L217–246 → `src/sessions/tools.ts`). The stale-handler guards (`if (session.pty !== ptyProcess) return`) stay. Every state change that baseline followed with `saveState()` emits `changed`.
  - `GroupRegistry` ← L1225–1297 (`normalizeGroupPath`, `isInGroup`, `groupAncestors`, `listSessionGroups`, the three handlers' logic).

- [ ] **Step 4: Verify** — `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"` → `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src test/unit/sessions.test.js
git commit -m "feat(ts): Session, SessionManager, GroupRegistry with injectable pty"
```

---

## Phase D — HTTP/WebSocket edge

### Task 9: AuthService and tunnel policy

**Files:**
- Create: `src/security/AuthService.ts`, `src/security/NgrokPolicy.ts`
- Test: `test/unit/auth.test.js`

**Interfaces:**
- Consumes: `Config`, `password.ts` (Task 5).
- Produces:

```ts
export interface NgrokPolicy { allowedIps: string[]; readOnly: boolean }          // mutable; NgrokTunnel (Task 15) owns the instance
export class AuthService {
  constructor(o: { config: Config; policy: NgrokPolicy });
  get useCredentials(): boolean;                                                    // L431: auth.username/auth.password configured
  isAuthenticated(req: { headers: Record<string, any>; url?: string; query?: any }): boolean;   // cookie session OR ?token=
  apiAuth: express.RequestHandler;                                                  // L1143–1168 incl. tunnel allow-list + read-only write-path block
  rateLimit: express.RequestHandler;                                                // L1105–1130: 600 req/min/IP, 429 body {error:"Rate limit exceeded. Try again later."}
  isTunnelRequest(req): boolean; clientIp(req): string; isReadOnlyTunnel(req): boolean;
  rotateToken(): string;                                                            // L2638–2650
  registerPages(app: express.Express, buildPage: (token: string) => string): void;   // GET/POST /login, GET / (L3280–3316)
}
```

- [ ] **Step 1: Failing tests** — cover: `?token=` accepted/rejected; cookie session accepted after a credentials login; `apiAuth` returns `401 {error:"Unauthorized"}`; with `policy.allowedIps=["1.1.1.1"]` and an `x-forwarded-for: 2.2.2.2` header → `403 {error:"IP not in allowlist: 2.2.2.2"}`; with `policy.readOnly=true`, `x-forwarded-for` set → `POST /api/file` is `403`, `GET` passes; the rate limiter returns 429 on request 601 from one IP and is per-IP; `rotateToken()` changes `config.token` and invalidates the old one. Use a fake `res` (`{ status(c){…;return this}, json(b){…} }`) and call the handlers directly.

- [ ] **Step 2: Run to verify failure**, **Step 3: Implement** by porting L247–253 (`password.ts` already), L431–455 (`useCredentials`, `parseCookies`, `isAuthenticated`), L1105–1168 (`apiRateLimit` + stale-bucket sweep interval `unref()`ed, `isNgrokRequest`, `getClientIp`, `apiAuth` and its `writePaths` list), L2638–2650 (token rotation, also updates the `config.token`), L3280–3316 (login pages and the `/` route: credentials mode serves the page to cookie sessions and redirects/serves login otherwise; token mode checks `req.query.token`). **Step 4: Verify** `npm test` → `fail 0`. In this task also add to `test/unit/auth.test.js` a credentials-mode test of `GET /login` (200), `POST /login` with bad creds (the baseline status/body) and good creds (sets a `session` cookie) by mounting `registerPages` on a bare Express app and calling it with Node's `http` client.

- [ ] **Step 5: Commit**

```bash
git add src test/unit/auth.test.js
git commit -m "feat(ts): AuthService (token, cookies, rate limit, tunnel policy, login pages)"
```

### Task 10: WsGateway

**Files:**
- Create: `src/http/WsGateway.ts`
- Test: `test/unit/ws-gateway.test.js` (new) + existing `test/session.test.js` ws tests (run later against the new entry in Task 17)

**Interfaces:**
- Consumes: `SessionManager`, `AuthService`, `SessionBus`, `NgrokPolicy`.
- Produces:

```ts
export class WsGateway {
  constructor(o: { server: http.Server; sessions: SessionManager; auth: AuthService; policy: NgrokPolicy; bus: SessionBus; pingMs?: number; maxBuffered?: number });
  clientCount(sessionId: number): number;
  broadcastEvent(event: string): void;      // {type:"event",event} to every client of every session (L959–963)
  dispose(): void;                          // clears the heartbeat; closes sockets
}
```
Behavior (all ported, L678–745 and L3317–3390): output coalescing (`OUTPUT_FLUSH_MS=16`, `OUTPUT_FLUSH_BYTES=64KB`) per session only while it has clients; clients with `bufferedAmount > maxBuffered` (default 4 MiB, env `AGENV_WS_MAX_BUFFERED`) are terminated; heartbeat ping (env `AGENV_WS_PING_MS`, default 20000, min 1000) terminates clients that did not pong; close codes `4401` (unauthorized), `4403` (IP not allowed), `4404` (no such session), `4500` (cannot start), `4429` (rate limit 200 msg/s); on connect wakes a sleeping session, sends `resize` then the scrollback as `{type:"output",data,replay:true}`; `input` ≤ 262144 chars written unless read-only tunnel; `resize` clamped to cols 1–500, rows 1–200; on bus `deleted` sends `{type:"exit",code}` and closes with 1000 `"session closed"` (+500 ms terminate guard); on bus `status`/`cwd` sends `{type:"status",status,sessionId}` / `{type:"cwd",cwd}`.

- [ ] **Step 1: Failing test** — Review-Focus #4 (hostile input). Using `ws` against a gateway on an ephemeral port with a fake `SessionManager`-like object (a real one over a fake pty from Task 8's rig is fine):

```js
// asserts, each in its own `it`:
//  - a non-JSON text frame is ignored and the socket stays open
//  - {type:"nonsense"} is ignored
//  - {type:"input",data:123} (non-string) is ignored
//  - {type:"resize",cols:"x",rows:-5} clamps to cols 80 / rows 1 (baseline: Number(msg.cols)||80, Math.max(1,…))
//  - input to a session deleted mid-connection (bus.emit "deleted") closes with 1000 and does not throw
//  - >200 messages in a second closes with 4429
//  - unauthenticated upgrade closes with 4401; unknown session closes with 4404
```

- [ ] **Step 2: Run to verify failure**, **Step 3: Implement** (port as above; per-session `OutputBatcher` is a small private class inside the file), **Step 4: Verify** `npm test` → `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src test/unit/ws-gateway.test.js
git commit -m "feat(ts): WsGateway (batching, backpressure, heartbeat, hostile-input safe)"
```

---

## Phase E — Services

### Task 11: TranscriptScanner, UsageService, SessionIndex

**Files:**
- Create: `src/claude/TranscriptScanner.ts`, `src/claude/UsageService.ts`, `src/claude/SessionIndex.ts`, `src/claude/paths.ts`
- Test: existing `test/claude-usage.test.js` (via HTTP, Task 17) + `test/unit/transcripts.test.js`

**Interfaces:**
- Produces:

```ts
// paths.ts
export const claudePaths: (home: string) => { home: string; projects: string; sessions: string; indexFile: string };
// TranscriptScanner (L2146–2181, L2373–2394, L2975–2992)
export class TranscriptScanner {
  constructor(projectsDir: string);
  scan(file: string, start: number, onEntry: (e: any) => void): Promise<number>;   // streams 1 MiB chunks; returns offset past the last consumed line; parses an unterminated tail only if valid JSON
  listFiles(): Promise<string[]>;                                                   // *.jsonl up to depth 5
  firstLine(file: string): string;                                                  // ≤8 MiB, 64 KiB reads
}
// UsageService (L2094–2145 pricing; L2386–2534)
export class UsageService {
  constructor(scanner: TranscriptScanner, refreshMs?: number /* env AGENV_USAGE_REFRESH_MS, default 10000 */);
  query(o: { from?: string; to?: string; provider?: string }): Promise<UsageResult>;   // same JSON as GET /api/claude-usage
}
// SessionIndex (L2732–2970)
export class SessionIndex {
  constructor(scanner: TranscriptScanner, p: { projects: string; indexFile: string });
  build(force?: boolean): Promise<IndexedSession[]>;      // per-file cache (size+mtime), persisted, concurrent callers share one build
  search(q: string): Promise<(IndexedSession & { score: number })[]>;   // scoring L2921–2943
  conversation(id: string): Promise<(IndexedSession & { entries: unknown[] }) | null>;   // L2944–2964
}
```

- [ ] **Step 1: Unit tests (new)** — `TranscriptScanner.scan`: (a) returns the offset after the last newline, (b) re-scanning from that offset yields only appended lines, (c) an unterminated *valid* JSON tail is consumed and an unterminated *invalid* tail is not, (d) a 3-line file with a malformed middle line yields 2 entries. `UsageService`: (e) pricing — a `bedrock` message id (`msg_bdrk_…`) with the haiku model is priced from the bedrock table; (f) date filter `from/to` boundaries (`to` exclusive); (g) two concurrent `query()` calls trigger one scan (count `scanner.scan` calls with a wrapper). `SessionIndex`: (h) three concurrent `build(true)` share one build; (i) a changed file is re-indexed, an unchanged file is not (spy on `indexFile` count via file mtime).

- [ ] **Step 2: Run to verify failure**, **Step 3: Implement** by porting; `StopWords` stays in `SessionIndex.ts`; `PRICING_TABLES`, `getModelPricing`, `detectProvider`, `extractTokens` become module-level data/functions in `UsageService.ts`. **Step 4: Verify** `npm test` → `fail 0`. **Step 5: Commit** `feat(ts): TranscriptScanner, UsageService, SessionIndex`.

### Task 12: ClaudeLinker and ClaudeMdService

**Files:**
- Create: `src/claude/ClaudeLinker.ts`, `src/claude/ClaudeMdService.ts`, `src/claude/templates.ts`
- Modify: `test/claude-link.test.js` (replace `loadInternals`), `test/helpers.js` (delete `loadInternals`, now unused), `test/session.test.js` import list
- Test: `test/unit/claude-linker.test.js`

**Interfaces:**
- Produces:

```ts
export class ClaudeLinker {
  static resolveLinks(registry: { pid: number; sessionId: string; startedAt?: number }[], parentOf: Map<number, number>, roots: Map<number, number>): Map<number, string>;   // resolveClaudeLinks (L2203–2222), cycle-safe, newest wins
  static idFromCommand(cmd: string): string | null;                                                                                          // claudeIdFromCommand (L2193–2201)
  constructor(o: { bus: SessionBus; sessions: SessionManager; scanner: TranscriptScanner; paths: { sessions: string; projects: string }; intervalMs?: number /*15000*/; listProcesses?: () => Promise<Map<number, number>> });
  start(): void; stop(): void; refresh(): Promise<void>;                                  // linkClaudeSessions (L2280–2328); subscribes to bus "command" (noteClaudeCommand L2269–2279)
  renameConversation(id: string, title: string): Promise<boolean>;                        // custom-title append (L2329–2350)
  conversationCwd(id: string): Promise<string | null>;                                    // L2351–2372
}
export class ClaudeMdService { constructor(o: { projects: string; home: string }); /* list/read/write/templates/memory — L2972–3230 incl. getProjectPaths 60 s cache */ }
```
`ClaudeLinker` sets `session.claudeSessionId` / `claudeRunning` and emits `changed` when the link changes. The `PUT /api/sessions/:id` handler (Task 16) calls `renameConversation` after a rename.

- [ ] **Step 1: Point the two old tests at compiled code** — in `test/claude-link.test.js` replace the `loadInternals` call with:

```js
const { ClaudeLinker } = require("../dist/claude/ClaudeLinker");
const resolveClaudeLinks = ClaudeLinker.resolveLinks, claudeIdFromCommand = ClaudeLinker.idFromCommand;
```
(delete `loadInternals` from that file's helper import and from `test/helpers.js` exports; `test/session.test.js` already dropped it in Task 7).

- [ ] **Step 2: New unit tests** — `refresh()` with an injected `listProcesses` and a temp `sessions` dir containing `{pid,sessionId,startedAt}` files: (a) links the session whose pty pid is an ancestor of the claude pid, (b) sets `claudeRunning` true then false after the registry file is removed, (c) caches a pid that belongs to no session (the injected `listProcesses` is called once across two refreshes), (d) a `command` event with `claude --resume <uuid>` links immediately without calling `listProcesses`, (e) `renameConversation` appends exactly one `{"type":"custom-title","customTitle":…,"sessionId":…}` line and inserts a leading `\n` when the file does not end with one, (f) `conversationCwd` returns the first `cwd` in the transcript.

- [ ] **Step 3: Run to verify failure**, **Step 4: Implement** (port as listed; `ClaudeMdService` ports the project-path resolution using `TranscriptScanner.firstLine`). **Step 5: Verify** `npm test` → `fail 0`. **Step 6: Commit** `feat(ts): ClaudeLinker, ClaudeMdService; tests use compiled classes`.

### Task 13: GitService (async)

**Files:**
- Create: `src/features/GitService.ts`, `src/features/exec.ts`
- Test: `test/unit/git.test.js`

**Interfaces:**
- Produces:

```ts
// exec.ts — async replacement for spawnSync with the same result shape the handlers use
export function run(cmd: string, args: string[], o: { cwd: string; timeoutMs?: number; maxBuffer?: number; shell?: boolean | string; input?: string }): Promise<{ status: number | null; stdout: string; stderr: string; error?: Error }>;
export class GitService {
  constructor(o: { winShell?: string });
  repos(dir: string): Promise<unknown>; diffFile(...): Promise<unknown>; diffForAi(cwd: string): Promise<unknown>; action(action: string, cwd: string, q: Record<string, string>): Promise<unknown>;
  stage/commit/push/checkout/unstage/discard/stash/stashPop/worktreeAdd: (…) => Promise<unknown>;     // one method per route in L1508–1800, returning the exact JSON body the route returned
}
```

- [ ] **Step 1: Failing test** — (a) the key behavior: while a slow git call is running, the event loop keeps ticking:

```js
it("git calls do not block the event loop", async () => {
  const { run } = require("../../dist/features/exec");
  let ticks = 0; const t = setInterval(() => ticks++, 10);
  await run(process.execPath, ["-e", "setTimeout(()=>{},300)"], { cwd: process.cwd() });
  clearInterval(t); assert.ok(ticks >= 15, `event loop ticked ${ticks} times in 300ms`);
});
```
(b) `run` honors `timeoutMs` (kills a 5 s child at 100 ms, `status === null`, `error` set), (c) `maxBuffer` overflow yields `error`, (d) against a temp git repo: `GitService.action("status", repo, {})` and `stage`/`commit` produce the same JSON the golden master saw from the baseline (the golden-master run in Task 17 is the cross-check; here assert the commit appears in `git log`).

- [ ] **Step 2: Run to verify failure**, **Step 3: Implement** — port every handler body from L1508–1800 replacing `spawnSync(...)` with `await run(...)`; keep command arrays, `cwd` validation, the Windows `winShell` selection, timeouts (10 s default, as in baseline per call) and response JSON. **Do not change** `shell: true` usage; append each occurrence to `docs/superpowers/follow-ups.md` (file, line, what it passes to the shell). **Step 4: Verify** `npm test` → `fail 0`. **Step 5: Commit** `feat(ts): GitService on async exec`.

### Task 14: FileService and SearchService

**Files:**
- Create: `src/features/FileService.ts`, `src/features/SearchService.ts`
- Test: `test/unit/files.test.js`

**Interfaces:**
- Produces: `FileService` — `list(dir)` (L1802–1830), `read(path)` (L1831–1848, 2 MB cap), `write(path, content)` (L1849–1864), `upload(...)` (L1981–2003), `clip(...)` (L2004–2056); `SearchService` — `files(q)` with `fuzzyMatch` (L1865–1925), `text(q)` (L1926–1976) with `SEARCH_SKIP_DIRS`/`SEARCH_TEXT_EXTS`. Each returns the exact JSON the route returned and throws `HttpError` where the route returned a non-200.

- [ ] **Step 1: Failing tests** against a temp tree: `list` returns dirs-first/sorted as baseline (read the handler to assert ordering), `read` of a >2 MB file → the baseline status/message, `read`/`write` outside the allowed root (path traversal such as `..\..\x`) → the baseline refusal, `write` then `read` round-trips UTF-8 and CRLF content unchanged, `files("srv")` fuzzy-matches `server.ts` above `s-e-r-v-e-r-x.ts`, `text("needle")` skips `node_modules`/`.git` and non-text extensions, results capped as baseline.
- [ ] **Step 2–5:** run → red; port; run → `fail 0`; commit `feat(ts): FileService, SearchService`. (If a baseline handler has a traversal weakness, port it as-is and add it to `follow-ups.md`.)

### Task 15: AiService, PromptLibrary, NgrokTunnel, SystemStats

**Files:**
- Create: `src/features/AiService.ts`, `src/features/PromptLibrary.ts`, `src/features/NgrokTunnel.ts`, `src/features/SystemStats.ts`
- Test: `test/unit/features.test.js`

**Interfaces:**
- Produces:

```ts
export class PromptLibrary { constructor(file: string); list(): Prompt[]; create(b: any): Prompt; update(id: string, b: any): Prompt | null; remove(id: string): boolean; use(id: string): Prompt | null }   // L3231–3280
export class SystemStats { snapshot(): StatsSnapshot }                                                          // cached 3 s; getSystemStats L654–677, route L2057–2068
export class NgrokTunnel implements NgrokPolicy { allowedIps: string[]; readOnly: boolean; start(port: number): Promise<{...}>; stop(): void; status(): Promise<{...}>; dispose(): void }   // L2530–2637; spawns `ngrok`, kills it on dispose
export class AiService { constructor(); ask(b: { prompt: string; agent?: string; model?: string; cwd?: string; timeout?: number }): Promise<{ response: string; agent: string; model: string; elapsed: number }> }   // L2662–2731, timeout ≤120 s
```

- [ ] **Step 1: Failing tests** — `PromptLibrary`: CRUD round-trip on a temp file, `use` increments the baseline's counter field (read L3273), unknown id → `null`/`false`. `SystemStats`: two calls within 3 s return the same object (cache), a call after advancing mock time returns a fresh one. `NgrokTunnel`: `allowedIps`/`readOnly` default `[]`/`false`; `dispose()` with no child is a no-op. `AiService`: with `agent` set to `process.execPath`-based fake (an injected spawn function) — success returns `{response,…}`; a non-zero exit rejects with `HttpError(500, stderr || "Process exited with code N")`; a missing prompt rejects with `HttpError(400, "prompt required")`; the timeout kills the child.
- [ ] **Step 2–5:** red → port → green → commit `feat(ts): AiService, PromptLibrary, NgrokTunnel, SystemStats`.

---

## Phase F — Assembly

### Task 16: Routers and createApp

**Files:**
- Create: `src/http/createApp.ts`, `src/http/errors.ts`, `src/http/routes/{sessions,git,files,search,system,claude,ai,prompts,ngrok}.ts`, `src/http/page.ts`
- Test: existing `test/api.test.js`, `test/routes.test.js` (Task 17 against the new entry)

**Interfaces:**
- Consumes: every service from Tasks 5–15.
- Produces:

```ts
export interface AppDeps { config: Config; auth: AuthService; sessions: SessionManager; groups: GroupRegistry; stateStore: StateStore; history: HistoryStore; archive: ArchiveStore; favorites: FavoritesStore; gateway: WsGateway; linker: ClaudeLinker; usage: UsageService; index: SessionIndex; claudeMd: ClaudeMdService; git: GitService; files: FileService; search: SearchService; ai: AiService; prompts: PromptLibrary; ngrok: NgrokTunnel; stats: SystemStats; layout: { get(): unknown | null; set(v: unknown | null): void }; shutdown: (reason: string) => void; publicDir: string; pageTemplate: () => string }
export function createApp(d: AppDeps): express.Express;
// http/errors.ts: wrap(fn) turns async handler rejections into next(err); errorMiddleware renders HttpError → res.status(e.status).json({ error: e.message }); any other Error → 500 {error: e.message}
```
Route → router assignment (all 71 unique routes; baseline lines in parentheses): **sessions.ts** — `/api/sessions*` (1170–1372, incl. `/:id/cwd`, `/:id/restart`), `/api/session-groups*` (1253–1297), `/api/workspace-layout` (1374–1383), `/api/history` (1385–1431), `/api/archive*` (1433–1442), `/api/favorites*` (1444–1472), `/api/quick-launch` (1474–1486), `/api/recent-folders` (1488–1505), `/api/analytics` (2076–2093), `/api/groups` (2652–2661); **git.ts** — 13 routes (1508–1800); **files.ts** — `/api/files`, `/api/file` GET/PUT, `/api/upload`, `/api/clip`; **search.ts** — `/api/search/files|text`; **system.ts** — `/api/stats`, `/api/shutdown`, `/api/token/rotate`; **claude.ts** — `/api/claude/*`, `/api/claude-usage`, `/api/claudemd/*`; **ai.ts** — `/api/ai/ask`; **prompts.ts** — 5 routes; **ngrok.ts** — 5 routes; **auth pages** via `AuthService.registerPages`. `PUT /api/sessions/:id` must: normalize `group` via `GroupRegistry.normalize`; on a name change call `linker.renameConversation` and respond `{ ok: true, claudeRenamed }`; clamp `name` to 64, `note` to 2000 chars; apply `tool`/`lastCommand`. `DELETE /api/sessions/:id` calls `sessions.delete(id)` then `gateway.broadcastEvent("archive-updated")`.

- [ ] **Step 1: Failing test** — `test/unit/errors.test.js`: `errorMiddleware` renders `HttpError(404,"Session not found")` as `404 {"error":"Session not found"}`; a thrown plain `Error("x")` as `500 {"error":"x"}`; `wrap` forwards a rejected promise. Build an Express app with a throwing route and use Node `http`.
- [ ] **Step 2–3:** run → red; write the routers by porting each handler (baseline lines above): handler bodies shrink to *parse → service call → `res.json(...)`*; **response bodies, status codes and validation messages must match the baseline** (the golden master in Task 17 enforces this). Middleware order in `createApp`: security headers + CSP (L1100–1107), `express.json({limit:"50mb"})`, `auth.rateLimit` on `/api`, `/public` static, routers, `auth.registerPages`, `errorMiddleware` last. `page.ts` ports `getPageTemplate/buildPage/LOGIN_TEMPLATE/buildLoginPage` (L3471–3514) including the dev-time `fs.watch` cache invalidation outside production.
- [ ] **Step 4:** `npm run build` clean. **Step 5: Commit** `feat(ts): express routers and createApp`.

### Task 17: Composition root — and verify against everything

**Files:**
- Create: `src/index.ts` (replaces stub), `src/banner.ts`
- Test: `test/unit/shutdown.test.js`

**Interfaces:**
- Produces: `dist/index.js` runnable as `node dist/index.js [flags]`, equivalent to `node server.js` at baseline. `index.ts` does, in order: `Config.fromArgv` → `runCommand(config)` (exit if handled) → build `Crypto`, stores, `bus`, `SessionManager` (real `PtyFactory` wraps `@lydell/node-pty`'s `spawn` with `{name:"xterm-256color",…, env:{...process.env, TERM:"xterm-256color"}}`), `OutputAnalyzer`, `GroupRegistry`, `AuthService`, `NgrokTunnel`, services, `createApp`, `http.createServer`, `WsGateway`; wires `bus.on("changed", () => stateStore.save())`, archive-updated broadcast on `deleted`, `ClaudeLinker.start()`; restores sessions exactly as baseline L961–1015 (`RUN_COMMAND` → one session running it with `restoreScrollback:false`; saved state → `restore(records, neededIds from layout)` or the `maxSessions` most-recent; otherwise `initialSessions` fresh shells); prints banner (L1016–1056) and QR (`showQr`), auto-open (L1057–1063), 30 s periodic save (L1064), stdin raw-mode + `--mirror` forwarding and session-0-exit-exits-process (L1068–1088, L916), `listen`, PID file; signals `SIGINT` (double Ctrl+C), `SIGTERM`, `SIGHUP`, `SIGBREAK`, `exit` hook, Windows raw-stdin Ctrl+C / `q` handling (L3402–3470); `gracefulShutdown(reason)`: save state, save scrollback (forced), clear timers, remove PID file, `sessions.shutdown()`, `server.close(() => process.exit(0))`, forced exit after 3 s (`unref`).

- [ ] **Step 1: Failing shutdown test** (Review-Focus #3):

```js
// test/unit/shutdown.test.js — spawns dist/index.js with a temp HOME
//  - start, create a session via POST /api/sessions {name:"keepme", group:"a/b"}, then POST /api/shutdown
//  - process exits within 5 s; ~/.agenv.pid no longer exists
//  - restart on the same HOME: GET /api/sessions contains "keepme" with group "a/b" (state saved), live === false
//  - SIGTERM path: start again, send proc.kill("SIGTERM"), same assertions (exit + pid file gone)
```
- [ ] **Step 2: Run** `node --test test/unit/shutdown.test.js` → FAIL (stub entry).
- [ ] **Step 3: Implement** `index.ts`/`banner.ts` per the Interfaces section (port the cited baseline ranges).
- [ ] **Step 4: Run the whole existing suite against the new entry**

Run: `AGENV_ENTRY=dist/index.js npm test`
Expected: **all tests PASS** — the original 69 plus every test added in this plan. Any failure is a regression in the port: fix in the owning module, not in the test.

- [ ] **Step 5: Golden master vs baseline** (three runs)

Run: `node scripts/golden-master.js ../agenv-pre-ts/server.js dist/index.js`
Expected: `identical (N calls)` three times in a row. Each reported difference is a port bug (or, only if it is genuinely an intended change, the async-git change — there should be none in responses). Fix the port, never the normalizer, unless the field is truly volatile.

- [ ] **Step 6: Real-data compatibility**

Run: `node scripts/compat-check.js dist/index.js` and compare with the Task 3 baseline output taken at the same time.
Expected: identical summary line.

- [ ] **Step 7: Commit**

```bash
git add src test/unit/shutdown.test.js
git commit -m "feat(ts): composition root, banner, signals, graceful shutdown"
```

### Task 18: Cutover, packaging, docs — then STOP

**Files:**
- Modify: `server.js` (becomes the loader), `package.json`, `Makefile`, `CONTRIBUTING.md`, `README.md` (dev section only), `.github/workflows/ci.yml`
- Create: `test/e2e/*.js` (moved from scratchpad), `docs/superpowers/follow-ups.md` (if not already created)

- [ ] **Step 1: Replace `server.js` with the loader**

```js
#!/usr/bin/env node
"use strict";
const fs = require("fs"), path = require("path");
const entry = path.join(__dirname, "dist", "index.js");
if (!fs.existsSync(entry)) { console.error("[agenv] dist/ is missing — run `npm run build` first."); process.exit(1); }
require(entry);
```
(the old 3,514-line file remains reachable via tag `pre-ts`.)

- [ ] **Step 2: Dev scripts** — `package.json`: `"watch"` → `"tsc -w --preserveWatchOutput"` plus a second script `"dev": "nodemon --watch dist --watch public/ --ext js,html,css --delay 500ms -- server.js"`; `electron:dev` watches `dist/`; `Makefile` dev target watches `dist/`. `start`, `restart`, `stop` unchanged (they call `server.js`).

- [ ] **Step 3: Packaging checks**

Run: `npm run build && npm pack --dry-run 2>&1 | grep -E "dist/|server.js|src/|total files"`
Expected: `dist/**` and `server.js` listed, **no `src/`**, no tests, no `.map` outside `dist/`. Confirm `build.files` (electron-builder) includes `dist/**/*`.

- [ ] **Step 4: Move the browser flows into the repo** — copy the three scripts (`hibernate-e2e.js`, `groups-e2e.js`, `claude-link-e2e.js`) and `fakeclaude.js` from the scratchpad `pw/` and parent directories into `test/e2e/`, change their `require("playwright-core")` lookup to the repo's, make the entry configurable (`process.argv[2]` default `.`), `npm i -D playwright-core@1.56`, add `"test:e2e": "node test/e2e/run-all.js"` where `run-all.js` runs the three in sequence and exits non-zero on any `FAIL`. They are **not** in CI and **not** run by `npm test` (the runner skips `test/e2e/`).

- [ ] **Step 5: Run the e2e flows against the cutover build**

Run: `npm run test:e2e`
Expected: hibernate 6/6, groups 11/11, claude-link 12/12 (counts as of the 1.4.2 scripts).

- [ ] **Step 6: Docs** — `CONTRIBUTING.md`: add "Architecture" (layout from the spec §3, dependency rules, "add a feature = add a service + a router + wire it in `src/index.ts`"), "Build" (`npm run build`, `npm run watch`), and "Verification" (`npm test`, `node scripts/golden-master.js`, `npm run test:e2e`). `README.md`: only the contributor/dev section.

- [ ] **Step 7: Final verification (fresh clone)**

```bash
git clone . "$TMPDIR/agenv-fresh" && cd "$TMPDIR/agenv-fresh" && git checkout refactor/typescript
npm install && npm test
```
Expected: build + all tests PASS from a clean clone. Then `node server.js --port 0`-style smoke: start it, `GET /api/stats?token=…` → 200.

- [ ] **Step 8: Commit and hand back**

```bash
git add -A server.js package.json package-lock.json Makefile CONTRIBUTING.md README.md .github test/e2e docs
git commit -m "refactor: server.js becomes a loader for the compiled TypeScript backend"
```
**STOP.** Report to the user: branch `refactor/typescript`, all verification results (route inventory, golden-master `identical` ×3, compat-check line, test counts, e2e counts, pack listing, follow-ups list). **Do not merge, tag, version-bump or publish** until the user explicitly approves the release (proposed 1.5.0).
