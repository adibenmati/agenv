import * as http from "http";
import * as path from "path";
import type { Express } from "express";
import type { Agent } from "./agents/Agent";
import { AgentStore } from "./agents/AgentStore";
import { ClaudeLinker } from "./claude/ClaudeLinker";
import { ClaudeMdService } from "./claude/ClaudeMdService";
import { claudePaths } from "./claude/paths";
import { SessionIndex } from "./claude/SessionIndex";
import { TranscriptScanner } from "./claude/TranscriptScanner";
import { UsageService } from "./claude/UsageService";
import { Config } from "./core/Config";
import { Crypto } from "./core/Crypto";
import { createRealDirChecker } from "./core/fsUtil";
import { JsonStore } from "./core/JsonStore";
import { TypedEmitter } from "./core/TypedEmitter";
import type { ArchiveEntry, Favorite, PersistedState } from "./core/types";
import { AiService } from "./features/AiService";
import { FileService } from "./features/FileService";
import { GitService } from "./features/GitService";
import { NgrokTunnel } from "./features/NgrokTunnel";
import { PromptLibrary } from "./features/PromptLibrary";
import { SearchService } from "./features/SearchService";
import { SystemStats } from "./features/SystemStats";
import type { AppDeps } from "./http/AppDeps";
import { createApp } from "./http/createApp";
import { PageBuilder } from "./http/page";
import { WsGateway } from "./http/WsGateway";
import { ArchiveStore } from "./persistence/ArchiveStore";
import { FavoritesStore } from "./persistence/FavoritesStore";
import { HistoryStore } from "./persistence/HistoryStore";
import { ScrollbackStore } from "./persistence/ScrollbackStore";
import { StateStore } from "./persistence/StateStore";
import { AuthService } from "./security/AuthService";
import { OutputAnalyzer } from "./sessions/OutputAnalyzer";
import type { SessionEvents } from "./sessions/events";
import { GroupRegistry } from "./sessions/GroupRegistry";
import type { PtyFactory } from "./sessions/pty";
import { SessionManager } from "./sessions/SessionManager";
import { WorkspaceLayout } from "./sessions/WorkspaceLayout";

export interface RuntimeOptions {
  config: Config;
  /** Where agenv keeps its files (~/.agenv-*) and finds Claude's (~/.claude). */
  homedir: string;
  ptyFactory: PtyFactory;
  publicDir: string;
  /** Reload the page template when index.html changes (development). */
  watchPage?: boolean;
  /** Called by POST /api/shutdown. */
  onShutdownRequest?: (reason: string) => void;
}

export interface Runtime extends AppDeps {
  app: Express;
  server: http.Server;
  bus: TypedEmitter<SessionEvents>;
  /** What was saved by the previous run, for index.ts to restore from. */
  savedState: PersistedState | null;
  /** Stop timers, watchers and sockets owned by the runtime and resolve once the server has closed. Does not touch shells or saved state. */
  dispose(): Promise<void>;
}

/**
 * The composition root: the one place that creates every object and hands each its dependencies. It does not
 * listen, restore sessions or touch the process — index.ts does that — so the whole application can be built in a
 * test with a fake pty factory and a temporary home folder.
 */
export function buildRuntime(o: RuntimeOptions): Runtime {
  const { config, homedir } = o;
  const crypto = new Crypto(path.join(homedir, ".agenv.key"));
  const claude = claudePaths(homedir);

  // ---- persistence ----
  const file = <T>(name: string, fallback: () => T, legacy?: { name: string; accept: (v: unknown) => boolean }): JsonStore<T> =>
    new JsonStore<T>({
      path: path.join(homedir, name), crypto, fallback,
      legacyPath: legacy && path.join(homedir, legacy.name), acceptLegacy: legacy && legacy.accept,
    });
  const stateFile = file<PersistedState | null>(".agenv-state.enc", () => null, { name: ".agenv-state.json", accept: (v) => !!(v && (v as any).sessions) });
  const history = new HistoryStore(file<string[]>(".agenv-history.enc", () => [], { name: ".agenv-history.json", accept: (v) => Array.isArray(v) && v.length > 0 }));
  const archive = new ArchiveStore(file<ArchiveEntry[]>(".agenv-archive.enc", () => []));
  const favorites = new FavoritesStore(file<Favorite[]>(".agenv-favorites.enc", () => []));
  const agents = new AgentStore(file<Agent[]>(".agenv-agents.enc", () => []), createRealDirChecker());
  void agents;   // exposed through AgentService in a later task
  const scrollbackStore = new ScrollbackStore(path.join(homedir, ".agenv-scrollback"), crypto);
  const savedState = stateFile.load();

  // ---- sessions ----
  const bus = new TypedEmitter<SessionEvents>();
  const isRealDir = createRealDirChecker();
  const layout = new WorkspaceLayout(savedState && savedState.workspaceLayout);
  const sessions = new SessionManager({
    bus, ptyFactory: o.ptyFactory, shell: config.shell, maxSessions: config.maxSessions,
    defaultCols: process.stdout.columns || 120, defaultRows: process.stdout.rows || 30,
    scrollbackStore, archive, isRealDir,
  });
  const stateStore = new StateStore(stateFile, () => ({
    sessions: sessions.all().map((s) => s.toPersisted()),
    workspaceLayout: layout.get(),
    sessionGroups: groups.defs,
  }));
  const groups = new GroupRegistry({
    sessions: () => sessions.all(), emitChanged: () => stateStore.save(),
    defs: savedState && Array.isArray(savedState.sessionGroups) ? savedState.sessionGroups : [],
  });
  const analyzer = new OutputAnalyzer(bus, isRealDir);

  // ---- tunnel, security, transport ----
  const ngrok = new NgrokTunnel({ defaultPort: config.port });
  const auth = new AuthService({ config, policy: ngrok });
  const server = http.createServer();
  const gateway = new WsGateway({ server, sessions, auth, policy: ngrok, bus });

  // ---- Claude integration ----
  const scanner = new TranscriptScanner(claude.projects);
  const linker = new ClaudeLinker({ bus, sessions, scanner, paths: claude });

  // ---- reactions between parts ----
  bus.on("changed", () => stateStore.save());
  bus.on("deleted", () => gateway.broadcastEvent("archive-updated"));
  linker.start();

  const pages = new PageBuilder({
    publicDir: o.publicDir, watch: o.watchPage,
    sessions: () => sessions.all(), archive: () => archive.list(), favorites: () => favorites.list(), layout: () => layout.get(),
  });

  const deps: AppDeps = {
    config, auth, sessions, groups, layout, stateStore, history, archive, favorites, gateway, linker,
    usage: new UsageService(scanner),
    sessionIndex: new SessionIndex(scanner, { projects: claude.projects, indexFile: claude.indexFile }),
    claudeMd: new ClaudeMdService({ projects: claude.projects, scanner }),
    git: new GitService(),
    files: new FileService({ sessionCwd: (id) => sessions.get(id)?.cwd }),
    search: new SearchService(),
    ai: new AiService(),
    prompts: new PromptLibrary(path.join(claude.home, "agenv-prompts.json")),
    ngrok, stats: new SystemStats(), pages, publicDir: o.publicDir,
    shutdown: o.onShutdownRequest || (() => {}),
  };

  const app = createApp(deps);
  server.on("request", app);

  return {
    ...deps, app, server, bus, savedState,
    dispose(): Promise<void> {
      linker.stop();
      gateway.dispose();
      auth.dispose();
      analyzer.dispose();
      ngrok.dispose();
      pages.dispose();
      if (!server.listening) return Promise.resolve();
      return new Promise((resolve) => {
        server.close(() => resolve());
        (server as any).closeAllConnections?.();   // open WebSockets would otherwise keep the server from closing
      });
    },
  };
}
