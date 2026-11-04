import fs from "node:fs";
import { connection } from "next/server";
import { z } from "zod";
import { app } from "@/server/app";
import { findApprovalFile } from "@/server/attachments";
import { errorResponse, HqError } from "@/server/errors";
import { fileResponse } from "@/server/file-response";

const idSchema = z.coerce.number().int().positive();

type Params = { params: Promise<{ id: string; fileId: string }> };

/**
 * A file joined to an item, served from the copy MyHQ made at submission, with
 * range requests (206) for the players. The path on disk comes from the
 * database only, never from the request. `?download=1` asks for a download.
 * See docs/api.md.
 */
async function serve(request: Request, ctx: Params): Promise<Response> {
  await connection();
  try {
    const { id: rawId, fileId: rawFileId } = await ctx.params;
    const id = idSchema.safeParse(rawId);
    const fileId = idSchema.safeParse(rawFileId);
    if (!id.success || !fileId.success) throw new HqError("INVALID_INPUT", 400, "The ids must be positive integers.");
    const { config, db } = app();
    const found = findApprovalFile(db, config.dataDir, id.data, fileId.data);
    if (!found || !fs.existsSync(found.file)) {
      throw new HqError("FILE_NOT_FOUND", 404, `Approval #${id.data} has no file #${fileId.data}.`);
    }
    const download = new URL(request.url).searchParams.get("download") === "1";
    return fileResponse(request, { path: found.file, name: found.name, mime: found.mime, sha256: found.sha256, download });
  } catch (error) {
    return errorResponse(error);
  }
}

export const GET = serve;
export const HEAD = serve;
