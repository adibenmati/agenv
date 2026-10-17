import express from "express";
import type { AppDeps } from "./AppDeps";
import { errorMiddleware } from "./errors";
import { aiRouter } from "./routes/ai";
import { agentsRouter } from "./routes/agents";
import { claudeRouter } from "./routes/claude";
import { filesRouter } from "./routes/files";
import { gitRouter } from "./routes/git";
import { ngrokRouter } from "./routes/ngrok";
import { promptsRouter } from "./routes/prompts";
import { routinesRouter } from "./routes/routines";
import { searchRouter } from "./routes/search";
import { sessionsRouter } from "./routes/sessions";
import { systemRouter } from "./routes/system";

const CSP = "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net; connect-src 'self' ws: wss:; img-src 'self' data: blob:; worker-src 'self' blob:";

/** The Express application: middleware in the order it has always run, then one router per area, then the pages. */
export function createApp(d: AppDeps): express.Express {
  const app = express();
  app.use(express.json({ limit: "50mb" }));

  // Security headers
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", CSP);
    next();
  });

  // API rate limiter — 600 req/min per IP
  app.use("/api", d.auth.rateLimit);
  app.use("/public", express.static(d.publicDir));

  app.use(sessionsRouter(d));
  app.use(gitRouter(d));
  app.use(filesRouter(d));
  app.use(searchRouter(d));
  app.use(systemRouter(d));
  app.use(claudeRouter(d));
  app.use(agentsRouter(d));
  app.use(routinesRouter(d));
  app.use(aiRouter(d));
  app.use(promptsRouter(d));
  app.use(ngrokRouter(d));

  // Auth pages: /login (credentials mode) and /
  d.auth.registerPages(app, { page: (token) => d.pages.page(token), login: (error) => d.pages.login(error) });

  app.use(errorMiddleware);
  return app;
}
