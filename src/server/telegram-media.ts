import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { attachmentPath, attachmentsDir, attachmentType, type AttachmentKind } from "./attachments";
import type { Env } from "./config";

/** What the Bot API takes from a bot: a photo up to 10 MB, any other upload up to 50 MB. */
export const TELEGRAM_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export const TELEGRAM_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

export type TelegramMediaMethod = "sendVideo" | "sendPhoto" | "sendAudio";

/** A file an alert carries, sent with the Bot API method that fits it. */
export type TelegramMedia = { method: TelegramMediaMethod; file: string; name: string; mime: string };

/** The plan for one item: which file, how, and whether a thumbnail must be made first. */
export type MediaPlan = { fileId: number; method: TelegramMediaMethod; thumbnail: boolean };

/**
 * Picks the first file of an item that an alert can carry, in the order the
 * agent gave: a video up to 50 MB (sendVideo), an image up to 10 MB
 * (sendPhoto), a sound up to 50 MB (sendAudio). A heavier video gets a
 * thumbnail (sendPhoto) when ffmpeg is available. Null: the alert stays text,
 * with its link to the item.
 */
export function planTelegramMedia(
  files: readonly { id: number; kind: AttachmentKind; size: number }[],
  options: { ffmpeg: boolean },
): MediaPlan | null {
  for (const file of files) {
    if (file.kind === "video") {
      if (file.size <= TELEGRAM_UPLOAD_MAX_BYTES) return { fileId: file.id, method: "sendVideo", thumbnail: false };
      if (options.ffmpeg) return { fileId: file.id, method: "sendPhoto", thumbnail: true };
    }
    if (file.kind === "image" && file.size <= TELEGRAM_PHOTO_MAX_BYTES) {
      return { fileId: file.id, method: "sendPhoto", thumbnail: false };
    }
    if (file.kind === "audio" && file.size <= TELEGRAM_UPLOAD_MAX_BYTES) {
      return { fileId: file.id, method: "sendAudio", thumbnail: false };
    }
  }
  return null;
}

const run = promisify(execFile);

/** HQ_FFMPEG_BIN: the ffmpeg binary to make thumbnails with. Optional, absent by default (portability). */
export function ffmpegBin(env: Env): string | null {
  return env.HQ_FFMPEG_BIN?.trim() || null;
}

/** Makes (once) a JPEG thumbnail of a video next to its copy. Null when ffmpeg fails. */
async function thumbnailOf(ffmpeg: string, video: string, target: string): Promise<string | null> {
  if (fs.existsSync(target)) return target;
  try {
    await run(ffmpeg, ["-y", "-loglevel", "error", "-i", video, "-vf", "thumbnail,scale=960:-2", "-frames:v", "1", target], {
      timeout: 60_000,
      windowsHide: true,
    });
    return fs.existsSync(target) && fs.statSync(target).size <= TELEGRAM_PHOTO_MAX_BYTES ? target : null;
  } catch (error) {
    console.warn(`[notify] thumbnail failed (${error instanceof Error ? error.message.split("\n")[0] : "unknown error"})`);
    return null;
  }
}

/**
 * The media an alert about an item carries, from its stored files (copies in
 * `dataDir`), or null when none fits (the alert is then text with its link).
 */
export async function telegramMediaFor(
  dataDir: string,
  approvalId: number,
  files: readonly { id: number; name: string; mime: string; size: number }[],
  env: Env,
): Promise<TelegramMedia | null> {
  const ffmpeg = ffmpegBin(env);
  const typed = files.map((file) => ({ ...file, kind: attachmentType(file.name)?.kind ?? ("pdf" as const) }));
  const plan = planTelegramMedia(typed, { ffmpeg: ffmpeg !== null });
  if (!plan) return null;
  const chosen = typed.find((file) => file.id === plan.fileId)!;
  const copy = attachmentPath(dataDir, approvalId, chosen.id, chosen.name);
  if (!fs.existsSync(copy)) return null;
  if (!plan.thumbnail) return { method: plan.method, file: copy, name: chosen.name, mime: chosen.mime };
  const thumb = await thumbnailOf(ffmpeg!, copy, path.join(attachmentsDir(dataDir, approvalId), `thumb-${chosen.id}.jpg`));
  if (!thumb) return null;
  return { method: "sendPhoto", file: thumb, name: `${path.parse(chosen.name).name}.jpg`, mime: "image/jpeg" };
}
