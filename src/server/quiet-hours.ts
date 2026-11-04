import { z } from "zod";
import { readRawHomeFile } from "./runtime-settings";
import { addDays, dayKey, wallTime, wallToInstants } from "./time";

// `quietHours` of `<home>/myhq.json`: a daily range of the home's time zone
// during which the Telegram alerts of the informational items (`notifyTypes`)
// are held, then sent together at its end. An item whose payload says
// `"urgent": true` goes at once. This module only needs zod and the clock.

/** A wall-clock time `HH:MM`, 24-hour. */
const clockSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "a time HH:MM such as 21:00");

/** `quietHours` of myhq.json: `start` and `end` in the home's time zone; `end` before `start` crosses midnight. */
export const quietHoursSchema = z
  .strictObject({ start: clockSchema, end: clockSchema })
  .refine((range) => range.start !== range.end, "start and end must differ");

export type QuietHours = z.infer<typeof quietHoursSchema>;

/**
 * The `quietHours` of myhq.json, null when the file or the key is absent.
 * Read apart from the rest of the file: an invalid value gives null with the
 * reason, and never breaks the other settings. Never throws.
 */
export function readQuietHours(home: string): { quietHours: QuietHours | null; error: string | null } {
  const { data, error } = readRawHomeFile(home);
  if (error) return { quietHours: null, error };
  const value = data?.quietHours;
  if (value === undefined) return { quietHours: null, error: null };
  const parsed = quietHoursSchema.safeParse(value);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => issue.message).join("; ");
    return { quietHours: null, error: `myhq.json quietHours: ${details}` };
  }
  return { quietHours: parsed.data, error: null };
}

const minutesOf = (clock: string): number => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

/** True when the wall clock of `timeZone` at `at` is inside the range (`start` included, `end` excluded). */
export function isQuiet(at: Date, range: QuietHours, timeZone: string): boolean {
  const wall = wallTime(at, timeZone);
  const now = wall.hour * 60 + wall.minute;
  const start = minutesOf(range.start);
  const end = minutesOf(range.end);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/** The first instant of a calendar day at which the wall clock shows `clock`, or the first minute after it that exists. */
function instantOn(key: string, clock: string, timeZone: string): Date {
  const [year, month, day] = key.split("-").map(Number) as [number, number, number];
  const base = minutesOf(clock);
  // A daylight saving gap skips an hour at most: the range ends at the first minute that exists.
  for (let minutes = base; minutes < base + 180; minutes++) {
    const date = new Date(Date.UTC(year, month - 1, day, 0, minutes));
    const found = wallToInstants(
      { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: date.getUTCHours(), minute: date.getUTCMinutes() },
      timeZone,
    );
    if (found.length > 0) return found[0]!;
  }
  throw new Error(`No instant of ${key} ${clock} exists in ${timeZone}`);
}

/** The last time the range ended at or before `at`: today's `end`, or yesterday's when today's is still to come. */
export function lastQuietEnd(at: Date, range: QuietHours, timeZone: string): Date {
  const today = dayKey(at, timeZone);
  const end = instantOn(today, range.end, timeZone);
  return end.getTime() <= at.getTime() ? end : instantOn(addDays(today, -1), range.end, timeZone);
}

/** True when the item's payload asks to be sent at once: `"urgent": true`. A payload that is not JSON is not urgent. */
export function isUrgentPayload(payload: string): boolean {
  try {
    const parsed = JSON.parse(payload) as unknown;
    return typeof parsed === "object" && parsed !== null && (parsed as { urgent?: unknown }).urgent === true;
  } catch {
    return false;
  }
}
