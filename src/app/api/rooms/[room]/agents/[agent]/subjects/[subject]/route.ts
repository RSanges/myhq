import { app } from "@/server/app";
import { errorResponse, readJson } from "@/server/errors";
import { findAgent } from "@/server/runner";
import { subjectIdSchema, toSubject, updateSubject, updateSubjectSchema } from "@/server/subjects";

type Params = { params: Promise<{ room: string; agent: string; subject: string }> };

/** Renames a subject (`title`), archives or reopens it (`status`). See docs/api.md. */
export async function PATCH(request: Request, ctx: Params) {
  try {
    const params = await ctx.params;
    const id = subjectIdSchema.parse(params.subject);
    const patch = updateSubjectSchema.parse(await readJson(request));
    const { config, db } = app();
    const found = findAgent(config, params.room, params.agent);
    return Response.json({ subject: toSubject(updateSubject(db, found.room.name, found.agent.id, id, patch)) });
  } catch (error) {
    return errorResponse(error);
  }
}
