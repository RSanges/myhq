/**
 * Wall-clock time in an IANA time zone, with the standard Intl API only (no
 * dependency). Used by the routine scheduler and the daily export, which both
 * reason in the user's time zone (HQ_TIMEZONE) rather than in UTC.
 */

/** A wall-clock minute in some time zone. `month` is 1 to 12, `weekday` 0 (Sunday) to 6. */
export type WallTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
};

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The time zone of the machine, used when HQ_TIMEZONE is not set. */
export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** True when `timeZone` is an IANA name the runtime knows (for example `Europe/Paris`). */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock minute of an instant in a time zone. */
export function wallTime(date: Date, timeZone: string): WallTime {
  const parts: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(date)) parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday ?? ""] ?? 0,
  };
}

/** Offset of the time zone at an instant, in milliseconds (wall clock minus UTC). */
function offsetAt(instant: number, timeZone: string): number {
  const w = wallTime(new Date(instant), timeZone);
  const floored = Math.floor(instant / 60_000) * 60_000;
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - floored;
}

/**
 * The instants at which the wall clock of `timeZone` shows this minute, in
 * order: none in a daylight saving gap, two in the repeated hour of a
 * fall-back, one otherwise.
 */
export function wallToInstants(
  t: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): Date[] {
  const naive = Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute);
  const candidates = new Set<number>();
  // The offset can differ by a few hours around the instant: try both sides.
  for (const probe of [naive - 12 * 3_600_000, naive, naive + 12 * 3_600_000]) {
    candidates.add(naive - offsetAt(probe, timeZone));
  }
  return [...candidates]
    .filter((instant) => {
      const w = wallTime(new Date(instant), timeZone);
      return (
        w.year === t.year && w.month === t.month && w.day === t.day && w.hour === t.hour && w.minute === t.minute
      );
    })
    .sort((a, b) => a - b)
    .map((instant) => new Date(instant));
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD` of an instant in a time zone. */
export function dayKey(date: Date, timeZone: string): string {
  const w = wallTime(date, timeZone);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

/** Adds days to a `YYYY-MM-DD` calendar date. */
export function addDays(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** The first instant of a calendar day in a time zone (midnight, or the first minute that exists). */
function startOfDay(key: string, timeZone: string): Date {
  const [year, month, day] = key.split("-").map(Number) as [number, number, number];
  for (let minutes = 0; minutes < 24 * 60; minutes++) {
    const found = wallToInstants({ year, month, day, hour: Math.floor(minutes / 60), minute: minutes % 60 }, timeZone);
    if (found.length > 0) return found[0]!;
  }
  throw new Error(`No instant of ${key} exists in ${timeZone}`);
}

/** `[start, end)` of a calendar day (`YYYY-MM-DD`) in a time zone. */
export function dayRange(key: string, timeZone: string): { start: Date; end: Date } {
  return { start: startOfDay(key, timeZone), end: startOfDay(addDays(key, 1), timeZone) };
}
