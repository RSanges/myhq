import { extractChoices, type Choice } from "../assistant/choices";
import { strings } from "../ui/strings";
import { publishChat } from "./chat-hub";
import { now, type Db } from "./db";

/** Who wrote a message of the conversation: the user, the chat, or the bot on its own. */
export const CHAT_ROLES = ["user", "assistant", "bot"] as const;
export type ChatRole = (typeof CHAT_ROLES)[number];

/** Where a message was exchanged: the Telegram chat, or the panel of the desk. */
export const CHAT_CHANNELS = ["telegram", "desk"] as const;
export type ChatChannel = (typeof CHAT_CHANNELS)[number];

/**
 * What the bot sent on its own: an approval alert, an informational item, a
 * run summary, or the confirmation that a task typed on the desk went to an agent.
 */
export type BotMessageKind = "alert" | "notification" | "summary" | "dispatch";

/** The agent a message of the user was addressed to (from the desk), instead of the chat. */
export type ChatTarget = { room: string; agent: string };

export type ChatMessageDto = {
  id: number;
  role: ChatRole;
  /** For a bot message, what it was; null otherwise. */
  kind: string | null;
  channel: ChatChannel;
  /** The agent a task was addressed to, null for a message to the chat. */
  to: ChatTarget | null;
  text: string;
  /** The task-list items of a reply of the chat (a selection list), null when it has none. */
  choices: Choice[] | null;
  createdAt: string;
};

type ChatMessageRow = {
  id: number;
  role: ChatRole;
  kind: string | null;
  channel: ChatChannel;
  target: string | null;
  text: string;
  created_at: string;
};

/** Messages returned by GET /api/chat/history when `limit` is not given. */
export const DEFAULT_HISTORY_LIMIT = 50;

function parseTarget(raw: string | null): ChatTarget | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<ChatTarget>;
    return typeof value.room === "string" && typeof value.agent === "string"
      ? { room: value.room, agent: value.agent }
      : null;
  } catch {
    return null;
  }
}

/** A stored text is cut beyond this (a message of the bot is at most a few Telegram messages). */
export const STORED_TEXT_LIMIT = 8_000;
/** Only the most recent messages are kept; the transcript never needs more. */
export const KEPT_MESSAGES = 500;

const toDto = (row: ChatMessageRow): ChatMessageDto => ({
  id: row.id,
  role: row.role,
  kind: row.kind,
  channel: row.channel,
  to: parseTarget(row.target),
  text: row.text,
  choices: row.role === "assistant" ? extractChoices(row.text) : null,
  createdAt: row.created_at,
});

/**
 * Adds a message to the conversation and forgets the oldest beyond
 * KEPT_MESSAGES. Tells the live streams (the `chat` event). Returns the
 * message as stored, or null when the text is blank.
 */
export function recordChatMessage(
  db: Db,
  role: ChatRole,
  text: string,
  kind: string | null = null,
  options: { channel?: ChatChannel; to?: ChatTarget | null } = {},
): ChatMessageDto | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const id = Number(
    db
      .prepare("INSERT INTO chat_messages (role, kind, channel, target, text, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        role,
        kind,
        options.channel ?? "telegram",
        options.to ? JSON.stringify({ room: options.to.room, agent: options.to.agent }) : null,
        trimmed.slice(0, STORED_TEXT_LIMIT),
        now(),
      ).lastInsertRowid,
  );
  db.prepare(
    "DELETE FROM chat_messages WHERE id <= (SELECT id FROM chat_messages ORDER BY id DESC LIMIT 1 OFFSET ?)",
  ).run(KEPT_MESSAGES);
  const message = toDto(db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(id) as ChatMessageRow);
  publishChat({ type: "message", message });
  return message;
}

/**
 * Records a message the bot sent on its own, so that the next chat turn
 * knows what the user may be answering. Never throws: an alert must go out
 * whatever happens to the history.
 */
export function recordBotMessage(db: Db, text: string, kind: BotMessageKind): void {
  try {
    recordChatMessage(db, "bot", text, kind);
  } catch (error) {
    console.error(`[chat-history] bot message not recorded: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** `/new`: the conversation starts over. */
export function clearChatHistory(db: Db): void {
  db.prepare("DELETE FROM chat_messages").run();
  publishChat({ type: "cleared" });
}

/** The last `limit` messages, oldest first. */
export function listChatHistory(db: Db, limit: number): ChatMessageDto[] {
  const rows = db.prepare("SELECT * FROM chat_messages ORDER BY id DESC LIMIT ?").all(limit) as ChatMessageRow[];
  return rows.reverse().map(toDto);
}

function line(row: ChatMessageRow): string {
  const t = strings.assistant.history;
  const to = parseTarget(row.target);
  const who =
    row.role === "user"
      ? to
        ? t.userTo(`${to.room} / ${to.agent}`)
        : t.user
      : row.role === "assistant"
        ? t.assistant
        : t.bot(row.kind);
  return `${who} : ${row.text}`;
}

/**
 * The conversation as text, to put at the start of a chat turn, or null when
 * there is nothing to give.
 *
 * - `since: "all"`: the last `turns` exchanges (a user message with the
 *   replies that follow it; each message of the bot counts as one), for a
 *   turn that does not resume the CLI's conversation.
 * - `since: "lastExchange"`: only the messages the bot sent on its own since
 *   the last exchange, which a resumed conversation (`--continue`) does not
 *   know about.
 *
 * At most `maxChars` characters, block marks included: the oldest messages
 * go first, and a newest message that is still too long is cut.
 */
export function chatTranscript(
  db: Db,
  options: { turns: number; maxChars: number; since: "all" | "lastExchange" },
): string | null {
  if (options.turns <= 0 || options.maxChars <= 0) return null;
  const rows = db
    .prepare("SELECT * FROM chat_messages ORDER BY id DESC LIMIT ?")
    .all(options.turns * 4 + 20) as ChatMessageRow[];
  const picked: ChatMessageRow[] = [];
  let exchanges = 0;
  for (const row of rows) {
    if (options.since === "lastExchange" && row.role !== "bot") break;
    if (row.role === "assistant") {
      if (exchanges < options.turns) picked.push(row);
      continue;
    }
    if (exchanges >= options.turns) break;
    exchanges++;
    picked.push(row);
  }
  if (picked.length === 0) return null;
  const t = strings.assistant.history;
  const head = options.since === "all" ? t.head : t.headSince;
  const frame = head.length + t.end.length + 2;
  const lines = picked.reverse().map(line);
  while (lines.length > 1 && frame + lines.join("\n").length > options.maxChars) lines.shift();
  const room = options.maxChars - frame;
  if (room <= 0) return null;
  if (lines[0]!.length > room) lines[0] = `${lines[0]!.slice(0, Math.max(0, room - 3))}...`;
  return [head, ...lines, t.end].join("\n");
}
