import fs from "node:fs";
import { z } from "zod";
import { app } from "./app";
import { attachmentType, findApprovalFile } from "./attachments";
import { errorResponse, HqError } from "./errors";
import { fileResponse, SANDBOX_POLICY } from "./file-response";

const idSchema = z.coerce.number().int().positive();

/**
 * GET and HEAD /api/approvals/<id>/files/<fileId>, apart from the route file
 * so that tests can call it: a file joined to an item, served from the copy
 * MyHQ made at submission, with range requests (206) for the players. The
 * path on disk comes from the database only, never from the request.
 * `?download=1` asks for a download. A file of kind "file" (a client's piece,
 * a data file) is a download only: application/octet-stream, attachment,
 * nosniff and a sandbox policy, so that the browser never renders an svg.
 */
export function approvalFileResponse(request: Request, rawId: string, rawFileId: string): Response {
  try {
    const id = idSchema.safeParse(rawId);
    const fileId = idSchema.safeParse(rawFileId);
    if (!id.success || !fileId.success) throw new HqError("INVALID_INPUT", 400, "The ids must be positive integers.");
    const { config, db } = app();
    const found = findApprovalFile(db, config.dataDir, id.data, fileId.data);
    if (!found || !fs.existsSync(found.file)) {
      throw new HqError("FILE_NOT_FOUND", 404, `Approval #${id.data} has no file #${fileId.data}.`);
    }
    const downloadOnly = attachmentType(found.name)?.kind === "file";
    const response = fileResponse(request, {
      path: found.file,
      name: found.name,
      mime: downloadOnly ? "application/octet-stream" : found.mime,
      etag: `"${found.sha256}"`,
      immutable: true,
      download: downloadOnly || new URL(request.url).searchParams.get("download") === "1",
    });
    if (downloadOnly) response.headers.set("Content-Security-Policy", SANDBOX_POLICY);
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
