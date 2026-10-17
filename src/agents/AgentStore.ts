import * as crypto from "crypto";
import { HttpError } from "../core/HttpError";
import type { JsonStore } from "../core/JsonStore";
import { Agent, AgentInput, AgentOrigin, isSafeId, validateAgentInput, validateOrigin } from "./Agent";

/** Named agents (~/.agenv-agents.enc). Names are unique case-insensitively; every mutation is persisted. */
export class AgentStore {
  constructor(private readonly store: JsonStore<Agent[]>, private readonly isDir: (p: string) => boolean) {}

  list(): Agent[] {
    const a = this.store.load();
    return Array.isArray(a) ? a : [];
  }

  get(id: string): Agent | undefined { return this.list().find((a) => a.id === id); }

  getByName(name: string): Agent | undefined {
    const n = String(name).toLowerCase();
    return this.list().find((a) => a.name.toLowerCase() === n);
  }

  add(input: AgentInput, origin: AgentOrigin, conversationId = ""): Agent {
    const v = validateAgentInput(input, { isDir: this.isDir });
    if (typeof conversationId !== "string" || (conversationId && !isSafeId(conversationId))) throw new HttpError(400, "conversationId has unexpected characters");
    const agents = this.list();
    this.assertNameFree(agents, v.name);
    const now = Date.now();
    const agent: Agent = { ...v, id: this.newId(agents), conversationId, origin, created: now, updated: now, lastRunAt: null };
    agents.push(agent);
    this.store.save(agents);
    return agent;
  }

  /** Patch of editable fields and/or run bookkeeping (conversationId, lastRunAt). */
  update(id: string, patch: Partial<Omit<Agent, "id" | "created">>): Agent {
    const agents = this.list();
    const cur = agents.find((a) => a.id === id);
    if (!cur) throw new HttpError(404, "agent not found");
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<Agent>;
    const { conversationId, lastRunAt, origin, ...editable } = defined;
    if (conversationId !== undefined && typeof conversationId !== "string") throw new HttpError(400, "conversationId must be a string");
    if (conversationId && !isSafeId(conversationId)) throw new HttpError(400, "conversationId has unexpected characters");
    if (lastRunAt !== undefined && lastRunAt !== null && !(typeof lastRunAt === "number" && Number.isFinite(lastRunAt))) throw new HttpError(400, "lastRunAt must be a number or null");
    if (origin !== undefined) validateOrigin(origin);
    if (Object.keys(editable).length) {
      // The folder is only checked when the patch changes it, so recording a run never depends on the folder still existing.
      const v = validateAgentInput({ ...cur, ...editable }, { isDir: "cwd" in editable ? this.isDir : () => true });
      this.assertNameFree(agents, v.name, id);
      Object.assign(cur, v, { updated: Date.now() });
    }
    if (conversationId !== undefined) cur.conversationId = conversationId;
    if (lastRunAt !== undefined) cur.lastRunAt = lastRunAt;
    if (origin !== undefined) cur.origin = origin;
    this.store.save(agents);
    return cur;
  }

  remove(id: string): void {
    const agents = this.list();
    const i = agents.findIndex((a) => a.id === id);
    if (i < 0) throw new HttpError(404, "agent not found");
    agents.splice(i, 1);
    this.store.save(agents);
  }

  /** `base` if free, else `base-copy`, `base-copy-2`, ... (trimmed so the result stays within 48 chars). */
  uniqueName(base: string): string {
    const taken = new Set(this.list().map((a) => a.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 1; ; n++) {
      const suffix = n === 1 ? "-copy" : `-copy-${n}`;
      const name = base.slice(0, 48 - suffix.length) + suffix;
      if (!taken.has(name.toLowerCase())) return name;
    }
  }

  private assertNameFree(agents: Agent[], name: string, exceptId?: string): void {
    const n = name.toLowerCase();
    if (agents.some((a) => a.id !== exceptId && a.name.toLowerCase() === n)) throw new HttpError(409, `an agent named "${name}" already exists`);
  }

  private newId(agents: Agent[]): string {
    for (;;) {
      const id = crypto.randomBytes(4).toString("hex");
      if (!agents.some((a) => a.id === id)) return id;
    }
  }
}
