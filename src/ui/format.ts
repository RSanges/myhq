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
