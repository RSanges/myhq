import { connection, type NextRequest } from "next/server";
import { z } from "zod";
import { app } from "@/server/app";
import { errorResponse, HqError } from "@/server/errors";
import { listFirings, schedulerInfo } from "@/server/routines";

const limitSchema = z.coerce.number().int().min(1).max(500);

/** The scheduler's state and the journal of routine firings. See docs/api.md. */
export async function GET(request: NextRequest) {
  await connection();
  try {
    const raw = request.nextUrl.searchParams.get("limit");
    const limit = raw === null ? 50 : limitSchema.safeParse(raw);
    if (typeof limit !== "number" && !limit.success) {
      throw new HqError("INVALID_INPUT", 400, "limit must be an integer from 1 to 500.");
    }
    const { config, db } = app();
    return Response.json({
      scheduler: schedulerInfo(config),
      firings: listFirings(db, typeof limit === "number" ? limit : limit.data),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
