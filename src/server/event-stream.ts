import { z } from "zod";
import { app } from "./app";
import { subscribeChat } from "./chat-hub";
import { errorResponse, HqError } from "./errors";
import { changesSince, currentCursor } from "./feed";
import { subscribeRoadmap } from "./roadmap";

const POLL_MS = 1_000;
const KEEPALIVE_MS = 15_000;
const cursorSchema = z.coerce.number().int().min(0);

/**
 * Server-Sent Events: new runs and run updates, events, messages and
 * approvals, read from the `changes` table, then the messages that are not
 * stored changes (roadmap, chat). See docs/api.md. Called by GET /api/events,
 * apart from the route so that tests can read the stream.
 */
export function eventStreamResponse(request: Request): Response {
  try {
    const { config, db } = app();
    const raw = new URL(request.url).searchParams.get("since") ?? request.headers.get("last-event-id");
    let cursor: number;
    if (raw === null || raw === "") {
      cursor = currentCursor(db);
    } else {
      const parsed = cursorSchema.safeParse(raw);
      if (!parsed.success) throw new HqError("INVALID_INPUT", 400, "since must be a non-negative integer.");
      cursor = parsed.data;
    }

    const encoder = new TextEncoder();
    let poll: ReturnType<typeof setInterval> | undefined;
    let keepalive: ReturnType<typeof setInterval> | undefined;
    let unsubscribeRoadmap: (() => void) | undefined;
    let unsubscribeChat: (() => void) | undefined;
    const stop = () => {
      clearInterval(poll);
      clearInterval(keepalive);
      unsubscribeRoadmap?.();
      unsubscribeChat?.();
    };

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (text: string) => controller.enqueue(encoder.encode(text));
        const tick = () => {
          try {
            const batch = changesSince(db, cursor);
            for (const item of batch.items) {
              send(`id: ${item.seq}\nevent: ${item.kind}\ndata: ${JSON.stringify(item.data)}\n\n`);
            }
            cursor = batch.cursor;
          } catch (error) {
            stop();
            controller.error(error);
          }
        };
        send(`retry: 3000\nevent: ready\ndata: ${JSON.stringify({ cursor })}\n\n`);
        tick();
        poll = setInterval(tick, POLL_MS);
        keepalive = setInterval(() => send(": keepalive\n\n"), KEEPALIVE_MS);
        // Not part of the changes table: no id, so the stream cursor does not move.
        unsubscribeRoadmap = subscribeRoadmap(config.home, () => {
          send(`event: roadmap\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
        });
        unsubscribeChat = subscribeChat((event) => {
          send(`event: chat\ndata: ${JSON.stringify(event)}\n\n`);
        });
        request.signal.addEventListener("abort", () => {
          stop();
          try {
            controller.close();
          } catch {
            // Already closed.
          }
        });
      },
      cancel: stop,
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        // no-transform keeps the response from being compressed (and buffered).
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
