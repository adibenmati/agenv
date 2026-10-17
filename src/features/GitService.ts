import * as fs from "fs";
import * as path from "path";
import { HttpError } from "../core/HttpError";
import { run, RunResult } from "./exec";

/** Read-only actions of GET /api/git/:action. */
const ACTIONS: Record<string, string[]> = {
  status: ["status", "--porcelain"],
  diff: ["diff"],
  "diff-staged": ["diff", "--staged"],
  log: ["log", "--oneline", "-20"],
  branch: ["branch", "-a"],
  stash: ["stash", "list"],
};

const KB = 1024;
const combined = (r: RunResult): string => ((r.stdout || "") + (r.stderr || "")).trim();
const looksLikeOption = (s: string): boolean => s.startsWith("-");

/** The shape git routes use for validation errors: `{ ok: false, output }`. */
const badOutput = (message: string): HttpError => new HttpError(400, message, { ok: false, output: message });

/**
 * Git operations for the Git panel. Each method returns the exact JSON the route answers with. Git is run
 * directly (no shell) and asynchronously, so a slow repository no longer freezes every terminal, and values such
 * as commit messages, branch names and file paths reach git verbatim.
 */
export class GitService {
  private git(args: string[], cwd: string, timeoutMs: number, maxBuffer?: number): Promise<RunResult> {
    return run("git", args, { cwd, timeoutMs, maxBuffer });
  }

  /** Repos in and around a directory: the one containing it, child repos (monorepos) and linked worktrees. */
  async repos(dirArg?: string): Promise<{ repos: Array<{ path: string; name: string; relation: string }>; dir: string }> {
    const dir = dirArg || process.cwd();
    const repos: Array<{ path: string; name: string; relation: string }> = [];

    // Check if dir itself is inside a git repo
    const top = await this.git(["rev-parse", "--show-toplevel"], dir, 5000);
    const topPath = (top.stdout || "").trim();
    if (top.status === 0 && topPath) repos.push({ path: path.resolve(topPath), name: path.basename(topPath), relation: "current" });

    // Scan immediate subdirectories for .git folders (monorepo detection)
    try {
      for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const subDir = path.join(dir, entry.name);
        try {
          // It's a git repo (or worktree — .git can be a file pointing to worktree)
          await fs.promises.access(path.join(subDir, ".git"));
          const repoPath = path.resolve(subDir);
          if (!repos.find((r) => r.path === repoPath)) repos.push({ path: repoPath, name: entry.name, relation: "child" });
        } catch {}
      }
    } catch {}

    // Also check for git worktrees (linked worktrees point to main repo)
    if (repos.length > 0 && repos[0].relation === "current") {
      const wt = await this.git(["worktree", "list", "--porcelain"], repos[0].path, 5000);
      if (wt.status === 0 && wt.stdout) {
        for (const line of wt.stdout.split("\n")) {
          if (!line.startsWith("worktree ")) continue;
          const wtPath = line.slice(9).trim();
          if (wtPath && !repos.find((r) => r.path === path.resolve(wtPath))) {
            repos.push({ path: path.resolve(wtPath), name: path.basename(wtPath), relation: "worktree" });
          }
        }
      }
    }
    return { repos, dir };
  }

  async diffFile(filePath: unknown, cwdArg?: string): Promise<{ ok: boolean; diff?: string; message?: string; error?: string }> {
    if (!filePath || typeof filePath !== "string") throw new HttpError(400, "Missing path");
    const cwd = cwdArg || process.cwd();
    const out = ((await this.git(["diff", "--", filePath], cwd, 10000, 1024 * KB)).stdout || "").trim();
    if (out) return { ok: true, diff: out };
    const out2 = ((await this.git(["diff", "HEAD", "--", filePath], cwd, 10000, 1024 * KB)).stdout || "").trim();
    if (!out2) return { ok: true, diff: "", message: "No changes" };
    return { ok: true, diff: out2 };
  }

  /** Combined diff for the AI features: working diff, staged diff and recent commits. */
  async diffForAi(dirArg?: string): Promise<{ diff: string; stagedDiff: string; recentCommits: string }> {
    const cwd = dirArg || process.cwd();
    const [diff, staged, log] = await Promise.all([
      this.git(["diff"], cwd, 10000, 2048 * KB),
      this.git(["diff", "--cached"], cwd, 10000, 2048 * KB),
      this.git(["log", "--oneline", "-10"], cwd, 10000, 2048 * KB),
    ]);
    return { diff: (diff.stdout || "").trim(), stagedDiff: (staged.stdout || "").trim(), recentCommits: (log.stdout || "").trim() };
  }

  async action(name: string, cwd: string): Promise<{ ok: boolean; output: string; cwd: string }> {
    if (!Object.prototype.hasOwnProperty.call(ACTIONS, name)) throw new HttpError(400, "Unknown action");
    const r = await this.git(ACTIONS[name], cwd, 10000, 512 * KB);
    return { ok: r.status === 0, output: ((r.stdout || "") + (r.stderr || "")).trim(), cwd };
  }

  // ---- writes ----

  /** `files`: paths to stage; everything when omitted. */
  async stage(dir: string | undefined, files: unknown): Promise<{ ok: boolean; output: string }> {
    const r = await this.git(["add", "--", ...(Array.isArray(files) ? files.map(String) : ["."])], dir || process.cwd(), 10000);
    return { ok: r.status === 0, output: combined(r) };
  }

  async unstage(dir: string | undefined, files: unknown): Promise<{ ok: boolean; output: string }> {
    const r = await this.git(["reset", "HEAD", "--", ...(Array.isArray(files) ? files.map(String) : ["."])], dir || process.cwd(), 10000);
    return { ok: r.status === 0, output: combined(r) };
  }

  async commit(dir: string | undefined, message: unknown): Promise<{ ok: boolean; output: string }> {
    if (typeof message !== "string" || !message.trim()) throw badOutput("Commit message required");
    const r = await this.git(["commit", "-m", message.trim()], dir || process.cwd(), 30000, 512 * KB);
    return { ok: r.status === 0, output: combined(r) };
  }

  async push(dir: string | undefined, remote?: unknown, branch?: unknown): Promise<{ ok: boolean; output: string }> {
    const args = ["push"];
    for (const v of [remote, branch]) {
      if (!v) continue;
      const s = String(v);
      if (looksLikeOption(s)) throw badOutput("Invalid remote or branch name");
      args.push(s);
    }
    const r = await this.git(args, dir || process.cwd(), 60000, 512 * KB);
    return { ok: r.status === 0, output: combined(r) };
  }

  async checkout(dir: string | undefined, branch: unknown): Promise<{ ok: boolean; output: string }> {
    if (typeof branch !== "string" || !branch.trim()) throw badOutput("Branch name required");
    // Strip "remotes/origin/" prefix if present (for checking out remote branches)
    let target = branch.trim();
    if (target.startsWith("remotes/")) target = target.replace(/^remotes\/[^/]+\//, "");
    if (looksLikeOption(target)) throw badOutput("Invalid branch name");
    const r = await this.git(["checkout", target], dir || process.cwd(), 30000, 512 * KB);
    return { ok: r.status === 0, output: combined(r) };
  }

  async discard(dir: string | undefined, files: unknown): Promise<{ ok: boolean; output: string }> {
    if (!Array.isArray(files) || files.length === 0) throw badOutput("Files required");
    const r = await this.git(["checkout", "--", ...files.map(String)], dir || process.cwd(), 10000);
    return { ok: r.status === 0, output: combined(r) };
  }

  async stash(dir: string | undefined, message?: unknown): Promise<{ ok: boolean; output: string }> {
    const args = ["stash", "push"];
    if (typeof message === "string" && message.trim()) args.push("-m", message.trim());
    args.push("--include-untracked");
    const r = await this.git(args, dir || process.cwd(), 30000, 512 * KB);
    return { ok: r.status === 0, output: combined(r) };
  }

  async stashPop(dir: string | undefined): Promise<{ ok: boolean; output: string }> {
    const r = await this.git(["stash", "pop"], dir || process.cwd(), 30000, 512 * KB);
    return { ok: r.status === 0, output: combined(r) };
  }

  /** New branch in a sibling folder named `<repo>-<branch>`. */
  async worktreeAdd(dir: string | undefined, branch: unknown): Promise<{ ok: boolean; output?: string; path?: string; branch?: string; error?: string }> {
    const invalid = (error: string): HttpError => new HttpError(400, error, { ok: false, error });
    if (typeof branch !== "string" || !branch.trim()) throw invalid("Branch name required");
    const cwd = dir || process.cwd();
    const branchName = branch.trim().replace(/[^a-zA-Z0-9_\-/.]/g, "");
    if (!branchName) throw invalid("Branch name required");
    if (looksLikeOption(branchName)) throw invalid("Invalid branch name");
    const wtPath = path.join(cwd, "..", path.basename(cwd) + "-" + branchName.replace(/\//g, "-"));
    const r = await this.git(["worktree", "add", "-b", branchName, wtPath], cwd, 30000, 512 * KB);
    const out = combined(r);
    return r.status === 0 ? { ok: true, output: out, path: wtPath, branch: branchName } : { ok: false, output: out };
  }
}
