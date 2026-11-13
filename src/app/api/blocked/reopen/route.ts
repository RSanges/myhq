import { app } from "@/server/app";
import { reopenBodySchema, reopenClosure } from "@/server/closures";
import { errorResponse, readJsonRequest } from "@/server/errors";
import { loadHome } from "@/server/rooms";

/** « Rouvrir » a closure by the supervisor: the entry is back on the Standard as it was, handed to the owner. See docs/api.md. */
export async function POST(request: Request) {
  try {
    const { id } = reopenBodySchema.parse(await readJsonRequest(request));
    const { config, db } = app();
    return Response.json(reopenClosure(db, loadHome(config.home), id));
  } catch (error) {
    return errorResponse(error);
  }
}
