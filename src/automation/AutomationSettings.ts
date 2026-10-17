import { HttpError } from "../core/HttpError";
import type { JsonStore } from "../core/JsonStore";

export interface AutomationSettingsData {
  /** Global kill switch: no scheduled, manual or catch-up run starts while true. */
  paused: boolean;
  /**
   * Total cost cap per day across all routines, or null for none. 0 is a valid cap that blocks every run:
   * guards must test `!== null`, never truthiness.
   */
  maxDailyCostUsd: number | null;
}

const DEFAULTS: AutomationSettingsData = { paused: false, maxDailyCostUsd: null };

/** Global automation switches (~/.agenv-automation.enc). */
export class AutomationSettings {
  constructor(private readonly store: JsonStore<Partial<AutomationSettingsData>>) {}

  get(): AutomationSettingsData {
    const s = this.store.load();
    const o = s && typeof s === "object" ? s : {};
    return {
      paused: typeof o.paused === "boolean" ? o.paused : DEFAULTS.paused,
      maxDailyCostUsd: typeof o.maxDailyCostUsd === "number" && Number.isFinite(o.maxDailyCostUsd) && o.maxDailyCostUsd >= 0 ? o.maxDailyCostUsd : DEFAULTS.maxDailyCostUsd,
    };
  }

  /** Merges the supplied fields (undefined = unchanged, maxDailyCostUsd null = no cap). Throws 400 and changes nothing on bad input. */
  set(patch: Partial<AutomationSettingsData>): AutomationSettingsData {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new HttpError(400, "settings must be an object");
    const cur = this.get();
    if (patch.paused !== undefined) {
      if (typeof patch.paused !== "boolean") throw new HttpError(400, "paused must be true or false");
      cur.paused = patch.paused;
    }
    if (patch.maxDailyCostUsd !== undefined) {
      const c = patch.maxDailyCostUsd;
      if (c !== null && !(typeof c === "number" && Number.isFinite(c) && c >= 0)) throw new HttpError(400, "maxDailyCostUsd must be a non-negative number or null");
      cur.maxDailyCostUsd = c;
    }
    this.store.save(cur);
    return cur;
  }
}
