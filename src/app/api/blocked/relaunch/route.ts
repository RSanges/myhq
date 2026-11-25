import { app } from "@/server/app";
import { relaunchBlocked, relaunchInputSchema } from "@/server/blocked";
import { errorResponse, readJson } from "@/server/errors";
import { toRun } from "@/server/feed";

/**
 * « Relancer » on the Standard: the tasks go back to pending and the agent is woken at once. With `answer`
 * (« Répondre »), the owner's words join them as a request of the owner. See docs/api.md.
 */
export async function POST(request: Request) {
  try {
    const { answer, ...target } = relaunchInputSchema.parse(await readJson(request));
    const { config, db } = app();
    const result = relaunchBlocked(config, db, target, {}, answer);
    return Response.json({ tasks: result.tasks, run: result.run ? toRun(result.run) : null, waiting: result.waiting });
  } catch (error) {
    return errorResponse(error);
  }
}
