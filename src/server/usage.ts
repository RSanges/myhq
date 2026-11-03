import type { Db } from "./db";
import type { Usage } from "./engine";
import { runsToday } from "./runner";

export type Totals = {
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  costUsd: number;
};

/** Totals of one agent's runs over a period. */
export type AgentTotals = Totals & { room: string; agentId: string };

/** Totals of the assistant's chat turns over a period (the chat is not a run). */
export type ChatTotals = {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  costUsd: number;
  /** Tool calls made by those turns. */
  toolCalls: number;
};

export type UsageDto = {
  today: Totals & { date: string };
  week: Totals & { start: string };
  days: (Totals & { date: string })[];
  cap: { maxRunsPerDay: number; runsToday: number; remaining: number };
  /** Share of the user's weekly budget spent this week (HQ_WEEKLY_BUDGET_USD), or null when not set. */
  budget: { weeklyUsd: number; spentUsd: number; share: number } | null;
  /** The runs of each agent that ran in the period, most expensive first. */
  agents: { today: AgentTotals[]; week: AgentTotals[] };
  /** The assistant's chat turns. */
  chat: { today: ChatTotals; week: ChatTotals };
};

const TOTALS = `COUNT(r.id) AS runs,
  COALESCE(SUM(r.input_tokens), 0) AS inputTokens,
  COALESCE(SUM(r.output_tokens), 0) AS outputTokens,
  COALESCE(SUM(r.cache_creation_input_tokens), 0) AS cacheCreationInputTokens,
  COALESCE(SUM(r.cache_read_input_tokens), 0) AS cacheReadInputTokens,
  COALESCE(SUM(r.cost_usd), 0) AS costUsd`;

const TODAY = `date('now', 'localtime')`;
const WEEK_START = `date('now', 'localtime', '-6 days', 'weekday 1')`;

function agentTotals(db: Db, from: string): AgentTotals[] {
  return db
    .prepare(
      `SELECT r.room AS room, r.agent_id AS agentId, ${TOTALS}
       FROM runs r WHERE date(r.started_at, 'localtime') >= ${from}
       GROUP BY r.room, r.agent_id ORDER BY costUsd DESC, r.room, r.agent_id`,
    )
    .all() as AgentTotals[];
}

function chatTotals(db: Db, from: string): ChatTotals {
  return db
    .prepare(
      `SELECT COUNT(c.id) AS turns,
         COALESCE(SUM(c.input_tokens), 0) AS inputTokens,
         COALESCE(SUM(c.output_tokens), 0) AS outputTokens,
         COALESCE(SUM(c.cache_creation_input_tokens), 0) AS cacheCreationInputTokens,
         COALESCE(SUM(c.cache_read_input_tokens), 0) AS cacheReadInputTokens,
         COALESCE(SUM(c.cost_usd), 0) AS costUsd,
         COALESCE(SUM(c.tool_calls), 0) AS toolCalls
       FROM chat_turns c WHERE date(c.started_at, 'localtime') >= ${from}`,
    )
    .get() as ChatTotals;
}

/**
 * Tokens and cost of the runs, by local calendar day (the server's time zone),
 * per agent, and of the assistant's chat turns. The week starts on Monday.
 */
export function getUsage(db: Db, maxRunsPerDay: number, weeklyBudgetUsd: number | null = null): UsageDto {
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
      `SELECT ${WEEK_START} AS start, ${TOTALS}
       FROM runs r WHERE date(r.started_at, 'localtime') >= ${WEEK_START}`,
    )
    .get() as Totals & { start: string };
  const today = days[days.length - 1]!;
  const count = runsToday(db);
  return {
    today,
    week,
    days,
    cap: { maxRunsPerDay, runsToday: count, remaining: Math.max(0, maxRunsPerDay - count) },
    budget:
      weeklyBudgetUsd === null
        ? null
        : { weeklyUsd: weeklyBudgetUsd, spentUsd: week.costUsd, share: week.costUsd / weeklyBudgetUsd },
    agents: { today: agentTotals(db, TODAY), week: agentTotals(db, WEEK_START) },
    chat: { today: chatTotals(db, TODAY), week: chatTotals(db, WEEK_START) },
  };
}

/** One chat turn, as the assistant records it. */
export type ChatTurnRecord = {
  engine: string;
  model: string | null;
  status: "done" | "failed";
  /** Why a turn failed (`budget`, `timeout`, `error`...), null when it answered. */
  reason: string | null;
  usage: Usage;
  costUsd: number;
  /** Names of the tools the turn called, in order. */
  tools: string[];
  startedAt: string;
  endedAt: string;
};

/** Records a chat turn in `chat_turns`, for the meter. */
export function recordChatTurn(db: Db, turn: ChatTurnRecord): void {
  db.prepare(
    `INSERT INTO chat_turns (engine, model, status, reason, input_tokens, output_tokens,
       cache_creation_input_tokens, cache_read_input_tokens, cost_usd, tool_calls, tools, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    turn.engine,
    turn.model,
    turn.status,
    turn.reason,
    turn.usage.inputTokens,
    turn.usage.outputTokens,
    turn.usage.cacheCreationInputTokens,
    turn.usage.cacheReadInputTokens,
    turn.costUsd,
    turn.tools.length,
    JSON.stringify(turn.tools),
    turn.startedAt,
    turn.endedAt,
  );
}
