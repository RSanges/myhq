import { z } from "zod";
import { app } from "@/server/app";
import { decideApproval, decisionSchema } from "@/server/approvals";
import { errorResponse, HqError, readJson } from "@/server/errors";

const idSchema = z.coerce.number().int().positive();

/** Approves, rejects or sends back a pending approval. See docs/api.md. */
export async function PATCH(request: Request, ctx: RouteContext<"/api/approvals/[id]">) {
  try {
    const { id: rawId } = await ctx.params;
    const id = idSchema.safeParse(rawId);
    if (!id.success) throw new HqError("INVALID_INPUT", 400, "The approval id must be a positive integer.");
    const decision = decisionSchema.parse(await readJson(request));
    const { config, db } = app();
    return Response.json({ approval: decideApproval(db, id.data, decision, config) });
  } catch (error) {
    return errorResponse(error);
  }
}
