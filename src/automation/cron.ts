/**
 * 5-field cron expressions evaluated in an IANA timezone.
 *
 *   minute hour day-of-month month day-of-week
 *   *  1,5  1-5  asterisk-slash-15  3-30/5  (day-of-week 0-7, 0 and 7 = Sunday)
 *
 * Like classic cron, when both day-of-month and day-of-week are restricted a day matches if either does.
 */
import { HttpError } from "../core/HttpError";

export interface CronField {
  values: Set<number>;
  /** The field was a bare `*`. */
  any: boolean;
  /** The source contained a `*` (so `*` or a star-step): the field is a rhythm, not a fixed time of day. */
  wild: boolean;
}

export interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dom: CronField;
  month: CronField;
  dow: CronField;
}

interface FieldSpec { name: string; min: number; max: number }

const FIELDS: FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "dom", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "dow", min: 0, max: 7 },
];

const bad = (message: string): never => { throw new HttpError(400, message); };

function parseField(src: string, { name, min, max }: FieldSpec): CronField {
  const values = new Set<number>();
  for (const part of src.split(",")) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) return bad(`Bad ${name} field: "${src}"`);
    let lo = min, hi = max;
    if (m[1] !== "*") {
      const [a, b] = m[1].split("-").map(Number);
      lo = a;
      hi = b === undefined ? (m[2] ? max : a) : b;
    }
    const step = m[2] ? Number(m[2]) : 1;
    if (lo < min || hi > max || lo > hi || step < 1) return bad(`Out of range ${name} field: "${src}"`);
    for (let v = lo; v <= hi; v += step) values.add(name === "dow" && v === 7 ? 0 : v);
  }
  return { values, any: src === "*", wild: src.includes("*") };
}

export function parseCron(expr: string): ParsedCron {
  const parts = (typeof expr === "string" ? expr : "").trim().split(/\s+/);
  if (parts.length !== 5) return bad("Cron needs 5 fields: minute hour day month weekday");
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i]));
  return { minute, hour, dom, month, dow };
}

interface Wall { year: number; month: number; day: number; hour: number; minute: number; dow: number }

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const formatters = new Map<string, Intl.DateTimeFormat>();

function wallClock(ts: number, tz: string): Wall {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", weekday: "short",
      year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
    });
    formatters.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const { type, value } of f.formatToParts(new Date(ts))) p[type] = value;
  return {
    year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute,
    dow: WEEKDAYS.indexOf(p.weekday),
  };
}

function dayMatches(c: ParsedCron, w: { month: number; day: number; dow: number }): boolean {
  if (!c.month.values.has(w.month)) return false;
  const domOk = c.dom.values.has(w.day), dowOk = c.dow.values.has(w.dow);
  if (c.dom.any && c.dow.any) return true;
  if (c.dom.any) return dowOk;
  if (c.dow.any) return domOk;
  return domOk || dowOk;
}

const MIN = 60_000;
const HORIZON_MS = 5 * 366 * 24 * 60 * MIN;

/** Fixed-time schedules ("30 2 * * *") are bound to the wall clock; `*` schedules ("30 * * * *") to elapsed time. */
const isFixedTime = (c: ParsedCron): boolean => !c.minute.wild && !c.hour.wild;

/** Did the wall clock jump forward (spring-forward) into `w`, skipping a minute that matches `c`? */
function skippedMatch(c: ParsedCron, prev: Wall, w: Wall): boolean {
  const mod = (x: Wall) => x.hour * 60 + x.minute;
  const jump = (mod(w) - mod(prev) + 1440) % 1440;
  if (jump <= 1 || jump > 720) return false; // no gap (or the clock went backwards)
  for (let k = 1; k < jump; k++) {
    const m = mod(prev) + k;
    const wrapped = m >= 1440; // the gap crossed midnight: those minutes belong to `w`'s date
    const hour = Math.floor((m % 1440) / 60), minute = m % 60;
    if (c.hour.values.has(hour) && c.minute.values.has(minute) && dayMatches(c, wrapped ? w : prev)) return true;
  }
  return false;
}

/** Is `t` a repeat of a wall-clock minute already seen shortly before (the second pass through a fall-back hour)? */
function isRepeatedWallTime(t: number, w: Wall, tz: string): boolean {
  for (const back of [30, 60, 120]) {
    const e = wallClock(t - back * MIN, tz);
    if (e.day === w.day && e.hour === w.hour && e.minute === w.minute && e.month === w.month) return true;
  }
  return false;
}

/**
 * First matching minute strictly after `afterMs` (epoch ms), or null within ~5 years.
 *
 * DST (same convention as Vixie cron): a fixed-time job whose local time does not exist (02:30 on the spring-forward day)
 * fires once, at the first instant after the gap; one whose local time happens twice (01:30 on the fall-back day) fires
 * only at the first occurrence. `*` schedules just follow the wall clock (skip the missing hour, repeat in the doubled one).
 */
export function nextCronTime(expr: string, tz: string, afterMs: number): number | null {
  const c = parseCron(expr);
  const zone = tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!isValidTimeZone(zone)) return bad(`Unknown timezone: "${tz}"`);
  if (!Number.isFinite(afterMs)) return bad("Bad start time");
  const fixed = isFixedTime(c);
  let t = Math.floor(afterMs / MIN) * MIN + MIN;
  const limit = afterMs + HORIZON_MS;
  while (t < limit) {
    const w = wallClock(t, zone);
    if (fixed && skippedMatch(c, wallClock(t - MIN, zone), w)) return t;
    // Skip ahead in big steps while whole days/hours can't match. Steps are computed from the wall clock,
    // so DST shifts just cost an extra loop (and the gap check above still sees the minute before `t`).
    if (!dayMatches(c, w)) { t += ((23 - w.hour) * 60 + (60 - w.minute)) * MIN; continue; }
    if (!c.hour.values.has(w.hour)) { t += (60 - w.minute) * MIN; continue; }
    if (!c.minute.values.has(w.minute)) { t += MIN; continue; }
    if (fixed && isRepeatedWallTime(t, w, zone)) { t += MIN; continue; }
    return t;
  }
  return null;
}

/** Friendly presets the UI offers; each is just a cron string. */
export const PRESETS: Record<"hourly" | "daily" | "weekdays" | "weekly", string> = {
  hourly: "0 * * * *",
  daily: "0 9 * * *",
  weekdays: "0 9 * * 1-5",
  weekly: "0 9 * * 1",
};

export function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

/**
 * Smallest possible gap, in minutes, between two firings (UTC, so DST never shortens it). Scans one week of firings;
 * if that week holds fewer than two (e.g. monthly), uses the first two firings after it.
 */
export function minGapMinutes(expr: string): number {
  parseCron(expr);
  const start = Date.UTC(2026, 0, 1);
  const weekEnd = start + 7 * 24 * 60 * MIN;
  let best = Infinity, prev: number | null = null, count = 0;
  for (let t = nextCronTime(expr, "UTC", start - 1); t !== null; t = nextCronTime(expr, "UTC", t)) {
    if (prev !== null) best = Math.min(best, (t - prev) / MIN);
    prev = t; count++;
    if (best === 1 || (t >= weekEnd && count >= 2)) break;
  }
  return Number.isFinite(best) ? best : 7 * 24 * 60;
}
