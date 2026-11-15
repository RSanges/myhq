import { connection } from "next/server";
import { approvalFileResponse } from "@/server/approval-files";

type Params = { params: Promise<{ id: string; fileId: string }> };

/** A file joined to an item: see approvalFileResponse and docs/api.md. */
async function serve(request: Request, ctx: Params): Promise<Response> {
  await connection();
  const { id, fileId } = await ctx.params;
  return approvalFileResponse(request, id, fileId);
}

export const GET = serve;
export const HEAD = serve;
