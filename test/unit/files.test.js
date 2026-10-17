// test/unit/files.test.js — FileService (explorer, read/write, upload, clip) and SearchService
"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { FileService } = require("../../dist/features/FileService");
const { SearchService } = require("../../dist/features/SearchService");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "agenv-f-"));
const put = (root, rel, content = "x") => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); return p; };
const mkFiles = (extra = {}) => { const uploads = tmp(); const sessions = new Map(Object.entries(extra)); return { uploads, svc: new FileService({ uploadDir: uploads, sessionCwd: (id) => sessions.get(String(id)) }) }; };

describe("FileService.list", () => {
  it("lists folders first, then files, each sorted case-insensitively, hiding dotfiles unless asked", async () => {
    const root = tmp(); put(root, "b.txt", "bb"); put(root, "A.txt", "a"); put(root, "Zdir/x.txt"); put(root, "adir/x.txt"); put(root, ".hidden", "h");
    const r = await mkFiles().svc.list(root, false);
    assert.equal(r.dir, root); assert.equal(r.parent, path.dirname(root));
    assert.deepEqual(r.items.map((i) => i.name), ["adir", "Zdir", "A.txt", "b.txt"]);
    assert.deepEqual(r.items.map((i) => i.isDir), [true, true, false, false]); assert.deepEqual(r.items.map((i) => i.size), [0, 0, 1, 2]);
    assert.equal(r.items[2].path, path.join(root, "A.txt")); assert.equal(typeof r.items[2].mtime, "number");
    assert.ok((await mkFiles().svc.list(root, true)).items.some((i) => i.name === ".hidden"));
  });
  it("a missing folder is a 400 carrying the system message; no argument means the current folder", async () => {
    const { svc } = mkFiles();
    await assert.rejects(svc.list(path.join(tmp(), "nope"), false), (e) => e.status === 400 && /ENOENT/.test(e.message));
    assert.equal((await svc.list(undefined, false)).dir, process.cwd());
  });
});

describe("FileService.read / write", () => {
  it("reads a file with its resolved path, name, size and content", async () => {
    const root = tmp(); const p = put(root, "n.txt", "héllo\r\nworld");
    const r = await mkFiles().svc.read(p); assert.deepEqual(r, { path: p, name: "n.txt", content: "héllo\r\nworld", size: Buffer.byteLength("héllo\r\nworld") });
  });
  it("refuses files over 2 MB, reports a missing file as 404 with its path, and a directory as 400", async () => {
    const root = tmp(); const { svc } = mkFiles();
    assert.equal((await svc.read(put(root, "ok.bin", "x".repeat(2 * 1024 * 1024)))).size, 2 * 1024 * 1024);
    await assert.rejects(svc.read(put(root, "big.bin", "x".repeat(2 * 1024 * 1024 + 1))), (e) => e.status === 400 && e.message === "File too large (>2MB)");
    const missing = path.join(root, "nope.txt");
    await assert.rejects(svc.read(missing), (e) => e.status === 404 && e.body.code === "ENOENT" && e.body.error === "File not found" && e.body.path === missing);
    await assert.rejects(svc.read(root), (e) => e.status === 400);
    await assert.rejects(svc.read(""), (e) => e.status === 400 && e.message === "Missing path");
  });
  it("writes UTF-8 and CRLF content unchanged, reports the size, and accepts empty content", async () => {
    const root = tmp(); const { svc } = mkFiles(); const p = path.join(root, "w.txt");
    const r = await svc.write(p, "héllo\r\nwörld\n"); assert.deepEqual(r, { ok: true, path: p, size: Buffer.byteLength("héllo\r\nwörld\n") });
    assert.equal(fs.readFileSync(p, "utf8"), "héllo\r\nwörld\n");
    assert.equal((await svc.write(p, "")).size, 0);
  });
  it("validates input and reports a failed write as 400", async () => {
    const { svc } = mkFiles();
    await assert.rejects(svc.write("", "x"), (e) => e.status === 400 && e.message === "Missing path");
    await assert.rejects(svc.write("/x", undefined), (e) => e.status === 400 && e.message === "Missing content");
    await assert.rejects(svc.write(path.join(tmp(), "no", "such", "dir", "f.txt"), "x"), (e) => e.status === 400 && /ENOENT/.test(e.message));
  });
});

describe("FileService.upload", () => {
  it("stores the file under the upload folder with a sanitized, timestamped name", async () => {
    const { svc, uploads } = mkFiles(); const r = await svc.upload({ filename: "up load!.txt", data: Buffer.from("hi").toString("base64") });
    assert.equal(r.ok, true); assert.match(r.name, /^up_load_-\d{13}\.txt$/); assert.equal(r.path, path.join(uploads, r.name)); assert.equal(r.size, 2);
    assert.equal(fs.readFileSync(r.path, "utf8"), "hi");
  });
  it("without a name, the type decides the extension", async () => {
    const { svc } = mkFiles(); const d = Buffer.from("x").toString("base64");
    assert.match((await svc.upload({ data: d, type: "image/png" })).name, /^upload-\d{13}\.png$/); assert.match((await svc.upload({ data: d, type: "image/jpeg" })).name, /\.jpg$/);
    assert.match((await svc.upload({ data: d, type: "image/gif" })).name, /\.gif$/); assert.match((await svc.upload({ data: d })).name, /\.bin$/);
  });
  it("requires data and refuses more than 50 MB", async () => {
    const { svc } = mkFiles();
    await assert.rejects(svc.upload({}), (e) => e.status === 400 && e.message === "Missing data");
    await assert.rejects(svc.upload({ data: Buffer.alloc(50 * 1024 * 1024 + 1).toString("base64") }), (e) => e.status === 400 && e.message === "File too large (>50MB)");
  });
  it("a non-string payload is a 500, as before", async () => {
    await assert.rejects(mkFiles().svc.upload({ data: 12345 }), (e) => e.status === 500);
  });
});

describe("FileService.clip", () => {
  it("saves clipboard text next to the session's folder under .clips, else in the upload folder", async () => {
    const proj = tmp(); const { svc, uploads } = mkFiles({ 7: proj });
    const a = await svc.clip({ sessionId: 7, content: "hello", filename: "c.txt" });
    assert.match(a.name, /^c-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.txt$/); assert.equal(a.path, path.join(proj, ".clips", a.name)); assert.equal(fs.readFileSync(a.path, "utf8"), "hello"); assert.equal(a.size, 5);
    const b = await svc.clip({ sessionId: 99, content: "x" }); assert.equal(path.dirname(b.path), uploads, "unknown session → upload folder");
    const c = await svc.clip({ content: "x" }); assert.equal(path.dirname(c.path), uploads); assert.match(c.name, /^clip-.*\.txt$/);
  });
  it("picks the extension from the file name, else the mime type, else .txt", async () => {
    const { svc } = mkFiles(); const ext = async (o) => path.extname((await svc.clip({ content: "x", ...o })).name);
    assert.equal(await ext({ filename: "data.csv" }), ".csv"); assert.equal(await ext({ mimeType: "text/html" }), ".html"); assert.equal(await ext({ mimeType: "application/json" }), ".json");
    assert.equal(await ext({ mimeType: "image/png" }), ".png"); assert.equal(await ext({ mimeType: "image/svg+xml" }), ".svg"); assert.equal(await ext({ mimeType: "application/x-weird" }), ".txt"); assert.equal(await ext({}), ".txt");
  });
  it("saves base64 content as bytes and sanitizes the base name", async () => {
    const { svc } = mkFiles(); const r = await svc.clip({ contentBase64: Buffer.from([1, 2, 3]).toString("base64"), filename: "my pic!.png" });
    assert.equal(r.size, 3); assert.match(r.name, /^my_pic_-/); assert.deepEqual([...fs.readFileSync(r.path)], [1, 2, 3]);
  });
  it("requires content and refuses more than 50 MB", async () => {
    const { svc } = mkFiles();
    await assert.rejects(svc.clip({}), (e) => e.status === 400 && e.message === "Missing content");
    await assert.rejects(svc.clip({ contentBase64: Buffer.alloc(50 * 1024 * 1024 + 1).toString("base64") }), (e) => e.status === 400 && e.message === "Content too large (>50MB)");
  });
});

describe("SearchService.files", () => {
  const tree = () => { const r = tmp(); for (const f of ["src/server.ts", "src/deep/serve-helper.ts", "readme.md", "node_modules/x/server.js", ".git/config", "dist/server.js", ".env", ".gitignore", ".hidden/file.txt", "s-e-r-v-e-r.txt", "docs/notes.md"]) put(r, f); return r; };
  const s = new SearchService();
  it("matches by substring or by fuzzy subsequence, skips junk folders and dotfiles (except .env/.gitignore)", async () => {
    const root = tree(); const r = await s.files({ dir: root, q: "server" });
    const rel = r.results.map((x) => x.relative);
    assert.ok(rel.includes("src/server.ts") && rel.includes("s-e-r-v-e-r.txt"), "substring and fuzzy hits: " + rel);
    assert.ok(!rel.some((p) => p.startsWith("node_modules") || p.startsWith("dist") || p.startsWith(".git/") || p.startsWith(".hidden")));
    const all = (await s.files({ dir: root, q: "" })).results.map((x) => x.relative);
    assert.ok(all.includes(".env") && all.includes(".gitignore") && all.includes("readme.md"));
    assert.equal(r.dir, root); assert.equal(r.results[0].path, path.join(root, ...r.results[0].relative.split("/"))); assert.equal(r.results[0].name, path.basename(r.results[0].relative));
  });
  it("ranks file-name matches first, then path matches, then shorter paths", async () => {
    const root = tmp(); for (const f of ["a/b/notes-long-name.md", "notes.md", "zzz/notes/readme.md", "n-o-t-e-s.txt"]) put(root, f);
    assert.deepEqual((await s.files({ dir: root, q: "notes" })).results.map((x) => x.relative), ["notes.md", "a/b/notes-long-name.md", "zzz/notes/readme.md", "n-o-t-e-s.txt"]);
  });
  it("honors the limit (default 100, at most 500) and treats a bad limit as the default", async () => {
    const root = tmp(); for (let i = 0; i < 130; i++) put(root, `f${i}.txt`);
    assert.equal((await s.files({ dir: root, q: "" })).results.length, 100);
    assert.equal((await s.files({ dir: root, q: "", limit: "5" })).results.length, 5);
    assert.equal((await s.files({ dir: root, q: "", limit: "9999" })).results.length, 130);
    assert.equal((await s.files({ dir: root, q: "", limit: "abc" })).results.length, 100);
    assert.equal((await s.files({ dir: root, q: "", limit: "-3" })).results.length, 100);
  });
  it("stops descending after 10 levels, and a missing folder gives no results", async () => {
    const root = tmp(); put(root, "a/b/c/d/e/f/g/h/i/j/ten.txt"); put(root, "a/b/c/d/e/f/g/h/i/j/k/eleven.txt");
    const names = (await s.files({ dir: root, q: ".txt" })).results.map((x) => x.name);
    assert.deepEqual(names, ["ten.txt"]); assert.deepEqual((await s.files({ dir: path.join(root, "nope"), q: "x" })).results, []);
  });
});

describe("SearchService.text", () => {
  const s = new SearchService();
  it("finds matching lines case-insensitively with file, full path, line number and a 200-character preview", async () => {
    const root = tmp(); put(root, "src/a.js", "first\nconst NeedleValue = 1;\nlast " + "x".repeat(300) + " needle");
    const r = await s.text({ dir: root, q: "needle" });
    assert.equal(r.dir, root); assert.deepEqual(r.results.map((m) => [m.file, m.line]), [["src/a.js", 2], ["src/a.js", 3]]);
    assert.equal(r.results[0].fullPath, path.join(root, "src", "a.js")); assert.equal(r.results[0].text, "const NeedleValue = 1;"); assert.equal(r.results[1].text.length, 200);
  });
  it("only reads text-like files within size limits and skips junk folders", async () => {
    const root = tmp();
    put(root, "ok.md", "needle"); put(root, "Dockerfile", "needle"); put(root, "README", "needle"); put(root, "image.png", "needle"); put(root, "empty.txt", "");
    put(root, "huge.txt", "needle " + "x".repeat(512 * 1024)); put(root, "node_modules/p/i.js", "needle"); put(root, ".git/x.txt", "needle"); put(root, ".env", "needle=1");
    const files = (await s.text({ dir: root, q: "needle" })).results.map((m) => m.file).sort();
    assert.deepEqual(files, [".env", "Dockerfile", "README", "ok.md"]);
  });
  it("requires a query and honors the limit (default 100, at most 200)", async () => {
    const root = tmp(); put(root, "many.txt", Array.from({ length: 300 }, (_, i) => "needle " + i).join("\n"));
    await assert.rejects(s.text({ dir: root, q: "" }), (e) => e.status === 400 && e.message === "Missing query");
    await assert.rejects(s.text({ dir: root, q: undefined }), (e) => e.status === 400);
    assert.equal((await s.text({ dir: root, q: "needle" })).results.length, 100);
    assert.equal((await s.text({ dir: root, q: "needle", limit: "7" })).results.length, 7);
    assert.equal((await s.text({ dir: root, q: "needle", limit: "5000" })).results.length, 200);
  });
});
