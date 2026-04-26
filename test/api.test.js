// test/api.test.js — API endpoint tests
"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const { startServer, stopServer, get, post, put, del } = require("./helpers");

let server;

before(async () => {
  server = await startServer();
}, { timeout: 15000 });

after(() => {
  stopServer();
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
describe("Authentication", () => {
  it("rejects requests without token", async () => {
    const http = require("http");
    const res = await new Promise((resolve, reject) => {
      const req = http.get(`${server.baseUrl}/api/sessions`, (res) => {
        let data = "";
        res.on("data", (d) => { data += d; });
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      });
      req.on("error", reject);
    });
    assert.equal(res.status, 401);
  });

  it("accepts requests with valid token", async () => {
    const res = await get("/api/sessions");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
  });
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
describe("Sessions API", () => {
  it("GET /api/sessions returns array", async () => {
    const res = await get("/api/sessions");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
  });

  it("POST /api/sessions creates a new session", async () => {
    const res = await post("/api/sessions", {});
    assert.equal(res.status, 200);
    assert.ok(res.body.id != null, "should return session id");
  });

  it("PUT /api/sessions/:id updates session metadata", async () => {
    // First create a session
    const create = await post("/api/sessions", {});
    const id = create.body.id;

    const res = await put(`/api/sessions/${id}`, { name: "Test Session" });
    assert.equal(res.status, 200);
    assert.ok(res.body.ok);
  });

  it("GET /api/sessions/:id/cwd returns working directory", async () => {
    const create = await post("/api/sessions", {});
    const id = create.body.id;
    // Give the PTY a moment to initialize
    await new Promise(r => setTimeout(r, 500));
    const res = await get(`/api/sessions/${id}/cwd`);
    assert.equal(res.status, 200);
    assert.ok(res.body.cwd, "should return cwd");
  });

  it("DELETE /api/sessions/:id closes the session", async () => {
    const create = await post("/api/sessions", {});
    const id = create.body.id;
    const res = await del(`/api/sessions/${id}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.ok);
  });

  it("DELETE /api/sessions/:id returns 404 for non-existent session", async () => {
    const res = await del("/api/sessions/99999");
    assert.equal(res.status, 404);
  });
});

// ---------------------------------------------------------------------------
// Workspace Layout
// ---------------------------------------------------------------------------
describe("Workspace Layout API", () => {
  it("GET /api/workspace-layout returns layout or null", async () => {
    const res = await get("/api/workspace-layout");
    assert.equal(res.status, 200);
    assert.ok(res.body != null);
  });

  it("POST /api/workspace-layout saves layout", async () => {
    const layout = [{ name: "Terminal", rootNode: { type: "leaf", sessionId: 0 }, isActive: true }];
    const res = await post("/api/workspace-layout", { layout });
    assert.equal(res.status, 200);
    assert.ok(res.body.ok);
  });
});

// ---------------------------------------------------------------------------
// File Explorer
// ---------------------------------------------------------------------------
describe("File Explorer API", () => {
  it("GET /api/files lists current directory", async () => {
    const res = await get("/api/files");
    assert.equal(res.status, 200);
    assert.ok(res.body.dir, "should return dir path");
    assert.ok(Array.isArray(res.body.items), "should return items array");
    assert.ok(res.body.items.length > 0, "should have at least one item");
  });

  it("GET /api/files?dir=<path> lists specific directory", async () => {
    const dir = path.join(__dirname, "..");
    const res = await get(`/api/files?dir=${encodeURIComponent(dir)}`);
    assert.equal(res.status, 200);
    const names = res.body.items.map(i => i.name);
    assert.ok(names.includes("package.json"), "should list package.json");
    assert.ok(names.includes("server.js"), "should list server.js");
  });

  it("items have required properties", async () => {
    const res = await get("/api/files");
    const item = res.body.items[0];
    assert.ok("name" in item);
    assert.ok("path" in item);
    assert.ok("isDir" in item);
    assert.ok("size" in item);
  });

  it("GET /api/files with invalid dir returns error", async () => {
    const res = await get("/api/files?dir=/this/path/does/not/exist");
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
  });
});

// ---------------------------------------------------------------------------
// File Read / Write
// ---------------------------------------------------------------------------
describe("File Read/Write API", () => {
  const testDir = path.join(__dirname, "tmp");
  const testFile = path.join(testDir, "test-file.txt");

  before(() => {
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(testFile, "hello world\n", "utf8");
  });

  after(() => {
    try { fs.unlinkSync(testFile); } catch {}
    try { fs.rmdirSync(testDir); } catch {}
  });

  it("GET /api/file reads file content", async () => {
    const res = await get(`/api/file?path=${encodeURIComponent(testFile)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.content, "hello world\n");
    assert.equal(res.body.name, "test-file.txt");
    assert.ok(res.body.size > 0);
  });

  it("GET /api/file returns 404 for missing file", async () => {
    const res = await get(`/api/file?path=${encodeURIComponent(testFile + ".nope")}`);
    assert.equal(res.status, 404);
    assert.equal(res.body.code, "ENOENT");
  });

  it("GET /api/file returns 400 without path param", async () => {
    const res = await get("/api/file");
    assert.equal(res.status, 400);
  });

  it("PUT /api/file writes file content", async () => {
    const newContent = "updated content\n";
    const res = await put("/api/file", { path: testFile, content: newContent });
    assert.equal(res.status, 200);
    assert.ok(res.body.ok);

    // Verify the write
    const readBack = fs.readFileSync(testFile, "utf8");
    assert.equal(readBack, newContent);
  });
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
describe("Search API", () => {
  it("GET /api/search/files returns results", async () => {
    const res = await get(`/api/search/files?q=package&dir=${encodeURIComponent(path.join(__dirname, ".."))}`);
    assert.equal(res.status, 200);
    // Response could be array or object with results property
    const results = Array.isArray(res.body) ? res.body : (res.body.results || res.body.files || []);
    assert.ok(Array.isArray(results), "should return results");
  });

  it("GET /api/search/files with no query returns ok", async () => {
    const res = await get("/api/search/files");
    assert.ok(res.status === 200 || res.status === 400);
  });
});

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------
describe("Stats API", () => {
  it("GET /api/stats returns server stats", async () => {
    const res = await get("/api/stats");
    assert.equal(res.status, 200);
    assert.ok(typeof res.body === "object", "should return an object");
  });
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------
describe("History API", () => {
  it("GET /api/history returns array", async () => {
    const res = await get("/api/history");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
  });

  it("POST /api/history saves a command", async () => {
    const res = await post("/api/history", { command: "echo test" });
    assert.equal(res.status, 200);
    assert.ok(res.body.ok);
  });
});

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------
describe("Git API", () => {
  it("GET /api/git/repos returns repo data", async () => {
    const dir = path.join(__dirname, "..");
    const res = await get(`/api/git/repos?dir=${encodeURIComponent(dir)}`);
    assert.equal(res.status, 200);
    // Response may be array or object with repos property
    const repos = Array.isArray(res.body) ? res.body : (res.body.repos || []);
    assert.ok(Array.isArray(repos), "should return repos");
    if (repos.length > 0) {
      assert.ok(repos[0].path, "repo should have path");
    }
  });

  it("GET /api/git/status returns status output", async () => {
    const dir = path.join(__dirname, "..");
    const res = await get(`/api/git/status?dir=${encodeURIComponent(dir)}`);
    assert.equal(res.status, 200);
    assert.ok("ok" in res.body);
    assert.ok("output" in res.body);
  });

  it("GET /api/git/log returns log output", async () => {
    const dir = path.join(__dirname, "..");
    const res = await get(`/api/git/log?dir=${encodeURIComponent(dir)}`);
    assert.equal(res.status, 200);
    assert.ok("ok" in res.body);
  });
});

// ---------------------------------------------------------------------------
// Favorites
// ---------------------------------------------------------------------------
describe("Favorites API", () => {
  it("GET /api/favorites returns array", async () => {
    const res = await get("/api/favorites");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
  });

  it("POST /api/favorites adds a favorite", async () => {
    const res = await post("/api/favorites", { name: "Test", cwd: "/tmp", command: "echo hi" });
    assert.equal(res.status, 200);
  });
});

// ---------------------------------------------------------------------------
// Token rotation
// ---------------------------------------------------------------------------
describe("Token API", () => {
  it("POST /api/token/rotate returns new token", async () => {
    const res = await post("/api/token/rotate", {});
    assert.equal(res.status, 200);
    assert.ok(res.body.token, "should return new token");
    assert.ok(res.body.token.length > 0);
  });
});
