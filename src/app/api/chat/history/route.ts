import { connection } from "next/server";
import { handleHistoryDelete, handleHistoryGet } from "@/assistant/chat-api";

/** The latest messages of the assistant's conversation, oldest first. See docs/api.md. */
export async function GET(request: Request) {
  await connection();
  return handleHistoryGet(request);
}

/** `/new`: the conversation starts over. See docs/api.md. */
export async function DELETE() {
  return handleHistoryDelete();
}
