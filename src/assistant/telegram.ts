import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

type Fetch = typeof fetch;

// Shapes of the Bot API objects MyHQ reads. Unknown fields are kept and
// ignored; an update that does not match is logged and skipped.
const chatSchema = z.looseObject({ id: z.number().int() });
const userSchema = z.looseObject({ id: z.number().int() });
const fileSchema = z.looseObject({
  file_id: z.string().min(1),
  file_size: z.number().int().nonnegative().optional(),
});

/** The message a reply answers: what MyHQ needs of it is its id and text (or caption). */
const repliedSchema = z.looseObject({
  message_id: z.number().int(),
  text: z.string().optional(),
  caption: z.string().optional(),
});

export const messageSchema = z.looseObject({
  message_id: z.number().int(),
  chat: chatSchema,
  from: userSchema.optional(),
  text: z.string().optional(),
  caption: z.string().optional(),
  reply_to_message: repliedSchema.optional(),
  voice: fileSchema.optional(),
  audio: fileSchema.extend({ file_name: z.string().optional() }).optional(),
  photo: z.array(fileSchema.extend({ width: z.number().int(), height: z.number().int() })).optional(),
  document: fileSchema.extend({ file_name: z.string().optional(), mime_type: z.string().optional() }).optional(),
});
export type TelegramMessage = z.infer<typeof messageSchema>;

export const callbackQuerySchema = z.looseObject({
  id: z.string().min(1),
  from: userSchema,
  message: z
    .looseObject({ message_id: z.number().int(), chat: chatSchema, text: z.string().optional(), caption: z.string().optional() })
    .optional(),
  data: z.string().optional(),
});
export type CallbackQuery = z.infer<typeof callbackQuerySchema>;

export const updateSchema = z.looseObject({
  update_id: z.number().int().nonnegative(),
  message: messageSchema.optional(),
  callback_query: callbackQuerySchema.optional(),
});
export type Update = z.infer<typeof updateSchema>;

/** Only the id is required to move the offset past an update we cannot read. */
const rawUpdatesSchema = z.array(z.looseObject({ update_id: z.number().int().nonnegative() }));

export type ParsedUpdate =
  | { ok: true; updateId: number; update: Update }
  | { ok: false; updateId: number; error: string };

/** Validates one raw update. */
export function parseUpdate(raw: { update_id: number }): ParsedUpdate {
  const parsed = updateSchema.safeParse(raw);
  if (parsed.success) return { ok: true, updateId: parsed.data.update_id, update: parsed.data };
  const error = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(update)"}: ${issue.message}`).join("; ");
  return { ok: false, updateId: raw.update_id, error };
}

export type InlineKeyboard = { inline_keyboard: { text: string; callback_data: string }[][] };

export type BotCommand = { command: string; description: string };

const envelopeSchema = z.looseObject({
  ok: z.boolean(),
  result: z.unknown().optional(),
  description: z.string().optional(),
  error_code: z.number().optional(),
});

/** A Bot API error. Its message never contains the token. */
export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | null,
    description: string,
  ) {
    super(`Telegram ${method} failed${code ? ` (${code})` : ""}: ${description}`);
    this.name = "TelegramError";
  }
}

/** Name and system code of a fetch failure, never its URL (which holds the token). */
function networkError(error: unknown): string {
  if (!(error instanceof Error)) return "network error";
  const cause = (error as { cause?: { code?: unknown } }).cause;
  return typeof cause?.code === "string" ? `${error.name} (${cause.code})` : error.name;
}

/**
 * Minimal Bot API client over `fetch`. The token only appears in request
 * URLs, never in errors or logs.
 */
export class Telegram {
  constructor(
    private readonly token: string,
    private readonly apiBase: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  async call<T>(
    method: string,
    params: Record<string, unknown>,
    schema: z.ZodType<T>,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiBase}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal,
      });
    } catch (error) {
      throw new TelegramError(method, null, networkError(error));
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new TelegramError(method, response.status, "the answer is not JSON");
    }
    const envelope = envelopeSchema.safeParse(body);
    if (!envelope.success) throw new TelegramError(method, response.status, "unexpected answer");
    if (!envelope.data.ok) {
      throw new TelegramError(method, envelope.data.error_code ?? response.status, envelope.data.description ?? "not ok");
    }
    const result = schema.safeParse(envelope.data.result);
    if (!result.success) throw new TelegramError(method, response.status, "unexpected result");
    return result.data;
  }

  /** Long polling. Returns raw updates (validated one by one by the caller). */
  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal) {
    return this.call(
      "getUpdates",
      { offset, timeout: timeoutSec, allowed_updates: ["message", "callback_query"] },
      rawUpdatesSchema,
      { timeoutMs: (timeoutSec + 15) * 1000, signal },
    );
  }

  async sendMessage(chatId: string, text: string, replyMarkup?: InlineKeyboard): Promise<number> {
    const sent = await this.call(
      "sendMessage",
      {
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      },
      z.looseObject({ message_id: z.number().int() }),
    );
    return sent.message_id;
  }

  /** Replaces a message's text; without `replyMarkup`, its buttons go away. */
  async editMessageText(chatId: string, messageId: number, text: string, replyMarkup?: InlineKeyboard): Promise<void> {
    await this.call(
      "editMessageText",
      { chat_id: chatId, message_id: messageId, text, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) },
      z.unknown(),
    );
  }

  /** Replaces the caption of a photo, a video or a sound; without `replyMarkup`, its buttons go away. */
  async editMessageCaption(chatId: string, messageId: number, caption: string, replyMarkup?: InlineKeyboard): Promise<void> {
    await this.call(
      "editMessageCaption",
      { chat_id: chatId, message_id: messageId, caption, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) },
      z.unknown(),
    );
  }

  async answerCallbackQuery(id: string, text?: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) }, z.unknown());
  }

  async sendChatAction(chatId: string, action: "typing"): Promise<void> {
    await this.call("sendChatAction", { chat_id: chatId, action }, z.unknown());
  }

  async setMyCommands(commands: BotCommand[]): Promise<void> {
    await this.call("setMyCommands", { commands }, z.unknown());
  }

  /** Downloads a file sent to the bot. Returns its size in bytes. */
  async download(fileId: string, destination: string): Promise<number> {
    const file = await this.call(
      "getFile",
      { file_id: fileId },
      z.looseObject({ file_path: z.string().min(1) }),
    );
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiBase}/file/bot${this.token}/${file.file_path}`, {
        signal: AbortSignal.timeout(300_000),
      });
    } catch (error) {
      throw new TelegramError("download", null, networkError(error));
    }
    if (!response.ok) throw new TelegramError("download", response.status, "HTTP error");
    const data = Buffer.from(await response.arrayBuffer());
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, data);
    return data.length;
  }
}
