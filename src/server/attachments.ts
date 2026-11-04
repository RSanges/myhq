import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { isInside, type Env } from "./config";
import type { Db } from "./db";

/**
 * Files an agent joins to an item (hq_submit `attachments`): a render to
 * validate (video, image, sound, 3D part, PDF). At submission MyHQ copies each
 * one into `<home>/data/attachments/<approvalId>/`, so what the owner validates
 * no longer changes when the agent touches its file again. The copy on disk is
 * named from integers and a whitelisted extension only; the original name is
 * metadata in `approval_files`.
 */

export type AttachmentKind = "video" | "image" | "audio" | "model" | "pdf";

/** The accepted extensions, with their MIME type and kind. Anything else is refused. */
export const ATTACHMENT_TYPES: Readonly<Record<string, { mime: string; kind: AttachmentKind }>> = {
  ".mp4": { mime: "video/mp4", kind: "video" },
  ".webm": { mime: "video/webm", kind: "video" },
  ".mov": { mime: "video/quicktime", kind: "video" },
  ".png": { mime: "image/png", kind: "image" },
  ".jpg": { mime: "image/jpeg", kind: "image" },
  ".jpeg": { mime: "image/jpeg", kind: "image" },
  ".webp": { mime: "image/webp", kind: "image" },
  ".gif": { mime: "image/gif", kind: "image" },
  ".wav": { mime: "audio/wav", kind: "audio" },
  ".mp3": { mime: "audio/mpeg", kind: "audio" },
  ".ogg": { mime: "audio/ogg", kind: "audio" },
  ".flac": { mime: "audio/flac", kind: "audio" },
  ".m4a": { mime: "audio/mp4", kind: "audio" },
  ".3mf": { mime: "model/3mf", kind: "model" },
  ".stl": { mime: "model/stl", kind: "model" },
  ".glb": { mime: "model/gltf-binary", kind: "model" },
  ".pdf": { mime: "application/pdf", kind: "pdf" },
};

export const MAX_ATTACHMENTS = 10;
/** Default cap on one file, in MB (HQ_ATTACHMENT_MAX_MB overrides it). */
export const DEFAULT_ATTACHMENT_MAX_MB = 200;

export const attachmentInputSchema = z.strictObject({
  path: z.string().trim().min(1).max(1_000),
  caption: z.string().trim().min(1).max(1_000).optional(),
});
export type AttachmentInput = z.infer<typeof attachmentInputSchema>;

export class AttachmentError extends Error {}

/** The cap on one attached file, in bytes, from HQ_ATTACHMENT_MAX_MB (default 200 MB). */
export function attachmentMaxBytes(env: Env): number {
  const parsed = z.coerce.number().positive().max(10_000).safeParse(env.HQ_ATTACHMENT_MAX_MB?.trim() || undefined);
  return Math.round((parsed.success ? parsed.data : DEFAULT_ATTACHMENT_MAX_MB) * 1024 * 1024);
}

export function attachmentType(name: string): { ext: string; mime: string; kind: AttachmentKind } | null {
  const ext = path.extname(name).toLowerCase();
  const type = ATTACHMENT_TYPES[ext];
  return type ? { ext, ...type } : null;
}

/** An attachment checked and ready to copy. */
export type ResolvedAttachment = {
  /** Real path of the agent's file. */
  source: string;
  name: string;
  ext: string;
  mime: string;
  size: number;
  caption: string | null;
};

/**
 * Checks one attachment of an agent: a path relative to its working directory
 * (or worktree), that stays inside it once every link is followed, of an
 * accepted extension, an existing regular file, and at most `maxBytes`.
 * Throws an AttachmentError the agent can act on.
 */
export function resolveAttachment(workDir: string, input: AttachmentInput, maxBytes: number): ResolvedAttachment {
  const raw = input.path;
  // Absolute in any convention (POSIX, drive letter, UNC), whatever the machine.
  if (path.isAbsolute(raw) || path.win32.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw)) {
    throw new AttachmentError(`attachments: "${raw}" is absolute: give a path relative to your working directory.`);
  }
  if (raw.split(/[\\/]+/).includes("..")) {
    throw new AttachmentError(`attachments: "${raw}" climbs out with "..": copy the file into your working directory first.`);
  }
  const type = attachmentType(raw);
  if (!type) {
    throw new AttachmentError(
      `attachments: "${raw}" is not an accepted type (${Object.keys(ATTACHMENT_TYPES).join(", ")}).`,
    );
  }
  let root: string;
  let real: string;
  try {
    root = fs.realpathSync(workDir);
  } catch {
    throw new AttachmentError("attachments: your working directory does not exist.");
  }
  try {
    real = fs.realpathSync(path.resolve(root, raw));
  } catch {
    throw new AttachmentError(`attachments: "${raw}" does not exist in your working directory.`);
  }
  // A link that leads out of the working directory is refused like "..".
  if (!isInside(root, real) || real === root) {
    throw new AttachmentError(`attachments: "${raw}" leads out of your working directory: copy the file into it first.`);
  }
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new AttachmentError(`attachments: "${raw}" is not a file.`);
  if (stat.size === 0) throw new AttachmentError(`attachments: "${raw}" is empty.`);
  if (stat.size > maxBytes) {
    throw new AttachmentError(
      `attachments: "${raw}" is ${(stat.size / 1024 / 1024).toFixed(1)} MB, above the cap of ${(maxBytes / 1024 / 1024).toFixed(0)} MB: send a lighter render.`,
    );
  }
  return {
    source: real,
    name: path.basename(raw).slice(-200),
    ext: type.ext,
    mime: type.mime,
    size: stat.size,
    caption: input.caption ?? null,
  };
}

/** The folder of an item's copies. */
export function attachmentsDir(dataDir: string, approvalId: number): string {
  return path.join(dataDir, "attachments", String(approvalId));
}

/** Where the copy of a file sits: built from integers and a whitelisted extension, never from a request. */
export function attachmentPath(dataDir: string, approvalId: number, fileId: number, name: string): string {
  const ext = attachmentType(name)?.ext ?? "";
  return path.join(attachmentsDir(dataDir, approvalId), `${fileId}${ext}`);
}

const CHUNK = 1024 * 1024;

/** Copies a file and returns the sha256 of the bytes written, in one pass. */
export function copyWithHash(source: string, target: string): { sha256: string; size: number } {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(CHUNK);
  const input = fs.openSync(source, "r");
  let size = 0;
  try {
    const output = fs.openSync(target, "wx");
    try {
      for (;;) {
        const read = fs.readSync(input, buffer, 0, CHUNK, null);
        if (read === 0) break;
        hash.update(buffer.subarray(0, read));
        fs.writeSync(output, buffer, 0, read);
        size += read;
      }
    } finally {
      fs.closeSync(output);
    }
  } finally {
    fs.closeSync(input);
  }
  return { sha256: hash.digest("hex"), size };
}

/**
 * Copies the checked attachments of an item and records them. Called inside
 * the transaction that inserts the item: when a copy fails, the copies made so
 * far are removed and the error rolls the item back.
 */
export function storeAttachments(db: Db, dataDir: string, approvalId: number, files: readonly ResolvedAttachment[]): void {
  if (files.length === 0) return;
  const dir = attachmentsDir(dataDir, approvalId);
  fs.mkdirSync(dir, { recursive: true });
  const insert = db.prepare(
    "INSERT INTO approval_files (approval_id, name, mime, size, sha256, caption, created_at) VALUES (?, ?, ?, ?, '', ?, ?)",
  );
  const update = db.prepare("UPDATE approval_files SET size = ?, sha256 = ? WHERE id = ?");
  try {
    for (const file of files) {
      const fileId = Number(insert.run(approvalId, file.name, file.mime, file.size, file.caption, new Date().toISOString()).lastInsertRowid);
      const copied = copyWithHash(file.source, attachmentPath(dataDir, approvalId, fileId, file.name));
      update.run(copied.size, copied.sha256, fileId);
    }
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** A file of an item, as the API gives it. */
export type ApprovalFileDto = {
  id: number;
  name: string;
  mime: string;
  kind: AttachmentKind;
  size: number;
  sha256: string;
  caption: string | null;
  /** Where the copy is served: `GET /api/approvals/<id>/files/<fileId>`. */
  url: string;
};

const storedFileSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  mime: z.string(),
  size: z.number().int(),
  sha256: z.string(),
  caption: z.string().nullable(),
});

/** Selects the files of an approval `a` as one JSON array (see APPROVAL_SELECT). */
export const FILES_SELECT = `(SELECT json_group_array(json_object('id', f.id, 'name', f.name, 'mime', f.mime, 'size', f.size,
  'sha256', f.sha256, 'caption', f.caption) ORDER BY f.id) FROM approval_files f WHERE f.approval_id = a.id) AS files`;

/** Reads the `files` column of APPROVAL_SELECT; anything unreadable counts as no file. */
export function parseFiles(raw: string | null | undefined, approvalId: number): ApprovalFileDto[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const files = z.array(storedFileSchema).safeParse(parsed);
  if (!files.success) return [];
  return files.data.map((file) => ({
    ...file,
    kind: attachmentType(file.name)?.kind ?? "pdf",
    url: `/api/approvals/${approvalId}/files/${file.id}`,
  }));
}

/** One stored file of an item, with where its copy is on disk. Null when the item has no such file. */
export function findApprovalFile(
  db: Db,
  dataDir: string,
  approvalId: number,
  fileId: number,
): { name: string; mime: string; size: number; sha256: string; file: string } | null {
  const row = db
    .prepare("SELECT name, mime, size, sha256 FROM approval_files WHERE id = ? AND approval_id = ?")
    .get(fileId, approvalId) as { name: string; mime: string; size: number; sha256: string } | undefined;
  if (!row) return null;
  return { ...row, file: attachmentPath(dataDir, approvalId, fileId, row.name) };
}
