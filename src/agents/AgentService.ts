import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { HttpError } from "../core/HttpError";
import type { Session } from "../sessions/Session";
import type { SessionManager } from "../sessions/SessionManager";
import { safeId } from "../core/ids";
import { Agent, AgentInput, validateAgentInput } from "./Agent";
import type { AgentStore } from "./AgentStore";
import type { RunResult, RunSpec, RunHandle } from "./ClaudeRunner";
import type { ConversationForker } from "./ConversationForker";

export type CreationMode = "fork" | "fork-compact" | "distill-briefing" | "distill-skill";

const DEFAULT_BUDGET_USD = 2;
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

/** `cancelAll`, when present, also cancels runs other users of the same runner (the forker) started. */
interface Runner { run(spec: RunSpec): RunHandle; cancelAll?(): void }

export interface AgentServiceDeps {
  store: AgentStore;
  forker: Pick<ConversationForker, "fork" | "distill">;
  runner: Runner;
  sessions: Pick<SessionManager, "create" | "get" | "all">;
  isDir: (p: string) => boolean;
}

export function adoptionPrompt(name: string, specialty: string): string {
  return `From now on you are the ${name} agent: ${specialty}. Reply only OK.`;
}

/** Creating, copying, opening and running named agents. Runs on one conversation never overlap. */
export class AgentService {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly handles = new Set<RunHandle>();
  /** Bumped by cancelAll(); jobs queued before the bump do not spawn. */
  private epoch = 0;

  constructor(private readonly d: AgentServiceDeps) {}

  list(): Agent[] { return this.d.store.list(); }

  get(id: string): Agent {
    const a = this.d.store.get(id);
    if (!a) throw new HttpError(404, "agent not found");
    return a;
  }

  createBlank(input: unknown): Agent {
    return this.d.store.add(input as AgentInput, { kind: "blank" }, "");
  }

  /** No "session" origin kind exists, so a bound session is recorded as blank. */
  createFromSession(o: { sessionId: number; name: string; specialty: string }): Agent {
    const s = this.d.sessions.get(o.sessionId);
    if (!s) throw new HttpError(404, "session not found");
    if (!s.claudeSessionId) throw new HttpError(409, "this session has no linked Claude conversation");
    return this.d.store.add({ ...blankInput(), name: o.name, specialty: o.specialty, cwd: s.cwd }, { kind: "blank" }, s.claudeSessionId);
  }

  async createFromConversation(o: {
    name: string; specialty: string; sourceConversationId: string; cwd: string; mode: CreationMode; overwrite?: boolean;
  }): Promise<Agent> {
    const sourceId = o.sourceConversationId;
    if (typeof sourceId !== "string" || !sourceId) throw new HttpError(400, "sourceConversationId is required");
    safeId(sourceId, "sourceConversationId has unexpected characters");
    const base = validateAgentInput({ ...blankInput(), name: o.name, specialty: o.specialty, cwd: o.cwd }, { isDir: this.d.isDir });
    this.assertNameFree(base.name);

    if (o.mode === "fork" || o.mode === "fork-compact") {
      const compact = o.mode === "fork-compact";
      const f = await this.d.forker.fork({ sourceId, cwd: base.cwd, adoptionPrompt: adoptionPrompt(base.name, base.specialty), compact });
      return this.d.store.add(base, { kind: "fork", sourceConversationId: sourceId, compacted: compact }, f.conversationId);
    }
    if (o.mode === "distill-briefing" || o.mode === "distill-skill") {
      const artifact = o.mode === "distill-briefing" ? "briefing" : "skill";
      const overwrite = o.overwrite === true;
      const existed = (p: string): boolean => { try { fs.lstatSync(p); return true; } catch { return false; } };
      const r = await this.d.forker.distill({ sourceId, cwd: base.cwd, name: base.name, specialty: base.specialty, artifact, overwrite });
      try {
        return this.d.store.add(
          { ...base, briefingFile: artifact === "briefing" ? r.artifactPath : "" },
          { kind: "distilled", sourceConversationId: sourceId, artifact }, "");
      } catch (e) {
        if (!overwrite && existed(r.artifactPath)) { try { fs.rmSync(r.artifactPath, { force: true }); } catch {} }
        throw e;
      }
    }
    throw new HttpError(400, "mode is not valid");
  }

  async duplicate(id: string, o: { compact?: boolean } = {}): Promise<Agent> {
    const src = this.get(id);
    const name = this.d.store.uniqueName(src.name);
    const copy: AgentInput = {
      name, specialty: src.specialty, cwd: src.cwd, instructions: src.instructions, briefingFile: src.briefingFile,
      addDirs: [...src.addDirs], mcpConfig: src.mcpConfig, model: src.model, permission: { mode: src.permission.mode, allowedTools: [...src.permission.allowedTools] },
    };
    validateAgentInput(copy, { isDir: this.d.isDir });
    let conversationId = "";
    if (src.conversationId) {
      const f = await this.d.forker.fork({
        sourceId: src.conversationId, cwd: src.cwd, adoptionPrompt: adoptionPrompt(name, src.specialty), compact: o.compact === true,
      });
      conversationId = f.conversationId;
    }
    return this.d.store.add(copy, { kind: "duplicate", sourceAgentId: src.id }, conversationId);
  }

  update(id: string, patch: Partial<Omit<Agent, "id" | "created">>): Agent { return this.d.store.update(id, patch); }

  /** Removes the agent record only; its conversation, briefing and skill files stay. */
  remove(id: string): void { this.d.store.remove(id); }

  openTerminal(id: string): Session {
    const a = this.get(id);
    if (!this.d.isDir(a.cwd)) throw new HttpError(409, "the agent's folder no longer exists");
    // An agent with no conversation yet gets one now, so the terminal's conversation is the one headless runs resume later.
    const fresh = !a.conversationId;
    const convId = fresh ? crypto.randomUUID() : safeId(a.conversationId, "conversation id has unexpected characters");
    const briefing = this.briefingFlag(a);
    const cmd = `claude ${fresh ? "--session-id" : "--resume"} ${convId}${briefing}`;
    const s = this.d.sessions.create({ cwd: a.cwd, name: a.name, runCommand: cmd });
    if (fresh) this.d.store.update(id, { conversationId: convId });
    return s;
  }

  /** ` --append-system-prompt-file <relative path>` when the briefing exists inside the agent's folder and is a plain path; else "". */
  private briefingFlag(a: Agent): string {
    if (!a.briefingFile) return "";
    const root = path.resolve(a.cwd), abs = path.resolve(root, a.briefingFile), rel = path.relative(root, abs);
    if (!rel || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return "";
    const fwd = rel.split(path.sep).join("/");
    if (!/^[A-Za-z0-9_./-]+$/.test(fwd)) return "";
    try { if (!fs.statSync(abs).isFile()) return ""; } catch { return ""; }
    return ` --append-system-prompt-file ${fwd}`;
  }

  forkConversationTerminal(conversationId: string, cwd: string): Session {
    if (!this.d.isDir(cwd)) throw new HttpError(400, "cwd is not an existing folder");
    return this.d.sessions.create({ cwd, name: "", runCommand: `claude --resume ${safeId(conversationId)} --fork-session` });
  }

  async run(id: string, prompt: string, overrides: Partial<RunSpec> = {}): Promise<RunResult> {
    const first = this.get(id);
    if (typeof prompt !== "string" || !prompt.trim()) throw new HttpError(400, "prompt is required");
    if (!this.d.isDir(first.cwd)) throw new HttpError(409, `the agent's folder no longer exists: ${first.cwd}`);
    const epoch = this.epoch;
    // One writer per agent (outer chain, fixed key) and per conversation (inner chain, key resolved when the job starts,
    // so a conversation bound by an earlier run is still honoured).
    return await this.enqueue(`agent:${first.id}`, async () => {
      const cur = this.get(id);
      const exec = (): Promise<RunResult> => this.execute(id, prompt, overrides, epoch);
      return cur.conversationId ? this.enqueue(cur.conversationId, exec) : exec();
    });
  }

  private async execute(id: string, prompt: string, overrides: Partial<RunSpec>, epoch: number): Promise<RunResult> {
    if (epoch !== this.epoch) {
      return { status: "cancelled", conversationId: "", text: "", costUsd: 0, numTurns: 0, durationMs: 0, exitCode: null, error: "Cancelled before it started" };
    }
    const a = this.get(id);
    if (!this.d.isDir(a.cwd)) throw new HttpError(409, `the agent's folder no longer exists: ${a.cwd}`);
    if (a.conversationId && this.inUse(a.conversationId)) {
      throw new HttpError(409, "the conversation is open in a running terminal session; close it or wait before running the agent");
    }
    const handle = this.d.runner.run({
      cwd: a.cwd, prompt, resume: a.conversationId || undefined, permission: a.permission,
      model: a.model, instructions: a.instructions, briefingFile: a.briefingFile, addDirs: a.addDirs, mcpConfig: a.mcpConfig,
      maxBudgetUsd: overrides.maxBudgetUsd ?? DEFAULT_BUDGET_USD,
      timeoutMs: overrides.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      logPath: overrides.logPath,
    });
    this.handles.add(handle);
    let r: RunResult;
    try { r = await handle.done; } finally { this.handles.delete(handle); }
    try {
      // A successful run decides the agent's conversation (a resumed run may come back on a new id); failed or cancelled ones never do.
      const bind = r.status === "succeeded" && r.conversationId && r.conversationId !== a.conversationId;
      this.d.store.update(id, { lastRunAt: Date.now(), ...(bind ? { conversationId: r.conversationId } : {}) });
    } catch {}   // the agent may have been removed while it ran
    return r;
  }

  /** Runs queued or running. */
  pendingRuns(): number { return this.chains.size; }

  cancelAll(): void { this.epoch++; for (const h of [...this.handles]) h.cancel(); this.d.runner.cancelAll?.(); }

  private inUse(conversationId: string): boolean {
    return this.d.sessions.all().some((s) => s.claudeSessionId === conversationId && s.claudeRunning);
  }

  private assertNameFree(name: string): void {
    if (this.d.store.getByName(name)) throw new HttpError(409, `an agent named "${name}" already exists`);
  }

  private enqueue<T>(key: string, job: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const result = prev.then(job);
    const tail = result.then(() => {}, () => {});
    this.chains.set(key, tail);
    void tail.then(() => { if (this.chains.get(key) === tail) this.chains.delete(key); });
    return result;
  }
}

function blankInput(): Omit<AgentInput, "name" | "specialty" | "cwd"> {
  return { instructions: "", briefingFile: "", addDirs: [], mcpConfig: "", model: "", permission: { mode: "acceptEdits", allowedTools: [] } };
}
