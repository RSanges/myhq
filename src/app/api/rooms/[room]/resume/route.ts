import { app } from "@/server/app";
import { errorResponse } from "@/server/errors";
import { resumeRoom } from "@/server/room-manage";
import { idSchema } from "@/server/rooms";
import { buildSettingsView } from "@/server/settings";

type Params = { params: Promise<{ room: string }> };

/** Resumes a paused room: re-arms the routines it disarmed. Returns the settings. See docs/api.md. */
export async function POST(_request: Request, ctx: Params) {
  try {
    const room = idSchema.parse((await ctx.params).room);
    const { config, db } = app();
    resumeRoom(config, db, room);
    return Response.json({ settings: buildSettingsView(config, db) });
  } catch (error) {
    return errorResponse(error);
  }
}
