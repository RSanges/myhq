import { connection } from "next/server";
import { app } from "@/server/app";
import { errorResponse } from "@/server/errors";
import { logoResponse } from "@/server/logos";

type Params = { params: Promise<{ room: string }> };

/** The logo of a room's project, from the path in its validated room.json (`logo`). See docs/api.md. */
export async function GET(request: Request, ctx: Params) {
  await connection();
  try {
    const { room } = await ctx.params;
    const { config } = app();
    return logoResponse(request, config, room);
  } catch (error) {
    return errorResponse(error);
  }
}
