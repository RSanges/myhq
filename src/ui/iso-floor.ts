import { z } from "zod";
import { CELL, COUNTER_FROM, COUNTER_LENGTH, screenOf, SIGN_TOP, type Cell, type Direction, type RoomLayout } from "./room-layout";

// The isometric floor set (public/iso/floor/floor.json, see
// scripts/iso/README.md) as the room view reads it, and the scene of a floor
// as a list of things to draw: the flat layer (tiles, shadows, rugs) in order,
// then the boxes to sort back to front (walls, rims, furniture, characters).
// Pure: no canvas. room-renderer.ts turns each `Ref` into a sprite.

/** `[frame, dx, dy]`: draw atlas frame `frame` at the top corner of the piece's first cell plus (dx, dy). */
const refSchema = z.tuple([z.number().int().nonnegative(), z.number(), z.number()]);
export type Ref = z.infer<typeof refSchema>;

const maskSchema = z.object({ frame: refSchema, mode: z.enum(["room", "pastel"]), slot: z.number().int() });
export type Mask = z.infer<typeof maskSchema>;

const tileSchema = z.object({ sprite: refSchema, masks: z.array(maskSchema) });
const wallSchema = z.object({ edge: z.string(), sprite: refSchema });

const turnSchema = z.object({
  cells: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  faces: z.string(),
  sprite: refSchema,
  shadow: refSchema.nullable(),
  masks: z.array(maskSchema).default([]),
  flat: z.boolean().optional(),
  under: z.array(refSchema).optional(),
  over: z.array(refSchema).optional(),
  sitterFaces: z.string().optional(),
  seat: z.tuple([z.number(), z.number()]).optional(),
});
export type Turn = z.infer<typeof turnSchema>;

/** A part of a signboard: its sprite and masks, and for each of its pixel columns from `face.x` the face's top row and height (null outside it). */
const signPartSchema = z.object({
  sprite: refSchema,
  masks: z.array(maskSchema),
  face: z.object({ x: z.number().int(), cols: z.array(z.tuple([z.number().int(), z.number().int().positive()]).nullable()) }),
});
export type SignPart = z.infer<typeof signPartSchema>;

const signSchema = z.object({
  end: z.number().int().positive(),
  segment: z.number().int().positive(),
  post: z.number().int().nonnegative(),
  bottom: z.number().int().positive(),
  top: z.number().int().positive(),
  period: z.tuple([z.number().int(), z.number().int()]),
  left: signPartSchema,
  middle: signPartSchema,
  right: signPartSchema,
});
export type SignSet = z.infer<typeof signSchema>;

/** The pixel font of the signboards: glyph rows of "#" (ink) and "." (`font` of floor.json). */
const fontSchema = z.object({
  height: z.number().int().positive(),
  spacing: z.number().int().nonnegative(),
  glyphs: z.record(z.string(), z.array(z.string())),
});
export type SignFont = z.infer<typeof fontSchema>;

/** A state of a live object of the user's office: its sprite and masks (slot k: folder k), or null for nothing to add. */
const officeStateSchema = z.object({ sprite: refSchema, masks: z.array(maskSchema) }).nullable();
export type OfficeState = z.infer<typeof officeStateSchema>;

/**
 * The user's own office of the single floor: the hub's scene as one sprite
 * from the room's back corner, and the states of its pile and letter tray
 * (index n: n items), drawn over it. `chair`: where a sitter's anchor goes
 * (the ground under its seat, from the room's back corner, facing `NE`) and
 * the chair's back, drawn over the sitter.
 */
const officeSchema = z.object({
  cells: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  sprite: refSchema,
  states: z.object({ pile: z.array(officeStateSchema).min(1), mail: z.array(officeStateSchema).min(1) }),
  chair: z.object({ seat: z.tuple([z.number(), z.number()]), over: refSchema }),
});
export type OfficeArt = z.infer<typeof officeSchema>;

export const floorSetSchema = z.object({
  version: z.literal(1),
  cell: z.object({ voxels: z.literal(CELL), w: z.number(), h: z.number() }),
  wall: z.object({ height: z.number(), thick: z.number(), rim: z.number() }),
  atlas: z.object({
    file: z.string().regex(/^[\w.-]+\.png$/),
    w: z.number(),
    h: z.number(),
    /** A hash of the atlas image: the runtime asks for `file?v=<hash>`, so the frames always match the image. */
    hash: z.string().regex(/^[0-9a-f]+$/).optional(),
    frames: z.array(z.tuple([z.number(), z.number(), z.number(), z.number()])),
  }),
  tiles: z.record(z.string(), z.array(tileSchema).min(1)),
  walls: z.object({
    wall: z.object({ 0: wallSchema, 1: wallSchema }),
    "wall-window": z.object({ 0: wallSchema, 1: wallSchema }),
    "wall-door": z.object({ 0: wallSchema, 1: wallSchema }),
    rim: z.object({ 0: wallSchema, 1: wallSchema }),
    "wall-corner": z.object({ sprite: refSchema }),
    "rim-corner": z.object({ sprite: refSchema }),
  }),
  furniture: z.record(z.string(), z.object({ turns: z.record(z.string(), turnSchema) })),
  sign: signSchema,
  font: fontSchema,
  office: officeSchema,
});
export type FloorSet = z.infer<typeof floorSetSchema>;

// ---- Character sheets ----------------------------------------------------------------------------

/** The frame of an iso character sheet (public/sprites/iso-characters.json). */
export const SHEET = {
  frame: { w: 96, h: 136 },
  anchor: { x: 48, y: 120 },
  columns: 8,
  directions: ["NE", "SE", "SW", "NW"] as const,
  animations: ["idle", "walk", "type"] as const,
};

/** Row of a sheet for a direction and an animation: `direction * 3 + animation`. */
export function sheetRow(direction: Direction, animation: (typeof SHEET.animations)[number]): number {
  return SHEET.directions.indexOf(direction) * SHEET.animations.length + SHEET.animations.indexOf(animation);
}

/** The neutral people shipped in public/sprites, one picked per agent from its key. */
export const NEUTRAL_PEOPLE = [
  "/sprites/iso-person-blue.png",
  "/sprites/iso-person-green.png",
  "/sprites/iso-person-mustard.png",
  "/sprites/iso-person-grey.png",
] as const;

export const RECEPTIONIST_SHEET = "/sprites/iso-receptionist.png";

/** The janitor (broom and bucket, its `type` row sweeps): the sheet of an agent that roams the floor without one of its own. */
export const JANITOR_SHEET = "/sprites/iso-janitor.png";

/** The neutral person of an agent: always the same for the same key (a small string hash). */
export function neutralPersonFor(key: string): string {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
  return NEUTRAL_PEOPLE[(hash >>> 0) % NEUTRAL_PEOPLE.length]!;
}

// ---- Colours ------------------------------------------------------------------------------------

/** Colour of the masks of a floor without a room colour: a soft slate. */
export const NEUTRAL_ROOM_COLOR = 0x8c96a8;

/** A `pastel` mask's colour: 55 % of the way from the room colour to #fffaf0 (`pastel()` of image.mjs). */
export function pastel(color: number): number {
  const mix = (shift: number, to: number) => {
    const from = (color >> shift) & 255;
    return Math.round(from + (to - from) * 0.55);
  };
  return (mix(16, 0xff) << 16) | (mix(8, 0xfa) << 8) | mix(0, 0xf0);
}

// ---- Depth order ----------------------------------------------------------------------------------

/** A footprint on the floor, in voxels. */
export type Box = { x0: number; y0: number; x1: number; y1: number };

/** True when box a is behind box b (non overlapping footprints, in voxels). The rule of compose.mjs. */
export function behind(a: Box, b: Box): boolean {
  const ax = a.x1 <= b.x0;
  const ay = a.y1 <= b.y0;
  const bx = b.x1 <= a.x0;
  const by = b.y1 <= a.y0;
  if ((ax || ay) && !(bx || by)) return true;
  if ((bx || by) && !(ax || ay)) return false;
  return a.x0 + a.x1 + a.y0 + a.y1 < b.x0 + b.x1 + b.y0 + b.y1;
}

/** Indices of `boxes` back to front: a topological sort on `behind` (depthSort() of compose.mjs). */
export function depthOrder(boxes: Box[]): number[] {
  const n = boxes.length;
  const after: number[][] = boxes.map(() => []);
  const count = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      if (i !== j && behind(boxes[i]!, boxes[j]!) && !behind(boxes[j]!, boxes[i]!)) {
        after[i]!.push(j);
        count[j]! += 1;
      }
    }
  }
  const out: number[] = [];
  const placed = new Array<boolean>(n).fill(false);
  const ready = boxes.map((_, i) => i).filter((i) => count[i] === 0);
  const key = (i: number) => boxes[i]!.x0 + boxes[i]!.y0;
  while (ready.length > 0) {
    ready.sort((a, b) => key(a) - key(b) || a - b);
    const i = ready.shift()!;
    out.push(i);
    placed[i] = true;
    for (const j of after[i]!) {
      count[j]! -= 1;
      if (count[j] === 0) ready.push(j);
    }
  }
  // Cycles (overlapping boxes both ways): keep going in index order.
  for (let i = 0; i < n; i += 1) if (!placed[i]) out.push(i);
  return out;
}

/** The footprint of a character standing at (x, y): 8 by 8 voxels around its feet. */
export const characterBox = (x: number, y: number): Box => ({ x0: x - 4, y0: y - 4, x1: x + 4, y1: y + 4 });

/** What a thing covers on the screen, in art pixels (x1 and y1 excluded). */
export type ScreenRect = { x0: number; y0: number; x1: number; y1: number };

const overlaps = (a: ScreenRect, b: ScreenRect): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/**
 * Where the characters that stand or walk go in the depth order, the walls
 * and furniture keeping theirs. The order of the static items is computed
 * once, from their own boxes (`rank[i]`, from `depthOrder`): `behind` is not
 * transitive, so sorting the characters together with them made the order
 * of the furniture itself change with where a character stood, and walls or
 * pieces swapped places for a frame as someone walked by. Here a character
 * goes just in front of the frontmost static item that is behind it among
 * the ones it overlaps on the screen (behind all of them when none is), and
 * nothing else moves. Characters with the same place among the static items
 * are ordered among themselves by their footprints (back to front), then by
 * index. Returns a depth per mover, between the ranks of the static items.
 */
export function moverDepths(
  statics: { box: Box; rect: ScreenRect }[],
  rank: number[],
  movers: { box: Box; rect: ScreenRect }[],
): number[] {
  const base = movers.map((mover) => {
    let after = -1;
    statics.forEach((item, index) => {
      if (rank[index]! > after && overlaps(item.rect, mover.rect) && behind(item.box, mover.box) && !behind(mover.box, item.box)) after = rank[index]!;
    });
    return after;
  });
  const order = movers
    .map((mover, index) => ({ index, key: mover.box.x0 + mover.box.y0 }))
    .sort((a, b) => base[a.index]! - base[b.index]! || a.key - b.key || a.index - b.index);
  const depths = new Array<number>(movers.length);
  // A slot between two ranks, split evenly among its characters.
  order.forEach(({ index }, position) => {
    depths[index] = base[index]! + 0.25 + (position + 1) / (2 * (movers.length + 1));
  });
  return depths;
}

// ---- The scene of a floor ------------------------------------------------------------------------

/**
 * A frame of the atlas at a screen position (art pixels), with the tint of a
 * mask (null: drawn as is) and the index of the room whose colour it takes
 * (-1 for the hall and the walls).
 */
export type Draw = { frame: number; x: number; y: number; tint: "room" | "pastel" | null; room: number };

/**
 * A thing sorted by depth: a wall piece, a rim, a piece of furniture, the
 * user's office drawn whole. `piece` is its index in `layout.pieces`;
 * `office` marks the office (its live pile and tray go over it).
 */
export type Sorted = { box: Box; draws: Draw[]; piece: number | null; office?: boolean };

export type FloorScene = {
  /** Tiles, then floor shadows, then rugs: drawn in this order under everything else. */
  flat: Draw[];
  sorted: Sorted[];
};

const wallName = (kind: "plain" | "window" | "door") => (kind === "plain" ? "wall" : kind === "window" ? "wall-window" : "wall-door");

/** Where to draw `ref` for a piece whose first cell has its top corner at voxel (vx, vy). */
export function placeRef(vx: number, vy: number, ref: Ref, tint: Draw["tint"] = null, room = -1): Draw {
  const corner = screenOf(vx, vy);
  return { frame: ref[0], x: corner.x + ref[1], y: corner.y + ref[2], tint, room };
}

const masksOf = (vx: number, vy: number, masks: Mask[], room: number): Draw[] => masks.map((mask) => placeRef(vx, vy, mask.frame, mask.mode, room));

/** The turn of a piece in the floor set (throws on a piece the set does not have: a template bug). */
export function turnOf(set: FloorSet, name: string, turn: number): Turn {
  const found = set.furniture[name]?.turns[String(turn)];
  if (!found) throw new Error(`the floor set has no ${name} at turn ${turn}`);
  return found;
}

/** A hash of a cell, to pick a tile variant (the same cell always gets the same one). */
const variant = ([cx, cy]: Cell, count: number) => (((cx * 7 + cy * 3) % count) + count) % count;

/**
 * The static scene of a floor: every tile of the hall and the rooms, the
 * floor shadows and rugs, and the sorted boxes of walls, rims and furniture.
 * `tinted` false draws the neutral carpet and tiles (a room without a colour);
 * a function says it room by room (the single floor, where each room has its own).
 */
export function buildFloorScene(set: FloorSet, layout: RoomLayout, tinted: boolean | ((room: number) => boolean)): FloorScene {
  const tiles: { cell: Cell; draws: Draw[] }[] = [];
  const tile = (cell: Cell, kind: string, room: number) => {
    const variants = set.tiles[kind] ?? set.tiles.wood!;
    const chosen = variants[variant(cell, variants.length)]!;
    const vx = cell[0] * CELL;
    const vy = cell[1] * CELL;
    tiles.push({ cell, draws: [placeRef(vx, vy, chosen.sprite, null, room), ...masksOf(vx, vy, chosen.masks, room)] });
  };
  for (const cell of layout.hall) tile(cell, "wood", -1);
  // The garden between the blocks of the single floor, when the floor set has grass.
  if (set.tiles.grass) for (const cell of layout.garden) tile(cell, "grass", -1);
  layout.rooms.forEach((room, index) => {
    // The user's office brings its own floor (the hub's scene).
    if (room.kind === "owner") return;
    const colored = typeof tinted === "function" ? tinted(index) : tinted;
    const kind = colored || room.floor === "wood" ? room.floor : room.floor === "carpet-room" ? "carpet" : "tiles";
    for (let cx = room.x; cx < room.x + room.w; cx += 1) for (let cy = room.y; cy < room.y + room.d; cy += 1) tile([cx, cy], kind, index);
  });
  tiles.sort((a, b) => a.cell[0] + a.cell[1] - (b.cell[0] + b.cell[1]) || a.cell[0] - b.cell[0]);

  const flat: Draw[] = tiles.flatMap((entry) => entry.draws);
  const sorted: Sorted[] = [];
  const box = (x0: number, y0: number, x1: number, y1: number): Box => ({ x0, y0, x1, y1 });
  const thick = set.wall.thick;
  const walls = set.walls;

  layout.pieces.forEach((piece, index) => {
    const turn = turnOf(set, piece.name, piece.turn);
    const vx = piece.cell[0] * CELL;
    const vy = piece.cell[1] * CELL;
    if (turn.shadow) flat.push(placeRef(vx, vy, turn.shadow));
    if (turn.flat) return;
    sorted.push({
      box: box(vx, vy, vx + turn.cells[0] * CELL, vy + turn.cells[1] * CELL),
      draws: [placeRef(vx, vy, turn.sprite, null, piece.room), ...masksOf(vx, vy, turn.masks, piece.room)],
      piece: index,
    });
  });
  // Rugs lie on the floor, after the shadows and before everything sorted.
  for (const piece of layout.pieces) {
    const turn = turnOf(set, piece.name, piece.turn);
    if (!turn.flat) continue;
    const vx = piece.cell[0] * CELL;
    const vy = piece.cell[1] * CELL;
    flat.push(placeRef(vx, vy, turn.sprite, null, piece.room), ...masksOf(vx, vy, turn.masks, piece.room));
  }

  for (const room of layout.rooms) {
    const X = room.x * CELL;
    const Y = room.y * CELL;
    const X1 = (room.x + room.w) * CELL;
    const Y1 = (room.y + room.d) * CELL;
    if (room.kind === "owner") {
      // The hub's scene, floor, back walls and furniture in one: one box, behind its rims.
      sorted.push({ box: box(X - thick, Y - thick, X1, Y1), draws: [placeRef(X, Y, set.office.sprite)], piece: null, office: true });
    }
    if (room.kind !== "owner") room.back.y.forEach((kind, i) => {
      const vx = X + i * CELL;
      sorted.push({ box: box(vx, Y - thick, vx + CELL, Y), draws: [placeRef(vx, Y, walls[wallName(kind)][0].sprite)], piece: null });
    });
    if (room.kind !== "owner") room.back.x.forEach((kind, i) => {
      const vy = Y + i * CELL;
      sorted.push({ box: box(X - thick, vy, X, vy + CELL), draws: [placeRef(X, vy, walls[wallName(kind)][1].sprite)], piece: null });
    });
    // The post of the corner, where two back walls meet (a room with a low partition on one side has none).
    if (room.kind !== "owner" && room.back.x.length > 0 && room.back.y.length > 0) {
      sorted.push({ box: box(X - thick, Y - thick, X, Y), draws: [placeRef(X, Y, walls["wall-corner"].sprite)], piece: null });
    }
    for (let i = 0; i < room.w; i += 1) {
      if (room.open.y.includes(i)) continue;
      const vx = X + i * CELL;
      sorted.push({ box: box(vx, Y1, vx + CELL, Y1 + thick), draws: [placeRef(vx, Y1 - CELL, walls.rim[0].sprite)], piece: null });
    }
    for (let i = 0; i < room.d; i += 1) {
      if (room.open.x.includes(i)) continue;
      const vy = Y + i * CELL;
      sorted.push({ box: box(X1, vy, X1 + thick, vy + CELL), draws: [placeRef(X1 - CELL, vy, walls.rim[1].sprite)], piece: null });
    }
    sorted.push({ box: box(X1, Y1, X1 + thick, Y1 + thick), draws: [placeRef(X1 - CELL, Y1 - CELL, walls["rim-corner"].sprite)], piece: null });
  }
  return { flat, sorted };
}

/**
 * Whether a point of the floor (voxels) is hidden by a back wall of a room it
 * is not in: behind the wall's line and inside the wall's shape on the screen.
 * A room with a signboard counts its back wall along x up to the top of the
 * sign, along all its length; a room with a counter its back wall along y up
 * to the top of the counter, where it stands. The floor plans are checked
 * with it (no room and no lane behind a wall).
 */
export function hiddenByWalls(layout: RoomLayout, x: number, y: number, height = 64): boolean {
  const p = screenOf(x, y);
  for (const room of layout.rooms) {
    const X0 = room.x * CELL;
    const Y0 = room.y * CELL;
    const X1 = (room.x + room.w) * CELL;
    const Y1 = (room.y + room.d) * CELL;
    if (x >= X0 && x <= X1 && y >= Y0 && y <= Y1) continue;
    // The wall along -y: ground points (wx, Y0), raised by up to `height` (a side without a back wall hides nothing).
    if (y < Y0 && room.back.y.length > 0) {
      const wx = p.x / 2 + Y0;
      const z = (wx + Y0 - p.y) / 2;
      if (wx >= X0 && wx <= X1 && z >= 0 && z <= (room.sign ? Math.max(height, SIGN_TOP) : height)) return true;
    }
    // The wall along -x: ground points (X0, wy).
    if (x < X0 && room.back.x.length > 0) {
      const wy = X0 - p.x / 2;
      const z = (X0 + wy - p.y) / 2;
      const counter = room.counter && wy >= Y0 + COUNTER_FROM - 4 && wy <= Y0 + COUNTER_FROM + COUNTER_LENGTH + 4;
      if (wy >= Y0 && wy <= Y1 && z >= 0 && z <= (counter ? Math.max(height, SIGN_TOP) : height)) return true;
    }
  }
  return false;
}
