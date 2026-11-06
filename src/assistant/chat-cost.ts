import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Usage } from "../server/engine";

/**
 * What a chat turn cost, for the meter.
 *
 * With `--continue`, the CLI (since Sonnet 5.5) reports the whole resumed
 * conversation: `total_cost_usd` and `modelUsage` add up every turn of the
 * session, while the top-level `usage` is the turn's own. Recording the
 * reported cost as is made the meter grow turn after turn (+59 % on the
 * audited week). The cost of the turn alone is the difference with what the
 * previous turn reported, which is the CLI's own figure and so follows its
 * prices; when that baseline is lost (the file below was deleted), it is
 * estimated from the share of the turn in the session's tokens.
 */

/** Share of the session's tokens above which the CLI is known to report the whole session. */
export const SESSION_MARGIN_TOKENS = 1_000;

/**
 * Relative price of a token, input being 1. Only used for the estimate, when
 * the previous total is unknown: the exact ratios depend on the model (a
 * cached read costs 0.05 to 0.1 of an input token).
 */
const WEIGHTS = { input: 1, output: 5, cacheWrite: 2, cacheRead: 0.1 } as const;

export const tokenCount = (u: Usage): number =>
  u.inputTokens + u.outputTokens + u.cacheCreationInputTokens + u.cacheReadInputTokens;

const weighted = (u: Usage): number =>
  u.inputTokens * WEIGHTS.input +
  u.outputTokens * WEIGHTS.output +
  u.cacheCreationInputTokens * WEIGHTS.cacheWrite +
  u.cacheReadInputTokens * WEIGHTS.cacheRead;

/** How a turn's cost was obtained: as reported, as the difference with the previous total, or estimated. */
export type CostMethod = "reported" | "delta" | "estimated";

export type TurnCost = { costUsd: number; method: CostMethod };

/**
 * @param reportedUsd `total_cost_usd` of the result.
 * @param usage The turn's own usage (top-level `usage`).
 * @param sessionUsage The tokens of the whole session (`modelUsage`, summed), when the CLI gave them.
 * @param continued Whether the turn resumed the CLI's conversation.
 * @param previousReportedUsd The total the previous turn reported, when known.
 */
export function chatTurnCost(params: {
  reportedUsd: number;
  usage: Usage;
  sessionUsage: Usage | null;
  continued: boolean;
  previousReportedUsd: number | null;
}): TurnCost {
  const { reportedUsd, usage, sessionUsage, continued, previousReportedUsd } = params;
  const wholeSession =
    continued && sessionUsage !== null && tokenCount(sessionUsage) - tokenCount(usage) > SESSION_MARGIN_TOKENS;
  if (!wholeSession) return { costUsd: reportedUsd, method: "reported" };
  if (previousReportedUsd !== null && previousReportedUsd <= reportedUsd) {
    return { costUsd: reportedUsd - previousReportedUsd, method: "delta" };
  }
  const share = weighted(usage) / weighted(sessionUsage);
  return { costUsd: reportedUsd * Math.min(1, share), method: "estimated" };
}

const ledgerSchema = z.object({ reportedUsd: z.number().min(0) });

/** The total the previous turn reported, or null when there is none (first turn, missing or unreadable file). */
export function readCostLedger(file: string): number | null {
  try {
    return ledgerSchema.parse(JSON.parse(fs.readFileSync(file, "utf8"))).reportedUsd;
  } catch {
    return null;
  }
}

export function writeCostLedger(file: string, reportedUsd: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ reportedUsd }));
}
