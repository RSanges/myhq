import { app } from "@/server/app";
import { errorResponse, readJson } from "@/server/errors";
import { toRun } from "@/server/feed";
import { startRun, startRunSchema } from "@/server/runner";
import { authorizeTrigger } from "@/server/trigger";

/** Starts a run of one agent. See docs/api.md. */
export async function POST(request: Request) {
  try {
    const { config } = app();
    const body = startRunSchema.parse(await readJson(request));
    authorizeTrigger(config, request.headers.get("authorization"), body.reason);
    const run = startRun(body, { config });
    return Response.json({ run: toRun(run) }, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
