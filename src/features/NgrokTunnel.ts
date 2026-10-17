import { ChildProcess, spawn as nodeSpawn } from "child_process";
import * as http from "http";
import type { NgrokPolicy } from "../security/NgrokPolicy";

export interface TunnelStartResult { ok: boolean; url?: string | null; pid?: number; message?: string; error?: string }
export interface TunnelStatus { running: boolean; url?: string | null; pid?: number }

export interface NgrokTunnelOptions {
  /** Port to expose when start() is not given one. */
  defaultPort: number;
  spawn?: (cmd: string, args: string[], opts: object) => ChildProcess;
  /** Asks ngrok's local API for the public URL; resolves null when it can't tell. */
  fetchUrl?: () => Promise<string | null>;
  /** How long to wait after launching before asking for the URL; default 3 s. */
  startWaitMs?: number;
}

/** ngrok exposes a local API at port 4040. */
function ngrokPublicUrl(): Promise<string | null> {
  return new Promise((resolve) => {
    const req = http.get("http://127.0.0.1:4040/api/tunnels", (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          const tunnel = (data.tunnels || []).find((t: any) => t.proto === "https") || data.tunnels?.[0];
          resolve(tunnel ? tunnel.public_url : null);
        } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(2000, () => { req.destroy(); resolve(null); });
  });
}

/**
 * The ngrok tunnel: starts and stops the ngrok process and holds the rules for requests that arrive through it
 * (an IP allow-list and a read-only switch). It *is* the NgrokPolicy that AuthService and WsGateway read.
 */
export class NgrokTunnel implements NgrokPolicy {
  allowedIps: string[] = [];
  readOnly = false;

  private proc: ChildProcess | null = null;
  private url: string | null = null;
  private readonly spawn: NonNullable<NgrokTunnelOptions["spawn"]>;
  private readonly fetchUrl: () => Promise<string | null>;
  private readonly startWaitMs: number;

  constructor(private readonly o: NgrokTunnelOptions) {
    this.spawn = o.spawn || ((cmd, args, opts) => nodeSpawn(cmd, args, opts));
    this.fetchUrl = o.fetchUrl || ngrokPublicUrl;
    this.startWaitMs = o.startWaitMs ?? 3000;
  }

  start(port?: number | string): Promise<TunnelStartResult> {
    if (this.proc) return Promise.resolve({ ok: true, url: this.url, pid: this.proc.pid, message: "Already running" });
    return new Promise((resolve) => {
      let proc: ChildProcess;
      try {
        proc = this.spawn("ngrok", ["http", String(port || this.o.defaultPort)], { stdio: ["ignore", "pipe", "pipe"], detached: false });
      } catch (e: any) { resolve({ ok: false, error: e.message }); return; }
      this.proc = proc;
      // Nobody reads ngrok's console output; if the pipes fill up ngrok blocks writing and the tunnel stalls.
      proc.stdout?.resume();
      proc.stderr?.resume();

      let settled = false;
      const timer = setTimeout(async () => {
        if (settled) return;
        settled = true;
        // Try to get the URL from ngrok's local API
        try {
          const url = await this.fetchUrl();
          if (url) { this.url = url; resolve({ ok: true, url, pid: proc.pid }); }
          else resolve({ ok: false, error: "ngrok started but could not determine tunnel URL. Check ngrok dashboard." });
        } catch {
          resolve({ ok: false, error: "ngrok started but tunnel URL not available yet. Check http://localhost:4040" });
        }
      }, this.startWaitMs);

      proc.on("error", (err) => {
        clearTimeout(timer);
        this.proc = null;
        if (!settled) {
          settled = true;
          resolve({ ok: false, error: "Failed to start ngrok: " + err.message + ". Is ngrok installed? (npm i -g ngrok or https://ngrok.com/download)" });
        }
      });
      proc.on("exit", () => { this.proc = null; this.url = null; });
    });
  }

  stop(): void {
    if (this.proc) {
      try { this.proc.kill(); } catch {}
      this.proc = null;
      this.url = null;
    }
  }

  async status(): Promise<TunnelStatus> {
    if (!this.proc) return { running: false };
    // Only fetch URL from ngrok API if we don't have it yet
    if (!this.url) {
      try {
        const url = await this.fetchUrl();
        if (url) this.url = url;
      } catch {}
      if (!this.proc) return { running: false };
    }
    return { running: true, url: this.url, pid: this.proc.pid };
  }

  settings(): { allowedIps: string[]; readOnly: boolean } {
    return { allowedIps: this.allowedIps, readOnly: this.readOnly };
  }

  updateSettings(b: { allowedIps?: unknown; readOnly?: unknown }): { ok: true; settings: { allowedIps: string[]; readOnly: boolean } } {
    if (Array.isArray(b.allowedIps)) this.allowedIps = b.allowedIps.filter((ip) => ip && typeof ip === "string");
    if (typeof b.readOnly === "boolean") this.readOnly = b.readOnly;
    return { ok: true, settings: this.settings() };
  }

  /** Stop the tunnel when agenv stops (it used to be left running). */
  dispose(): void { this.stop(); }
}
