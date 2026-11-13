import { app } from "@/server/app";
import { errorResponse } from "@/server/errors";
import { archiveRoom } from "@/server/room-manage";
import { idSchema } from "@/server/rooms";
import { buildSettingsView } from "@/server/settings";

type Params = { params: Promise<{ room: string }> };

/** Archives a room: out of the floor and the scheduler, nothing moved on disk. Returns the settings. See docs/api.md. */
export async function POST(_request: Request, ctx: Params) {
  try {
    const room = idSchema.parse((await ctx.params).room);
    const { config, db } = app();
    archiveRoom(config, db, room);
    return Response.json({ settings: buildSettingsView(config, db) });
  } catch (error) {
    return errorResponse(error);
  }
}
