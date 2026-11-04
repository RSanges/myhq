import { connection, type NextRequest } from "next/server";
import { z } from "zod";
import { app } from "@/server/app";
import { errorResponse, HqError } from "@/server/errors";
import { loadHome } from "@/server/rooms";
import { agentRoutines, listFirings, schedulerInfo } from "@/server/routines";

const limitSchema = z.coerce.number().int().min(1).max(500);

/** The scheduler's state, the journal of routine firings and the routines of each agent. See docs/api.md. */
export async function GET(request: NextRequest) {
  await connection();
  try {
    const raw = request.nextUrl.searchParams.get("limit");
    const limit = raw === null ? 50 : limitSchema.safeParse(raw);
    if (typeof limit !== "number" && !limit.success) {
      throw new HqError("INVALID_INPUT", 400, "limit must be an integer from 1 to 500.");
    }
    const { config, db } = app();
    const scheduler = schedulerInfo(config);
    return Response.json({
      scheduler,
      firings: listFirings(db, typeof limit === "number" ? limit : limit.data),
      agents: agentRoutines(db, loadHome(config.home), new Date(), scheduler.timeZone),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
