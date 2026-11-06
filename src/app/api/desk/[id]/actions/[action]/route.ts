import { deskActionResponse } from "@/server/desk";

/** An action of a desk object (add an item, mark one done), run by a command of the home. See docs/api.md. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string; action: string }> }) {
  const { id, action } = await ctx.params;
  return deskActionResponse(id, action, request);
}
