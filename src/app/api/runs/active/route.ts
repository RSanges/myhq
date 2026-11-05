import { connection } from "next/server";
import { app } from "@/server/app";
import { errorResponse } from "@/server/errors";
import { runsInProgress } from "@/server/feed";
import { isStopping } from "@/server/runner";

/**
 * The runs in progress and whether the app is stopping: what a deployment
 * waits on (`npm run wait-idle`). See docs/api.md.
 */
export async function GET() {
  await connection();
  try {
    const { db } = app();
    const runs = runsInProgress(db);
    return Response.json({ running: runs.length, stopping: isStopping(), runs });
  } catch (error) {
    return errorResponse(error);
  }
}
