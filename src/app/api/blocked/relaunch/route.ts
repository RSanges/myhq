import { app } from "@/server/app";
import { blockedTargetSchema, relaunchBlocked } from "@/server/blocked";
import { errorResponse, readJson } from "@/server/errors";
import { toRun } from "@/server/feed";

/** « Relancer » on the Standard: the tasks go back to pending and the agent is woken at once. See docs/api.md. */
export async function POST(request: Request) {
  try {
    const target = blockedTargetSchema.parse(await readJson(request));
    const { config, db } = app();
    const result = relaunchBlocked(config, db, target);
    return Response.json({ tasks: result.tasks, run: result.run ? toRun(result.run) : null, waiting: result.waiting });
  } catch (error) {
    return errorResponse(error);
  }
}
