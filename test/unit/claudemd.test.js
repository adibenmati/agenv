// test/unit/claudemd.test.js — ClaudeMdService: project discovery, CLAUDE.md read/write, templates, memory
"use strict";
const { describe, it, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { ClaudeMdService } = require("../../dist/claude/ClaudeMdService");
const { TranscriptScanner } = require("../../dist/claude/TranscriptScanner");

function rig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenv-md-")); const projects = path.join(root, "projects");
  fs.mkdirSync(projects);
  const svc = new ClaudeMdService({ projects, scanner: new TranscriptScanner(projects) });
  // A Claude project dir whose transcript records the real folder, which we create too.
  const project = (dir, name, { claude, settings, memory } = {}) => {
    const real = path.join(root, "work", name); fs.mkdirSync(real, { recursive: true });
    fs.mkdirSync(path.join(projects, dir), { recursive: true });
    fs.writeFileSync(path.join(projects, dir, "t.jsonl"), JSON.stringify({ cwd: real.replace(/\\/g, "/") }) + "\n" + "x".repeat(1000) + "\n");
    if (claude != null) fs.writeFileSync(path.join(real, "CLAUDE.md"), claude);
    if (settings) { fs.mkdirSync(path.join(real, ".claude")); fs.writeFileSync(path.join(real, ".claude", "settings.local.json"), "{}"); }
    if (memory) for (const [rel, files] of Object.entries(memory)) { const d = path.join(projects, dir, rel); fs.mkdirSync(d, { recursive: true }); for (const f of files) fs.writeFileSync(path.join(d, f), "memo " + f); }
    return real;
  };
  return { root, projects, svc, project };
}

describe("ClaudeMdService.list", () => {
  it("lists projects with their CLAUDE.md, local settings and memory files, CLAUDE.md first then by name", () => {
    const r = rig();
    const b = r.project("p-b", "bravo", { claude: "# bravo\n", settings: true, memory: { memory: ["a.md", "skip.txt", "b.md"] } });
    r.project("p-a", "alpha");
    const c = r.project("p-c", "charlie", { claude: "hi", memory: { "session-1/memory": ["n.md"] } });
    const list = r.svc.list();
    assert.deepEqual(list.map((p) => p.name), ["bravo", "charlie", "alpha"]);
    const bravo = list[0]; assert.equal(bravo.dir, "p-b"); assert.equal(bravo.path, path.normalize(b)); assert.equal(bravo.hasClaude, true); assert.equal(bravo.size, 8);
    assert.equal(bravo.hasLocalSettings, true); assert.deepEqual(bravo.memoryFiles.sort(), ["a.md", "b.md"]);
    assert.deepEqual(list[1].memoryFiles, ["n.md"], "memory nested in a session subfolder");
    assert.equal(list[2].hasClaude, false); assert.equal(list[2].size, 0); assert.equal(list[2].hasLocalSettings, false); assert.deepEqual(list[2].memoryFiles, []);
  });
  it("falls back to decoding the folder name when a project has no usable transcript", () => {
    const r = rig(); fs.mkdirSync(path.join(r.projects, "C--Some-thing"));
    assert.equal(r.svc.list()[0].path, "C:\\Some\\thing");
  });
  it("caches the project list for a minute, then notices new projects", () => {
    mock.timers.enable({ apis: ["Date"] });
    try {
      const r = rig(); r.project("p-a", "alpha"); assert.equal(r.svc.list().length, 1);
      r.project("p-b", "bravo"); assert.equal(r.svc.list().length, 1, "still cached");
      mock.timers.tick(60001); assert.equal(r.svc.list().length, 2);
    } finally { mock.timers.reset(); }
  });
  it("an empty or missing projects folder lists nothing", () => {
    const r = rig(); assert.deepEqual(r.svc.list(), []);
    assert.deepEqual(new ClaudeMdService({ projects: path.join(r.root, "none"), scanner: new TranscriptScanner(path.join(r.root, "none")) }).list(), []);
  });
});

describe("ClaudeMdService read/write", () => {
  it("reads CLAUDE.md, reports a missing one, and writes it back", () => {
    const r = rig(); const real = r.project("p-a", "alpha", { claude: "# hi\n" });
    assert.deepEqual(r.svc.read(real), { content: "# hi\n", path: path.join(real, "CLAUDE.md") });
    const none = r.project("p-b", "bravo"); assert.deepEqual(r.svc.read(none), { content: "", path: path.join(none, "CLAUDE.md"), exists: false });
    assert.deepEqual(r.svc.write(none, "# new"), { ok: true, path: path.join(none, "CLAUDE.md") }); assert.equal(r.svc.read(none).content, "# new");
  });
  it("validates input and reports a failed write as a 500", () => {
    const r = rig();
    assert.throws(() => r.svc.read(""), (e) => e.status === 400 && e.message === "path required");
    assert.throws(() => r.svc.read(undefined), (e) => e.status === 400);
    assert.throws(() => r.svc.write("", "x"), (e) => e.status === 400 && e.message === "path and content required");
    assert.throws(() => r.svc.write("/x", null), (e) => e.status === 400);
    assert.throws(() => r.svc.write(path.join(r.root, "does", "not", "exist"), "x"), (e) => e.status === 500);
    assert.doesNotThrow(() => r.svc.write(r.project("p", "empty"), ""), "an empty string is valid content");
  });
});

describe("ClaudeMdService templates and memory", () => {
  it("offers the starter templates with capitalized names", () => {
    const t = new ClaudeMdService({ projects: "/x", scanner: new TranscriptScanner("/x") }).templates();
    assert.deepEqual(t.map((x) => x.id), ["basic", "webdev", "cli", "python"]); assert.deepEqual(t.map((x) => x.name), ["Basic", "Webdev", "Cli", "Python"]);
    assert.ok(t.every((x) => x.content.startsWith("# ")));
  });
  it("reads memory notes from memory/ or from a session subfolder, and reports none", () => {
    const r = rig(); r.project("direct", "d", { memory: { memory: ["x.md", "y.md", "skip.txt"] } }); r.project("nested", "n", { memory: { "s1/memory": ["z.md"] } }); r.project("empty", "e");
    const direct = r.svc.memory("direct"); assert.equal(direct.path, path.join(r.projects, "direct", "memory"));
    assert.deepEqual(direct.memories.map((m) => m.file).sort(), ["x.md", "y.md"]); assert.equal(direct.memories[0].content.startsWith("memo "), true);
    assert.deepEqual(r.svc.memory("nested").memories, [{ file: "z.md", content: "memo z.md" }]);
    assert.deepEqual(r.svc.memory("empty"), { memories: [], path: null }); assert.deepEqual(r.svc.memory("unknown-dir"), { memories: [], path: null });
    assert.throws(() => r.svc.memory(""), (e) => e.status === 400 && e.message === "dir required");
  });
});
