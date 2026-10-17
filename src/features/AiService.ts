import { ChildProcess, spawn as nodeSpawn } from "child_process";
import { HttpError } from "../core/HttpError";

export interface AskRequest { prompt?: string; agent?: string; model?: string; cwd?: string; timeout?: unknown }
export interface AskResult { response: string; agent: string; model: string; elapsed: number }

export interface AiServiceOptions {
  spawn?: (cmd: string, args: string[], opts: object) => ChildProcess;
  platform?: NodeJS.Platform;
}

const DEFAULT_TIMEOUT_MS = 90000;
const MAX_TIMEOUT_MS = 120000;

/**
 * AI helpers for the git panel, CLAUDE.md manager and prompts. It rides on the user's own CLI agent: the agent is
 * run once in print mode with the prompt on stdin, so no separate API key is needed.
 */
export class AiService {
  private readonly spawn: NonNullable<AiServiceOptions["spawn"]>;
  private readonly platform: NodeJS.Platform;

  constructor(o: AiServiceOptions = {}) {
    this.spawn = o.spawn || ((cmd, args, opts) => nodeSpawn(cmd, args, opts));
    this.platform = o.platform || process.platform;
  }

  ask(b: AskRequest): Promise<AskResult> {
    const { prompt, agent, model, cwd, timeout } = b || {};
    if (!prompt) return Promise.reject(new HttpError(400, "prompt required"));

    const cli = agent || "claude";
    const mdl = model || "sonnet";
    const asked = Number(timeout);
    const timeoutMs = Number.isFinite(asked) && asked > 0 ? Math.min(asked, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;

    // Build command args based on agent type
    let cmd: string, args: string[];
    if (cli === "claude") { cmd = "claude"; args = ["-p", "--model", mdl, "--output-format", "text"]; }
    else if (cli === "gemini") { cmd = "gemini"; args = ["-p"]; }
    else if (cli === "codex") { cmd = "codex"; args = ["-p"]; }
    else { cmd = cli; args = ["-p"]; }

    return new Promise((resolve, reject) => {
      const start = Date.now();
      const chunks: Buffer[] = [], errChunks: Buffer[] = [];
      let done = false;
      const finish = (fn: () => void): void => { if (done) return; done = true; clearTimeout(timer); fn(); };

      // A shell is needed on Windows, where agent CLIs installed with npm are .cmd shims.
      const winShell = (process.env.SystemRoot || "C:\\Windows") + "\\System32\\cmd.exe";
      const child = this.spawn(cmd, args, {
        cwd: cwd || process.cwd(), env: { ...process.env },
        shell: this.platform === "win32" ? winShell : true,
        timeout: timeoutMs, windowsHide: true,
      });

      child.stdout?.on("data", (d: Buffer) => chunks.push(d));
      child.stderr?.on("data", (d: Buffer) => errChunks.push(d));

      // Pipe prompt to stdin then close. An agent that exits without reading it must not raise an unhandled EPIPE.
      child.stdin?.on("error", () => {});
      child.stdin?.write(prompt);
      child.stdin?.end();

      const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);

      child.on("close", (code) => finish(() => {
        const response = Buffer.concat(chunks).toString("utf8").trim();
        const stderr = Buffer.concat(errChunks).toString("utf8").trim();
        const elapsed = Date.now() - start;
        if (code !== 0 && !response) {
          const error = stderr || `Process exited with code ${code}`;
          reject(new HttpError(500, error, { error, elapsed }));
          return;
        }
        resolve({ response, agent: cli, model: mdl, elapsed });
      }));

      child.on("error", (err) => finish(() => reject(new HttpError(500, `Failed to spawn ${cli}: ${err.message}`))));
    });
  }
}
