// test/unit/git.test.js — async process runner and GitService against real temporary repositories
"use strict";
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { execFileSync } = require("child_process");
const { run } = require("../../dist/features/exec");
const { GitService } = require("../../dist/features/GitService");

const node = process.execPath;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("exec.run", () => {
  it("captures stdout, stderr and the exit status", async () => {
    const r = await run(node, ["-e", "console.log('out'); console.error('err'); process.exit(3)"], { cwd: process.cwd() });
    assert.equal(r.status, 3); assert.equal(r.stdout.trim(), "out"); assert.equal(r.stderr.trim(), "err"); assert.equal(r.error, undefined);
  });
  it("does not block the event loop while a child runs", async () => {
    let ticks = 0; const t = setInterval(() => ticks++, 10);
    await run(node, ["-e", "setTimeout(()=>{},300)"], { cwd: process.cwd() });
    clearInterval(t); assert.ok(ticks >= 15, `event loop ticked ${ticks} times in 300ms`);
  });
  it("runs children concurrently", async () => {
    const t0 = Date.now();
    await Promise.all([1, 2, 3].map(() => run(node, ["-e", "setTimeout(()=>{},400)"], { cwd: process.cwd() })));
    assert.ok(Date.now() - t0 < 1000, "three 400ms children should overlap");
  });
  it("kills a child that outlives its timeout and reports ETIMEDOUT with a null status", async () => {
    const t0 = Date.now(); const r = await run(node, ["-e", "setTimeout(()=>{},5000)"], { cwd: process.cwd(), timeoutMs: 150 });
    assert.equal(r.status, null); assert.equal(r.error.code, "ETIMEDOUT"); assert.ok(Date.now() - t0 < 2000);
  });
  it("stops reading past maxBuffer, keeps what it has and reports ENOBUFS", async () => {
    const r = await run(node, ["-e", "process.stdout.write('x'.repeat(2000000))"], { cwd: process.cwd(), maxBuffer: 1000 });
    assert.equal(r.error.code, "ENOBUFS"); assert.equal(r.status, null); assert.ok(r.stdout.length > 0 && r.stdout.length <= 70000, "partial output kept, not the whole 2 MB: " + r.stdout.length);
  });
  it("reports a command that cannot be started instead of throwing", async () => {
    const r = await run("definitely-not-a-real-command-xyz", [], { cwd: process.cwd() });
    assert.equal(r.status, null); assert.equal(r.error.code, "ENOENT"); assert.equal(r.stdout, ""); assert.equal(r.stderr, "");
    const bad = await run(node, ["-e", "1"], { cwd: path.join(os.tmpdir(), "no-such-dir-xyz") });
    assert.equal(bad.status, null); assert.ok(bad.error);
  });
  it("passes arguments verbatim — spaces and shell metacharacters are not interpreted", async () => {
    const r = await run(node, ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", "two words", '"; echo pwned', "a&b|c", "$HOME"], { cwd: process.cwd() });
    assert.deepEqual(JSON.parse(r.stdout), ["two words", '"; echo pwned', "a&b|c", "$HOME"]);
  });
  it("decodes multi-byte output split across chunks", async () => {
    const r = await run(node, ["-e", "process.stdout.write(Buffer.from('é'.repeat(100000)))"], { cwd: process.cwd() });
    assert.equal(r.stdout, "é".repeat(100000));
  });
});

/** A throwaway repo: a.txt committed then modified, b.txt untracked. */
function mkRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenv-git-")); const repo = path.join(root, "repo"); fs.mkdirSync(repo);
  const git = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t"); git("config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n"); git("add", "."); git("commit", "-qm", "init");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n"); fs.writeFileSync(path.join(repo, "b.txt"), "new\n");
  return { root, repo, git };
}
const svc = new GitService();

describe("GitService reads", () => {
  it("runs the read-only actions and reports git's own output", async () => {
    const { repo } = mkRepo();
    const st = await svc.action("status", repo); assert.deepEqual(st, { ok: true, output: "M a.txt\n?? b.txt", cwd: repo });
    assert.match((await svc.action("diff", repo)).output, /\+two/); assert.equal((await svc.action("diff-staged", repo)).output, "");
    assert.match((await svc.action("log", repo)).output, /init$/); assert.match((await svc.action("branch", repo)).output, /\* (master|main)/);
    assert.equal((await svc.action("stash", repo)).output, "");
  });
  it("rejects an unknown action with a 400", async () => {
    await assert.rejects(svc.action("bogus", process.cwd()), (e) => e.status === 400 && e.message === "Unknown action");
  });
  it("outside a repository reports git's error with ok:false", async () => {
    const r = await svc.action("status", fs.mkdtempSync(path.join(os.tmpdir(), "agenv-nogit-")));
    assert.equal(r.ok, false); assert.match(r.output, /not a git repository/i);
  });
  it("diffFile shows the unstaged diff, falls back to HEAD for staged changes, and says so when there are none", async () => {
    const { repo, git } = mkRepo();
    assert.match((await svc.diffFile("a.txt", repo)).diff, /\+two/);
    git("add", "a.txt"); const staged = await svc.diffFile("a.txt", repo); assert.equal(staged.ok, true); assert.match(staged.diff, /\+two/);
    git("commit", "-qm", "two"); assert.deepEqual(await svc.diffFile("a.txt", repo), { ok: true, diff: "", message: "No changes" });
    await assert.rejects(svc.diffFile("", repo), (e) => e.status === 400 && e.message === "Missing path");
  });
  it("diffForAi bundles the diff, the staged diff and recent commits", async () => {
    const { repo, git } = mkRepo(); git("add", "b.txt");
    const r = await svc.diffForAi(repo); assert.match(r.diff, /\+two/); assert.match(r.stagedDiff, /\+new/); assert.match(r.recentCommits, /init/);
  });
  it("repos finds the current repo, child repos and linked worktrees", async () => {
    const { root, repo, git } = mkRepo(); git("worktree", "add", "-q", "-b", "wt", path.join(root, "linked"));
    const kid = path.join(repo, "kid"); fs.mkdirSync(kid); execFileSync("git", ["init", "-q"], { cwd: kid });
    fs.mkdirSync(path.join(repo, "node_modules", "x", ".git"), { recursive: true }); fs.mkdirSync(path.join(repo, ".hidden", ".git"), { recursive: true });
    const r = await svc.repos(repo); assert.equal(r.dir, repo);
    const by = (rel) => r.repos.filter((x) => x.relation === rel).map((x) => x.name).sort();
    assert.deepEqual(by("current"), ["repo"]); assert.deepEqual(by("child"), ["kid"]); assert.deepEqual(by("worktree"), ["linked"]);
    const none = await svc.repos(fs.mkdtempSync(path.join(os.tmpdir(), "agenv-empty-"))); assert.deepEqual(none.repos, []);
  });
});

describe("GitService writes", () => {
  it("stages, unstages and commits — including messages with spaces and shell characters (they were split by a shell before)", async () => {
    const { repo, git } = mkRepo();
    assert.equal((await svc.stage(repo, ["a.txt"])).ok, true); assert.match(git("status", "--porcelain"), /^M  a.txt/m);
    assert.equal((await svc.unstage(repo, ["a.txt"])).ok, true); assert.match(git("status", "--porcelain"), /^ M a.txt/m);
    await svc.stage(repo, undefined);   // default: everything
    assert.match(git("status", "--porcelain"), /A  b.txt/);
    const evil = '"; echo pwned > pwned.txt; "';
    assert.equal((await svc.commit(repo, "fix the login bug")).ok, true); assert.equal(git("log", "-1", "--format=%s").trim(), "fix the login bug");
    fs.writeFileSync(path.join(repo, "c.txt"), "c\n"); await svc.stage(repo, ["c.txt"]);
    assert.equal((await svc.commit(repo, evil)).ok, true); assert.equal(git("log", "-1", "--format=%s").trim(), evil);
    assert.ok(!fs.existsSync(path.join(repo, "pwned.txt")), "the message must not be executed");
  });
  it("stages a file whose name contains spaces", async () => {
    const { repo, git } = mkRepo(); fs.writeFileSync(path.join(repo, "my file.txt"), "x\n");
    assert.equal((await svc.stage(repo, ["my file.txt"])).ok, true); assert.match(git("status", "--porcelain"), /A  "my file.txt"/);
  });
  it("a path that looks like an option is a path, not a git flag", async () => {
    const { repo, git } = mkRepo(); fs.writeFileSync(path.join(repo, "--force"), "x\n");
    assert.equal((await svc.stage(repo, ["--force"])).ok, true); assert.match(git("status", "--porcelain"), /A  --force/);
  });
  it("commit needs a message", async () => {
    await assert.rejects(svc.commit(process.cwd(), "   "), (e) => e.status === 400 && e.body.ok === false && e.body.output === "Commit message required");
    await assert.rejects(svc.commit(process.cwd(), undefined), (e) => e.status === 400);
  });
  it("discard needs files and restores them", async () => {
    const { repo } = mkRepo();
    await assert.rejects(svc.discard(repo, []), (e) => e.status === 400 && e.body.output === "Files required");
    await assert.rejects(svc.discard(repo, undefined), (e) => e.status === 400);
    assert.equal((await svc.discard(repo, ["a.txt"])).ok, true); assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "one\n");
  });
  it("push without a remote reports git's failure; option-looking remotes and branches are refused", async () => {
    const { repo } = mkRepo();
    const r = await svc.push(repo); assert.equal(r.ok, false); assert.match(r.output, /No configured push destination|no upstream|does not appear to be a git repository/i);
    await assert.rejects(svc.push(repo, "--mirror"), (e) => e.status === 400 && e.body.ok === false);
    await assert.rejects(svc.push(repo, "origin", "--delete"), (e) => e.status === 400);
  });
  it("checkout switches branches, strips a remotes/<remote>/ prefix, and refuses option-looking names", async () => {
    const { repo, git } = mkRepo(); git("branch", "feature");
    assert.equal((await svc.checkout(repo, "feature")).ok, true); assert.equal(git("branch", "--show-current").trim(), "feature");
    git("checkout", "-q", "-"); assert.equal((await svc.checkout(repo, "remotes/origin/feature")).ok, true); assert.equal(git("branch", "--show-current").trim(), "feature");
    assert.equal((await svc.checkout(repo, "no-such-branch")).ok, false);
    await assert.rejects(svc.checkout(repo, " "), (e) => e.status === 400 && e.body.output === "Branch name required");
    await assert.rejects(svc.checkout(repo, "--orphan"), (e) => e.status === 400);
  });
  it("stash saves untracked files too, with an optional message, and stash-pop brings them back", async () => {
    const { repo, git } = mkRepo();
    assert.equal((await svc.stash(repo, " wip thing ")).ok, true); assert.equal(git("status", "--porcelain").trim(), ""); assert.match(git("stash", "list"), /wip thing/);
    assert.equal((await svc.stashPop(repo)).ok, true); assert.match(git("status", "--porcelain"), /\?\? b.txt/);
    assert.equal((await svc.stashPop(repo)).ok, false, "nothing left to pop");
  });
  it("worktree-add creates a sibling folder named after the branch and sanitizes the name", async () => {
    const { root, repo } = mkRepo();
    const r = await svc.worktreeAdd(repo, " feat/new thing! ");
    assert.equal(r.ok, true); assert.equal(r.branch, "feat/newthing"); assert.equal(path.resolve(r.path), path.resolve(root, "repo-feat-newthing"));
    assert.ok(fs.existsSync(path.join(r.path, ".git")));
    assert.equal((await svc.worktreeAdd(repo, "feat/newthing")).ok, false, "branch already exists");
    await assert.rejects(svc.worktreeAdd(repo, ""), (e) => e.status === 400 && e.body.error === "Branch name required" && e.body.ok === false);
  });
});
