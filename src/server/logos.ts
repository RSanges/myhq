import fs from "node:fs";
import path from "node:path";
import { isInside, type HqConfig } from "./config";
import { HqError } from "./errors";
import { loadHome, type Room } from "./rooms";
import { sniffImageType } from "./sprites";

// The logo of a room's project (room.json `logo`, docs/home-layout.md), drawn
// on the room's signboard on the floor. Served from the path of the validated
// room.json, never from the URL, like the character sheets.

/** A logo is a small image; anything bigger is not one. */
export const LOGO_MAX_BYTES = 1024 * 1024;

const stat = (file: string): fs.Stats | null => {
  try {
    const found = fs.statSync(file);
    return found.isFile() ? found : null;
  } catch {
    return null;
  }
};

/** URL of the room's logo when it declares one that exists, otherwise null. The version follows the file, so a new logo shows up at once. */
export function logoUrl(room: Room): string | null {
  const found = room.logo ? stat(room.logo) : null;
  if (!found) return null;
  return `/api/rooms/${encodeURIComponent(room.name)}/logo?v=${Math.round(found.mtimeMs).toString(36)}`;
}

/** An SVG document (its first tag, after an optional XML declaration and comments), or not. */
export function isSvg(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 1024).toString("utf8").replace(/^﻿/, "");
  return /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head);
}

function notFound(message: string): HqError {
  return new HqError("LOGO_NOT_FOUND", 404, message);
}

/**
 * The logo of a room: inside the room directory once symbolic links are
 * resolved, under LOGO_MAX_BYTES, really a PNG, a WebP or an SVG. An SVG is
 * served with a policy that runs nothing in it, should it be opened alone.
 */
export function logoResponse(request: Request, config: HqConfig, roomName: string): Response {
  const home = loadHome(config.home);
  const room = home.rooms.find((candidate) => candidate.name === roomName);
  if (!room) throw new HqError("ROOM_NOT_FOUND", 404, `No room "${roomName}" in ${path.join(config.home, "rooms")}.`);
  if (!room.logo) throw notFound(`Room "${roomName}" declares no logo.`);
  let real: string;
  try {
    real = fs.realpathSync(room.logo);
    if (!isInside(fs.realpathSync(room.dir), real)) throw notFound("The logo must stay inside the room directory.");
  } catch (error) {
    if (error instanceof HqError) throw error;
    throw notFound(`The logo of "${roomName}" does not exist.`);
  }
  const found = stat(real);
  if (!found) throw notFound(`The logo of "${roomName}" is not a file.`);
  if (found.size > LOGO_MAX_BYTES) throw notFound(`The logo of "${roomName}" is larger than ${LOGO_MAX_BYTES} bytes.`);

  const etag = `"${Math.round(found.mtimeMs).toString(16)}-${found.size.toString(16)}"`;
  const headers: Record<string, string> = { ETag: etag, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" };
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  const bytes = fs.readFileSync(real);
  const type = sniffImageType(bytes) ?? (isSvg(bytes) ? "image/svg+xml" : null);
  if (!type) throw notFound(`The logo of "${roomName}" is not a PNG, WebP or SVG image.`);
  if (type === "image/svg+xml") headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
  return new Response(new Uint8Array(bytes), { headers: { ...headers, "Content-Type": type } });
}
