import { openOrderResponse } from "@/server/folder-routes";

type Params = { params: Promise<{ room: string }> };

/** Opens an order of a room that takes orders: JSON `{ client, subject }`. See docs/api.md. */
export async function POST(request: Request, ctx: Params) {
  return openOrderResponse(request, (await ctx.params).room);
}
