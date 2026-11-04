// Builds the floor set into public/iso/floor/: one atlas (floor.png) with
// the tiles, walls, rims and furniture in both orientations, their floor
// shadows and tint masks, floor.json, and a contact sheet. See README.md.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { World, material, render } from "./engine.mjs";
import { Img, bbox, blit, colour, contactSheet, crop, fromRender, pack, pastel, tintOnto, upscale, writePng } from "./image.mjs";
import * as F from "./furniture.mjs";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "public", "iso", "floor");
export const SUN = [0, 0.55, 1];
export const COVER = 24;
/** Floor shadows: the key light shadow and contact shadow on the floor, as ink at this alpha. */
export const SHADOW_ALPHA = 72;
export const DIRECTIONS = { 0: "SW", 1: "SE", 2: "NE", 3: "NW" };

/**
 * Renders one piece and returns its layers relative to the anchor (the
 * screen pixel of world point (0, 0, 0), the top corner of the footprint):
 * { sprite, masks, shadow, parts } with each image as { img, dx, dy }.
 * `parts(b)` may draw named sub-objects: { name: build } (chair layers).
 */
export function renderPiece({ build, rot = 0, size = null, floor = null, lights = {}, parts = null, outline = "all" }) {
  const world = new World();
  const ids = {};
  const at = [0, 0, 0];
  const extra = { rot, ...(size ? { size } : {}) };
  if (parts) for (const [name, draw] of Object.entries(parts)) ids[name] = world.add(name, at, draw, extra).id;
  else ids.piece = world.add("piece", at, build, extra).id;
  let floorId = null;
  if (floor) floorId = world.add("floor", [0, 0, -1], (b) => b.box(0, 0, 0, floor[0], floor[1], 1, FLOOR_SLAB)).id;
  const r = render(world, { ground: true, ...lights, outline, shadowOnly: floorId ? [floorId] : [] });
  const anchor = { x: -r.uMin, y: -r.vMin };
  const place = (img) => {
    const box = bbox(img);
    return box ? { img: crop(img, box), dx: box.x - anchor.x, dy: box.y - anchor.y } : null;
  };
  const { sprite, masks } = fromRender(r);
  const out = { sprite: place(sprite), masks: {}, shadow: null, parts: {} };
  for (const [key, mask] of Object.entries(masks)) out.masks[key] = place(mask);
  if (floorId) {
    const shadow = new Img(r.w, r.h);
    const ink = colour("ink0");
    for (let i = 0; i < r.w * r.h; i++) {
      if (r.surface[i] === floorId && r.shadowed[i] && r.idx[i] < 0) shadow.set(i % r.w, Math.floor(i / r.w), ink, SHADOW_ALPHA);
    }
    out.shadow = place(shadow);
  }
  if (parts) {
    for (const name of Object.keys(parts)) {
      const part = fromRender(r, (i) => r.owner[i] === ids[name]);
      out.parts[name] = { sprite: place(part.sprite), masks: Object.fromEntries(Object.entries(part.masks).map(([k, m]) => [k, place(m)])) };
    }
  }
  return out;
}
const FLOOR_SLAB = material({ ramp: "wood", top: 4, left: 3, right: 2 });

// ---------------------------------------------------------------- atlas

const frames = [];
const addFrame = (placed) => (placed ? [frames.push(placed.img) - 1, placed.dx, placed.dy] : null);
const maskList = (masks) =>
  Object.entries(masks)
    .filter(([, m]) => m)
    .map(([key, m]) => { const [mode, slot] = key.split(":"); return { frame: addFrame(m), mode, slot: Number(slot) }; });

export function buildFloor() {
  frames.length = 0;
  const previews = []; // for the contact sheet: { name, img (composed at the anchor) }
  const json = {
    version: 1,
    cell: { voxels: F.CELL, w: 64, h: 32 },
    wall: F.WALL,
    seatTop: F.SEAT_TOP,
    deskTop: F.DESK_TOP,
    shadowAlpha: SHADOW_ALPHA,
    atlas: null,
    tiles: {},
    walls: {},
    furniture: {},
  };

  // Tiles: kind x variant.
  for (const kind of ["wood", "carpet", "tiles", "carpet-room", "tiles-room", "grass"]) {
    json.tiles[kind] = [];
    for (let variant = 0; variant < (kind.startsWith("wood") || kind.startsWith("carpet") || kind === "grass" ? 3 : 1); variant++) {
      const p = renderPiece({ build: (b) => F.tile(b, { kind, variant }), outline: "none" });
      json.tiles[kind].push({ sprite: addFrame(p.sprite), masks: maskList(p.masks) });
      if (variant === 0) previews.push({ name: kind, p });
    }
  }

  // Walls and rims, both orientations.
  const wallPieces = [
    ["wall", (b) => F.wall(b, { kind: "plain" })],
    ["wall-window", (b) => F.wall(b, { kind: "window" })],
    ["wall-door", (b) => F.wall(b, { kind: "door" })],
    ["rim", F.rim],
  ];
  for (const [name, build] of wallPieces) {
    json.walls[name] = {};
    for (const rot of [0, 1]) {
      const p = renderPiece({ build, rot, size: [F.CELL, F.CELL], outline: "top" });
      json.walls[name][rot] = { edge: rot === 0 ? (name === "rim" ? "+y" : "-y") : name === "rim" ? "+x" : "-x", sprite: addFrame(p.sprite) };
      previews.push({ name: `${name} ${rot}`, p });
    }
  }
  for (const [name, build] of [["wall-corner", F.wallCorner], ["rim-corner", F.rimCorner]]) {
    const p = renderPiece({ build, outline: "top" });
    json.walls[name] = { sprite: addFrame(p.sprite) };
    previews.push({ name, p });
  }

  // Furniture.
  for (const piece of F.FURNITURE) {
    const entry = { cells: piece.cells, turns: {} };
    for (const rot of piece.turns) {
      const size = piece.cells.map((c) => c * F.CELL);
      const cells = rot % 2 ? [piece.cells[1], piece.cells[0]] : piece.cells;
      const floor = cells.map((c) => c * F.CELL);
      const lights = piece.flat ? {} : { sun: SUN, cover: COVER };
      const parts = piece.layers ? { seat: (b) => piece.build(b, { part: "seat" }), back: (b) => piece.build(b, { part: "back" }) } : null;
      const p = renderPiece({ build: piece.build, rot, size, floor: piece.flat ? null : floor, lights, parts });
      const turn = { cells, faces: DIRECTIONS[rot], sprite: addFrame(p.sprite), masks: maskList(p.masks), shadow: addFrame(p.shadow) };
      if (piece.flat) turn.flat = true;
      if (piece.layers) {
        // The back is in front of a sitter when it is on the viewer's side.
        const backInFront = rot === 0 || rot === 1;
        const seat = addFrame(p.parts.seat.sprite), back = addFrame(p.parts.back.sprite);
        turn.under = backInFront ? [seat] : [back, seat];
        turn.over = backInFront ? [back] : [];
        turn.sitterFaces = DIRECTIONS[(rot + 2) % 4];
        const [sx, sy] = F.CHAIR_SEAT;
        turn.seat = [2 * (sx - sy), sx + sy]; // the seat centre on the ground, from the anchor
      }
      // Cells given in the model frame (a seat, the staff spot) follow the turn.
      const turnCell = ([mx, my]) => {
        const [W] = size;
        const c = [(mx + 0.5) * F.CELL, (my + 0.5) * F.CELL];
        const w = rot === 1 ? [c[1], W - c[0]] : c;
        return [Math.floor(w[0] / F.CELL), Math.floor(w[1] / F.CELL)];
      };
      if (piece.seat) turn.chair = { cell: turnCell(piece.seat), turn: rot, sitterFaces: DIRECTIONS[(rot + 2) % 4] };
      if (piece.staff) turn.staff = { cell: turnCell(piece.staff), faces: DIRECTIONS[rot] };
      entry.turns[rot] = turn;
      previews.push({ name: `${piece.name} ${rot}`, p });
    }
    json.furniture[piece.name] = entry;
  }

  const atlas = pack(frames, 1024);
  json.atlas = { file: "floor.png", w: atlas.img.w, h: atlas.img.h, frames: atlas.rects.map((r) => [r.x, r.y, r.w, r.h]) };
  return { json, atlas, previews };
}

/** Composes a piece at its anchor the runtime way (shadow, sprite, tints). */
export function composePiece(p, roomColour = "#ff3d7f") {
  const all = [p.shadow, p.sprite, ...Object.values(p.masks)].filter(Boolean);
  const x0 = Math.min(...all.map((l) => l.dx)), y0 = Math.min(...all.map((l) => l.dy));
  const x1 = Math.max(...all.map((l) => l.dx + l.img.w)), y1 = Math.max(...all.map((l) => l.dy + l.img.h));
  const img = new Img(x1 - x0, y1 - y0);
  if (p.shadow) blit(img, p.shadow.img, p.shadow.dx - x0, p.shadow.dy - y0);
  blit(img, p.sprite.img, p.sprite.dx - x0, p.sprite.dy - y0);
  for (const [key, m] of Object.entries(p.masks)) if (m) tintOnto(img, m.img, m.dx - x0, m.dy - y0, key.startsWith("pastel") ? pastel(roomColour) : roomColour);
  return img;
}

export function writeFloor({ json, atlas, previews }) {
  mkdirSync(OUT, { recursive: true });
  writePng(path.join(OUT, "floor.png"), atlas.img);
  writeFileSync(path.join(OUT, "floor.json"), JSON.stringify(json, null, 1).replace(/\n\s+(-?\d+,?)(?=\n)/g, " $1").replace(/\[\s+/g, "[").replace(/\s+\]/g, "]") + "\n");
  const sheet = contactSheet(previews.map(({ name, p }) => ({ name, img: composePiece(p) })), { maxW: 640 });
  writePng(path.join(OUT, "contact-sheet.png"), sheet);
  writePng(path.join(OUT, "contact-sheet@3x.png"), upscale(sheet, 3));
  console.log(`floor atlas ${atlas.img.w}x${atlas.img.h}, ${json.atlas.frames.length} frames, ${Object.keys(json.furniture).length} furniture pieces`);
}

if (process.argv[1]?.endsWith("build-floor.mjs")) writeFloor(buildFloor());
