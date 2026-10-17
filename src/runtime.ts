import * as http from "http";
import * as path from "path";
import type { Express } from "express";
import type { Agent } from "./agents/Agent";
import { AgentService } from "./agents/AgentService";
import { AgentStore } from "./agents/AgentStore";
import { ClaudeRunner } from "./agents/ClaudeRunner";
import { TrackedRunner } from "./agents/TrackedRunner";
import { ConversationForker } from "./agents/ConversationForker";
import { ChangeBatcher } from "./automation/ChangeBatcher";
import { AutomationGuards } from "./automation/AutomationGuards";
import { AutomationOwnership } from "./automation/AutomationOwnership";
import { AutomationService } from "./automation/AutomationService";
import { AutomationSettings } from "./automation/AutomationSettings";
import type { AutomationSettingsData } from "./automation/AutomationSettings";
import type { Routine } from "./automation/Routine";
import { RoutineScheduler, createRunQueue, makePreflight } from "./automation/RoutineScheduler";
import { RoutineStore } from "./automation/RoutineStore";
import { AgentRunExecutor } from "./automation/RunExecutor";
import { RunStore } from "./automation/RunStore";
import type { Run } from "./automation/RunStore";
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
  /** The routine tick. Not started by buildRuntime: index.ts calls startup() then start() once the server listens. */
  scheduler: RoutineScheduler;
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
  const agentStore = new AgentStore(file<Agent[]>(".agenv-agents.enc", () => []), createRealDirChecker());
  const routineStore = new RoutineStore(
    file<Routine[]>(".agenv-routines.enc", () => []), createRealDirChecker(), (id) => agentStore.get(id) !== undefined);
  const runStore = new RunStore({ store: file<Run[]>(".agenv-runs.enc", () => []), logDir: path.join(homedir, ".agenv-runs") });
  const automationSettings = new AutomationSettings(file<Partial<AutomationSettingsData>>(".agenv-automation.enc", () => ({})));
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
  const claudeRunner = new TrackedRunner(new ClaudeRunner());
  const agents = new AgentService({
    store: agentStore, runner: claudeRunner, forker: new ConversationForker({ runner: claudeRunner }), sessions, isDir: isRealDir, projectsDir: claude.projects,
  });

  // ---- tunnel, security, transport ----
  const ngrok = new NgrokTunnel({ defaultPort: config.port });
  const auth = new AuthService({ config, policy: ngrok });
  const server = http.createServer();
  const gateway = new WsGateway({ server, sessions, auth, policy: ngrok, bus });

  // ---- automation (routines): the tick is started by index.ts once the server listens, never here ----
  // A tick or catch-up burst changes many rows at once: one broadcast per burst.
  const runsBroadcast = new ChangeBatcher(() => gateway.broadcastEvent("runs-updated"));
  const runsChanged = (): void => runsBroadcast.notify();
  const clock = (): number => Date.now();
  const guards = new AutomationGuards({ settings: automationSettings, runs: runStore, now: clock });
  const executor = new AgentRunExecutor({
    agents, runs: runStore, now: clock,
    preflight: makePreflight({ runs: runStore, routines: routineStore, guards, now: clock }),
  });
  const runQueue = createRunQueue({ limit: 2, routines: routineStore, runs: runStore, executor, now: clock, onChange: runsChanged });
  const scheduler = new RoutineScheduler({ routines: routineStore, runs: runStore, guards, queue: runQueue, now: clock, onChange: runsChanged });
  // One agenv instance per machine runs the schedules (a lock file in the home folder); index.ts acquires it once the port is ours.
  const ownership = new AutomationOwnership({ path: path.join(homedir, ".agenv-automation.lock"), port: config.port });
  const automation = new AutomationService({
    ownership, routines: routineStore, runs: runStore, settings: automationSettings, scheduler, queue: runQueue, agents,
    isDir: isRealDir, agentExists: (id) => agentStore.get(id) !== undefined, now: clock, onChange: runsChanged,
  });

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
    config, auth, sessions, agents, automation, groups, layout, stateStore, history, archive, favorites, gateway, linker,
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
    ...deps, app, server, bus, savedState, scheduler,
    dispose(): Promise<void> {
      // Stop the tick and cancel queued/running routine runs first; agents.cancelAll() then sweeps whatever is left.
      const automationStopped = automation.dispose().catch(() => {});
      agents.cancelAll();
      linker.stop();
      gateway.dispose();
      auth.dispose();
      analyzer.dispose();
      ngrok.dispose();
      pages.dispose();
      const serverClosed = !server.listening ? Promise.resolve() : new Promise<void>((resolve) => {
        server.close(() => resolve());
        (server as any).closeAllConnections?.();   // open WebSockets would otherwise keep the server from closing
      });
      return Promise.all([automationStopped, serverClosed]).then(() => undefined);
    },
  };
}
