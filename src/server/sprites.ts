import fs from "node:fs";
import path from "node:path";
import { isInside, type HqConfig } from "./config";
import { HqError } from "./errors";
import { loadHome, SPRITE_EXTENSIONS, type Agent } from "./rooms";

/** A character sheet is a few tens of kilobytes; anything bigger is not one. */
export const SPRITE_MAX_BYTES = 2 * 1024 * 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** `image/png` or `image/webp` from the first bytes, or null when the file is neither. */
export function sniffImageType(bytes: Buffer): "image/png" | "image/webp" | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") {
    return "image/webp";
  }
  return null;
}

/** URL of the agent's character sheet when it declares one that exists, otherwise null (the neutral sheet). */
export function spriteUrl(room: string, agent: Agent): string | null {
  if (!agent.sprite) return null;
  try {
    if (!fs.statSync(agent.sprite).isFile()) return null;
  } catch {
    return null;
  }
  return `/api/sprites/${encodeURIComponent(room)}/${encodeURIComponent(agent.id)}`;
}

function notFound(message: string): HqError {
  return new HqError("SPRITE_NOT_FOUND", 404, message);
}

/**
 * The character sheet of an agent, served from the path declared in the
 * validated room.json (never from the URL). The file must stay inside the home
 * once symbolic links are resolved, carry a .png or .webp extension, stay under
 * SPRITE_MAX_BYTES and really be a PNG or a WebP. `ETag` follows the
 * modification time, so a redrawn sheet shows up at the next load.
 */
export function spriteResponse(request: Request, config: HqConfig, roomName: string, agentId: string): Response {
  const home = loadHome(config.home);
  const room = home.rooms.find((candidate) => candidate.name === roomName);
  if (!room) {
    const invalid = home.invalid.find((candidate) => path.basename(candidate.dir) === roomName);
    if (invalid) throw new HqError("ROOM_INVALID", 422, `Room "${roomName}" is invalid: ${invalid.error}`);
    throw new HqError("ROOM_NOT_FOUND", 404, `No room "${roomName}" in ${path.join(config.home, "rooms")}.`);
  }
  const agent = room.agents.find((candidate) => candidate.id === agentId);
  if (!agent) throw new HqError("AGENT_NOT_FOUND", 404, `No agent "${agentId}" in room "${roomName}".`);
  if (!agent.sprite) throw notFound(`Agent "${agentId}" declares no sprite.`);

  if (!(SPRITE_EXTENSIONS as readonly string[]).includes(path.extname(agent.sprite).toLowerCase())) {
    throw notFound("The sprite must be a .png or .webp file.");
  }
  let real: string;
  let realHome: string;
  try {
    real = fs.realpathSync(agent.sprite);
    realHome = fs.realpathSync(home.root);
  } catch {
    throw notFound(`The sprite of "${agentId}" does not exist.`);
  }
  if (!isInside(realHome, real)) throw notFound("The sprite must stay inside the home.");
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw notFound(`The sprite of "${agentId}" is not a file.`);
  if (stat.size > SPRITE_MAX_BYTES) throw notFound(`The sprite of "${agentId}" is larger than ${SPRITE_MAX_BYTES} bytes.`);

  const etag = `"${Math.round(stat.mtimeMs).toString(16)}-${stat.size.toString(16)}"`;
  const headers = { ETag: etag, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" };
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });

  const bytes = fs.readFileSync(real);
  const type = sniffImageType(bytes);
  if (!type) throw notFound(`The sprite of "${agentId}" is not a PNG or WebP image.`);
  return new Response(new Uint8Array(bytes), { headers: { ...headers, "Content-Type": type } });
}
