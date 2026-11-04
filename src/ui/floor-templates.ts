// The floor plans: a few hand-designed templates by size, as plain data, in
// floor cells of the isometric floor set (public/iso/floor, see
// scripts/iso/README.md). Each one is a small agency's floor made of cutaway
// rooms (back walls at full height, a low rim in front): a lobby with the
// user's own desk, the "to approve" tray and the reception counter, one or two
// offices of agents, a meeting room with its whiteboard and a kitchen. A wooden
// hall joins the rooms; agents walk along its lanes and the aisles of the rooms
// (axis-aligned lines through cell centres). room-layout.ts turns a template
// into the layout the floor draws and the agents walk in.
//
// Cells: x towards the lower right of the screen, y towards the lower left. A
// back wall stands along the -x and -y edges of a room and hides about four
// cells behind it, so a room sits either beside another one (to its +x and
// entirely behind it on y, a step of the staircase) or four cells away from
// its back walls: no room ever hides another, and no lane runs behind a wall
// (checked by the tests). Agents fill the desks in order, room after room.

export type Cell = [number, number];
export type CellRect = { x: number; y: number; w: number; d: number };
export type WallKind = "plain" | "window" | "door";
export type TileKind = "carpet-room" | "tiles-room";
export type Direction = "NE" | "SE" | "SW" | "NW";
export type RoomKind = "lobby" | "office" | "meeting" | "kitchen";

/** A piece of furniture of the floor set (`furniture` of floor.json), its turn and its first cell in the room. */
export type PieceSpec = { name: string; turn: 0 | 1 | 2 | 3; at: Cell };

/** A desk of an agent: a workstation, its chair (from floor.json) and the aisle cell next to the chair. */
export type DeskSpec = { turn: 0 | 1; at: Cell; stand: Cell };

export type RoomSpec = {
  kind: RoomKind;
  /** Position and size in cells. */
  x: number;
  y: number;
  w: number;
  d: number;
  /** Carpet or tiles, tinted with the colour of the room. */
  floor: TileKind;
  /** The back walls, one kind per cell: along -y (w cells, left to right on x) and along -x (d cells). */
  back: { y: WallKind[]; x: WallKind[] };
  /** Openings in the front rim: cells along +y (by x) and along +x (by y) where the rim is left out. */
  open: { y?: number[]; x?: number[] };
  pieces: PieceSpec[];
  desks?: DeskSpec[];
  /** Walkable lines inside the room, in room cells, one of them leaving through an opening onto a hall lane. */
  aisles?: Cell[][];
  /** The lobby: the user's desk, the tray where agents drop folders, the reception counter. */
  lobby?: {
    user: DeskSpec;
    /** The filing cabinet that holds the "to approve" tray, and where an agent stands to drop a folder. */
    tray: { at: Cell; stand: Cell };
    /** The reception counter (drawn on one floor of the home), where the receptionist stands behind it, and the aisle cell it leaves by. */
    reception: { at: Cell; staff: Cell; stand: Cell };
    /** What stands where the counter is, on the floors that do not have one. */
    instead: PieceSpec[];
  };
};

export type FloorTemplate = {
  id: "small" | "medium" | "large";
  rooms: RoomSpec[];
  /** The wooden hall around the rooms, in cells. */
  hall: CellRect[];
  /** Lanes of the hall, absolute cells: every opening's aisle ends on one. */
  lanes: Cell[][];
};

// ---- Rooms -----------------------------------------------------------------------------------

const piece = (name: string, turn: 0 | 1, at: Cell): PieceSpec => ({ name, turn, at });

/** The lobby: the user's desk at the back, a bookshelf, the tray, a sofa; the counter in the middle. 7 by 6. */
function lobby(x: number, y: number): RoomSpec {
  return {
    kind: "lobby",
    x,
    y,
    w: 7,
    d: 6,
    floor: "tiles-room",
    back: { y: ["window", "plain", "plain", "window", "plain", "window", "door"], x: ["plain", "window", "plain", "plain", "window", "plain"] },
    open: { y: [2] },
    pieces: [
      piece("bookshelf", 0, [2, 0]),
      piece("plant-small", 0, [4, 0]),
      piece("sofa", 1, [0, 3]),
      piece("water-cooler", 0, [0, 5]),
      piece("plant-tall", 0, [6, 5]),
    ],
    aisles: [
      [
        [1, 1],
        [5, 1],
      ],
      [
        [2, 1],
        [2, 6],
      ],
    ],
    lobby: {
      user: { turn: 0, at: [0, 0], stand: [1, 1] },
      tray: { at: [5, 0], stand: [5, 1] },
      reception: { at: [3, 3], staff: [4, 2], stand: [4, 1] },
      instead: [piece("printer", 0, [4, 3]), piece("plant-small", 0, [5, 3])],
    },
  };
}

/** An office of six desks: three along the back wall, two along the side wall, one island. 8 by 7. */
function office6(x: number, y: number): RoomSpec {
  return {
    kind: "office",
    x,
    y,
    w: 8,
    d: 7,
    floor: "carpet-room",
    back: {
      y: ["plain", "window", "plain", "plain", "window", "plain", "plain", "window"],
      x: ["plain", "window", "plain", "plain", "window", "plain", "plain"],
    },
    open: { y: [6] },
    pieces: [piece("bookshelf", 0, [6, 0]), piece("plant-tall", 0, [7, 3]), piece("plant-small", 0, [7, 6]), piece("rug", 0, [3, 5])],
    desks: [
      { turn: 0, at: [0, 0], stand: [0, 2] },
      { turn: 0, at: [2, 0], stand: [2, 2] },
      { turn: 0, at: [4, 0], stand: [4, 2] },
      { turn: 1, at: [0, 3], stand: [2, 4] },
      { turn: 0, at: [4, 3], stand: [4, 5] },
      { turn: 1, at: [0, 5], stand: [2, 6] },
    ],
    aisles: [
      [
        [0, 2],
        [6, 2],
      ],
      [
        [2, 2],
        [2, 6],
      ],
      [
        [2, 5],
        [6, 5],
      ],
      [
        [6, 2],
        [6, 7],
      ],
    ],
  };
}

/** An office of three desks along the back wall, a bookshelf and a rug. 6 by 5. */
function office3(x: number, y: number): RoomSpec {
  return {
    kind: "office",
    x,
    y,
    w: 6,
    d: 5,
    floor: "carpet-room",
    back: { y: ["plain", "window", "plain", "window", "plain", "window"], x: ["plain", "window", "plain", "plain", "plain"] },
    open: { y: [4] },
    pieces: [piece("bookshelf", 1, [0, 3]), piece("plant-small", 0, [5, 2]), piece("plant-tall", 0, [5, 4]), piece("rug", 0, [1, 3])],
    desks: [
      { turn: 0, at: [0, 0], stand: [0, 2] },
      { turn: 0, at: [2, 0], stand: [2, 2] },
      { turn: 0, at: [4, 0], stand: [4, 2] },
    ],
    aisles: [
      [
        [0, 2],
        [4, 2],
      ],
      [
        [4, 2],
        [4, 5],
      ],
    ],
  };
}

/** The meeting room: the whiteboard, the table and its chairs; with `coffee`, a coffee corner too (the small floor has no kitchen). 7 by 5. */
function meeting(x: number, y: number, coffee = false): RoomSpec {
  return {
    kind: "meeting",
    x,
    y,
    w: 7,
    d: 5,
    floor: "carpet-room",
    back: { y: ["plain", "plain", "window", "plain", "plain", "window", "plain"], x: ["plain", "window", "plain", "window", "plain"] },
    open: { y: [1] },
    pieces: [
      piece("whiteboard", 0, [0, 0]),
      ...(coffee ? [piece("coffee-corner", 0, [3, 0])] : [piece("plant-small", 0, [3, 0])]),
      piece("water-cooler", 0, [6, 0]),
      piece("meeting-table", 0, [2, 2]),
      piece("plant-tall", 0, [6, 4]),
    ],
  };
}

/** The kitchen and lounge: the coffee corner, two sofas around a rug. 6 by 5. */
function kitchen(x: number, y: number): RoomSpec {
  return {
    kind: "kitchen",
    x,
    y,
    w: 6,
    d: 5,
    floor: "tiles-room",
    back: { y: ["plain", "plain", "window", "plain", "window", "plain"], x: ["plain", "window", "plain", "plain", "door"] },
    open: { y: [4] },
    pieces: [
      piece("coffee-corner", 0, [0, 0]),
      piece("plant-small", 0, [2, 0]),
      piece("sofa", 0, [3, 0]),
      piece("plant-tall", 0, [5, 0]),
      piece("sofa", 1, [0, 2]),
      piece("rug", 0, [1, 2]),
    ],
  };
}

// ---- Templates ------------------------------------------------------------------------------------
// The back row climbs like a staircase (an office to the +x of the lobby and
// entirely behind it), so it reads as a row across the screen; a second
// office follows on the same line, four cells away (that gap is behind its
// wall). The lanes run along the front of the back row; the front row stands
// four cells away from them, so its back walls hide no lane.

const rect = (x: number, y: number, w: number, d: number): CellRect => ({ x, y, w, d });

/** Large: 7 to 12 agents. Lobby, two offices of six, a meeting room with a coffee corner. */
const large: FloorTemplate = {
  id: "large",
  rooms: [lobby(0, 0), office6(9, -7), office6(21, -7), meeting(13, 6, true)],
  hall: [rect(2, 6, 7, 2), rect(7, 0, 2, 8), rect(9, 0, 21, 2), rect(9, 2, 11, 4)],
  lanes: [
    [
      [2, 6],
      [8, 6],
      [8, 0],
      [27, 0],
    ],
  ],
};

/** Medium: 4 to 6 agents. Lobby, an office of six, meeting room, kitchen. */
const medium: FloorTemplate = {
  id: "medium",
  rooms: [lobby(0, 0), office6(9, -7), meeting(13, 6), kitchen(21, -1)],
  hall: [rect(2, 6, 7, 2), rect(7, 0, 2, 8), rect(9, 0, 12, 2), rect(9, 2, 12, 4), rect(17, -1, 4, 1)],
  lanes: [
    [
      [2, 6],
      [8, 6],
      [8, 0],
      [15, 0],
    ],
  ],
};

/** Small: 1 to 3 agents. Lobby, an office of three, a meeting room with a coffee corner. */
const small: FloorTemplate = {
  id: "small",
  rooms: [lobby(0, 0), office3(9, -5), meeting(13, 6, true)],
  hall: [rect(2, 6, 7, 2), rect(7, 0, 2, 8), rect(9, 0, 6, 2), rect(9, 2, 5, 4)],
  lanes: [
    [
      [2, 6],
      [8, 6],
      [8, 0],
      [13, 0],
    ],
  ],
};

export const FLOOR_TEMPLATES: Record<FloorTemplate["id"], FloorTemplate> = { small, medium, large };

/** How many agents the template seats: one per desk of its offices. */
export function capacityOf(template: FloorTemplate): number {
  return template.rooms.reduce((total, room) => total + (room.desks?.length ?? 0), 0);
}

/** The smallest template that seats `count` agents (the largest when none does). */
export function templateFor(count: number): FloorTemplate {
  for (const template of [small, medium, large]) if (capacityOf(template) >= count) return template;
  return large;
}
