import { strings } from "./strings";

const dateTime = new Intl.DateTimeFormat(strings.locale, {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});
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

export function formatDateTime(iso: string): string {
  const date = toDate(iso);
  return date ? dateTime.format(date) : iso;
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
