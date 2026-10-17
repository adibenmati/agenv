import * as fs from "fs";
import * as path from "path";
import type { ArchiveEntry } from "../core/types";
import { recentFolders } from "../sessions/queries";
import { LOGIN_TEMPLATE } from "./loginTemplate";

const RUNTIME_MARKER = "/*__RUNTIME_DATA__*/";

interface PageSession {
  id: number; name?: string; cwd: string; detectedTool?: string; lastCommand?: string; launchCommand?: string;
  created?: number; lastActivity: number; status?: string; group?: string; note?: string; analytics?: unknown; claudeSessionId?: string | null;
}

export interface PageBuilderOptions {
  publicDir: string;
  sessions: () => PageSession[];
  archive: () => ArchiveEntry[];
  favorites: () => unknown[];
  layout: () => unknown | null;
  /** Reload the page template when index.html changes (development). */
  watch?: boolean;
}

/** Builds the app page (index.html with the current state embedded, so it can render without a first fetch) and the login page. */
export class PageBuilder {
  private template: string | null = null;
  private watcher: fs.FSWatcher | null = null;

  constructor(private readonly o: PageBuilderOptions) {
    if (o.watch) {
      try {
        this.watcher = fs.watch(path.join(o.publicDir, "index.html"), () => this.invalidate());
        this.watcher.unref();
      } catch {}
    }
  }

  invalidate(): void { this.template = null; }

  dispose(): void { this.watcher?.close(); this.watcher = null; }

  private getTemplate(): string {
    if (!this.template) this.template = fs.readFileSync(path.join(this.o.publicDir, "index.html"), "utf8");
    return this.template;
  }

  login(error?: string): string {
    return LOGIN_TEMPLATE.replace(/__ERROR__/g, error ? `<p class="error">${error}</p>` : "");
  }

  page(token: string): string {
    const sessionList = [...this.o.sessions()].sort((a, b) => a.id - b.id).map((s) => ({
      id: s.id, name: s.name || "", cwd: s.cwd, tool: s.detectedTool || "terminal",
      lastCommand: s.lastCommand || "", launchCommand: s.launchCommand || "",
      created: s.created, lastActivity: s.lastActivity, status: s.status || "idle",
      group: s.group || "", note: s.note || "", analytics: s.analytics || {},
      claudeSessionId: s.claudeSessionId || null,
    }));
    const archive = [...this.o.archive()].reverse().slice(0, 30);

    // "<" is escaped so a session name such as "</script>" cannot end the script tag; the parsed data is unchanged.
    const runtimeData = JSON.stringify({
      token, sessions: sessionList, archive, favorites: this.o.favorites(),
      recentFolders: recentFolders(this.o.sessions(), archive, 15),
      workspaceLayout: this.o.layout() || null,
    }).replace(/</g, "\\u003c");
    const runtimeScript = `window.__RUNTIME__ = ${runtimeData};`;

    // A replacer function: a string replacement would interpret "$&", "$1" and friends inside the data.
    return this.getTemplate().replace(RUNTIME_MARKER, () => runtimeScript);
  }
}
