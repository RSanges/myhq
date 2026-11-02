import assert from "node:assert/strict";
import { test } from "node:test";
import { cronError, cronMatches, nextFire, parseCron } from "../src/server/cron";
import { addDays, dayKey, dayRange, wallTime, wallToInstants } from "../src/server/time";

const next = (expr: string, after: string, tz: string) => nextFire(parseCron(expr), new Date(after), tz)?.toISOString() ?? null;

test("parses fields, ranges, steps, lists and names", () => {
  const s = parseCron("*/15 9-17/4 1,15 jan-mar MON-fri");
  assert.deepEqual(s.minutes, [0, 15, 30, 45]);
  assert.deepEqual(s.hours, [9, 13, 17]);
  assert.deepEqual([...s.daysOfMonth].sort((a, b) => a - b), [1, 15]);
  assert.deepEqual([...s.months].sort((a, b) => a - b), [1, 2, 3]);
  assert.deepEqual([...s.daysOfWeek].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  assert.deepEqual([...parseCron("0 0 * * 7").daysOfWeek], [0]);
  assert.deepEqual([...parseCron("0 0 * * 5/1").daysOfWeek].sort(), [5, 6]);
});

test("refuses invalid expressions with an explicit error", () => {
  assert.match(cronError("0 7 * *") ?? "", /five fields/);
  assert.match(cronError("60 7 * * *") ?? "", /minute 60 is out of range/);
  assert.match(cronError("0 7 * * funday") ?? "", /not a valid day of week/);
  assert.match(cronError("0 7 10-2 * *") ?? "", /goes backwards/);
  assert.match(cronError("*/0 * * * *") ?? "", /at least 1/);
  assert.equal(cronError("0 7 * * 1-5"), null);
});

test("day of month and day of week: OR when both are restricted, AND when one is a star", () => {
  const either = parseCron("0 0 13 * fri");
  // Friday 2026-11-06 (not the 13th) and Friday 2026-11-13, and Tuesday 2026-10-13.
  assert.equal(cronMatches(either, { year: 2026, month: 11, day: 6, hour: 0, minute: 0, weekday: 5 }), true);
  assert.equal(cronMatches(either, { year: 2026, month: 10, day: 13, hour: 0, minute: 0, weekday: 2 }), true);
  assert.equal(cronMatches(either, { year: 2026, month: 11, day: 7, hour: 0, minute: 0, weekday: 6 }), false);
  const everyOtherDay = parseCron("0 0 */2 * *");
  assert.equal(cronMatches(everyOtherDay, { year: 2026, month: 11, day: 2, hour: 0, minute: 0, weekday: 1 }), false);
  assert.equal(cronMatches(everyOtherDay, { year: 2026, month: 11, day: 3, hour: 0, minute: 0, weekday: 2 }), true);
});

test("next fire in a time zone", () => {
  // 07:00 in Paris on 2 November 2026 is 06:00 UTC (CET, +1).
  assert.equal(next("0 7 * * *", "2026-11-02T05:00:00Z", "Europe/Paris"), "2026-11-02T06:00:00.000Z");
  assert.equal(next("0 7 * * *", "2026-11-02T06:00:00Z", "Europe/Paris"), "2026-11-03T06:00:00.000Z");
  // Same expression, other zones.
  assert.equal(next("0 7 * * *", "2026-11-02T05:00:00Z", "UTC"), "2026-11-02T07:00:00.000Z");
  assert.equal(next("0 7 * * *", "2026-11-02T05:00:00Z", "America/New_York"), "2026-11-02T12:00:00.000Z");
  // Summer time in Paris (CEST, +2).
  assert.equal(next("30 8 * * *", "2026-07-01T00:00:00Z", "Europe/Paris"), "2026-07-01T06:30:00.000Z");
  // Friday 17:00 from a Monday.
  assert.equal(next("0 17 * * fri", "2026-11-02T10:00:00Z", "Europe/Paris"), "2026-11-06T16:00:00.000Z");
  // Monthly, first of the month.
  assert.equal(next("0 9 1 * *", "2026-11-02T10:00:00Z", "Europe/Paris"), "2026-12-01T08:00:00.000Z");
  // A date that never exists.
  assert.equal(next("0 0 30 2 *", "2026-11-02T10:00:00Z", "UTC"), null);
});

test("next fire across daylight saving changes", () => {
  // Paris springs forward on 2026-03-29: 02:30 does not exist that day.
  assert.equal(next("30 2 * * *", "2026-03-28T12:00:00Z", "Europe/Paris"), "2026-03-30T00:30:00.000Z");
  // Before and after the change, 07:00 stays 07:00 on the wall clock.
  assert.equal(next("0 7 * * *", "2026-03-28T12:00:00Z", "Europe/Paris"), "2026-03-29T05:00:00.000Z");
  // Paris falls back on 2026-10-25: 02:30 happens twice, the routine fires once.
  assert.equal(next("30 2 * * *", "2026-10-24T12:00:00Z", "Europe/Paris"), "2026-10-25T00:30:00.000Z");
  assert.equal(next("30 2 * * *", "2026-10-25T00:30:00Z", "Europe/Paris"), "2026-10-26T01:30:00.000Z");
});

test("wall time helpers", () => {
  const w = wallTime(new Date("2026-11-02T23:30:00Z"), "Europe/Paris");
  assert.deepEqual(w, { year: 2026, month: 11, day: 3, hour: 0, minute: 30, weekday: 2 });
  assert.equal(wallToInstants({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, "Europe/Paris").length, 0);
  assert.equal(wallToInstants({ year: 2026, month: 10, day: 25, hour: 2, minute: 30 }, "Europe/Paris").length, 2);
  assert.equal(dayKey(new Date("2026-11-02T23:30:00Z"), "Europe/Paris"), "2026-11-03");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  const range = dayRange("2026-10-25", "Europe/Paris");
  assert.equal(range.start.toISOString(), "2026-10-24T22:00:00.000Z");
  assert.equal(range.end.toISOString(), "2026-10-25T23:00:00.000Z");
});
