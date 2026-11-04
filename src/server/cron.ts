import { wallToInstants, wallTime, type WallTime } from "./time";

/**
 * A minimal five-field cron parser (minute, hour, day of month, month, day of
 * week), written here rather than taken from a package: MyHQ only needs to
 * know whether a minute matches and when the next one is.
 *
 * Each field accepts `*`, a number, a range `a-b`, a step `*\/n`, `a-b/n` or
 * `a/n`, and comma-separated lists of those. Months accept `jan` to `dec` and
 * days of week `sun` to `sat` (0 and 7 are both Sunday). As in classic cron,
 * when both the day of month and the day of week are restricted, a day
 * matches if either one does.
 */
export type CronSchedule = {
  source: string;
  minutes: number[];
  hours: number[];
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** The day-of-month field starts with `*` (classic cron rule for the day OR). */
  anyDayOfMonth: boolean;
  anyDayOfWeek: boolean;
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

type FieldSpec = { name: string; min: number; max: number; names?: string[]; namesFrom?: number };

const FIELDS: FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS, namesFrom: 1 },
  { name: "day of week", min: 0, max: 7, names: DAYS, namesFrom: 0 },
];

function value(raw: string, spec: FieldSpec): number {
  const lower = raw.toLowerCase();
  const named = spec.names?.indexOf(lower) ?? -1;
  if (named >= 0) return named + (spec.namesFrom ?? 0);
  if (!/^\d+$/.test(raw)) throw new Error(`"${raw}" is not a valid ${spec.name}`);
  const n = Number(raw);
  if (n < spec.min || n > spec.max) {
    throw new Error(`${spec.name} ${n} is out of range (${spec.min}-${spec.max})`);
  }
  return n;
}

function parseField(field: string, spec: FieldSpec): { values: Set<number>; any: boolean } {
  const values = new Set<number>();
  let any = false;
  for (const part of field.split(",")) {
    const match = /^([^/]+)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new Error(`"${part}" is not a valid ${spec.name}`);
    const [, range, stepRaw] = match as unknown as [string, string, string | undefined];
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (step < 1) throw new Error(`step of "${part}" must be at least 1`);
    let from: number;
    let to: number;
    if (range === "*") {
      from = spec.min;
      to = spec.name === "day of week" ? 6 : spec.max;
      any = true;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-") as [string, string];
      from = value(a, spec);
      to = value(b, spec);
      if (from > to) throw new Error(`range "${range}" of the ${spec.name} goes backwards`);
    } else {
      from = value(range, spec);
      to = stepRaw === undefined ? from : spec.name === "day of week" ? 6 : spec.max;
    }
    for (let n = from; n <= to; n += step) values.add(spec.name === "day of week" && n === 7 ? 0 : n);
  }
  return { values, any };
}

/** Parses a five-field cron expression. Throws an explicit Error when invalid. */
export function parseCron(expression: string): CronSchedule {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron "${expression}" must have five fields (minute hour day month weekday)`);
  }
  const parsed = fields.map((field, i) => {
    try {
      return parseField(field, FIELDS[i]!);
    } catch (error) {
      throw new Error(`cron "${expression}": ${(error as Error).message}`);
    }
  });
  const [minute, hour, dom, month, dow] = parsed as [
    ReturnType<typeof parseField>,
    ReturnType<typeof parseField>,
    ReturnType<typeof parseField>,
    ReturnType<typeof parseField>,
    ReturnType<typeof parseField>,
  ];
  return {
    source: expression.trim(),
    minutes: [...minute.values].sort((a, b) => a - b),
    hours: [...hour.values].sort((a, b) => a - b),
    daysOfMonth: dom.values,
    months: month.values,
    daysOfWeek: dow.values,
    anyDayOfMonth: dom.any,
    anyDayOfWeek: dow.any,
  };
}

/** Error message of an invalid expression, or null when it is valid. */
export function cronError(expression: string): string | null {
  try {
    parseCron(expression);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

function dayMatches(s: CronSchedule, month: number, day: number, weekday: number): boolean {
  if (!s.months.has(month)) return false;
  const dom = s.daysOfMonth.has(day);
  const dow = s.daysOfWeek.has(weekday);
  // Classic cron: when either day field starts with `*`, both must match;
  // when both are restricted, either one is enough.
  return s.anyDayOfMonth || s.anyDayOfWeek ? dom && dow : dom || dow;
}

/** Whether a wall-clock minute matches the schedule. */
export function cronMatches(s: CronSchedule, t: WallTime): boolean {
  return (
    s.minutes.includes(t.minute) && s.hours.includes(t.hour) && dayMatches(s, t.month, t.day, t.weekday)
  );
}

/** Days searched ahead before giving up (an impossible date such as 30 February). */
const SEARCH_DAYS = 366 * 5;

/**
 * The first instant strictly after `after` (at minute precision) at which the
 * schedule fires in `timeZone`, or null when it never does. A wall-clock
 * minute skipped by a daylight saving change does not fire; a minute repeated
 * by one fires once, at its first occurrence.
 */
export function nextFire(s: CronSchedule, after: Date, timeZone: string): Date | null {
  const from = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  const start = wallTime(new Date(from), timeZone);
  for (let offset = 0; offset < SEARCH_DAYS; offset++) {
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day + offset));
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    if (!dayMatches(s, month, day, date.getUTCDay())) continue;
    for (const hour of s.hours) {
      for (const minute of s.minutes) {
        const first = wallToInstants({ year, month, day, hour, minute }, timeZone)[0];
        if (first && first.getTime() >= from) return first;
      }
    }
  }
  return null;
}

/** More times of day than this and a summary gives none (`*\/5 * * * *` reads better as its expression). */
export const SUMMARY_MAX_TIMES = 6;

/**
 * What a schedule says, without any wording, for an interface to phrase it
 * (« tous les jours à 7 h »). Times are on the wall clock the expression is
 * read on (the scheduler's time zone). When both `weekdays` and `monthDays`
 * are set, they combine as the classic cron rule does: `dayRule` says how.
 */
export type CronSummary = {
  /** The times of day it fires, "HH:MM", in order; null when there are more than SUMMARY_MAX_TIMES. */
  times: string[] | null;
  /** The days of the week it is limited to, 0 Sunday to 6 Saturday, in order; null for every day of the week. */
  weekdays: number[] | null;
  /** The days of the month it is limited to, in order; null for every day of the month. */
  monthDays: number[] | null;
  /** The months it is limited to, 1 to 12, in order; null for every month. */
  months: number[] | null;
  /** How the days of the week and of the month combine when both are set: either one, or both. */
  dayRule: "or" | "and";
};

const sorted = (values: Iterable<number>): number[] => [...values].sort((a, b) => a - b);
const two = (n: number): string => String(n).padStart(2, "0");

/** The summary of a parsed schedule (see CronSummary). */
export function describeCron(s: CronSchedule): CronSummary {
  const count = s.minutes.length * s.hours.length;
  return {
    times: count > SUMMARY_MAX_TIMES ? null : s.hours.flatMap((hour) => s.minutes.map((minute) => `${two(hour)}:${two(minute)}`)),
    weekdays: s.daysOfWeek.size >= 7 ? null : sorted(s.daysOfWeek),
    monthDays: s.daysOfMonth.size >= 31 ? null : sorted(s.daysOfMonth),
    months: s.months.size >= 12 ? null : sorted(s.months),
    dayRule: s.anyDayOfMonth || s.anyDayOfWeek ? "and" : "or",
  };
}
