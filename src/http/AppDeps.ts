import type { AgentService } from "../agents/AgentService";
import type { ClaudeLinker } from "../claude/ClaudeLinker";
import type { ClaudeMdService } from "../claude/ClaudeMdService";
import type { SessionIndex } from "../claude/SessionIndex";
import type { UsageService } from "../claude/UsageService";
import type { Config } from "../core/Config";
import type { AiService } from "../features/AiService";
import type { FileService } from "../features/FileService";
import type { GitService } from "../features/GitService";
import type { NgrokTunnel } from "../features/NgrokTunnel";
import type { PromptLibrary } from "../features/PromptLibrary";
import type { SearchService } from "../features/SearchService";
import type { SystemStats } from "../features/SystemStats";
import type { ArchiveStore } from "../persistence/ArchiveStore";
import type { FavoritesStore } from "../persistence/FavoritesStore";
import type { HistoryStore } from "../persistence/HistoryStore";
import type { StateStore } from "../persistence/StateStore";
import type { AuthService } from "../security/AuthService";
import type { GroupRegistry } from "../sessions/GroupRegistry";
import type { SessionManager } from "../sessions/SessionManager";
import type { WorkspaceLayout } from "../sessions/WorkspaceLayout";
import type { PageBuilder } from "./page";
import type { WsGateway } from "./WsGateway";

/** Everything the HTTP layer needs. Built in one place (runtime.ts) and handed to each router. */
export interface AppDeps {
  config: Config;
  auth: AuthService;
  sessions: SessionManager;
  agents: AgentService;
  groups: GroupRegistry;
  layout: WorkspaceLayout;
  stateStore: StateStore;
  history: HistoryStore;
  archive: ArchiveStore;
  favorites: FavoritesStore;
  gateway: WsGateway;
  linker: ClaudeLinker;
  usage: UsageService;
  sessionIndex: SessionIndex;
  claudeMd: ClaudeMdService;
  git: GitService;
  files: FileService;
  search: SearchService;
  ai: AiService;
  prompts: PromptLibrary;
  ngrok: NgrokTunnel;
  stats: SystemStats;
  pages: PageBuilder;
  publicDir: string;
  /** Stops the server cleanly (POST /api/shutdown). */
  shutdown: (reason: string) => void;
}
