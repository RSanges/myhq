import { connection } from "next/server";
import { readThread } from "@/server/agent-thread";
import { app } from "@/server/app";
import { errorResponse } from "@/server/errors";
import { findAgent } from "@/server/runner";
import { subjectIdSchema } from "@/server/subjects";

type Params = { params: Promise<{ room: string; agent: string }> };

/**
 * The thread of an agent's sheet in one subject (`?subject=<id>`, left out: the general one):
 * the discussion, its runs and its items, oldest first, with the tabs. See docs/api.md.
 */
export async function GET(request: Request, ctx: Params) {
  await connection();
  try {
    const { room, agent } = await ctx.params;
    const raw = new URL(request.url).searchParams.get("subject");
    const subject = raw === null ? null : subjectIdSchema.parse(raw);
    const { config, db } = app();
    const found = findAgent(config, room, agent);
    return Response.json({
      agent: { room: found.room.name, id: found.agent.id, name: found.agent.name },
      ...readThread(db, found.room.name, found.agent.id, subject),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
