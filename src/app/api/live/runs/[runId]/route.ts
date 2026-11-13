import { connection } from "next/server";
import { liveRunResponse } from "@/server/live-routes";

type Params = { params: Promise<{ runId: string }> };

/** One run of the surveillance room, for its detail panel: its tile and its statuses. See docs/api.md. */
export async function GET(_request: Request, ctx: Params) {
  await connection();
  return liveRunResponse((await ctx.params).runId);
}
