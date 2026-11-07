// A Telegram reply to one of our messages answers the item that message is
// about: the text of an alert says which one in its first line, « (#12) » for
// an item, « (#12, 2/3) » for the second of three questions. The id is read
// from that text, not kept in memory, so a reply works after a restart too.

/** What a replied-to message is about: an item, and, for a question message, the question (0-based). */
export type ReplyTarget = { approvalId: number; question: number | null };

/** The tag ends the line, so a title that looks like one does not take its place. */
const TAG = /\(#(\d{1,9})(?:, (\d{1,2})\/\d{1,2})?\)\s*$/;

/** Reads the tag of the first line of a bot message. Null when it has none. */
export function replyTarget(text: string | undefined): ReplyTarget | null {
  const match = TAG.exec((text ?? "").split("\n", 1)[0]!);
  if (!match) return null;
  return { approvalId: Number(match[1]), question: match[2] === undefined ? null : Number(match[2]) - 1 };
}
