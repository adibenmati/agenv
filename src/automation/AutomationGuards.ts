import type { AutomationSettings } from "./AutomationSettings";
import type { Routine } from "./Routine";
import type { RunStore, RunTrigger } from "./RunStore";

export type GuardResult = { ok: true } | { ok: false; reason: string };

/** Midnight (machine-local) of the calendar day containing `ms`. */
export function localDayStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export interface AutomationGuardsOptions {
  settings: Pick<AutomationSettings, "get">;
  runs: Pick<RunStore, "countSince" | "costSince">;
  now?: () => number;
  /** Start of "today" for an instant; defaults to local midnight. Injectable for tests. */
  dayStart?: (ms: number) => number;
}

/**
 * Runaway protection, checked before anything is spawned and for every trigger (schedule, manual, catch-up):
 * the global pause, the routine's runs/day and the global daily cost cap.
 */
export class AutomationGuards {
  private readonly settings: Pick<AutomationSettings, "get">;
  private readonly runs: Pick<RunStore, "countSince" | "costSince">;
  private readonly now: () => number;
  private readonly dayStart: (ms: number) => number;

  constructor(o: AutomationGuardsOptions) {
    this.settings = o.settings;
    this.runs = o.runs;
    this.now = o.now ?? Date.now;
    this.dayStart = o.dayStart ?? localDayStart;
  }

  /**
   * `reservedUsd` is budget already promised to other running runs (their maxBudgetUsd): their cost is not recorded
   * until they finish, so the cap is compared against spent + reserved.
   */
  check(routine: Routine, _trigger: RunTrigger, opts: { reservedUsd?: number } = {}): GuardResult {
    const s = this.settings.get();
    if (s.paused) return { ok: false, reason: "automation paused" };
    const since = this.dayStart(this.now());
    if (routine.maxRunsPerDay !== null && this.runs.countSince(routine.id, since) >= routine.maxRunsPerDay) {
      return { ok: false, reason: `daily run limit reached (${routine.maxRunsPerDay})` };
    }
    // 0 is a real cap that blocks everything, so this must be a null test, not a truthiness test.
    if (s.maxDailyCostUsd !== null && this.runs.costSince(since) + (opts.reservedUsd ?? 0) >= s.maxDailyCostUsd) {
      return { ok: false, reason: `daily cost cap reached ($${s.maxDailyCostUsd})` };
    }
    return { ok: true };
  }
}
