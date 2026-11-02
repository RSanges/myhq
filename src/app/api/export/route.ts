import { app } from "@/server/app";
import { errorResponse, HqError } from "@/server/errors";
import { exportDateSchema, exportOnDemand } from "@/server/export";

/** Writes the daily export of one day (yesterday by default) now. The body is optional. See docs/api.md. */
export async function POST(request: Request) {
  try {
    const text = await request.text();
    let raw: unknown = {};
    if (text.trim()) {
      try {
        raw = JSON.parse(text);
      } catch {
        throw new HqError("INVALID_JSON", 400, "The request body must be valid JSON.");
      }
    }
    const { date } = exportDateSchema.parse(raw);
    const { config, db } = app();
    return Response.json({ export: exportOnDemand(config, db, date) });
  } catch (error) {
    return errorResponse(error);
  }
}
