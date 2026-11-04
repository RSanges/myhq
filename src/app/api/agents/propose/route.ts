import { app } from "@/server/app";
import { proposeAgent, proposeAgentSchema } from "@/server/agent-need";
import { errorResponse, readJson } from "@/server/errors";
import { toRun } from "@/server/feed";

/** Starts a run of the receptionist that proposes an agent for a need. See docs/api.md. */
export async function POST(request: Request) {
  try {
    const { config } = app();
    const body = proposeAgentSchema.parse(await readJson(request));
    const { run } = proposeAgent(body, { config });
    return Response.json({ run: run ? toRun(run) : null }, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
