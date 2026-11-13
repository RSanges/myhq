import { connection } from "next/server";
import { liveFileResponse } from "@/server/live-routes";

type Params = { params: Promise<{ runId: string }> };

/** A media file of a run of the surveillance room (see liveFileResponse). See docs/api.md. */
async function serve(request: Request, ctx: Params): Promise<Response> {
  await connection();
  return liveFileResponse(request, (await ctx.params).runId);
}

export const GET = serve;
export const HEAD = serve;
