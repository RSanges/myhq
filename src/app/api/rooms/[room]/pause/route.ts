import { app } from "@/server/app";
import { errorResponse } from "@/server/errors";
import { pauseRoom } from "@/server/room-manage";
import { idSchema } from "@/server/rooms";
import { buildSettingsView } from "@/server/settings";

type Params = { params: Promise<{ room: string }> };

/** Pauses a room: disarms its armed routines and remembers them. Returns the settings. See docs/api.md. */
export async function POST(_request: Request, ctx: Params) {
  try {
    const room = idSchema.parse((await ctx.params).room);
    const { config, db } = app();
    pauseRoom(config, db, room);
    return Response.json({ settings: buildSettingsView(config, db) });
  } catch (error) {
    return errorResponse(error);
  }
}
