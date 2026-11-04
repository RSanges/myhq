import { strings } from "./strings";

const dateTime = new Intl.DateTimeFormat(strings.locale, {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});
const clock = new Intl.DateTimeFormat(strings.locale, { hour: "2-digit", minute: "2-digit" });
const shortDay = new Intl.DateTimeFormat(strings.locale, { day: "numeric", month: "short" });
const day = new Intl.DateTimeFormat(strings.locale, { day: "numeric", month: "short", year: "numeric" });
const time = new Intl.DateTimeFormat(strings.locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const integer = new Intl.NumberFormat(strings.locale);
const compact = new Intl.NumberFormat(strings.locale, { notation: "compact", maximumFractionDigits: 1 });
const usd = new Intl.NumberFormat(strings.locale, {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

function toDate(iso: string): Date | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The time of day, for a message of the conversation. */
export function formatClock(iso: string): string {
  const date = toDate(iso);
  return date ? clock.format(date) : iso;
}

export function formatDateTime(iso: string): string {
  const date = toDate(iso);
  return date ? dateTime.format(date) : iso;
}

/** A calendar date: `2026-11-02` is shown as is in the local calendar, never shifted by a time zone. */
function calendarDate(value: string): Date | null {
  const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return plain ? new Date(Number(plain[1]), Number(plain[2]) - 1, Number(plain[3])) : toDate(value);
}

export function formatDay(value: string): string {
  const date = calendarDate(value);
  return date ? day.format(date) : value;
}

/** Same as formatDay without the year, for dense lists. */
export function formatShortDay(value: string): string {
  const date = calendarDate(value);
  return date ? shortDay.format(date) : value;
}

/**
 * When something happened or will happen, near `at`, in words: « à 07:00 »
 * the same day, « hier à », « demain à », else « le 9 nov. à 06:00 ».
 */
export function formatWhen(iso: string, at: number = Date.now()): string {
  const date = toDate(iso);
  if (!date) return iso;
  const w = strings.room.roomSheet.when;
  const midnight = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  // Rounded: a day with a daylight saving change is 23 or 25 hours long.
  const days = Math.round((midnight(date) - midnight(new Date(at))) / 86_400_000);
  const time = clock.format(date);
  if (days === 0) return w.today(time);
  if (days === -1) return w.yesterday(time);
  if (days === 1) return w.tomorrow(time);
  return w.other(shortDay.format(date), time);
}

export function formatTime(iso: string): string {
  const date = toDate(iso);
  return date ? time.format(date) : iso;
}

export const formatInteger = (value: number): string => integer.format(value);
export const formatCompact = (value: number): string => compact.format(value);
export const formatCost = (value: number): string => usd.format(value);

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}...` : text;
}

/**
 * How long ago `iso` was, as « il y a 2 h »: minutes under an hour, hours
 * under a day, days under two weeks, then the date. An unreadable date is
 * returned as is, a future one counts as « à l'instant ».
 */
export function formatAge(iso: string, at: number = Date.now()): string {
  const date = toDate(iso);
  if (!date) return iso;
  const minutes = Math.floor((at - date.getTime()) / 60_000);
  const t = strings.desk.age;
  if (minutes < 1) return t.now;
  if (minutes < 60) return t.minutes(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t.hours(hours);
  const days = Math.floor(hours / 24);
  return days < 14 ? t.days(days) : shortDay.format(date);
}

const longDay = new Intl.DateTimeFormat(strings.locale, { weekday: "long", day: "numeric", month: "long" });
const fullDay = new Intl.DateTimeFormat(strings.locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" });

/** The local calendar day of an instant or a date, as `2026-11-04` (a plain date is kept as is). */
export function localDayKey(value: string | Date): string | null {
  const date = typeof value === "string" ? calendarDate(value) : value;
  if (!date || Number.isNaN(date.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The day `days` after a day key. */
export function addDayKey(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return localDayKey(new Date(y ?? 0, (m ?? 1) - 1, (d ?? 1) + days)) ?? key;
}

/** « mercredi 4 novembre », for a day key or an instant. */
export function formatLongDay(value: string): string {
  const date = calendarDate(value);
  return date ? longDay.format(date) : value;
}

/** « mercredi 4 novembre 2026 ». */
export function formatFullDay(value: string | Date): string {
  const date = typeof value === "string" ? calendarDate(value) : value;
  return date ? fullDay.format(date) : String(value);
}

/** The time of an instant the French way: « 9 h », « 14 h 30 ». */
export function formatHour(iso: string): string {
  const date = toDate(iso);
  if (!date) return iso;
  const minutes = date.getMinutes();
  return minutes === 0 ? `${date.getHours()} h` : `${date.getHours()} h ${String(minutes).padStart(2, "0")}`;
}
