import { connection } from "next/server";
import { app } from "@/server/app";
import { errorResponse } from "@/server/errors";
import { spriteResponse } from "@/server/sprites";

type Params = { params: Promise<{ room: string; agent: string }> };

/** The character sheet of an agent, from the path in its validated room.json (`?sheet=iso`: its iso sheet). See docs/api.md. */
export async function GET(request: Request, ctx: Params) {
  await connection();
  try {
    const { room, agent } = await ctx.params;
    const { config } = app();
    const kind = new URL(request.url).searchParams.get("sheet") === "iso" ? "iso" : "sprite";
    return spriteResponse(request, config, room, agent, kind);
  } catch (error) {
    return errorResponse(error);
  }
}
