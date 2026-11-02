import { app } from "@/server/app";
import { errorResponse, readJson } from "@/server/errors";
import { armSchema, setArmed } from "@/server/routines";

type Params = { params: Promise<{ room: string; agent: string }> };

/** Arms or disarms the routines of an agent. See docs/api.md. */
export async function PATCH(request: Request, ctx: Params) {
  try {
    const { room, agent } = await ctx.params;
    const body = armSchema.parse(await readJson(request));
    const { config, db } = app();
    const armed = setArmed(config, db, room, agent, body.armed);
    return Response.json({ agent: { room, id: agent, armed } });
  } catch (error) {
    return errorResponse(error);
  }
}
