import { connection } from "next/server";
import { app } from "@/server/app";
import { errorResponse } from "@/server/errors";
import { deletionCheck } from "@/server/room-manage";
import { idSchema } from "@/server/rooms";

type Params = { params: Promise<{ room: string }> };

/** What deleting a room would do, and what blocks it now. Read only. See docs/api.md. */
export async function GET(_request: Request, ctx: Params) {
  await connection();
  try {
    const room = idSchema.parse((await ctx.params).room);
    const { config, db } = app();
    return Response.json({ check: deletionCheck(config, db, room) });
  } catch (error) {
    return errorResponse(error);
  }
}
