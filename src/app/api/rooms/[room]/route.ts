import { app } from "@/server/app";
import { errorResponse, readJson } from "@/server/errors";
import { deleteRoom, deleteRoomSchema } from "@/server/room-manage";
import { idSchema } from "@/server/rooms";
import { buildSettingsView } from "@/server/settings";

type Params = { params: Promise<{ room: string }> };

/**
 * Deletes a room: its configuration folder moves to archives/rooms/, nothing
 * else moves and nothing is erased. The body carries the room's name typed by
 * the owner. See docs/api.md.
 */
export async function DELETE(request: Request, ctx: Params) {
  try {
    const room = idSchema.parse((await ctx.params).room);
    const { confirm } = deleteRoomSchema.parse(await readJson(request));
    const { config, db } = app();
    const { destination } = deleteRoom(config, db, room, confirm);
    return Response.json({ destination, settings: buildSettingsView(config, db) });
  } catch (error) {
    return errorResponse(error);
  }
}
