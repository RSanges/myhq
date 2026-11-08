import { z } from "zod";
import { decideProposal, proposalActionSchema, toQuestion } from "@/server/agent-questions";
import { app } from "@/server/app";
import { errorResponse, readJson } from "@/server/errors";
import { toRun } from "@/server/feed";

type Params = { params: Promise<{ room: string; agent: string; question: string }> };

const questionIdSchema = z.coerce.number().int().positive();

/**
 * « Lancer le tour » or « On en parle d'abord » on the run an answer proposes:
 * the only way such a run starts. See docs/api.md.
 */
export async function POST(request: Request, ctx: Params) {
  try {
    const params = await ctx.params;
    const questionId = questionIdSchema.parse(params.question);
    const { action } = proposalActionSchema.parse(await readJson(request));
    const { config } = app();
    const { question, run } = decideProposal({ room: params.room, agent: params.agent, questionId, action }, { config });
    return Response.json({ question: toQuestion(question), run: run ? toRun(run) : null }, { status: run ? 202 : 200 });
  } catch (error) {
    return errorResponse(error);
  }
}
