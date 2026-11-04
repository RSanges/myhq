import { z } from "zod";
import { app } from "@/server/app";
import { markApprovalSeen } from "@/server/approvals";
import { errorResponse, HqError } from "@/server/errors";

const idSchema = z.coerce.number().int().positive();

/** « Vu »: an informational item leaves « À regarder » and stays in the history. See docs/api.md. */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id: rawId } = await ctx.params;
    const id = idSchema.safeParse(rawId);
    if (!id.success) throw new HqError("INVALID_INPUT", 400, "The approval id must be a positive integer.");
    const { db } = app();
    return Response.json({ approval: markApprovalSeen(db, id.data) });
  } catch (error) {
    return errorResponse(error);
  }
}
