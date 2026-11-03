import { handleChatPost } from "@/assistant/chat-api";

/** A message to the assistant's chat, or a task for an agent. See docs/api.md. */
export async function POST(request: Request) {
  return handleChatPost(request);
}
