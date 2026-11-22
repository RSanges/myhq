import { z } from "zod";
import { app } from "@/server/app";
import { decideApproval, decisionSchema } from "@/server/approvals";
import { APPROVAL_SELECT, toApproval, type ApprovalRowWithAction } from "@/server/feed";
import { errorResponse, HqError, readJson } from "@/server/errors";

const idSchema = z.coerce.number().int().positive();

/** The whole item, which the history of `GET /api/state` only summarises. See docs/api.md. */
export async function GET(_request: Request, ctx: RouteContext<"/api/approvals/[id]">) {
  try {
    const { id: rawId } = await ctx.params;
    const id = idSchema.safeParse(rawId);
    if (!id.success) throw new HqError("INVALID_INPUT", 400, "The approval id must be a positive integer.");
    const { db } = app();
    const row = db.prepare(`${APPROVAL_SELECT} WHERE a.id = ?`).get(id.data) as ApprovalRowWithAction | undefined;
    if (!row) throw new HqError("APPROVAL_NOT_FOUND", 404, `No approval #${id.data}.`);
    return Response.json({ approval: toApproval(row) });
  } catch (error) {
    return errorResponse(error);
  }
}

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
