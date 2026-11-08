import fs from "node:fs";
import path from "node:path";
import { isInside, type HqConfig } from "./config";
import { HqError } from "./errors";
import { readFloorOwner, readReceptionSprite, type FloorOwner } from "./home-settings";
import { loadHome, SPRITE_EXTENSIONS, type Agent } from "./rooms";
import { OWNER_AGENT, RECEPTION_AGENT, RECEPTION_ROOM } from "../ui/reception";

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

/** Which sheet of an agent: the old top-down one (`sprite`) or the isometric one of the floor (`isoSprite`). */
export type SheetKind = "sprite" | "iso";

const isFile = (file: string | null): boolean => {
  if (!file) return false;
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

/** URL of the agent's old top-down sheet when it declares one that exists, otherwise null. */
export function spriteUrl(room: string, agent: Agent): string | null {
  if (!isFile(agent.sprite)) return null;
  return `/api/sprites/${encodeURIComponent(room)}/${encodeURIComponent(agent.id)}`;
}

/** URL of the agent's iso sheet (`isoSprite`) when it declares one that exists, otherwise null (a neutral person). */
export function isoSpriteUrl(room: string, agent: Agent): string | null {
  if (!isFile(agent.isoSprite)) return null;
  return `/api/sprites/${encodeURIComponent(room)}/${encodeURIComponent(agent.id)}?sheet=iso`;
}

/** Largest walk stride a sheet may declare (a floor cell is 16 voxels); anything else is ignored. */
const STRIDE_MAX = 16;

/**
 * Voxels per walk frame of the agent's iso sheet: `walk.voxelsPerFrame` of the
 * `iso.json` next to it (the format of scripts/iso/README.md), or null when
 * there is no sheet, no such file or no sensible value (the floor then walks
 * at the default stride of the humans).
 */
export function isoStrideOf(agent: Agent): number | null {
  if (!agent.isoSprite || !isFile(agent.isoSprite)) return null;
  const file = path.join(path.dirname(agent.isoSprite), "iso.json");
  try {
    if (fs.statSync(file).size > SPRITE_MAX_BYTES) return null;
    const json = JSON.parse(fs.readFileSync(file, "utf8")) as { walk?: { voxelsPerFrame?: unknown } };
    const stride = json.walk?.voxelsPerFrame;
    return typeof stride === "number" && Number.isInteger(stride) && stride >= 1 && stride <= STRIDE_MAX ? stride : null;
  } catch {
    return null;
  }
}

/** URL of the receptionist's own sheet (`onboarding.sprite` of myhq.json) when it is set and the file exists, otherwise null (the shipped one). */
export function receptionSpriteUrl(home: string): string | null {
  const file = readReceptionSprite(home);
  if (!file) return null;
  try {
    if (!fs.statSync(file).isFile()) return null;
  } catch {
    return null;
  }
  return `/api/sprites/${RECEPTION_ROOM}/${RECEPTION_AGENT}`;
}

/** URL of the iso sheet of the owner of the floor (`floor.owner.isoSprite` of myhq.json) when it is set and the file exists, otherwise null (a neutral person). */
export function ownerSpriteUrl(owner: FloorOwner | null): string | null {
  return isFile(owner?.isoSprite ?? null) ? `/api/sprites/${RECEPTION_ROOM}/${OWNER_AGENT}?sheet=iso` : null;
}

function notFound(message: string): HqError {
  return new HqError("SPRITE_NOT_FOUND", 404, message);
}

/**
 * The character sheet of an agent, served from the path declared in the
 * validated room.json (never from the URL): `sprite`, or `isoSprite` when
 * `kind` is "iso" (`?sheet=iso`). The file must stay inside the home
 * once symbolic links are resolved, carry a .png or .webp extension, stay under
 * SPRITE_MAX_BYTES and really be a PNG or a WebP. `ETag` follows the
 * modification time, so a redrawn sheet shows up at the next load.
 */
export function spriteResponse(
  request: Request,
  config: HqConfig,
  roomName: string,
  agentId: string,
  kind: SheetKind = "sprite",
): Response {
  const home = loadHome(config.home);
  let declared: string | null;
  if (roomName === RECEPTION_ROOM && agentId === RECEPTION_AGENT && kind === "sprite") {
    // The receptionist belongs to no room: its sheet is declared in myhq.json.
    declared = readReceptionSprite(config.home);
  } else if (roomName === RECEPTION_ROOM && agentId === OWNER_AGENT && kind === "iso") {
    // The owner of the floor belongs to no room either: `floor.owner` of myhq.json.
    declared = readFloorOwner(config.home).owner?.isoSprite ?? null;
  } else {
    const room = home.rooms.find((candidate) => candidate.name === roomName);
    if (!room) {
      const invalid = home.invalid.find((candidate) => path.basename(candidate.dir) === roomName);
      if (invalid) throw new HqError("ROOM_INVALID", 422, `Room "${roomName}" is invalid: ${invalid.error}`);
      throw new HqError("ROOM_NOT_FOUND", 404, `No room "${roomName}" in ${path.join(config.home, "rooms")}.`);
    }
    const agent = room.agents.find((candidate) => candidate.id === agentId);
    if (!agent) throw new HqError("AGENT_NOT_FOUND", 404, `No agent "${agentId}" in room "${roomName}".`);
    declared = kind === "iso" ? agent.isoSprite : agent.sprite;
  }
  if (!declared) throw notFound(`Agent "${agentId}" declares no ${kind === "iso" ? "isoSprite" : "sprite"}.`);
  const sprite = declared;

  if (!(SPRITE_EXTENSIONS as readonly string[]).includes(path.extname(sprite).toLowerCase())) {
    throw notFound("The sprite must be a .png or .webp file.");
  }
  let real: string;
  let realHome: string;
  try {
    real = fs.realpathSync(sprite);
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
