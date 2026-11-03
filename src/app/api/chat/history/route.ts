import { connection, type NextRequest } from "next/server";
import { z } from "zod";
import { app } from "@/server/app";
import { listChatHistory } from "@/server/chat-history";
import { errorResponse, HqError } from "@/server/errors";

const limitSchema = z.coerce.number().int().min(1).max(200);

/** The latest messages of the assistant's conversation, oldest first. See docs/api.md. */
export async function GET(request: NextRequest) {
  await connection();
  try {
    const raw = request.nextUrl.searchParams.get("limit");
    const limit = raw === null ? 50 : limitSchema.safeParse(raw);
    if (typeof limit !== "number" && !limit.success) {
      throw new HqError("INVALID_INPUT", 400, "limit must be an integer from 1 to 200.");
    }
    const { db } = app();
    return Response.json({ messages: listChatHistory(db, typeof limit === "number" ? limit : limit.data) });
  } catch (error) {
    return errorResponse(error);
  }
}
