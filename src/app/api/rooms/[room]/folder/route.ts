import { connection } from "next/server";
import { folderListingResponse } from "@/server/folder-routes";

type Params = { params: Promise<{ room: string }> };

/** The entries of a directory of a room folder (`?path=`, empty for the folder itself). See docs/api.md. */
export async function GET(request: Request, ctx: Params) {
  await connection();
  return folderListingResponse(request, (await ctx.params).room);
}
