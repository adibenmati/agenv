import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { HttpError } from "../core/HttpError";
import { isSafeId, safeId } from "../core/ids";
import type { JsonStore } from "../core/JsonStore";

export const RUN_TRIGGERS = ["schedule", "manual", "catch_up"] as const;
export const RUN_STATUSES = ["queued", "running", "succeeded", "failed", "timed_out", "cancelled", "skipped", "coalesced"] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface Run {
  id: string;
  routineId: string;
  trigger: RunTrigger;
  status: RunStatus;
  reason: string;
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number;
  costUsd: number;
  numTurns: number;
  conversationId: string;
  exitCode: number | null;
  error: string;
  summary: string;
}

export const MAX_RUNS = 500;
export const MAX_SUMMARY = 2000;
export const MAX_REASON = 500;
/** Hard ceiling for one log read, whatever the caller asks for. */
export const MAX_LOG_READ = 1024 * 1024;
const DEFAULT_LIMIT = 50;
const MAX_ROUTINE_ID = 128;
const INTERRUPTED = "interrupted by restart";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isTime = (v: unknown): v is number | null => v === null || (isNum(v) && v >= 0);
const isActive = (r: Run) => r.status === "queued" || r.status === "running";

/**
 * Keeps at most MAX_RUNS rows by dropping the oldest FINISHED ones. Queued and running rows are never dropped (a run that is
 * still executing must keep its record), so a history made only of active runs may exceed the limit.
 */
function prune(runs: Run[]): { runs: Run[]; pruned: Run[] } {
  let excess = runs.length - MAX_RUNS;
  if (excess <= 0) return { runs, pruned: [] };
  const kept: Run[] = [], pruned: Run[] = [];
  runs.forEach((r, i) => {
    // the row just created (the last one) is never its own victim
    if (excess > 0 && !isActive(r) && i < runs.length - 1) { pruned.push(r); excess--; } else kept.push(r);
  });
  return { runs: kept, pruned };
}

function oneOf<T extends string>(list: readonly T[], v: unknown, what: string): T {
  if (typeof v !== "string" || !(list as readonly string[]).includes(v)) throw new HttpError(400, `invalid ${what}`);
  return v as T;
}

/** Non-strings are a 400; over-long text is cut to `max` (ending in an ellipsis) so a long stderr can never strand a run. */
function clipText(v: unknown, max: number, what: string): string {
  if (typeof v !== "string") throw new HttpError(400, `${what} must be a string`);
  return v.length > max ? v.slice(0, max - 1) + "…" : v;
}

/**
 * Run history (~/.agenv-runs.enc, newest 500) plus the location and bounded reading of each run's log file.
 * The parsed history is cached under the file's signature (mtime, size, inode), so repeated reads (the panel polls every
 * 2 s) do not decrypt; the cache is dropped when the file changes underneath it and replaced by the store's own saves.
 * Every mutation still re-encrypts the file (about 10 ms typical, ~80 ms with a full 500-run history).
 * Rows handed out are copies, so a caller can never corrupt the cache.
 */
export class RunStore {
  private readonly store: JsonStore<Run[]>;
  private readonly logDir: string;

  constructor(o: { store: JsonStore<Run[]>; logDir: string }) {
    this.store = o.store;
    this.logDir = o.logDir;
  }

  private cache: { sig: string; runs: Run[] } | null = null;

  /** The cached history. Read-only: callers that change rows work on `editable()` and hand the result to `write()`. */
  private all(): Run[] {
    const sig = this.signature();                       // stat BEFORE reading: a write in between only makes the next read reload
    if (sig !== null && this.cache && this.cache.sig === sig) return this.cache.runs;
    const r = this.store.load();
    const runs = Array.isArray(r) ? r : [];
    this.cache = sig === null ? null : { sig, runs };
    return runs;
  }

  private editable(): Run[] { return this.all().map((r) => ({ ...r })); }

  /** Persists `runs` (which the cache then owns) and re-keys the cache to the file as written. A failed save drops the cache. */
  private write(runs: Run[]): void {
    this.cache = null;
    this.store.save(runs);
    const sig = this.signature();
    if (sig !== null) this.cache = { sig, runs };
  }

  private signature(): string | null {
    const s = this.store as { signature?: () => string | null };
    return typeof s.signature === "function" ? s.signature() : null;
  }

  /** Statuses other than queued/running are final, so such a run is born finished (and never started). */
  create(routineId: string, trigger: RunTrigger, status: RunStatus = "queued", reason = ""): Run {
    if (typeof routineId !== "string" || !routineId || routineId.length > MAX_ROUTINE_ID) throw new HttpError(400, "invalid routineId");
    oneOf(RUN_TRIGGERS, trigger, "trigger");
    oneOf(RUN_STATUSES, status, "status");
    reason = clipText(reason, MAX_REASON, "reason");
    const runs = this.editable();
    const now = Date.now();
    const run: Run = {
      id: this.newId(runs), routineId, trigger, status, reason,
      queuedAt: now, startedAt: null, finishedAt: status === "queued" || status === "running" ? null : now,
      durationMs: 0, costUsd: 0, numTurns: 0, conversationId: "", exitCode: null, error: "", summary: "",
    };
    runs.push(run);
    const kept = prune(runs);
    this.write(kept.runs);
    for (const p of kept.pruned) this.deleteLog(p.id);
    return { ...run };
  }

  /**
   * Patch of the outcome fields. `id`, `routineId`, `queuedAt`, `trigger` and unknown keys are ignored. The whole patch
   * is validated before anything changes; `summary` is cut to 2000 characters and `reason`/`error` to 500 (ellipsis
   * included); only non-strings are a 400.
   */
  update(id: string, patch: Partial<Omit<Run, "id" | "routineId" | "queuedAt" | "trigger">>): Run {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new HttpError(400, "patch must be an object");
    const runs = this.editable();
    const cur = runs.find((r) => r.id === id);
    if (!cur) throw new HttpError(404, "run not found");
    const p = patch as Record<string, unknown>;
    const next: Partial<Run> = {};
    if (p.status !== undefined) next.status = oneOf(RUN_STATUSES, p.status, "status");
    if (p.reason !== undefined) next.reason = clipText(p.reason, MAX_REASON, "reason");
    if (p.error !== undefined) next.error = clipText(p.error, MAX_REASON, "error");
    if (p.summary !== undefined) next.summary = clipText(p.summary, Infinity, "summary").slice(0, MAX_SUMMARY);
    for (const k of ["startedAt", "finishedAt"] as const) {
      if (p[k] !== undefined) {
        if (!isTime(p[k])) throw new HttpError(400, `${k} must be a non-negative number or null`);
        next[k] = p[k] as number | null;
      }
    }
    if (p.exitCode !== undefined) {
      if (p.exitCode !== null && !(isNum(p.exitCode) && Number.isInteger(p.exitCode))) throw new HttpError(400, "exitCode must be an integer or null");
      next.exitCode = p.exitCode as number | null;
    }
    for (const k of ["durationMs", "costUsd"] as const) {
      if (p[k] !== undefined) {
        if (!isNum(p[k]) || (p[k] as number) < 0) throw new HttpError(400, `${k} must be a non-negative number`);
        next[k] = p[k] as number;
      }
    }
    if (p.numTurns !== undefined) {
      if (!isNum(p.numTurns) || !Number.isInteger(p.numTurns) || p.numTurns < 0) throw new HttpError(400, "numTurns must be a non-negative integer");
      next.numTurns = p.numTurns;
    }
    if (p.conversationId !== undefined) {
      if (p.conversationId !== "" && !isSafeId(p.conversationId)) throw new HttpError(400, "invalid conversationId");
      next.conversationId = p.conversationId as string;
    }
    Object.assign(cur, next);
    this.write(runs);
    return { ...cur };
  }

  get(id: string): Run | undefined {
    const r = this.all().find((x) => x.id === id);
    return r && { ...r };
  }

  /** Newest first. `limit` defaults to 50 and is capped at 500 (anything not a positive number means the default). */
  list(routineId?: string, limit?: number): Run[] {
    const n = isNum(limit) && limit >= 1 ? Math.min(Math.floor(limit), MAX_RUNS) : DEFAULT_LIMIT;
    const out: Run[] = [];
    const runs = this.all();
    for (let i = runs.length - 1; i >= 0 && out.length < n; i--) {
      if (routineId === undefined || runs[i].routineId === routineId) out.push({ ...runs[i] });
    }
    return out;
  }

  /** The newest run of every routine that has one, from a single pass over the history. */
  latestByRoutine(): Map<string, Run> {
    const out = new Map<string, Run>();
    for (const r of this.all()) out.set(r.routineId, r);       // oldest first, so the last write per routine is the newest
    for (const [k, v] of out) out.set(k, { ...v });
    return out;
  }

  /** Queued + running runs per routine (routines with none are absent), from one pass over the cached history. */
  activeCounts(): Map<string, number> {
    const out = new Map<string, number>();
    for (const r of this.all()) if (isActive(r)) out.set(r.routineId, (out.get(r.routineId) ?? 0) + 1);
    return out;
  }

  /** How many of the routine's runs are queued or running. */
  activeCount(routineId: string): number {
    let n = 0;
    for (const r of this.all()) if (r.routineId === routineId && isActive(r)) n++;
    return n;
  }

  costSince(sinceMs: number): number {
    let sum = 0;
    for (const r of this.all()) if (r.startedAt !== null && r.startedAt >= sinceMs) sum += r.costUsd;
    return sum;
  }

  /** Runs that actually started; skipped / coalesced firings never did. */
  countSince(routineId: string, sinceMs: number): number {
    return this.all().filter((r) => r.routineId === routineId && r.startedAt !== null && r.startedAt >= sinceMs).length;
  }

  /** Where the runner writes this run's log. Throws 400 for an id that is not a safe id. */
  logPath(id: string): string {
    return path.join(this.logDir, `${safeId(id, "invalid run id")}.log`);
  }

  /**
   * The last `tailBytes` of the log (at most 1 MB), starting on a line boundary: a window that begins mid-line drops
   * that partial line, unless no complete line fits (the runner logs one raw event per line and one can exceed the
   * window), in which case the partial line is returned minus any cut-off UTF-8 character. "" when there is no log yet. Throws 400 for an unsafe id or a non-numeric size.
   */
  readLog(id: string, tailBytes: number): string {
    const file = this.logPath(id);
    if (!isNum(tailBytes)) throw new HttpError(400, "tail must be a number");
    const want = Math.min(Math.floor(tailBytes), MAX_LOG_READ);
    if (want <= 0) return "";
    let fd: number;
    try { fd = fs.openSync(file, "r"); } catch { return ""; }
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - want);
      const len = size - start;
      if (len <= 0) return "";
      // one extra leading byte tells whether the window already begins on a line boundary
      const lead = start > 0 ? 1 : 0;
      const buf = Buffer.alloc(len + lead);
      const got = fs.readSync(fd, buf, 0, buf.length, start - lead);
      let chunk = buf.subarray(0, got);
      if (lead) {
        if (chunk[0] === 10) {
          chunk = chunk.subarray(1); // the window begins exactly on a line
        } else {
          const nl = chunk.indexOf(10, 1);
          if (nl >= 0 && nl + 1 < chunk.length) {
            chunk = chunk.subarray(nl + 1); // drop the partial first line
          } else {
            // no complete line fits (one very long line): a partial line beats nothing; skip the cut-off character
            let i = 1;
            while (i < chunk.length && (chunk[i] & 0xc0) === 0x80) i++;
            chunk = chunk.subarray(i);
          }
        }
      }
      return chunk.toString("utf8");
    } catch {
      return "";
    } finally {
      try { fs.closeSync(fd); } catch {}
    }
  }

  /** At startup: runs a dead server left queued/running can never finish. Returns how many were closed. */
  markInterrupted(): number {
    const runs = this.editable();
    const now = Date.now();
    let n = 0;
    for (const r of runs) {
      if (!isActive(r)) continue;
      r.status = "failed";
      r.reason = INTERRUPTED;
      r.error = INTERRUPTED;
      r.finishedAt = now;
      r.durationMs = r.startedAt !== null ? Math.max(0, now - r.startedAt) : 0;
      n++;
    }
    if (n) this.write(runs);
    return n;
  }

  /** The routine's queued/running run (a running one wins over a queued one). */
  active(routineId: string): Run | undefined {
    const mine = this.all().filter((r) => r.routineId === routineId && isActive(r));
    const r = mine.find((x) => x.status === "running") ?? mine[0];
    return r && { ...r };
  }

  /**
   * Deletes all runs of a routine and their log files, but only when none of them is queued/running (returns
   * { removed: 0 } and changes nothing otherwise): the caller cancels active runs first.
   */
  removeForRoutine(routineId: string): { removed: number } {
    const runs = this.all();
    const mine = runs.filter((r) => r.routineId === routineId);
    if (!mine.length || mine.some(isActive)) return { removed: 0 };
    this.write(runs.filter((r) => r.routineId !== routineId));
    for (const r of mine) this.deleteLog(r.id);
    return { removed: mine.length };
  }

  private deleteLog(id: string): void {
    if (!isSafeId(id)) return;
    try { fs.unlinkSync(path.join(this.logDir, `${id}.log`)); } catch {}
  }

  private newId(runs: Run[]): string {
    for (;;) {
      const id = crypto.randomBytes(6).toString("hex");
      if (!runs.some((r) => r.id === id)) return id;
    }
  }
}
