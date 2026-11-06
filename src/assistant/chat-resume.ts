/**
 * Whether a chat turn resumes the CLI's conversation (`--continue`) or starts
 * a new one fed with the conversation MyHQ keeps.
 *
 * The CLI caches the conversation for an hour. A turn inside that hour pays a
 * tenth of the price for what is already there; after a longer pause, the
 * whole conversation (it grows by 7,000 to 8,000 tokens a turn, 74,000 after
 * eighteen) is written again at twice the price of an input token. A new
 * conversation only writes the fixed prefix and the last exchanges.
 */

/** Pause after which the conversation starts over by default: the lifetime of the CLI's cache. */
export const DEFAULT_FRESH_AFTER_MINUTES = 60;

export function shouldResumeCli(params: {
  /** `chat.resume`: "history" never resumes. */
  mode: "cli" | "history";
  /** False after `/new`, or while no turn has answered since a conversation was lost. */
  conversationAlive: boolean;
  /** End of the previous chat turn (ISO date), null when there was none. */
  lastTurnEndedAt: string | null;
  nowMs: number;
  freshAfterMinutes: number;
}): boolean {
  if (params.mode !== "cli" || !params.conversationAlive) return false;
  if (params.lastTurnEndedAt === null) return true;
  const endedMs = Date.parse(params.lastTurnEndedAt);
  if (Number.isNaN(endedMs)) return true;
  return params.nowMs - endedMs <= params.freshAfterMinutes * 60_000;
}
