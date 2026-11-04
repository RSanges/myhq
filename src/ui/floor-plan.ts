import type { Cell, CellRect, DeskSpec, PieceSpec, RoomSpec, WallKind } from "./floor-templates";
import { RECEPTION_ROOM } from "./reception";
import { assembleLayout, type BuildRoom, type RoomLayout } from "./room-layout";

// The single floor of the home (myhq.json `floor.layout: "room-per-project"`):
// each room of the home is a suite of its own, sized from its number of
// agents, with the user's own empty desk in it; a lobby holds the reception
// counter. Pure: no canvas, no clock.
//
// The suites are blocks laid out on a loose grid, separated by corridors: a
// corridor along x under each row of blocks, a corridor along y to the right
// of each column, so the corridors branch and cross. Each block is a cutaway
// room like the floors of one room (back walls at full height on its -x and
// -y sides, with windows, a low rim in front) and it opens onto the corridor
// in front of it: a block of an even column opens downwards (+y) onto the
// corridor of its row, a block of an odd column is turned a quarter and opens
// sideways (+x) onto the corridor of its column, a few cells lower for a less
// regular look. A short walkway leads from the opening to the corridor when
// the block is smaller than its place in the grid.
//
// A back wall hides about four cells behind it, so blocks stand GAP cells
// apart and each corridor runs along the front side of the blocks it serves:
// it is four cells and a half from the back walls of the next row or column
// (out of their shadow), no block hides another, and the windows of every
// back wall look onto an empty strip, not onto a corridor.
//
// A suite is planned in its own frame: `u` along its back wall, `v` from the
// back wall (0) to the front rim (ROOM_DEPTH). Two rows of desks face the back
// wall (desk, chair, aisle; desk, chair, aisle), two cells per desk along `u`;
// the column after them is the aisle to the opening; a big team also gets a
// coffee nook beyond it. A block turned a quarter is the same plan with x and
// y swapped and every piece at its other turn.

/** Depth of a suite, from its back wall to its front rim, in cells. */
export const ROOM_DEPTH = 6;
/** Width of a corridor. */
export const CORRIDOR_WIDTH = 2;
/** Cells between two blocks along a corridor's axis: the corridor, then the shadow of the next block's back wall. */
export const GAP = CORRIDOR_WIDTH + 3;
/** The lobby block, square. */
export const LOBBY_SIZE = 8;
/** Agents seated in one room at most; the others are listed under the floor without a desk. */
export const MAX_ROOM_AGENTS = 12;
/** A team of at least this many agents gets a coffee nook in its suite. */
const NOOK_FROM = 6;
const NOOK_LENGTH = 3;
/** How much lower the blocks of an odd column stand. */
const STAGGER = 2;

/** Furniture tall enough to hide a window (a window never stands behind one). */
const TALL = new Set(["bookshelf", "whiteboard", "filing-cabinet", "water-cooler", "plant-tall", "coffee-corner"]);
/** Furniture two cells long at turn 0; the rest is one cell (rugs are flat and never matter here). */
const LONG = new Set(["bookshelf", "whiteboard", "coffee-corner", "sofa", "workstation"]);

export type FloorRoomInput = {
  /** The room of the home. */
  name: string;
  /** Its agents (`room/agent` keys), in order. */
  keys: string[];
  /** Its colour (a normalized hex), or null for the neutral look. */
  color: string | null;
};

export type FloorPlanOptions = {
  /** The room placed next to the lobby (`reception.room` of the home). */
  reception: string | null;
  /** Draw the counter and the receptionist. */
  receptionist?: boolean;
};

/** Which way a block opens: downwards onto the corridor of its row (x), sideways onto the corridor of its column (y). */
type Side = "x" | "y";
type LocalPiece = { name: string; turn: 0 | 1; u: number; v: number };
type LocalDesk = { u: number; v: number };

/** A suite in its own frame. */
type SuitePlan = {
  length: number;
  pieces: LocalPiece[];
  desks: LocalDesk[];
  owner: LocalDesk;
  aisles: Cell[][];
  /** The back wall (along `u`) and the side wall (along `v`, at u = 0), one kind per cell. */
  back: WallKind[];
  side: WallKind[];
  /** The opening of the front rim, along `u`. */
  door: number;
};

/**
 * How many cells along its back wall the suite of a room of `agents` agents
 * takes: a column of two cells per two desks (the agents' and the user's),
 * at least two columns, the aisle to the opening, and a nook for a big team.
 */
export function roomLength(agents: number): number {
  const seated = Math.min(MAX_ROOM_AGENTS, Math.max(0, agents));
  return 2 * Math.max(2, Math.ceil((seated + 1) / 2)) + 1 + (seated >= NOOK_FROM ? NOOK_LENGTH : 0);
}

/** On a block turned a quarter the chair of a workstation is beside its second cell (floor.json), one further along `u`. */
const chairShift = (side: Side): number => (side === "y" ? 1 : 0);

/** A wall with a window every other cell, unless something tall stands in front of it or `skip` says not there. */
function wall(length: number, tall: Set<number>, skip: number | null): WallKind[] {
  return Array.from({ length }, (_, i) => (i % 2 === 1 && i !== skip && !tall.has(i) ? "window" : "plain"));
}

/** The suite of a room of the home with `agents` agents (at most MAX_ROOM_AGENTS seated). */
function suitePlan(agents: number, side: Side): SuitePlan {
  const seated = Math.min(MAX_ROOM_AGENTS, Math.max(0, agents));
  const nook = seated >= NOOK_FROM;
  const columns = Math.max(2, Math.ceil((seated + 1) / 2));
  const door = 2 * columns;
  const length = roomLength(seated);
  const row = (v: number) => Array.from({ length: columns }, (_, k): LocalDesk => ({ u: 2 * k, v }));
  const back = row(0);
  const front = row(3);
  const owner = front[columns - 1]!;
  // Places for furniture first, against the back wall then in the front row, from the far end of the opening.
  const priority: LocalDesk[] = [];
  for (let k = 0; k < columns; k += 1) priority.push(back[k]!, front[k]!);
  const spare = 2 * columns - seated - 1;
  const furniture = priority.filter((slot) => slot !== owner).slice(0, spare);
  const free = new Set(furniture);
  const desks = [...back, ...front].filter((slot) => slot !== owner && !free.has(slot));

  // The top of the aisle's column, against the back wall, is free in every suite: a tall plant.
  const pieces: LocalPiece[] = [{ name: "plant-tall", turn: 0, u: door, v: 0 }];
  let backFurniture = 0;
  let frontFurniture = 0;
  for (const slot of furniture) {
    if (slot.v === 0) {
      if (backFurniture === 0) pieces.push({ name: "bookshelf", turn: 0, u: slot.u, v: 0 });
      else pieces.push({ name: "plant-tall", turn: 0, u: slot.u, v: 0 }, { name: "plant-small", turn: 0, u: slot.u + 1, v: 0 });
      backFurniture += 1;
    } else {
      if (frontFurniture === 0 && columns >= 4) pieces.push({ name: "whiteboard", turn: 0, u: slot.u, v: 3 });
      else if (frontFurniture === 0) pieces.push({ name: "plant-tall", turn: 0, u: slot.u, v: 3 }, { name: "water-cooler", turn: 0, u: slot.u + 1, v: 3 });
      else pieces.push({ name: "printer", turn: 0, u: slot.u, v: 3 }, { name: "plant-small", turn: 0, u: slot.u + 1, v: 3 });
      frontFurniture += 1;
    }
  }
  // The nook of a big team, beyond the aisle: the coffee corner, a sofa on a rug, plants.
  if (nook) {
    pieces.push(
      { name: "coffee-corner", turn: 0, u: door + 1, v: 0 },
      { name: "water-cooler", turn: 0, u: door + 3, v: 0 },
      { name: "sofa", turn: 0, u: door + 1, v: 3 },
      { name: "plant-small", turn: 0, u: door + 3, v: 3 },
      { name: "rug", turn: 0, u: door + 1, v: 4 },
    );
  }

  const shift = chairShift(side);
  const standU = (slot: LocalDesk) => slot.u + shift;
  const backDesks = desks.filter((slot) => slot.v === 0);
  const frontStands = [...desks.filter((slot) => slot.v === 3), owner].map(standU);
  const aisles: Cell[][] = [];
  if (backDesks.length > 0) {
    aisles.push([
      [Math.min(...backDesks.map(standU)), 2],
      [door, 2],
    ]);
  }
  const frontFrom = Math.min(...frontStands);
  aisles.push([
    [frontFrom, 5],
    [door, 5],
  ]);
  aisles.push([
    [door, backDesks.length > 0 ? 2 : 5],
    [door, ROOM_DEPTH],
  ]);
  // A small plant at the far end of the front aisle, when the aisle leaves room for it.
  if (frontFrom >= 2) pieces.push({ name: "plant-small", turn: 0, u: 0, v: 5 });

  // What stands against each wall: the back wall (v = 0) and the side wall (u = 0).
  const tallBack = new Set<number>();
  const tallSide = new Set<number>();
  for (const piece of pieces) {
    if (!TALL.has(piece.name)) continue;
    const span = LONG.has(piece.name) ? 2 : 1;
    if (piece.v === 0) for (let i = 0; i < span; i += 1) tallBack.add(piece.u + i);
    if (piece.u === 0) tallSide.add(piece.v);
  }
  return { length, pieces, desks, owner, aisles, back: wall(length, tallBack, door), side: wall(ROOM_DEPTH, tallSide, null), door };
}

/** A suite placed with its back corner at (x, y): along x opening downwards, or turned a quarter opening sideways. */
function placeSuite(plan: SuitePlan, side: Side, x: number, y: number): { spec: RoomSpec; owner: DeskSpec; door: Cell } {
  const cell = (u: number, v: number): Cell => (side === "x" ? [u, v] : [v, u]);
  const turn = (t: 0 | 1): 0 | 1 => (side === "x" ? t : t === 0 ? 1 : 0);
  const desk = (slot: LocalDesk): DeskSpec => ({
    turn: turn(0),
    at: cell(slot.u, slot.v),
    stand: cell(slot.u + chairShift(side), slot.v + 2),
  });
  const spec: RoomSpec = {
    kind: "office",
    x,
    y,
    w: side === "x" ? plan.length : ROOM_DEPTH,
    d: side === "x" ? ROOM_DEPTH : plan.length,
    floor: "carpet-room",
    back: side === "x" ? { y: plan.back, x: plan.side } : { y: plan.side, x: plan.back },
    open: side === "x" ? { y: [plan.door] } : { x: [plan.door] },
    pieces: plan.pieces.map((piece) => ({ name: piece.name, turn: turn(piece.turn), at: cell(piece.u, piece.v) })),
    desks: plan.desks.map(desk),
    aisles: plan.aisles.map((line) => line.map(([u, v]) => cell(u, v))),
  };
  const [dx, dy] = cell(plan.door, ROOM_DEPTH);
  return { spec, owner: desk(plan.owner), door: [x + dx, y + dy] };
}

/**
 * The lobby, LOBBY_SIZE square: the coffee corner and the user's desk of the
 * reception (where room proposals land) against the back wall, a bookshelf
 * and a sofa by a rug, the reception counter, the receptionist behind it. It
 * opens downwards, like the blocks of an even column.
 */
function lobbyRoom(x: number, y: number): { spec: RoomSpec; owner: DeskSpec; counter: NonNullable<BuildRoom["counter"]>; door: Cell } {
  const size = LOBBY_SIZE;
  const piece = (name: string, turn: 0 | 1, at: Cell): PieceSpec => ({ name, turn, at });
  const doorAt = 6;
  const spec: RoomSpec = {
    kind: "lobby",
    x,
    y,
    w: size,
    d: size,
    floor: "tiles-room",
    back: {
      y: ["plain", "plain", "window", "plain", "window", "plain", "window", "plain"],
      x: ["plain", "window", "plain", "plain", "window", "plain", "window", "plain"],
    },
    open: { y: [doorAt] },
    pieces: [
      piece("coffee-corner", 0, [0, 0]),
      piece("water-cooler", 0, [5, 0]),
      piece("plant-tall", 0, [7, 0]),
      piece("bookshelf", 1, [0, 2]),
      piece("sofa", 1, [0, 4]),
      piece("rug", 0, [1, 4]),
      piece("plant-small", 0, [0, 7]),
      piece("plant-small", 0, [7, 3]),
      piece("plant-tall", 0, [7, 7]),
    ],
    aisles: [
      [
        [2, 2],
        [doorAt, 2],
      ],
      [
        [doorAt, 2],
        [doorAt, size],
      ],
    ],
  };
  return {
    spec,
    owner: { turn: 0, at: [2, 0], stand: [2, 2] },
    counter: { at: [5, 3], staff: [4, 4], stand: [4, 2], faces: "SE", turn: 1 },
    door: [x + doorAt, y + size],
  };
}

type Block = {
  room: FloorRoomInput | null;
  side: Side;
  w: number;
  d: number;
  plan: SuitePlan | null;
};

/** Columns of the grid for `count` blocks: the arrangement whose floor is the smallest on screen, two by two at least. */
function gridOf(blocks: Block[]): { columns: number; rows: number } {
  let best = { columns: 1, rows: blocks.length, size: Number.POSITIVE_INFINITY };
  const most = Math.max(1, blocks.length);
  for (let columns = 1; columns <= most; columns += 1) {
    const rows = Math.ceil(blocks.length / columns);
    if (blocks.length >= 3 && (columns < 2 || rows < 2)) continue;
    const widths = new Array<number>(columns).fill(0);
    const heights = new Array<number>(rows).fill(0);
    blocks.forEach((block, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const shaped = sideOf(column) === block.side ? block : shapeBlock(block.room, sideOf(column));
      widths[column] = Math.max(widths[column]!, shaped.w);
      heights[row] = Math.max(heights[row]!, shaped.d + (column % 2 === 1 ? STAGGER : 0));
    });
    // A screen spans x + y cells of the floor: keep their sum small, then the wider one.
    const size = widths.reduce((a, b) => a + b, 0) + heights.reduce((a, b) => a + b, 0) + (columns + rows) * GAP;
    if (size < best.size) best = { columns, rows, size };
  }
  return { columns: best.columns, rows: best.rows };
}

const sideOf = (column: number): Side => (column % 2 === 0 ? "x" : "y");

function shapeBlock(room: FloorRoomInput | null, side: Side): Block {
  if (room === null) return { room, side: "x", w: LOBBY_SIZE, d: LOBBY_SIZE, plan: null };
  const plan = suitePlan(room.keys.length, side);
  return { room, side, w: side === "x" ? plan.length : ROOM_DEPTH, d: side === "x" ? ROOM_DEPTH : plan.length, plan };
}

/**
 * The single floor for the rooms of the home, in their order: the lobby
 * first, the room of the reception next to it, then the others, on a grid
 * that keeps the floor compact on screen, each block at the back corner of
 * its place, the corridors in front of them.
 */
export function layoutFloor(rooms: FloorRoomInput[], options: FloorPlanOptions): RoomLayout {
  const first = rooms.find((room) => room.name === options.reception) ?? null;
  const ordered = [null, ...(first ? [first] : []), ...rooms.filter((room) => room !== first)];
  const rough = ordered.map((room) => shapeBlock(room, "x"));
  const { columns, rows } = gridOf(rough);
  const blocks = ordered.map((room, index) => shapeBlock(room, room === null ? "x" : sideOf(index % columns)));

  const widths = new Array<number>(columns).fill(0);
  const heights = new Array<number>(rows).fill(0);
  blocks.forEach((block, index) => {
    const column = index % columns;
    widths[column] = Math.max(widths[column]!, block.w);
    heights[Math.floor(index / columns)] = Math.max(heights[Math.floor(index / columns)]!, block.d + (column % 2 === 1 ? STAGGER : 0));
  });
  const left: number[] = [];
  const top: number[] = [];
  widths.forEach((width, column) => left.push(column === 0 ? 0 : left[column - 1]! + widths[column - 1]! + GAP));
  heights.forEach((height, row) => top.push(row === 0 ? 0 : top[row - 1]! + heights[row - 1]! + GAP));
  /** The corridor along x under row r, the corridor along y right of column c (their first cell, where the lane runs). */
  const rowCorridor = (row: number) => top[row]! + heights[row]!;
  const columnCorridor = (column: number) => left[column]! + widths[column]!;

  const built: BuildRoom[] = [];
  const spurs: CellRect[] = [];
  const doorsAt: Cell[] = [];
  const lanes: Cell[][] = [];
  blocks.forEach((block, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = left[column]!;
    const y = top[row]! + (column % 2 === 1 ? STAGGER : 0);
    let door: Cell;
    if (block.room === null) {
      const lobby = lobbyRoom(x, y);
      built.push({ spec: lobby.spec, project: RECEPTION_ROOM, color: null, keys: [], owner: lobby.owner, counter: lobby.counter });
      door = lobby.door;
    } else {
      const placed = placeSuite(block.plan!, block.side, x, y);
      built.push({
        spec: placed.spec,
        project: block.room.name,
        color: block.room.color,
        keys: block.room.keys.slice(0, MAX_ROOM_AGENTS),
        owner: placed.owner,
      });
      door = placed.door;
    }
    doorsAt.push(door);
    // From the opening to the corridor in front: down to the row's corridor, or right to the column's.
    if (block.side === "x") {
      const end = rowCorridor(row);
      if (end > door[1]) spurs.push({ x: door[0], y: door[1], w: 1, d: end - door[1] });
      lanes.push([door, [door[0], end]]);
    } else {
      const end = columnCorridor(column);
      if (end > door[0]) spurs.push({ x: door[0], y: door[1], w: end - door[0], d: 1 });
      lanes.push([door, [end, door[1]]]);
    }
  });

  // The corridors along y: right of each column whose blocks open sideways onto it (of the last column when none
  // does, to join the rows), from the highest opening that leads to it (or the first row's corridor) to the last
  // row's corridor. The corridors along x: under each row, from the first to the last place something meets them.
  const bottom = rowCorridor(rows - 1);
  const hall: CellRect[] = [...spurs];
  const sideways = (column: number) => blocks.some((block, index) => index % columns === column && block.side === "y");
  const used = Array.from({ length: columns }, (_, column) => column).filter(
    (column) => sideways(column) || (column === columns - 1 && !Array.from({ length: columns }, (_, c) => c).some(sideways)),
  );
  for (const column of used) {
    const x = columnCorridor(column);
    const doors = blocks.flatMap((block, index) =>
      index % columns === column && block.side === "y" ? [top[Math.floor(index / columns)]! + STAGGER] : [],
    );
    const from = Math.min(rowCorridor(0), ...doors);
    hall.push({ x, y: from, w: CORRIDOR_WIDTH, d: bottom + CORRIDOR_WIDTH - from });
    lanes.push([
      [x, from],
      [x, bottom],
    ]);
  }
  for (let row = 0; row < rows; row += 1) {
    const y = rowCorridor(row);
    const meets = [
      ...used.map(columnCorridor),
      ...blocks.flatMap((block, index) => (Math.floor(index / columns) === row && block.side === "x" ? [doorsAt[index]![0]] : [])),
    ];
    const from = Math.min(...meets);
    const to = Math.max(...meets);
    hall.push({ x: from, y, w: to - from + CORRIDOR_WIDTH, d: CORRIDOR_WIDTH });
    lanes.push([
      [from, y],
      [to, y],
    ]);
  }
  return assembleLayout({ template: "rooms", rooms: built, hall, lanes }, { reception: options.receptionist ?? false });
}
