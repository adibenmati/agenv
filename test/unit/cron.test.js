// test/unit/cron.test.js — 5-field cron in an IANA timezone: parsing, matching, DST edges, minimum gap
"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { parseCron, nextCronTime, minGapMinutes, PRESETS, isValidTimeZone } = require("../../dist/automation/cron");
const { HttpError } = require("../../dist/core/HttpError");

const NY = "America/New_York";
const iso = (ms) => new Date(ms).toISOString();
const utc = (s) => Date.parse(s);
/** Wall clock {date:"YYYY-MM-DD", time:"HH:MM"} of an instant in a zone. */
function local(ms, tz) {
  const p = {};
  for (const { type, value } of new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(ms))) p[type] = value;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
/** All firings of `expr` in [from, to) (epoch ms). */
function fires(expr, tz, from, to) {
  const out = [];
  for (let t = nextCronTime(expr, tz, from - 1); t != null && t < to; t = nextCronTime(expr, tz, t)) out.push(t);
  return out;
}
const isBad = (fn) => assert.throws(fn, (e) => e instanceof HttpError && e.status === 400);

describe("parseCron", () => {
  it("parses */15 and ranges and lists", () => {
    const c = parseCron("*/15 9-11 1,15 */6 1-5");
    assert.deepEqual([...c.minute.values], [0, 15, 30, 45]);
    assert.deepEqual([...c.hour.values], [9, 10, 11]);
    assert.deepEqual([...c.dom.values], [1, 15]);
    assert.deepEqual([...c.month.values], [1, 7]);
    assert.deepEqual([...c.dow.values], [1, 2, 3, 4, 5]);
    assert.deepEqual([...parseCron("3-30/10 * * * *").minute.values], [3, 13, 23]);
    assert.equal(parseCron("* * * * *").minute.any, true);
  });

  it("rejects 6 fields, out-of-range, empty, and garbage (400)", () => {
    for (const bad of ["* * * * * *", "* * * *", "", "   ", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * 32 * *",
      "* * * 13 *", "* * * * 8", "5-2 * * * *", "*/0 * * * *", "a b c d e", "1,,2 * * * *", "-5 * * * *", "1- * * * *"]) {
      isBad(() => parseCron(bad));
    }
    isBad(() => parseCron(undefined));
    isBad(() => parseCron(null));
    isBad(() => parseCron(42));
  });

  it("7 means Sunday", () => {
    assert.deepEqual([...parseCron("0 0 * * 7").dow.values], [0]);
    assert.deepEqual([...parseCron("0 0 * * 5-7").dow.values].sort(), [0, 5, 6]);
    // 2026-10-18 is a Sunday
    assert.equal(iso(nextCronTime("0 0 * * 7", "UTC", utc("2026-10-17T00:00:00Z"))), "2026-10-18T00:00:00.000Z");
    assert.equal(nextCronTime("0 0 * * 7", "UTC", utc("2026-10-17T00:00:00Z")), nextCronTime("0 0 * * 0", "UTC", utc("2026-10-17T00:00:00Z")));
  });
});

describe("nextCronTime", () => {
  it("next fire is strictly after the given time", () => {
    const at = utc("2026-10-17T09:00:00Z");
    assert.equal(iso(nextCronTime("0 9 * * *", "UTC", at)), "2026-10-18T09:00:00.000Z");
    assert.equal(iso(nextCronTime("0 9 * * *", "UTC", at - 1)), "2026-10-17T09:00:00.000Z");
    assert.equal(iso(nextCronTime("*/15 * * * *", "UTC", utc("2026-10-17T09:07:30Z"))), "2026-10-17T09:15:00.000Z");
    assert.equal(iso(nextCronTime("* * * * *", "UTC", at)), "2026-10-17T09:01:00.000Z");
  });

  it("day-of-month and day-of-week both restricted match either", () => {
    // 2026-10-13 is a Tuesday. "the 15th OR any Monday": Mon 10-19 comes after Thu 10-15 -> 15th first.
    const after = utc("2026-10-13T12:00:00Z");
    const hits = fires("0 0 15 * 1", "UTC", after, utc("2026-10-21T00:00:00Z")).map(iso);
    assert.deepEqual(hits, ["2026-10-15T00:00:00.000Z", "2026-10-19T00:00:00.000Z"]);
    // only dom restricted -> dow ignored; only dow restricted -> dom ignored
    assert.deepEqual(fires("0 0 15 * *", "UTC", after, utc("2026-10-21T00:00:00Z")).map(iso), ["2026-10-15T00:00:00.000Z"]);
    assert.deepEqual(fires("0 0 * * 1", "UTC", after, utc("2026-10-21T00:00:00Z")).map(iso), ["2026-10-19T00:00:00.000Z"]);
  });

  it("is evaluated in the given zone", () => {
    // 09:00 in Tokyo (UTC+9, no DST) is 00:00Z
    assert.equal(iso(nextCronTime("0 9 * * *", "Asia/Tokyo", utc("2026-10-17T00:00:00Z"))), "2026-10-18T00:00:00.000Z");
  });

  it("returns null when nothing matches within 5 years", () => {
    assert.equal(nextCronTime("0 0 31 2 *", "UTC", utc("2026-01-01T00:00:00Z")), null);
  });

  it("finds Feb 29 within the 5-year horizon", () => {
    assert.equal(iso(nextCronTime("0 0 29 2 *", "UTC", utc("2026-10-17T00:00:00Z"))), "2028-02-29T00:00:00.000Z");
  });

  it("rejects an unknown timezone (400)", () => {
    isBad(() => nextCronTime("0 9 * * *", "Mars/Base", Date.now()));
  });
});

describe("daylight saving", () => {
  it("Asia/Jerusalem 09:00 daily across the 2026-03-27 DST jump keeps 09:00 local", () => {
    const tz = "Asia/Jerusalem";
    const hits = fires("0 9 * * *", tz, utc("2026-03-24T00:00:00Z"), utc("2026-03-31T00:00:00Z"));
    assert.equal(hits.length, 7);
    for (const h of hits) assert.equal(local(h, tz).time, "09:00");
    assert.deepEqual(hits.map((h) => local(h, tz).date), ["2026-03-24", "2026-03-25", "2026-03-26", "2026-03-27", "2026-03-28", "2026-03-29", "2026-03-30"]);
    // the day before is UTC+2 (07:00Z), the day after UTC+3 (06:00Z)
    assert.equal(iso(hits[2]), "2026-03-26T07:00:00.000Z");
    assert.equal(iso(hits[3]), "2026-03-27T06:00:00.000Z");
  });

  it("America/New_York 02:30 on 2026-03-08 (nonexistent) fires once that day, at the first instant after the gap", () => {
    // 02:00-02:59 does not exist; the job runs when the gap ends (03:00 EDT = 07:00Z), like Vixie cron.
    const day = fires("30 2 * * *", NY, utc("2026-03-08T00:00:00-05:00"), utc("2026-03-09T00:00:00-04:00"));
    assert.deepEqual(day.map(iso), ["2026-03-08T07:00:00.000Z"]);
    assert.deepEqual(local(day[0], NY), { date: "2026-03-08", time: "03:00" });
    // neighbouring days are unaffected: 02:30 EST on the 7th, 02:30 EDT on the 9th
    assert.equal(iso(nextCronTime("30 2 * * *", NY, utc("2026-03-07T00:00:00Z"))), "2026-03-07T07:30:00.000Z");
    assert.equal(iso(nextCronTime("30 2 * * *", NY, day[0])), "2026-03-09T06:30:00.000Z");
  });

  it("a fixed time just after the gap still fires once, not twice", () => {
    const day = fires("0 3 * * *", NY, utc("2026-03-08T00:00:00-05:00"), utc("2026-03-09T00:00:00-04:00"));
    assert.deepEqual(day.map(iso), ["2026-03-08T07:00:00.000Z"]);
  });

  it("wildcard schedules skip the missing hour instead of bunching up", () => {
    const hits = fires("30 * * * *", NY, utc("2026-03-08T05:00:00Z"), utc("2026-03-08T09:00:00Z")).map(iso);
    assert.deepEqual(hits, ["2026-03-08T05:30:00.000Z", "2026-03-08T06:30:00.000Z", "2026-03-08T07:30:00.000Z", "2026-03-08T08:30:00.000Z"]);
  });

  it("America/New_York 01:30 on 2026-11-01 (ambiguous) fires exactly once, at the first occurrence", () => {
    const day = fires("30 1 * * *", NY, utc("2026-11-01T00:00:00-04:00"), utc("2026-11-02T00:00:00-05:00"));
    assert.deepEqual(day.map(iso), ["2026-11-01T05:30:00.000Z"]); // 01:30 EDT, not 01:30 EST (06:30Z)
    assert.equal(iso(nextCronTime("30 1 * * *", NY, day[0])), "2026-11-02T06:30:00.000Z");
  });

  it("wildcard-hour schedules still run in the repeated hour", () => {
    const hits = fires("30 * * * *", NY, utc("2026-11-01T04:00:00Z"), utc("2026-11-01T08:00:00Z")).map(iso);
    assert.deepEqual(hits, ["2026-11-01T04:30:00.000Z", "2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z", "2026-11-01T07:30:00.000Z"]);
  });
});

describe("isValidTimeZone / PRESETS", () => {
  it('isValidTimeZone rejects "Mars/Base"', () => {
    assert.equal(isValidTimeZone("Mars/Base"), false);
    assert.equal(isValidTimeZone(""), false);
    assert.equal(isValidTimeZone("UTC"), true);
    assert.equal(isValidTimeZone("Asia/Jerusalem"), true);
  });

  it("PRESETS values parse", () => {
    assert.deepEqual(Object.keys(PRESETS).sort(), ["daily", "hourly", "weekdays", "weekly"]);
    for (const expr of Object.values(PRESETS)) assert.doesNotThrow(() => parseCron(expr));
    assert.equal(PRESETS.daily, "0 9 * * *");
    assert.equal(PRESETS.weekly, "0 9 * * 1");
  });
});

describe("minGapMinutes", () => {
  it("is the smallest gap between firings", () => {
    assert.equal(minGapMinutes("*/15 * * * *"), 15);
    assert.equal(minGapMinutes("0 * * * *"), 60);
    assert.equal(minGapMinutes("0 9 * * 1-5"), 1440);
    assert.equal(minGapMinutes("* * * * *"), 1);
    assert.equal(minGapMinutes("0,5 * * * *"), 5);
    assert.equal(minGapMinutes("0 9 * * 1"), 10080);
  });

  it("sees a short gap that only occurs on some days", () => {
    assert.equal(minGapMinutes("0,10 9 * * 1"), 10);
  });

  it("falls back to the first two firings when a week holds fewer than two", () => {
    const monthly = minGapMinutes("0 0 1 * *");
    assert.ok(monthly >= 28 * 1440 && monthly <= 31 * 1440, `got ${monthly}`);
  });

  it("rejects a bad expression (400)", () => {
    isBad(() => minGapMinutes("nope"));
  });
});
