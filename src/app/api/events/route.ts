import { connection } from "next/server";
import { eventStreamResponse } from "@/server/event-stream";

/** Server-Sent Events of the app. See docs/api.md. */
export async function GET(request: Request) {
  await connection();
  return eventStreamResponse(request);
}
