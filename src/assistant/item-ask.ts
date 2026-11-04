import { z } from "zod";
import { app } from "../server/app";
import { markApprovalSeen } from "../server/approvals";
import type { Db } from "../server/db";
import { errorResponse, HqError, readJson } from "../server/errors";
import { APPROVAL_SELECT, toApproval, type ApprovalDto, type ApprovalRowWithAction } from "../server/feed";
import { strings } from "../ui/strings";
import type { ChatService, TurnResult } from "./chat-service";
import { getChatService } from "./chat-service";

// « Demander à Rom2 » on an item of « À regarder »: the request typed on the
// desk goes to the chat through the same pipeline as POST /api/chat, with the
// item as context, and the item is marked seen once the chat has answered.

/** The part of the item's body the chat reads: a long mail is cut, the chat message is limited. */
export const ITEM_BODY_LIMIT = 8_000;

export const askBodySchema = z.strictObject({ text: z.string().trim().min(1).max(2_000) });

/** The message the chat receives: the user's request, then the item (type, title, who brought it, body). */
export function itemQuestion(approval: ApprovalDto, request: string): string {
  const body = approval.body.trim();
  return strings.chat.itemContext({
    request,
    id: approval.id,
    type: approval.type,
    title: approval.title,
    agent: approval.agentId,
    room: approval.room,
    body: body.length > ITEM_BODY_LIMIT ? `${body.slice(0, ITEM_BODY_LIMIT).trimEnd()}...` : body,
  });
}

export type ItemAnswer = { result: TurnResult; approval: ApprovalDto };

/**
 * Asks the chat about an unseen item. The item is marked seen only when the
 * chat answered (`result.ok`): a failed turn (budget, timeout) leaves it in
 * « À regarder », and `result.reply` says why. Throws `APPROVAL_NOT_FOUND`,
 * `APPROVAL_NOT_WATCHABLE` (the item is not unseen) or `CHAT_NOT_CONFIGURED`.
 */
export async function askAboutItem(service: ChatService, db: Db, id: number, request: string): Promise<ItemAnswer> {
  const row = db.prepare(`${APPROVAL_SELECT} WHERE a.id = ?`).get(id) as ApprovalRowWithAction | undefined;
  if (!row) throw new HqError("APPROVAL_NOT_FOUND", 404, `No approval #${id}.`);
  const approval = toApproval(row);
  if (approval.status !== "unseen") {
    throw new HqError("APPROVAL_NOT_WATCHABLE", 409, `Approval #${id} is not waiting to be looked at.`);
  }
  if (!service.configured) {
    throw new HqError("CHAT_NOT_CONFIGURED", 404, "The conversation is not configured (no chat section in assistant.json).");
  }
  const result = await service.ask(itemQuestion(approval, request), "desk");
  return { result, approval: result.ok ? markApprovalSeen(db, id) : approval };
}

const idSchema = z.coerce.number().int().positive();

/** POST /api/approvals/[id]/ask. See docs/api.md. */
export async function handleItemAsk(request: Request, rawId: string): Promise<Response> {
  try {
    const id = idSchema.safeParse(rawId);
    if (!id.success) throw new HqError("INVALID_INPUT", 400, "The approval id must be a positive integer.");
    const body = askBodySchema.parse(await readJson(request));
    const { config, db } = app();
    const { result, approval } = await askAboutItem(getChatService(config), db, id.data, body.text);
    return Response.json({ ok: result.ok, reply: result.reply, approval, messages: result.messages });
  } catch (error) {
    return errorResponse(error);
  }
}
