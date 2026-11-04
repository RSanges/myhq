import type { Schedule } from "./schemas";
import { strings } from "./strings";

const t = strings.schedule;
/** The week as it reads in French, Monday first (cron numbers, 0 is Sunday). */
const WEEK = [1, 2, 3, 4, 5, 6, 0];
/** More days of the month than this read better as the expression. */
const MAX_MONTH_DAYS = 3;

/**
 * A routine's schedule in words (« Tous les jours à 7 h », « Du lundi au
 * vendredi à 8 h »), from the summary the server gives (`schedule` of a
 * routine, docs/api.md). Null when it reads better as its cron expression:
 * many times a day, some months only, days of the week and of the month
 * together, or a summary missing (an older server).
 */
export function scheduleText(schedule: Schedule | undefined): string | null {
  if (!schedule || schedule.times === null || schedule.times.length === 0 || schedule.months !== null) return null;
  const { weekdays, monthDays } = schedule;
  if (weekdays !== null && monthDays !== null) return null;
  const times: string[] = [];
  for (const time of schedule.times) {
    const match = /^(\d{2}):(\d{2})$/.exec(time);
    if (!match) return null;
    times.push(t.time(Number(match[1]), Number(match[2])));
  }
  let days: string = t.everyDay;
  if (weekdays !== null) {
    const order = WEEK.filter((day) => weekdays.includes(day));
    const first = order[0];
    const last = order[order.length - 1];
    if (first === undefined || last === undefined) return null;
    const inARow = order.length >= 3 && WEEK.indexOf(last) - WEEK.indexOf(first) === order.length - 1;
    days = inARow ? t.dayRange(t.weekdays[first] ?? "", t.weekdays[last] ?? "") : t.someDays(order.map((day) => t.weekdays[day] ?? ""));
  } else if (monthDays !== null) {
    if (monthDays.length === 0 || monthDays.length > MAX_MONTH_DAYS) return null;
    days = t.monthDays(monthDays);
  }
  return t.line(days, times);
}
