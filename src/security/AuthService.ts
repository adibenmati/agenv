import * as crypto from "crypto";
import express, { Express, RequestHandler } from "express";
import type { Config } from "../core/Config";
import { verifyPassword } from "../core/password";
import type { NgrokPolicy } from "./NgrokPolicy";

/** The slice of a request that authentication looks at — satisfied by Express requests and WS upgrade requests. */
export interface AuthRequest {
  headers: Record<string, string | string[] | undefined>;
  url?: string;
  query?: Record<string, unknown>;
  method?: string;
  path?: string;
  socket?: { remoteAddress?: string };
}

export interface PageBuilders {
  /** The app page; `token` is the access token in token mode and "" in credentials mode. */
  page: (token: string) => string;
  login: (error?: string) => string;
}

// Write operations blocked for tunnel clients in read-only mode.
const WRITE_PATHS = ["/api/sessions", "/api/git/stage", "/api/git/commit", "/api/git/push",
  "/api/git/checkout", "/api/git/unstage", "/api/git/discard", "/api/git/stash",
  "/api/git/stash-pop", "/api/git/worktree-add", "/api/session-groups",
  "/api/file", "/api/upload", "/api/clip", "/api/shutdown", "/api/quick-launch",
  "/api/agents", "/api/claude/conversations", "/api/routines", "/api/runs", "/api/automation"];

const RATE_LIMIT_PER_MINUTE = 600;

function parseCookies(header: string | string[] | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const c of String(header || "").split(";")) {
    const idx = c.indexOf("=");
    if (idx <= 0) continue;
    const value = c.substring(idx + 1).trim();
    let decoded = value;
    try { decoded = decodeURIComponent(value); } catch {}   // a malformed escape must not throw (it would crash the WS handler)
    cookies[c.substring(0, idx).trim()] = decoded;
  }
  return cookies;
}

/**
 * Who may talk to the server: access token or username/password session cookie, plus the extra rules for requests
 * that come through the ngrok tunnel (IP allow-list, read-only mode) and a per-IP API rate limit.
 */
export class AuthService {
  private readonly credentials: boolean;
  private readonly cookieSessions = new Set<string>();
  private readonly buckets = new Map<string, { count: number; windowStart: number }>();
  private readonly sweep: NodeJS.Timeout;

  constructor(private readonly o: { config: Config; policy: NgrokPolicy }) {
    const auth = o.config.get("auth") as { username?: string; password?: string } | undefined;
    this.credentials = !!(auth && auth.username && auth.password);   // decided once, at startup
    // Clean up stale rate-limit buckets every 5 minutes
    this.sweep = setInterval(() => {
      const cutoff = Date.now() - 120000;
      for (const [ip, b] of this.buckets) if (b.windowStart < cutoff) this.buckets.delete(ip);
    }, 300000);
    if (this.sweep.unref) this.sweep.unref();
  }

  dispose(): void { clearInterval(this.sweep); }

  get useCredentials(): boolean { return this.credentials; }

  isAuthenticated(req: AuthRequest): boolean {
    try {
      const cookies = parseCookies(req.headers.cookie);
      if (cookies.session && this.cookieSessions.has(cookies.session)) return true;
      const token = this.o.config.token;
      if (new URL(req.url || "/", "http://localhost").searchParams.get("token") === token) return true;
      if (req.query && req.query.token === token) return true;
    } catch {}
    return false;
  }

  // ---- tunnel (ngrok) helpers ----
  isTunnelRequest(req: AuthRequest): boolean {
    return !!(req.headers["x-forwarded-for"] || req.headers["ngrok-skip-browser-warning"]);
  }

  clientIp(req: AuthRequest): string {
    const xff = req.headers["x-forwarded-for"];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
    return first || req.socket?.remoteAddress || "";
  }

  isReadOnlyTunnel(req: AuthRequest): boolean {
    return this.isTunnelRequest(req) && this.o.policy.readOnly;
  }

  // ---- middleware ----
  readonly apiAuth: RequestHandler = (req, res, next) => {
    if (!this.isAuthenticated(req)) { res.status(401).json({ error: "Unauthorized" }); return; }

    // ngrok IP allowlist check
    const { policy } = this.o;
    if (this.isTunnelRequest(req) && policy.allowedIps.length > 0) {
      const clientIp = this.clientIp(req);
      if (!policy.allowedIps.includes(clientIp)) { res.status(403).json({ error: "IP not in allowlist: " + clientIp }); return; }
    }

    // ngrok read-only mode: block write operations
    if (this.isReadOnlyTunnel(req)) {
      const method = String(req.method || "").toUpperCase();
      if ((method === "POST" || method === "PUT" || method === "DELETE") &&
          WRITE_PATHS.some((p) => String(req.path || "").toLowerCase().startsWith(p))) {
        res.status(403).json({ error: "Read-only mode: write operations disabled via tunnel" });
        return;
      }
    }
    next();
  };

  /** 600 requests per minute per client address. */
  readonly rateLimit: RequestHandler = (req, res, next) => {
    const ip = this.clientIp(req) || "unknown";
    const now = Date.now();
    let bucket = this.buckets.get(ip);
    if (!bucket || now - bucket.windowStart > 60000) {
      bucket = { count: 0, windowStart: now };
      this.buckets.set(ip, bucket);
    }
    bucket.count++;
    if (bucket.count > RATE_LIMIT_PER_MINUTE) { res.status(429).json({ error: "Rate limit exceeded. Try again later." }); return; }
    next();
  };

  /** New access token; the old one stops working immediately. */
  rotateToken(): string {
    const token = crypto.randomBytes(24).toString("hex");
    this.o.config.token = token;
    this.o.config.set("token", token);
    return token;
  }

  /** `GET /login`, `POST /login` (credentials mode only) and `GET /`. */
  registerPages(app: Express, pages: PageBuilders): void {
    const { config } = this.o;
    if (this.credentials) {
      app.get("/login", (req, res) => {
        if (this.isAuthenticated(req)) return res.redirect("/");
        res.type("html").send(pages.login());
      });
      app.post("/login", express.urlencoded({ extended: false }), (req, res) => {
        const { username, password } = req.body;
        const auth = config.get("auth") as { username?: string; password?: string } | undefined;
        if (auth && auth.username === username && auth.password && verifyPassword(password, auth.password)) {
          const sid = crypto.randomBytes(32).toString("hex");
          this.cookieSessions.add(sid);
          const secure = (req.secure || req.headers["x-forwarded-proto"] === "https") ? "; Secure" : "";
          res.setHeader("Set-Cookie", `session=${sid}; HttpOnly; SameSite=Strict; Path=/${secure}`);
          res.redirect("/");
        } else {
          res.status(401).type("html").send(pages.login("Invalid username or password."));
        }
      });
      app.get("/", (req, res) => {
        if (!this.isAuthenticated(req)) return res.redirect("/login");
        res.type("html").send(pages.page(""));
      });
    } else {
      app.get("/", (req, res) => {
        if (req.query.token !== config.token) {
          return res.status(401).type("html").send(
            `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>401</title><style>body{font-family:monospace;background:#1e1e1e;color:#f44;padding:2rem}</style></head><body><h2>401 Unauthorized</h2><p>Missing or invalid token.</p></body></html>`
          );
        }
        res.type("html").send(pages.page(config.token));
      });
    }
  }
}
