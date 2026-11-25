import { z } from "zod";
import { app } from "./app";
import { attachmentMaxBytes } from "./attachments";
import { errorResponse, HqError } from "./errors";
import { fileResponse } from "./file-response";
import { waitTotals } from "./live-activity";
import { liveFile, readLiveRoom, readLiveRun } from "./live-room";
import { listQueue } from "./queue";
import { loadHome } from "./rooms";

// The answers of the surveillance room's routes (src/app/api/live), apart from
// the route files so that tests can call them: a route only awaits
// `connection()` first. See docs/api.md.

/** The window of the wait totals of GET /api/live: the last day. */
const WAITS_WINDOW_MS = 24 * 60 * 60 * 1000;

const idSchema = z.coerce.number().int().positive();

/** GET /api/live: the tiles of the runs in progress and of those ended under 5 minutes ago, the queue, and the waits of the last day. */
export function liveRoomResponse(): Response {
  try {
    const { config, db } = app();
    const now = Date.now();
    const home = loadHome(config.home);
    return Response.json({
      now: new Date(now).toISOString(),
      tiles: readLiveRoom(db, home, config.runsDir, now),
      // What waits and why (the queue of the desk), and how long each agent waited over the last day (task_waits).
      queue: listQueue(db, config, home),
      waits: waitTotals(db, now - WAITS_WINDOW_MS, now).map((each) => {
        const agent = home.rooms.find((room) => room.name === each.room)?.agents.find((one) => one.id === each.agentId);
        return { ...each, agentName: agent?.name ?? each.agentId };
      }),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** GET /api/live/runs/<id>: one run for the detail panel, its tile and its statuses. */
export function liveRunResponse(rawId: string): Response {
  try {
    const id = idSchema.safeParse(rawId);
    if (!id.success) throw new HqError("INVALID_INPUT", 400, "The run id must be a positive integer.");
    const { config, db } = app();
    return Response.json(readLiveRun(db, loadHome(config.home), config.runsDir, id.data));
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * GET and HEAD /api/live/runs/<id>/file?path=<relative path>: a media file of
 * the run, read where the agent wrote it, with range requests for the players.
 * Served only when the run showed it or it matches the agent's patterns and
 * was written during the run (liveFile): anything else is a 404 that does not
 * tell whether the file exists. The file may change: weak ETag from its size
 * and time, revalidated each time.
 */
export function liveFileResponse(request: Request, rawId: string): Response {
  try {
    const id = idSchema.safeParse(rawId);
    const raw = new URL(request.url).searchParams.get("path");
    if (!id.success || !raw) throw new HqError("INVALID_INPUT", 400, "A positive run id and a path are required.");
    const { config, db } = app();
    const file = liveFile(db, loadHome(config.home), id.data, raw, attachmentMaxBytes(process.env));
    return fileResponse(request, {
      path: file.path,
      fd: file.fd,
      name: file.name,
      mime: file.mime,
      etag: `W/"${file.size}-${Math.floor(file.mtimeMs)}"`,
      immutable: false,
      download: false,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
