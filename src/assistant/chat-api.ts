import { z } from "zod";
import { app } from "../server/app";
import { DEFAULT_HISTORY_LIMIT, listChatHistory } from "../server/chat-history";
import { errorResponse, HqError, readJson } from "../server/errors";
import { toRun } from "../server/feed";
import { getChatService } from "./chat-service";

// The HTTP side of the conversation (POST /api/chat, GET and DELETE
// /api/chat/history). The routes only call these, so that tests can too: a
// route that reads `connection()` cannot run outside a request.

const limitSchema = z.coerce.number().int().min(1).max(200);

export const chatBodySchema = z.strictObject({
  text: z.string().trim().min(1).max(20_000),
  /** The agent the text is a task for; without it the chat answers. */
  to: z.strictObject({ room: z.string().min(1), agent: z.string().min(1) }).optional(),
});

/** POST /api/chat: a message to the chat, or a task for an agent. */
export async function handleChatPost(request: Request): Promise<Response> {
  try {
    const { config } = app();
    const body = chatBodySchema.parse(await readJson(request));
    const service = getChatService(config);
    if (body.to) {
      const { reply, run, messages } = service.dispatch(body.text, body.to, "desk");
      return Response.json({ ok: true, reply, dispatch: { run: toRun(run) }, messages }, { status: 202 });
    }
    if (!service.configured) {
      throw new HqError("CHAT_NOT_CONFIGURED", 404, "The conversation is not configured (no chat section in assistant.json).");
    }
    const result = await service.ask(body.text, "desk");
    return Response.json({
      ok: result.ok,
      reply: result.reply,
      ...(result.pendingConfirmation ? { pendingConfirmation: result.pendingConfirmation } : {}),
      ...(result.choices ? { choices: result.choices } : {}),
      messages: result.messages,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** GET /api/chat/history: the latest messages and the state of the turns. */
export function handleHistoryGet(request: Request): Response {
  try {
    const raw = new URL(request.url).searchParams.get("limit");
    const limit = raw === null ? DEFAULT_HISTORY_LIMIT : limitSchema.safeParse(raw);
    if (typeof limit !== "number" && !limit.success) {
      throw new HqError("INVALID_INPUT", 400, "limit must be an integer from 1 to 200.");
    }
    const { config, db } = app();
    return Response.json({
      messages: listChatHistory(db, typeof limit === "number" ? limit : limit.data),
      turn: getChatService(config).state(),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** DELETE /api/chat/history: the conversation starts over (after the turn in progress). */
export async function handleHistoryDelete(): Promise<Response> {
  try {
    const { config } = app();
    await getChatService(config).newConversation();
    return Response.json({ cleared: true });
  } catch (error) {
    return errorResponse(error);
  }
}
