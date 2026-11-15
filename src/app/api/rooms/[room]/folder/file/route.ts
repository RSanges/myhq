import { connection } from "next/server";
import { folderFileResponse } from "@/server/folder-routes";

type Params = { params: Promise<{ room: string }> };

/** One file of a room folder (`?path=`), with range requests; anything but a known media kind is a download only. See docs/api.md. */
async function serve(request: Request, ctx: Params): Promise<Response> {
  await connection();
  return folderFileResponse(request, (await ctx.params).room);
}

export const GET = serve;
export const HEAD = serve;
