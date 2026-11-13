import { app } from "@/server/app";
import { errorResponse, readJson } from "@/server/errors";
import { removeAgent } from "@/server/room-manage";
import { idSchema } from "@/server/rooms";
import { armSchema, setArmed } from "@/server/routines";
import { buildSettingsView } from "@/server/settings";

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

/** Removes an agent from its room (its block of room.json, nothing else). See docs/api.md. */
export async function DELETE(_request: Request, ctx: Params) {
  try {
    const { room, agent } = await ctx.params;
    const { config, db } = app();
    removeAgent(config, db, idSchema.parse(room), idSchema.parse(agent));
    return Response.json({ settings: buildSettingsView(config, db) });
  } catch (error) {
    return errorResponse(error);
  }
}
