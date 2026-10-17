// test/unit/auth.test.js — AuthService: token/cookie auth, tunnel policy, rate limit, token rotation, login pages
"use strict";
const { describe, it, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const express = require("express");
const { Config } = require("../../dist/core/Config");
const { hashPassword } = require("../../dist/core/password");
const { AuthService } = require("../../dist/security/AuthService");

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "agenv-a-"));
const mk = ({ credentials = false, policy } = {}) => {
  const home = tmpHome(); const config = Config.fromArgv(["--token", "T"], {}, home);
  if (credentials) { config.set("auth.username", "bob"); config.set("auth.password", hashPassword("pw")); }
  const pol = policy || { allowedIps: [], readOnly: false };
  return { auth: new AuthService({ config, policy: pol }), config, policy: pol, home };
};
const fakeRes = () => ({ statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
const run = (handler, req) => { const res = fakeRes(); let nexted = false; handler(req, res, () => { nexted = true; }); return { res, nexted }; };
const req = (o = {}) => ({ headers: {}, url: "/api/x", query: {}, method: "GET", path: "/api/x", socket: { remoteAddress: "9.9.9.9" }, ...o });

describe("isAuthenticated", () => {
  it("accepts the token from the query string or the parsed query, rejects a wrong or missing one", () => {
    const { auth } = mk();
    assert.equal(auth.isAuthenticated(req({ url: "/ws?session=1&token=T" })), true);
    assert.equal(auth.isAuthenticated(req({ query: { token: "T" } })), true);
    assert.equal(auth.isAuthenticated(req({ url: "/api/x?token=nope" })), false);
    assert.equal(auth.isAuthenticated(req()), false);
  });
  it("survives a malformed cookie or URL instead of throwing (a bad header must not crash the server)", () => {
    const { auth } = mk();
    assert.equal(auth.isAuthenticated(req({ headers: { cookie: "session=%E0%A4%A; x=%" } })), false);
    assert.equal(auth.isAuthenticated(req({ url: "http://[bad" })), false);
    assert.equal(auth.isAuthenticated(req({ url: undefined })), false);
  });
});

describe("apiAuth", () => {
  it("401 without credentials, passes with a valid token", () => {
    const { auth } = mk();
    const bad = run(auth.apiAuth, req()); assert.equal(bad.res.statusCode, 401); assert.deepEqual(bad.res.body, { error: "Unauthorized" }); assert.equal(bad.nexted, false);
    assert.equal(run(auth.apiAuth, req({ query: { token: "T" } })).nexted, true);
  });
  it("a tunnel client outside the allow-list gets 403 with its address; direct clients are not affected", () => {
    const { auth, policy } = mk(); policy.allowedIps = ["1.1.1.1"];
    const tunnel = (ip) => req({ query: { token: "T" }, headers: { "x-forwarded-for": ip + ", 10.0.0.1" } });
    const blocked = run(auth.apiAuth, tunnel("2.2.2.2")); assert.equal(blocked.res.statusCode, 403); assert.deepEqual(blocked.res.body, { error: "IP not in allowlist: 2.2.2.2" });
    assert.equal(run(auth.apiAuth, tunnel("1.1.1.1")).nexted, true);
    assert.equal(run(auth.apiAuth, req({ query: { token: "T" } })).nexted, true);   // no tunnel headers → direct
  });
  it("read-only tunnel blocks writes on the write paths but not reads or other paths", () => {
    const { auth, policy } = mk(); policy.readOnly = true;
    const t = (method, p) => req({ method, path: p, query: { token: "T" }, headers: { "x-forwarded-for": "1.1.1.1" } });
    for (const [m, p] of [["POST", "/api/file"], ["PUT", "/api/file"], ["POST", "/api/sessions"], ["DELETE", "/api/sessions/3"], ["POST", "/api/session-groups/rename"], ["POST", "/api/git/commit"], ["POST", "/api/shutdown"], ["POST", "/api/quick-launch"]]) {
      const r = run(auth.apiAuth, t(m, p)); assert.equal(r.res.statusCode, 403, m + " " + p);
      assert.deepEqual(r.res.body, { error: "Read-only mode: write operations disabled via tunnel" });
    }
    assert.equal(run(auth.apiAuth, t("GET", "/api/file")).nexted, true);
    assert.equal(run(auth.apiAuth, t("POST", "/api/history")).nexted, true);
    assert.equal(run(auth.apiAuth, req({ method: "POST", path: "/api/file", query: { token: "T" } })).nexted, true);   // direct client
  });
  it("exposes the tunnel helpers", () => {
    const { auth, policy } = mk(); policy.readOnly = true;
    const t = req({ headers: { "x-forwarded-for": "5.5.5.5, 6.6.6.6" } });
    assert.equal(auth.isTunnelRequest(t), true); assert.equal(auth.isTunnelRequest(req()), false);
    assert.equal(auth.clientIp(t), "5.5.5.5"); assert.equal(auth.clientIp(req()), "9.9.9.9");
    assert.equal(auth.isReadOnlyTunnel(t), true); assert.equal(auth.isReadOnlyTunnel(req()), false);
  });
});

describe("rateLimit", () => {
  it("allows 600 requests a minute per IP, answers 429 after, and resets with the window", () => {
    mock.timers.enable({ apis: ["Date"] });
    try {
      const { auth } = mk(); const ip = (a) => req({ socket: { remoteAddress: a } });
      for (let i = 0; i < 600; i++) assert.equal(run(auth.rateLimit, ip("1.1.1.1")).nexted, true);
      const over = run(auth.rateLimit, ip("1.1.1.1")); assert.equal(over.res.statusCode, 429); assert.deepEqual(over.res.body, { error: "Rate limit exceeded. Try again later." });
      assert.equal(run(auth.rateLimit, ip("2.2.2.2")).nexted, true);   // another client is unaffected
      mock.timers.tick(60001); assert.equal(run(auth.rateLimit, ip("1.1.1.1")).nexted, true);
      auth.dispose();
    } finally { mock.timers.reset(); }
  });
  it("keys on the first X-Forwarded-For address when present", () => {
    mock.timers.enable({ apis: ["Date"] });
    try {
      const { auth } = mk(); const t = (a) => req({ headers: { "x-forwarded-for": a } });
      for (let i = 0; i < 600; i++) run(auth.rateLimit, t("3.3.3.3, 8.8.8.8"));
      assert.equal(run(auth.rateLimit, t("3.3.3.3, 4.4.4.4")).res.statusCode, 429); auth.dispose();
    } finally { mock.timers.reset(); }
  });
});

describe("rotateToken", () => {
  it("issues a new token, persists it, and the old one stops working", () => {
    const { auth, config, home } = mk(); const old = config.token;
    const t = auth.rotateToken();
    assert.notEqual(t, old); assert.equal(t.length, 48); assert.equal(config.token, t);
    assert.equal(Config.fromArgv([], {}, home).token, t);
    assert.equal(auth.isAuthenticated(req({ query: { token: old } })), false); assert.equal(auth.isAuthenticated(req({ query: { token: t } })), true);
  });
});

describe("login pages", () => {
  const pages = { page: (token) => "PAGE:" + token, login: (error) => "LOGIN:" + (error || "") };
  const call = (app, opts) => new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const r = http.request({ host: "127.0.0.1", port: server.address().port, method: opts.method || "GET", path: opts.path, headers: opts.headers || {}, agent: false }, (res) => {
        let body = ""; res.on("data", (d) => (body += d)); res.on("end", () => { server.close(); resolve({ status: res.statusCode, headers: res.headers, body }); });
      });
      r.on("error", (e) => { server.close(); reject(e); }); r.end(opts.body);
    });
  });
  const form = (o) => ({ method: "POST", path: "/login", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString() });

  it("token mode: / needs the token, and serves the page with it", async () => {
    const { auth } = mk(); const app = express(); auth.registerPages(app, pages);
    const denied = await call(app, { path: "/" }); assert.equal(denied.status, 401); assert.match(denied.body, /401 Unauthorized/);
    const ok = await call(app, { path: "/?token=T" }); assert.equal(ok.status, 200); assert.equal(ok.body, "PAGE:T");
    assert.equal((await call(app, { path: "/login" })).status, 404, "no login page in token mode");
  });
  it("credentials mode: login page, bad credentials, good credentials set an HttpOnly session cookie", async () => {
    const { auth } = mk({ credentials: true }); assert.equal(auth.useCredentials, true);
    const app = express(); auth.registerPages(app, pages);
    assert.equal((await call(app, { path: "/" })).status, 302);
    assert.equal((await call(app, { path: "/" })).headers.location, "/login");
    assert.equal((await call(app, { path: "/login" })).body, "LOGIN:");
    const bad = await call(app, form({ username: "bob", password: "wrong" })); assert.equal(bad.status, 401); assert.equal(bad.body, "LOGIN:Invalid username or password.");
    const good = await call(app, form({ username: "bob", password: "pw" }));
    assert.equal(good.status, 302); assert.equal(good.headers.location, "/");
    const cookie = good.headers["set-cookie"][0]; assert.match(cookie, /^session=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\/$/);
    const sid = cookie.split(";")[0];
    const home = await call(app, { path: "/", headers: { Cookie: sid } }); assert.equal(home.status, 200); assert.equal(home.body, "PAGE:");
    assert.equal((await call(app, { path: "/login", headers: { Cookie: sid } })).headers.location, "/", "already signed in → redirect home");
    assert.equal(auth.isAuthenticated(req({ headers: { cookie: sid } })), true);
  });
  it("marks the cookie Secure behind an https proxy", async () => {
    const { auth } = mk({ credentials: true }); const app = express(); auth.registerPages(app, pages);
    const r = await call(app, { ...form({ username: "bob", password: "pw" }), headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-Proto": "https" } });
    assert.match(r.headers["set-cookie"][0], /; Secure$/);
  });
  it("a missing username or password field is a normal login failure, not a crash", async () => {
    const { auth } = mk({ credentials: true }); const app = express(); auth.registerPages(app, pages);
    assert.equal((await call(app, form({}))).status, 401);
    assert.equal((await call(app, form({ username: "bob" }))).status, 401);
  });
});
