import { receivedResponse } from "@/server/folder-routes";

type Params = { params: Promise<{ room: string }> };

/** The owner drops files into the `recu/` of a room or of one of its orders (multipart: `file` parts, optional `order`). See docs/api.md. */
export async function POST(request: Request, ctx: Params) {
  return receivedResponse(request, (await ctx.params).room);
}
