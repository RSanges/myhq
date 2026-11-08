import { connection } from "next/server";
import { readThread } from "@/server/agent-thread";
import { app } from "@/server/app";
import { errorResponse } from "@/server/errors";
import { findAgent } from "@/server/runner";

type Params = { params: Promise<{ room: string; agent: string }> };

/** The thread of an agent's sheet: the discussion, its runs and its items, oldest first. See docs/api.md. */
export async function GET(_request: Request, ctx: Params) {
  await connection();
  try {
    const { room, agent } = await ctx.params;
    const { config, db } = app();
    const found = findAgent(config, room, agent);
    return Response.json({
      agent: { room: found.room.name, id: found.agent.id, name: found.agent.name },
      ...readThread(db, found.room.name, found.agent.id),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
