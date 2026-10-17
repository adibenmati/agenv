// test/routes.test.js — every baseline route must still exist (anything but 404 when unauthenticated)
"use strict";
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { startServer } = require("./helpers");
const inventory = require("./routes.inventory.json");

const AUTH_PAGES = new Set(["GET /login", "POST /login", "GET /"]); // covered by the auth tests (Task 9)
const concrete = (p) => p.replace(/:action/, "status").replace(/:[a-zA-Z]+/g, "1");

function status(port, method, p) {
  return new Promise((resolve, reject) => {
    // A fresh connection per request: reusing keep-alive sockets raced with the server closing them.
    const body = method === "GET" ? undefined : "{}";
    const headers = { "Content-Type": "application/json", Connection: "close" };
    if (body) headers["Content-Length"] = Buffer.byteLength(body);
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers, agent: false }, (r) => { r.resume(); r.on("end", () => resolve(r.statusCode)); });
    req.on("error", reject);
    req.end(body);
  });
}

describe("Route inventory", () => {
  let server;
  before(async () => { server = await startServer(); }, { timeout: 30000 });
  after(() => server.stop());

  it("a route that does not exist is a 404 (the check can fail)", async () => {
    assert.equal(await status(server.port, "GET", "/api/definitely-not-a-route"), 404);
  });

  for (const { method, path: p } of inventory) {
    if (AUTH_PAGES.has(method + " " + p)) continue;
    it(`${method} ${p} exists`, async () => {
      assert.notEqual(await status(server.port, method, concrete(p)), 404);
    });
  }
});
