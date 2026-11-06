import type { Cell, CellRect, DeskSpec, PieceSpec, RoomSpec, WallKind } from "./floor-templates";
import { RECEPTION_ROOM } from "./reception";
import { assembleLayout, boundsOf, type BuildRoom, type RoomLayout } from "./room-layout";

// The single floor of the home (myhq.json `floor.layout: "room-per-project"`):
// each room of the home is a suite of its own, sized from its number of
// agents, with a counter of what waits for the user beside its signboard
// (drawn by the renderer) and the spot in its opening where its agents bring
// what they submit; the lobby holds the reception counter. Pure: no canvas,
// no clock.
//
// The lobby is the entrance, at the front corner of the floor (the bottom of
// the screen). The main corridor runs along the front, from the lobby's
// opening to the left; the spine, a corridor along y, climbs from the same
// corner along the right edge to the back; ribs (corridors along x) branch
// off the spine to the left. Every row of suites, right-aligned on the spine,
// stands on a rib and opens downwards (+y) onto it: the front row on the main
// corridor, with the lobby at its right end and the reception's room beside
// it, and the user's own office between them. Each suite is a cutaway room
// like the floors of one room: back walls at full height on its -x and -y
// sides, with windows, a low rim in front, and a signboard on its back wall
// along x.
//
// A back wall hides about four cells behind it, its signboard five. So a
// corridor always runs along the front of the suites it serves and keeps five
// cells and a half from any other back wall: between a rib and the back walls
// of the row in front of it lies the shadow of those walls and their signs
// (four cells), and two suites side by side keep four cells between them (a
// sign hides nothing beside its room). No block hides another, no corridor runs behind a wall, and what is
// left between the blocks, under the walls' shadow, is a garden; on screen it
// is mostly covered by the walls themselves. The arrangement chosen is the
// most compact one (the screen spans x + y cells of the floor).
//
// A suite is planned in its own frame: `u` along its back wall, `v` from the
// back wall (0) to the front rim (ROOM_DEPTH). Two rows of desks face the back
// wall (desk, chair, aisle; desk, chair, aisle), two cells per desk along `u`;
// the column after them is the aisle to the opening, where agents drop what
// they submit; a big team also gets a coffee nook beyond it.

/** Depth of a suite, from its back wall to its front rim, in cells. */
export const ROOM_DEPTH = 6;
/** Width of a corridor. */
export const CORRIDOR_WIDTH = 2;
/** The shadow of a back wall and its signboard: cells a corridor keeps clear of it, after its own two. */
export const SHADOW = 4;
/** From the front of a block to the back wall of the next one across a corridor. */
export const GAP = CORRIDOR_WIDTH + SHADOW;
/** Between two blocks side by side, with no corridor between them: the shadow of a side wall (it has no sign). */
export const BESIDE = 4;
/** The user's own office, a block beside the lobby: its length along the main corridor (its depth is a suite's). */
export const OFFICE_LENGTH = 6;
/** The lobby block, square. */
export const LOBBY_SIZE = 8;
/** Agents seated in one room at most; the others are listed under the floor without a desk. */
export const MAX_ROOM_AGENTS = 12;
/** A team of at least this many agents gets a coffee nook in its suite. */
const NOOK_FROM = 6;
const NOOK_LENGTH = 3;
/** From one rib to the next: a row of suites, the rib, the shadow of the next row's back walls. */
const RIB_STEP = ROOM_DEPTH + GAP;
/** Where the lobby opens onto the main corridor, from its side wall. */
const LOBBY_DOOR = 6;

/** Furniture tall enough to hide a window, or hung on the wall (a window never stands behind one). */
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
  /** The room placed right next to the lobby (`reception.room` of the home). */
  reception: string | null;
  /** Draw the counter and the receptionist. */
  receptionist?: boolean;
  /** Agents who roam the floor (`floor.behaviour: "roam"`, `room/agent` keys): no desk, a broom closet in the lobby. */
  roamers?: string[];
};

type LocalPiece = { name: string; turn: 0 | 1; u: number; v: number };
type LocalDesk = { u: number; v: number };

/** Where agents bring what they submit in a room: a cell of its aisles (`OwnerSpot` of room-layout.ts). */
type DropSpec = { stand: Cell };

/** A suite in its own frame. */
type SuitePlan = {
  length: number;
  pieces: LocalPiece[];
  desks: LocalDesk[];
  aisles: Cell[][];
  /** The back wall (along `u`) and the side wall (along `v`, at u = 0), one kind per cell. */
  back: WallKind[];
  side: WallKind[];
  /** The opening of the front rim, along `u`. */
  door: number;
};

/**
 * How many cells along its back wall the suite of a room of `agents` agents
 * takes: a column of two cells per two desks, at least two columns, the aisle
 * to the opening, and a nook for a big team.
 */
export function roomLength(agents: number): number {
  const seated = Math.min(MAX_ROOM_AGENTS, Math.max(0, agents));
  return 2 * deskColumns(seated) + 1 + (seated >= NOOK_FROM ? NOOK_LENGTH : 0);
}

/** Columns of two desks (one against the back wall, one in the front row) for `seated` agents, two at least. */
function deskColumns(seated: number): number {
  return Math.max(2, Math.ceil(seated / 2));
}

/** A wall with a window every other cell, unless something tall stands in front of it or `skip` says not there. */
function wall(length: number, tall: Set<number>, skip: number | null): WallKind[] {
  return Array.from({ length }, (_, i) => (i % 2 === 1 && i !== skip && !tall.has(i) ? "window" : "plain"));
}

/** The suite of a room of the home with `agents` agents (at most MAX_ROOM_AGENTS seated). */
function suitePlan(agents: number): SuitePlan {
  const seated = Math.min(MAX_ROOM_AGENTS, Math.max(0, agents));
  const nook = seated >= NOOK_FROM;
  const columns = deskColumns(seated);
  const door = 2 * columns;
  const length = roomLength(seated);
  const row = (v: number) => Array.from({ length: columns }, (_, k): LocalDesk => ({ u: 2 * k, v }));
  const back = row(0);
  const front = row(3);
  // Places for furniture first, against the back wall then in the front row, from the far end of the opening.
  const priority: LocalDesk[] = [];
  for (let k = 0; k < columns; k += 1) priority.push(back[k]!, front[k]!);
  const spare = 2 * columns - seated;
  const furniture = priority.slice(0, spare);
  const free = new Set(furniture);
  const desks = [...back, ...front].filter((slot) => !free.has(slot));

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

  const standU = (slot: LocalDesk) => slot.u;
  const backDesks = desks.filter((slot) => slot.v === 0);
  const frontStands = desks.filter((slot) => slot.v === 3).map(standU);
  const aisles: Cell[][] = [];
  if (backDesks.length > 0) {
    aisles.push([
      [Math.min(...backDesks.map(standU)), 2],
      [door, 2],
    ]);
  }
  const frontFrom = Math.min(door, ...frontStands);
  if (frontFrom < door) {
    aisles.push([
      [frontFrom, 5],
      [door, 5],
    ]);
  }
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
  return { length, pieces, desks, aisles, back: wall(length, tallBack, door), side: wall(ROOM_DEPTH, tallSide, null), door };
}

/** A suite placed with its back corner at (x, y), along x, opening downwards; agents drop their items in its opening. */
function placeSuite(plan: SuitePlan, x: number, y: number): { spec: RoomSpec; drop: DropSpec; door: Cell } {
  const desk = (slot: LocalDesk): DeskSpec => ({ turn: 0, at: [slot.u, slot.v], stand: [slot.u, slot.v + 2] });
  const spec: RoomSpec = {
    kind: "office",
    x,
    y,
    w: plan.length,
    d: ROOM_DEPTH,
    floor: "carpet-room",
    back: { y: plan.back, x: plan.side },
    open: { y: [plan.door] },
    pieces: plan.pieces.map((piece) => ({ name: piece.name, turn: piece.turn, at: [piece.u, piece.v] })),
    desks: plan.desks.map(desk),
    aisles: plan.aisles,
  };
  return { spec, drop: { stand: [plan.door, ROOM_DEPTH - 1] }, door: [x + plan.door, y + ROOM_DEPTH] };
}

/** The broom closet against the lobby's back wall, and where the roaming agents rest beside it (the second one and beyond share a cell). */
const CLOSET: Cell = [3, 0];
const CLOSET_REST: Cell[] = [
  [2, 1],
  [1, 1],
];

/**
 * The lobby, LOBBY_SIZE square: the coffee corner against the back wall, a
 * bookshelf and a sofa by a rug, the reception counter, the receptionist
 * behind it; with agents who roam the floor, a broom closet against the back
 * wall, and they rest beside it. It opens downwards (+y) onto the main
 * corridor, at the corner of the spine; room proposals are dropped in its
 * opening.
 */
function lobbyRoom(
  x: number,
  y: number,
  roamers: string[],
): { spec: RoomSpec; drop: DropSpec; counter: NonNullable<BuildRoom["counter"]>; closet: BuildRoom["closet"]; door: Cell } {
  const size = LOBBY_SIZE;
  const piece = (name: string, turn: 0 | 1, at: Cell): PieceSpec => ({ name, turn, at });
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
    open: { y: [LOBBY_DOOR] },
    pieces: [
      piece("coffee-corner", 0, [0, 0]),
      piece("plant-small", 0, [2, 0]),
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
        [6, 2],
      ],
      [
        [LOBBY_DOOR, 2],
        [LOBBY_DOOR, size],
      ],
      // From the first aisle to the cells by the closet (only with roaming agents).
      ...(roamers.length > 0 ? [[[2, 2], ...CLOSET_REST] satisfies Cell[]] : []),
    ],
  };
  return {
    spec,
    drop: { stand: [LOBBY_DOOR, size - 1] },
    counter: { at: [5, 3], staff: [4, 4], stand: [4, 2], faces: "SE", turn: 1 },
    closet: roamers.length > 0 ? { at: CLOSET, turn: 0, rest: CLOSET_REST, faces: "SW", keys: roamers } : undefined,
    door: [x + LOBBY_DOOR, y + size],
  };
}

/**
 * The user's own office, OFFICE_LENGTH by ROOM_DEPTH: the hub's scene (the
 * desk scene of /bureau), drawn whole by the renderer from the floor set
 * (`office` of floor.json): its walls, window, furniture, pile and letter
 * tray. Nobody works there; a click opens the desk. It opens downwards (+y)
 * onto the main corridor.
 */
function ownerOffice(x: number, y: number): BuildRoom {
  const door = OFFICE_LENGTH - 1;
  const spec: RoomSpec = {
    kind: "owner",
    x,
    y,
    w: OFFICE_LENGTH,
    d: ROOM_DEPTH,
    floor: "wood",
    // The hub's window is in its left wall (along y), over its second and third cells.
    back: {
      y: Array.from({ length: OFFICE_LENGTH }, (): WallKind => "plain"),
      x: ["plain", "window", "window", "plain", "plain", "plain"],
    },
    open: { y: [door] },
    pieces: [],
    aisles: [
      [
        [door, 2],
        [door, ROOM_DEPTH],
      ],
    ],
  };
  return { spec, project: null, color: null, keys: [], sign: true, office: true };
}

type Arrangement = {
  /** Rows of rooms along the ribs, from the front (the main corridor, the lobby's row) back, each listed from the spine leftwards. */
  rows: FloorRoomInput[][];
};

const lengthOf = (room: FloorRoomInput): number => roomLength(room.keys.length);
/** The front row starts with the lobby and the user's office beside it. */
const rowWidth = (row: FloorRoomInput[], front: boolean): number =>
  row.reduce((total, room) => total + lengthOf(room) + BESIDE, front ? LOBBY_SIZE + BESIDE + OFFICE_LENGTH : -BESIDE);

/** The box of the floor (cells along x and y) for an arrangement. */
function extentOf({ rows }: Arrangement): { x: number; y: number } {
  const widest = Math.max(...rows.map((row, index) => rowWidth(row, index === 0)));
  // The front row is as deep as the lobby; the next rib keeps clear of the lobby's back wall, the others of a suite's.
  const depth = CORRIDOR_WIDTH + LOBBY_SIZE + (rows.length > 1 ? GAP + ROOM_DEPTH + (rows.length - 2) * RIB_STEP : 0);
  return { x: widest + CORRIDOR_WIDTH, y: depth };
}

/** Rooms on `count` rows, the longest first, each on the row that is the narrowest so far; `first` beside the lobby. */
function intoRows(rooms: FloorRoomInput[], count: number, first: FloorRoomInput | null): FloorRoomInput[][] {
  const rows: FloorRoomInput[][] = Array.from({ length: count }, () => []);
  if (first) rows[0]!.push(first);
  const rest = rooms.filter((room) => room !== first).sort((a, b) => lengthOf(b) - lengthOf(a));
  for (const room of rest) {
    let target = 0;
    rows.forEach((row, index) => {
      if (rowWidth(row, index === 0) < rowWidth(rows[target]!, target === 0)) target = index;
    });
    rows[target]!.push(room);
  }
  // In a row, the reception's room first (next to the lobby), then the order of the home.
  return rows.map((row) => row.slice().sort((a, b) => (a === first ? -1 : b === first ? 1 : rooms.indexOf(a) - rooms.indexOf(b))));
}

/**
 * The arrangement whose floor is the smallest on screen (a screen spans x + y
 * cells of the floor), then the one with the least room left in its box; from
 * two rooms on, two rows at least, so the floor is never a single line.
 */
function arrange(rooms: FloorRoomInput[], reception: FloorRoomInput | null): Arrangement {
  const used = rooms.reduce((total, room) => total + lengthOf(room) * ROOM_DEPTH, LOBBY_SIZE * LOBBY_SIZE);
  let best: { arrangement: Arrangement; size: number; empty: number } | null = null;
  const most = Math.max(1, rooms.length);
  for (let count = rooms.length >= 2 ? 2 : 1; count <= most; count += 1) {
    const arrangement: Arrangement = { rows: intoRows(rooms, count, reception) };
    if (arrangement.rows.slice(1).some((row) => row.length === 0)) continue;
    const { x, y } = extentOf(arrangement);
    const size = x + y;
    const empty = x * y - used;
    if (!best || size < best.size || (size === best.size && empty < best.empty)) best = { arrangement, size, empty };
  }
  return best ? best.arrangement : { rows: [[]] };
}

/** The single floor for the rooms of the home (see the top of this file). */
export function layoutFloor(rooms: FloorRoomInput[], options: FloorPlanOptions): RoomLayout {
  const reception = rooms.find((room) => room.name === options.reception) ?? null;
  const { rows } = arrange(rooms, reception);
  const extent = extentOf({ rows });
  // The spine along the right edge; the main corridor (the first rib) along the front.
  const spine = extent.x - CORRIDOR_WIDTH;
  const main = extent.y - CORRIDOR_WIDTH;

  const built: BuildRoom[] = [];
  const lanes: Cell[][] = [];
  const hall: CellRect[] = [];
  const suite = (room: FloorRoomInput, x: number, y: number): Cell => {
    const placed = placeSuite(suitePlan(room.keys.length), x, y);
    built.push({ spec: placed.spec, project: room.name, color: room.color, keys: room.keys.slice(0, MAX_ROOM_AGENTS), drop: placed.drop, sign: true });
    return placed.door;
  };

  let back = main;
  // The user's office: beside the lobby on the front row, listed after the suites (their order is the home's).
  let office: BuildRoom | null = null;
  rows.forEach((row, index) => {
    // Rib 0 runs along the front; the next keeps clear of the lobby's back wall, the others of the suites'.
    const rib = index === 0 ? main : main - LOBBY_SIZE - GAP - (index - 1) * RIB_STEP;
    let right = spine;
    let leftmost = spine;
    if (index === 0) {
      const lobby = lobbyRoom(spine - LOBBY_SIZE, rib - LOBBY_SIZE, options.roamers ?? []);
      built.push({ spec: lobby.spec, project: RECEPTION_ROOM, color: null, keys: [], drop: lobby.drop, counter: lobby.counter, closet: lobby.closet, sign: true });
      right = spine - LOBBY_SIZE - BESIDE;
      office = ownerOffice(right - OFFICE_LENGTH, rib - ROOM_DEPTH);
      right -= OFFICE_LENGTH + BESIDE;
      leftmost = office.spec.x + (office.spec.open.y?.[0] ?? 0);
    }
    for (const room of row) {
      const x = right - lengthOf(room);
      leftmost = suite(room, x, rib - ROOM_DEPTH)[0];
      right = x - BESIDE;
    }
    hall.push({ x: Math.min(leftmost, right + BESIDE), y: rib, w: spine - Math.min(leftmost, right + BESIDE), d: CORRIDOR_WIDTH });
    lanes.push([
      [leftmost, rib],
      [spine, rib],
    ]);
    back = Math.min(back, rib);
  });

  if (office) built.push(office);

  // The spine climbs from the lobby's corner to the back-most rib.
  hall.push({ x: spine, y: back, w: CORRIDOR_WIDTH, d: main + CORRIDOR_WIDTH - back });
  lanes.push([
    [spine, back],
    [spine, main],
  ]);

  // Columns and rows from 0: the box starts at the leftmost block and the back-most wall.
  const left = Math.min(0, ...built.map((room) => room.spec.x), ...hall.map((rect) => rect.x));
  const top = Math.min(0, ...built.map((room) => room.spec.y));
  const layout = assembleLayout(
    {
      template: "rooms",
      rooms: built.map((room) => ({ ...room, spec: { ...room.spec, x: room.spec.x - left, y: room.spec.y - top } })),
      hall: hall.map((rect) => ({ ...rect, x: rect.x - left, y: rect.y - top })),
      lanes: lanes.map((lane) => lane.map(([cx, cy]): Cell => [cx - left, cy - top])),
    },
    { reception: options.receptionist ?? false },
  );

  // What is left inside the box of the floor, out of the rooms and the corridors: the garden.
  const taken = new Set(layout.hall.map(([cx, cy]) => `${cx},${cy}`));
  for (const room of layout.rooms) for (let cx = room.x; cx < room.x + room.w; cx += 1) for (let cy = room.y; cy < room.y + room.d; cy += 1) taken.add(`${cx},${cy}`);
  const maxX = Math.max(...layout.rooms.map((room) => room.x + room.w), ...layout.hall.map(([cx]) => cx + 1));
  const maxY = Math.max(...layout.rooms.map((room) => room.y + room.d), ...layout.hall.map(([, cy]) => cy + 1));
  const garden: Cell[] = [];
  for (let cx = 0; cx < maxX; cx += 1) for (let cy = 0; cy < maxY; cy += 1) if (!taken.has(`${cx},${cy}`)) garden.push([cx, cy]);
  return { ...layout, garden, bounds: boundsOf(layout.rooms, [...layout.hall, ...garden]) };
}
