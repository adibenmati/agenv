import * as crypto from "crypto";
import { HttpError } from "../core/HttpError";
import type { JsonStore } from "../core/JsonStore";
import { Routine, RoutineInput, validateRoutineInput } from "./Routine";

const isTime = (v: unknown): v is number | null => v === null || (typeof v === "number" && Number.isFinite(v));

/** Routines (~/.agenv-routines.enc). Every mutation is persisted. */
export class RoutineStore {
  constructor(
    private readonly store: JsonStore<Routine[]>,
    private readonly isDir: (p: string) => boolean,
    private readonly agentExists: (id: string) => boolean,
  ) {}

  list(): Routine[] {
    const r = this.store.load();
    return Array.isArray(r) ? r : [];
  }

  get(id: string): Routine | undefined { return this.list().find((r) => r.id === id); }

  /** `nextRunAt` is computed by the caller (the scheduler owns the clock). */
  add(input: RoutineInput, nextRunAt: number | null): Routine {
    const v = validateRoutineInput(input, { isDir: this.isDir, agentExists: this.agentExists, now: Date.now() });
    if (!isTime(nextRunAt)) throw new HttpError(400, "nextRunAt must be a number or null");
    const routines = this.list();
    const now = Date.now();
    const routine: Routine = { ...v, id: this.newId(routines), nextRunAt, lastRunAt: null, created: now, updated: now };
    routines.push(routine);
    this.store.save(routines);
    return routine;
  }

  /**
   * Patch of editable fields and/or schedule bookkeeping (nextRunAt, lastRunAt). Only the supplied fields are
   * re-validated; the target (folder / agent) is only checked when the patch changes it, so recording a run never
   * depends on the folder or agent still existing. `id`, `created` and `updated` in a patch are ignored.
   *
   * The store does not own the clock, so it cannot compute `nextRunAt`; instead it enforces the contract: a patch that
   * changes `cron`/`timezone` or turns `enabled` on must carry a finite `nextRunAt` (else 400).
   * `allowBypass` is never inherited when the patch supplies `permission`: the bypass acknowledgement has to come
   * with the same request that sets the mode.
   */
  update(id: string, patch: Partial<Omit<Routine, "id" | "created">>): Routine {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new HttpError(400, "patch must be an object");
    const routines = this.list();
    const cur = routines.find((r) => r.id === id);
    if (!cur) throw new HttpError(404, "routine not found");
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<Routine>;
    const { nextRunAt, lastRunAt, id: _id, created: _created, updated: _updated, ...editable } = defined;
    if (nextRunAt !== undefined && !isTime(nextRunAt)) throw new HttpError(400, "nextRunAt must be a number or null");
    if (lastRunAt !== undefined && !isTime(lastRunAt)) throw new HttpError(400, "lastRunAt must be a number or null");
    for (const [k, v] of Object.entries(editable)) {
      if (v === null && k !== "maxRunsPerDay") throw new HttpError(400, `${k} must not be null`);
    }
    if (Object.keys(editable).length) {
      const merged: Record<string, unknown> = { ...cur, ...editable };
      if ("permission" in editable) merged.allowBypass = editable.allowBypass; // never inherited from the stored record
      if ("target" in editable && !("conversation" in editable)) {
        const kind = (editable.target as { kind?: unknown } | undefined)?.kind;
        if (kind === "folder") merged.conversation = "fresh";
        else if (kind === "agent" && cur.target.kind === "folder") merged.conversation = "agent";
      }
      const supplied = "target" in editable;
      const v = validateRoutineInput(merged, {
        isDir: supplied ? this.isDir : () => true,
        agentExists: supplied ? this.agentExists : () => true,
        now: Date.now(),
      });
      const scheduleChanged = v.cron !== cur.cron || v.timezone !== cur.timezone || (v.enabled && !cur.enabled);
      if (scheduleChanged && !(typeof nextRunAt === "number" && Number.isFinite(nextRunAt))) {
        throw new HttpError(400, "nextRunAt must be supplied when the schedule changes");
      }
      Object.assign(cur, v, { updated: Date.now() });
    }
    if (nextRunAt !== undefined) cur.nextRunAt = nextRunAt;
    if (lastRunAt !== undefined) cur.lastRunAt = lastRunAt;
    this.store.save(routines);
    return cur;
  }

  /** Records a claim / completion without touching any other field (not even `updated`). */
  setSchedule(id: string, s: { nextRunAt: number | null; lastRunAt?: number | null }): Routine {
    if (!isTime(s.nextRunAt)) throw new HttpError(400, "nextRunAt must be a number or null");
    if (s.lastRunAt !== undefined && !isTime(s.lastRunAt)) throw new HttpError(400, "lastRunAt must be a number or null");
    const routines = this.list();
    const cur = routines.find((r) => r.id === id);
    if (!cur) throw new HttpError(404, "routine not found");
    cur.nextRunAt = s.nextRunAt;
    if (s.lastRunAt !== undefined) cur.lastRunAt = s.lastRunAt;
    this.store.save(routines);
    return cur;
  }

  remove(id: string): void {
    const routines = this.list();
    const i = routines.findIndex((r) => r.id === id);
    if (i < 0) throw new HttpError(404, "routine not found");
    routines.splice(i, 1);
    this.store.save(routines);
  }

  private newId(routines: Routine[]): string {
    for (;;) {
      const id = crypto.randomBytes(4).toString("hex");
      if (!routines.some((r) => r.id === id)) return id;
    }
  }
}
