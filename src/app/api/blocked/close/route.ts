import { app } from "@/server/app";
import { blockedTargetSchema, closeBlocked } from "@/server/blocked";
import { errorResponse, readJson } from "@/server/errors";

/** « Clore » on the Standard: the tasks are done, closed by the owner. See docs/api.md. */
export async function POST(request: Request) {
  try {
    const target = blockedTargetSchema.parse(await readJson(request));
    const { db } = app();
    return Response.json(closeBlocked(db, target));
  } catch (error) {
    return errorResponse(error);
  }
}
