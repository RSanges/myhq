import { app } from "@/server/app";
import { deskObjectSchema, deskSeenResponse } from "@/server/desk";
import { errorResponse, HqError } from "@/server/errors";

/** The owner opened the page of a desk object: what its unread sources counted is seen. See docs/api.md. */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id: rawId } = await ctx.params;
    const id = deskObjectSchema.shape.id.safeParse(rawId);
    if (!id.success) throw new HqError("INVALID_INPUT", 400, "The object id is lowercase letters, digits and hyphens.");
    app();
    return deskSeenResponse(id.data);
  } catch (error) {
    return errorResponse(error);
  }
}
