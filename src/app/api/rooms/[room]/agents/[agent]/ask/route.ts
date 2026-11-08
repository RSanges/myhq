import { connection } from "next/server";
import { askAgent, askSchema, readDiscussion, resetDiscussion, toQuestion } from "@/server/agent-questions";
import { app } from "@/server/app";
import { errorResponse, readJson } from "@/server/errors";
import { findAgent } from "@/server/runner";

type Params = { params: Promise<{ room: string; agent: string }> };

/** The discussion of the owner with an agent: its questions and answers, oldest first. See docs/api.md. */
export async function GET(_request: Request, ctx: Params) {
  await connection();
  try {
    const { room, agent } = await ctx.params;
    const { config, db } = app();
    const found = findAgent(config, room, agent);
    const questions = readDiscussion(db, found.room.name, found.agent.id).map(toQuestion);
    return Response.json({
      agent: { room: found.room.name, id: found.agent.id, name: found.agent.name },
      questions,
      busy: questions.some((question) => question.status === "running"),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Asks the agent a question, answered in the background (not a run). See docs/api.md. */
export async function POST(request: Request, ctx: Params) {
  try {
    const { room, agent } = await ctx.params;
    const body = askSchema.parse(await readJson(request));
    const { config } = app();
    const question = askAgent({ room, agent, question: body.question }, { config });
    return Response.json({ question: toQuestion(question) }, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}

/** A new discussion with the agent: the questions leave the sheet, their cost stays metered. See docs/api.md. */
export async function DELETE(_request: Request, ctx: Params) {
  try {
    const { room, agent } = await ctx.params;
    const { config, db } = app();
    const found = findAgent(config, room, agent);
    return Response.json({ cleared: resetDiscussion(db, found.room.name, found.agent.id) });
  } catch (error) {
    return errorResponse(error);
  }
}
