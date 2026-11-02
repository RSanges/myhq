import { app } from "@/server/app";
import { errorResponse, readJson } from "@/server/errors";
import { toRun } from "@/server/feed";
import { startRun, startRunSchema } from "@/server/runner";

/** Starts a run of one agent. See docs/api.md. */
export async function POST(request: Request) {
  try {
    app();
    const body = startRunSchema.parse(await readJson(request));
    const run = startRun(body);
    return Response.json({ run: toRun(run) }, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
