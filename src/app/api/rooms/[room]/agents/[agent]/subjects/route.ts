import { connection } from "next/server";
import { app } from "@/server/app";
import { errorResponse, readJson } from "@/server/errors";
import { findAgent } from "@/server/runner";
import { createSubject, createSubjectSchema, listSubjects, toSubject } from "@/server/subjects";

type Params = { params: Promise<{ room: string; agent: string }> };

/** The open subjects of an agent, oldest first; with `?archived=1` its archived ones, the latest first. See docs/api.md. */
export async function GET(request: Request, ctx: Params) {
  await connection();
  try {
    const { room, agent } = await ctx.params;
    const archived = new URL(request.url).searchParams.get("archived") === "1";
    const { config, db } = app();
    const found = findAgent(config, room, agent);
    return Response.json({ subjects: listSubjects(db, found.room.name, found.agent.id, archived).map(toSubject) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Opens a new subject with the agent; without a title it takes the owner's first message in it. See docs/api.md. */
export async function POST(request: Request, ctx: Params) {
  try {
    const { room, agent } = await ctx.params;
    const body = createSubjectSchema.parse(await readJson(request));
    const { config, db } = app();
    const found = findAgent(config, room, agent);
    return Response.json({ subject: toSubject(createSubject(db, found.room.name, found.agent.id, body.title)) }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
