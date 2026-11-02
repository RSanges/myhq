import { connection } from "next/server";
import { assistantStatus } from "@/assistant/status";
import { app, loadAndSyncHome } from "@/server/app";
import { errorResponse } from "@/server/errors";
import { getState } from "@/server/feed";

/** Snapshot for the interface, to load before following /api/events. See docs/api.md. */
export async function GET() {
  await connection();
  try {
    const { config, db } = app();
    return Response.json({ ...getState(db, loadAndSyncHome(config, db)), assistant: assistantStatus() });
  } catch (error) {
    return errorResponse(error);
  }
}
