import type { Db } from "./db";
import { runsToday } from "./runner";

export type Totals = {
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  costUsd: number;
};

export type UsageDto = {
  today: Totals & { date: string };
  week: Totals & { start: string };
  days: (Totals & { date: string })[];
  cap: { maxRunsPerDay: number; runsToday: number; remaining: number };
};

const TOTALS = `COUNT(r.id) AS runs,
  COALESCE(SUM(r.input_tokens), 0) AS inputTokens,
  COALESCE(SUM(r.output_tokens), 0) AS outputTokens,
  COALESCE(SUM(r.cache_creation_input_tokens), 0) AS cacheCreationInputTokens,
  COALESCE(SUM(r.cache_read_input_tokens), 0) AS cacheReadInputTokens,
  COALESCE(SUM(r.cost_usd), 0) AS costUsd`;

/**
 * Tokens and cost of the runs, by local calendar day (the server's time zone).
 * The week starts on Monday.
 */
export function getUsage(db: Db, maxRunsPerDay: number): UsageDto {
  const days = db
    .prepare(
      `WITH RECURSIVE d(date, n) AS (
         SELECT date('now', 'localtime', '-6 days'), 0
         UNION ALL SELECT date(date, '+1 day'), n + 1 FROM d WHERE n < 6
       )
       SELECT d.date AS date, ${TOTALS}
       FROM d LEFT JOIN runs r ON date(r.started_at, 'localtime') = d.date
       GROUP BY d.date ORDER BY d.date`,
    )
    .all() as (Totals & { date: string })[];
  const week = db
    .prepare(
      `SELECT date('now', 'localtime', '-6 days', 'weekday 1') AS start, ${TOTALS}
       FROM runs r WHERE date(r.started_at, 'localtime') >= date('now', 'localtime', '-6 days', 'weekday 1')`,
    )
    .get() as Totals & { start: string };
  const today = days[days.length - 1]!;
  const count = runsToday(db);
  return {
    today,
    week,
    days,
    cap: { maxRunsPerDay, runsToday: count, remaining: Math.max(0, maxRunsPerDay - count) },
  };
}
