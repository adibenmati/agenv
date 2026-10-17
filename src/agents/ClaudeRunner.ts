import { ChildProcess, execFileSync, spawn, spawnSync } from "child_process";
import * as fs from "fs";
import { dirname, join } from "path";
import { Permission } from "./Agent";

export interface RunSpec {
  cwd: string;
  prompt: string;
  resume?: string;
  fork?: boolean;
  permission: Permission;
  model?: string;
  instructions?: string;
  briefingFile?: string;
  addDirs?: string[];
  mcpConfig?: string;
  maxBudgetUsd: number;
  timeoutMs: number;
  logPath?: string;
}

export interface RunResult {
  status: "succeeded" | "failed" | "timed_out" | "cancelled";
  conversationId: string;
  text: string;
  costUsd: number;
  numTurns: number;
  durationMs: number;
  exitCode: number | null;
  error?: string;
  /** Not from the runner: AgentService adds a remark about how the run started (for example that a stored conversation was lost). */
  note?: string;
}

export interface RunHooks { onEvent?: (e: unknown) => void }
export interface RunHandle { done: Promise<RunResult>; cancel(): void }

const LOG_CAP = 5 * 1024 * 1024;
const MAX_LINE = 1024 * 1024;
const KILL_GRACE_MS = 5000;

/** The headless claude command line. The prompt is the last item, after "--", so "/compact" or "-x" stay data. */
export function buildArgs(spec: RunSpec): string[] {
  const a = ["-p", "--output-format", "stream-json", "--verbose"];
  if (spec.resume) { a.push("--resume", spec.resume); if (spec.fork) a.push("--fork-session"); }
  a.push("--permission-mode", spec.permission.mode);
  if (spec.permission.allowedTools.length) a.push("--allowedTools", spec.permission.allowedTools.join(","));
  if (spec.model) a.push("--model", spec.model);
  if (spec.instructions) a.push("--append-system-prompt", spec.instructions);
  if (spec.briefingFile) a.push("--append-system-prompt-file", spec.briefingFile);
  for (const d of spec.addDirs ?? []) a.push("--add-dir", d);
  if (spec.mcpConfig) a.push("--mcp-config", spec.mcpConfig);
  a.push("--max-budget-usd", String(spec.maxBudgetUsd), "--", spec.prompt);
  return a;
}

/** Kills a process and everything it started. */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid == null) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else process.kill(-pid, "SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch {}
  }
}

/** Appends lines to a file as they arrive, rotating to the last LOG_CAP bytes (from a line start) past 2x the cap. */
class LiveLog {
  private size = 0;
  private ok: boolean;
  constructor(private path: string | undefined) {
    this.ok = !!path;
    if (path) {
      // Logs hold prompts and tool output: private to the user where the platform has file modes.
      try {
        fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        fs.writeFileSync(path, "", { mode: 0o600 });
        if (process.platform !== "win32") fs.chmodSync(path, 0o600);   // a file that already existed keeps its old mode otherwise
      } catch { this.ok = false; }
    }
  }
  add(text: string): void {
    if (!this.ok || !this.path) return;
    const b = Buffer.from(text + "\n", "utf8");
    try {
      fs.appendFileSync(this.path, b);
      this.size += b.length;
      if (this.size > LOG_CAP * 2) this.rotate();
    } catch { this.ok = false; }
  }
  close(): void {
    if (this.ok && this.size > LOG_CAP) { try { this.rotate(); } catch {} }
  }
  private rotate(): void {
    const all = fs.readFileSync(this.path!);
    let tail = all.subarray(all.length - LOG_CAP);
    const nl = tail.indexOf(10);
    tail = nl >= 0 ? tail.subarray(nl + 1) : tail;
    fs.writeFileSync(this.path!, tail);
    this.size = tail.length;
  }
}


/**
 * On Windows an npm-installed claude is a `claude.cmd` wrapper, which cannot be spawned without a shell. Finds the
 * `cli.js` the wrapper runs (next to it, under node_modules) so it can be started through node instead. Null if not found.
 */
export function resolveNpmClaude(): string | null {
  let out: string;
  try { out = execFileSync("where", ["claude"], { encoding: "utf8", windowsHide: true, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; }
  for (const line of out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const cli = join(dirname(line), "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    if (fs.existsSync(cli)) return cli;
  }
  return null;
}

export class ClaudeRunner {
  private bin: string;
  private env: NodeJS.ProcessEnv;
  private platform: string;
  private resolveShim: (bin: string) => string | null;

  constructor(o: { bin?: string; env?: NodeJS.ProcessEnv; platform?: string; resolveShim?: (bin: string) => string | null } = {}) {
    this.bin = o.bin ?? (process.env.AGENV_CLAUDE_BIN || "claude");
    this.env = o.env ?? {};
    this.platform = o.platform ?? process.platform;
    this.resolveShim = o.resolveShim ?? (() => resolveNpmClaude());
  }

  run(spec: RunSpec, hooks: RunHooks = {}): RunHandle {
    const started = Date.now();
    const log = new LiveLog(spec.logPath);
    let child: ChildProcess | null = null;
    let cancelled = false, timedOut = false, settled = false;
    let result: Record<string, unknown> | null = null;
    let stderr = "";
    let spawnError = "";
    let timer: NodeJS.Timeout | null = null;
    let force: NodeJS.Timeout | null = null;
    let finish: (code: number | null) => void = () => {};

    const done = new Promise<RunResult>((resolve) => {
      finish = (code) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (force) clearTimeout(force);
        log.close();
        const r = result;
        const base = {
          conversationId: typeof r?.session_id === "string" ? r.session_id : spec.resume ?? "",
          text: typeof r?.result === "string" ? r.result : "",
          costUsd: typeof r?.total_cost_usd === "number" ? r.total_cost_usd : 0,
          numTurns: typeof r?.num_turns === "number" ? r.num_turns : 0,
          durationMs: Date.now() - started,
          exitCode: code,
        };
        if (cancelled) return resolve({ ...base, status: "cancelled" });
        if (timedOut) return resolve({ ...base, status: "timed_out", error: `Timed out after ${spec.timeoutMs} ms` });
        if (spawnError) return resolve({ ...base, status: "failed", error: spawnError });
        if (r && r.is_error !== true && (r.subtype === undefined || r.subtype === "success") && code === 0) return resolve({ ...base, status: "succeeded" });
        let error: string;
        if (r && r.subtype === "error_max_budget_usd") error = `Budget limit of $${spec.maxBudgetUsd} reached`;
        else if (r && r.is_error === true) error = (typeof r.result === "string" && r.result) || String(r.subtype ?? "claude reported an error");
        else if (r && r.is_error !== true && code === 0) error = `claude ended with ${String(r.subtype)}`;
        else if (code !== 0) error = stderr.trim() || `claude exited with code ${code}`;
        else error = "claude finished without a result";
        resolve({ ...base, status: "failed", error });
      };
    });

    const kill = (): void => {
      if (child) killTree(child);
      if (!force) force = setTimeout(() => finish(null), KILL_GRACE_MS);   // a stuck pipe must not hang the caller
    };

    // A launch that fails on Windows with ENOENT/EINVAL is usually an npm `claude.cmd` wrapper: retry once through its cli.js.
    let attempt = 0, retried = false, launched = this.bin;
    const failSpawn = (e: NodeJS.ErrnoException, mine: number): void => {
      if (mine !== attempt || settled) return;
      const retryable = this.platform === "win32" && (e.code === "ENOENT" || e.code === "EINVAL") && !/\.js$/i.test(launched);
      if (retryable && !retried) {
        retried = true;
        const cli = this.resolveShim(this.bin);
        if (cli) { launch(cli); return; }
      }
      spawnError = retryable
        ? `Could not start claude (${e.code}). If claude was installed with npm, set AGENV_CLAUDE_BIN to ${String.raw`...\node_modules\@anthropic-ai\claude-code\cli.js`}`
        : `Could not start claude: ${e.message}`;
      finish(null);
    };

    const launch = (bin: string): void => {
      const mine = ++attempt;
      launched = bin;
      const isJs = /\.js$/i.test(bin);
      const args = buildArgs(spec);
      let c: ChildProcess;
      try {
        c = spawn(isJs ? process.execPath : bin, isJs ? [bin, ...args] : args, {
          cwd: spec.cwd,
          env: { ...process.env, ...this.env },
          shell: false,   // never a shell: prompts are arbitrary text
          detached: process.platform !== "win32",
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (e) { failSpawn(e as NodeJS.ErrnoException, mine); return; }
      child = c;

      let pending = "";
      const onLine = (line: string): void => {
        if (!line.trim()) return;
        log.add(line);
        let ev: unknown;
        try { ev = JSON.parse(line); } catch { return; }
        if (ev === null || typeof ev !== "object") return;
        if ((ev as { type?: unknown }).type === "result") result = ev as Record<string, unknown>;
        try { hooks.onEvent?.(ev); } catch {}
      };
      c.stdout!.setEncoding("utf8");
      c.stdout!.on("data", (chunk: string) => {
        pending += chunk;
        if (pending.length > MAX_LINE && pending.indexOf("\n") < 0) { onLine(pending); pending = ""; }
        let i: number;
        while ((i = pending.indexOf("\n")) >= 0) { onLine(pending.slice(0, i).replace(/\r$/, "")); pending = pending.slice(i + 1); }
      });
      c.stderr!.setEncoding("utf8");
      c.stderr!.on("data", (chunk: string) => {
        if (stderr.length < 64 * 1024) stderr += chunk;
        for (const l of chunk.split(/\r?\n/)) if (l) log.add("[stderr] " + l);
      });
      c.on("error", (e) => failSpawn(e as NodeJS.ErrnoException, mine));
      c.on("close", (code) => { if (mine !== attempt) return; onLine(pending); pending = ""; finish(code); });
    };
    launch(this.bin);

    if (!settled) timer = setTimeout(() => { timedOut = true; kill(); }, spec.timeoutMs);

    return { done, cancel: () => { if (settled || cancelled) return; cancelled = true; kill(); } };
  }
}
