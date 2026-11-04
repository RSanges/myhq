import type { Cell, CellRect, DeskSpec, PieceSpec, RoomSpec, WallKind } from "./floor-templates";
import { RECEPTION_ROOM } from "./reception";
import { assembleLayout, type BuildRoom, type RoomLayout } from "./room-layout";

// The single floor of the home (myhq.json `floor.layout: "room-per-project"`):
// each room of the home is one room of the floor, sized from its number of
// agents, with the user's own empty desk in it; one shared lobby holds the
// reception counter and the coffee corner. Pure: no canvas, no clock.
//
// The floor is the corner of a building seen from the front. The lobby stands
// in the corner (the top of the screen); the rooms line the two back walls of
// the building, one wing along x (to the lower right of the screen), one along
// y (to the lower left), and a wooden hall runs in front of both wings. Only
// the outer walls of the building stand at full height: they look outside, so
// they carry the windows, and they hide nothing but the outside. Between two
// rooms of a wing the partition is the low rim of the first one (the second
// one has no back wall on that side), so no room ever hides another, every
// room is entered from the hall in front of it, through an opening of its
// front rim, and every lane stays in sight. The lobby is two cells deeper than
// the wings so that it reaches the hall on both sides.
//
// A room of a wing is planned in its own frame: `u` along the wing, `v` from
// the back wall (0) to the front rim (ROOM_DEPTH). Two rows of desks face the
// back wall (desk, chair, aisle; desk, chair, aisle), two cells per desk along
// `u`, and the last column of the room is the aisle that joins both rows to
// the opening. The wing along y is the same plan turned a quarter (x and y
// swapped, every piece at its other turn).

/** Depth of a room of a wing, from its back wall to its front rim, in cells. */
export const ROOM_DEPTH = 6;
/** Width of the hall in front of the wings. */
export const HALL_WIDTH = 2;
/** The lobby in the corner: as deep as a room plus the hall, so it opens onto the hall on both sides. */
export const LOBBY_SIZE = ROOM_DEPTH + HALL_WIDTH;
/** Agents seated in one room at most; the others are listed under the floor without a desk. */
export const MAX_ROOM_AGENTS = 12;
/** Length of the meeting room that evens out two wings of very different lengths. */
const MEETING_LENGTH = 7;

/** Furniture tall enough to hide a window (a window never stands behind one). */
const TALL = new Set(["bookshelf", "whiteboard", "filing-cabinet", "water-cooler", "plant-tall", "coffee-corner"]);

export type FloorRoomInput = {
  /** The room of the home. */
  name: string;
  /** Its agents (`room/agent` keys), in order. */
  keys: string[];
  /** Its colour (a normalized hex), or null for the neutral look. */
  color: string | null;
};

export type FloorPlanOptions = {
  /** The room the lobby's counter is next to (`reception.room` of the home): it opens the wing along x. */
  reception: string | null;
  /** Draw the counter and the receptionist. */
  receptionist?: boolean;
};

type Side = "x" | "y";
type LocalPiece = { name: string; turn: 0 | 1; u: number; v: number };
type LocalDesk = { u: number; v: number };

/** A room of a wing in its own frame. */
type WingPlan = {
  kind: "office" | "meeting";
  length: number;
  pieces: LocalPiece[];
  desks: LocalDesk[];
  owner: LocalDesk | null;
  aisles: Cell[][];
  /** The back wall, one kind per cell along `u`. */
  back: WallKind[];
  /** The opening of the front rim, along `u`. */
  door: number;
};

/**
 * How many cells along the wing a room of `agents` agents takes: a column of
 * two cells per two desks (the agents' and the user's), at least two columns,
 * plus the aisle to the opening.
 */
export function roomLength(agents: number): number {
  const seated = Math.min(MAX_ROOM_AGENTS, Math.max(0, agents));
  return 2 * Math.max(2, Math.ceil((seated + 1) / 2)) + 1;
}

/** On the wing along y the chair of a workstation is beside its second cell (floor.json), one further along `u`. */
const chairShift = (side: Side): number => (side === "y" ? 1 : 0);

/** The back wall of a room: a window every other cell, unless something tall stands in front of it or it is the aisle's column. */
function backWall(length: number, pieces: LocalPiece[], door: number): WallKind[] {
  const tallAt = new Set<number>();
  for (const piece of pieces) {
    if (piece.v !== 0 || !TALL.has(piece.name)) continue;
    const span = piece.name === "bookshelf" || piece.name === "whiteboard" || piece.name === "coffee-corner" ? 2 : 1;
    for (let i = 0; i < span; i += 1) tallAt.add(piece.u + i);
  }
  return Array.from({ length }, (_, u) => (u % 2 === 1 && u !== door && !tallAt.has(u) ? "window" : "plain"));
}

/** The office of a room of the home with `agents` agents (at most MAX_ROOM_AGENTS seated). */
function officePlan(agents: number, side: Side): WingPlan {
  const seated = Math.min(MAX_ROOM_AGENTS, Math.max(0, agents));
  const length = roomLength(seated);
  const columns = (length - 1) / 2;
  const door = length - 1;
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

  // The top of the aisle's column, against the back wall, is free in every room: a tall plant.
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

  return { kind: "office", length, pieces, desks, owner, aisles, back: backWall(length, pieces, door), door };
}

/** The meeting room: a whiteboard, the table and its chairs, plants. Nobody walks into it. */
function meetingPlan(): WingPlan {
  const door = MEETING_LENGTH - 1;
  const pieces: LocalPiece[] = [
    { name: "whiteboard", turn: 0, u: 0, v: 0 },
    { name: "water-cooler", turn: 0, u: 4, v: 0 },
    { name: "plant-tall", turn: 0, u: 6, v: 0 },
    { name: "meeting-table", turn: 0, u: 2, v: 2 },
    { name: "plant-small", turn: 0, u: 0, v: 5 },
  ];
  return { kind: "meeting", length: MEETING_LENGTH, pieces, desks: [], owner: null, aisles: [], back: backWall(MEETING_LENGTH, pieces, door), door };
}

/** A plan of a wing placed on the floor: along x from (`at`, 0), or along y from (0, `at`). */
function placeWing(plan: WingPlan, side: Side, at: number): { spec: RoomSpec; owner: DeskSpec | undefined } {
  const cell = (u: number, v: number): Cell => (side === "x" ? [u, v] : [v, u]);
  const turn = (t: 0 | 1): 0 | 1 => (side === "x" ? t : t === 0 ? 1 : 0);
  const desk = (slot: LocalDesk): DeskSpec => {
    const t = turn(0);
    const shift = chairShift(side);
    return { turn: t, at: cell(slot.u, slot.v), stand: cell(slot.u + shift, slot.v + 2) };
  };
  const pieces: PieceSpec[] = plan.pieces.map((piece) => ({ name: piece.name, turn: turn(piece.turn), at: cell(piece.u, piece.v) }));
  const spec: RoomSpec = {
    kind: plan.kind,
    x: side === "x" ? at : 0,
    y: side === "x" ? 0 : at,
    w: side === "x" ? plan.length : ROOM_DEPTH,
    d: side === "x" ? ROOM_DEPTH : plan.length,
    floor: plan.kind === "meeting" ? "tiles-room" : "carpet-room",
    // The outer wall of the building, with its windows; the side towards the lobby is a low partition (no wall).
    back: side === "x" ? { y: plan.back, x: [] } : { y: [], x: plan.back },
    open: side === "x" ? { y: [plan.door] } : { x: [plan.door] },
    pieces,
    desks: plan.desks.map(desk),
    aisles: plan.aisles.map((line) => line.map(([u, v]) => cell(u, v))),
  };
  return { spec, owner: plan.owner ? desk(plan.owner) : undefined };
}

/**
 * The lobby in the corner of the building, LOBBY_SIZE square: the coffee
 * corner and the user's desk of the reception (where room proposals land)
 * against the back wall, a bookshelf and a sofa by a rug, and the reception
 * counter facing the wing along x, the receptionist behind it. It opens onto
 * the hall on both sides; its aisles join the two halves of the hall.
 */
function lobbyRoom(): { spec: RoomSpec; owner: DeskSpec; counter: NonNullable<BuildRoom["counter"]> } {
  const size = LOBBY_SIZE;
  const piece = (name: string, turn: 0 | 1, at: Cell): PieceSpec => ({ name, turn, at });
  const spec: RoomSpec = {
    kind: "lobby",
    x: 0,
    y: 0,
    w: size,
    d: size,
    floor: "tiles-room",
    back: {
      y: ["plain", "plain", "window", "plain", "window", "plain", "window", "plain"],
      x: ["plain", "window", "plain", "plain", "window", "plain", "window", "plain"],
    },
    open: { x: [ROOM_DEPTH, ROOM_DEPTH + 1], y: [ROOM_DEPTH, ROOM_DEPTH + 1] },
    pieces: [
      piece("coffee-corner", 0, [0, 0]),
      piece("water-cooler", 0, [5, 0]),
      piece("plant-tall", 0, [7, 0]),
      piece("bookshelf", 1, [0, 2]),
      piece("sofa", 1, [0, 4]),
      piece("rug", 0, [1, 4]),
      piece("plant-small", 0, [0, 7]),
      piece("plant-small", 0, [7, 3]),
    ],
    aisles: [
      [
        [2, 2],
        [6, 2],
      ],
      [
        [6, 2],
        [6, size],
      ],
      [
        [6, ROOM_DEPTH],
        [size, ROOM_DEPTH],
      ],
    ],
  };
  return {
    spec,
    owner: { turn: 0, at: [2, 0], stand: [2, 2] },
    counter: { at: [5, 3], staff: [4, 4], stand: [4, 2], faces: "SE", turn: 1 },
  };
}

/**
 * The single floor for the rooms of the home, in their order: the lobby in
 * the corner, the room of the reception first along x, every other room on
 * the shorter wing so the floor stays balanced, and a meeting room at the end
 * of the shorter wing when the two differ by more than its length.
 */
export function layoutFloor(rooms: FloorRoomInput[], options: FloorPlanOptions): RoomLayout {
  const first = rooms.find((room) => room.name === options.reception) ?? rooms[0] ?? null;
  const wings: Record<Side, { room: FloorRoomInput | null; plan: WingPlan }[]> = { x: [], y: [] };
  const lengthOf = (side: Side) => wings[side].reduce((total, entry) => total + entry.plan.length, 0);
  if (first) wings.x.push({ room: first, plan: officePlan(first.keys.length, "x") });
  for (const room of rooms) {
    if (room === first) continue;
    const side: Side = lengthOf("y") <= lengthOf("x") ? "y" : "x";
    wings[side].push({ room, plan: officePlan(room.keys.length, side) });
  }
  const shorter: Side = lengthOf("y") <= lengthOf("x") ? "y" : "x";
  if (Math.abs(lengthOf("x") - lengthOf("y")) >= MEETING_LENGTH) wings[shorter].push({ room: null, plan: meetingPlan() });

  const lobby = lobbyRoom();
  const built: BuildRoom[] = [
    { spec: lobby.spec, project: RECEPTION_ROOM, color: null, keys: [], owner: lobby.owner, counter: lobby.counter },
  ];
  for (const side of ["x", "y"] as const) {
    let at = LOBBY_SIZE;
    for (const { room, plan } of wings[side]) {
      const { spec, owner } = placeWing(plan, side, at);
      at += plan.length;
      built.push({
        spec,
        project: room?.name ?? null,
        color: room?.color ?? null,
        keys: room ? room.keys.slice(0, MAX_ROOM_AGENTS) : [],
        owner,
      });
    }
  }

  // The hall: in front of the wing along x, in front of the wing along y, and the corner where they meet.
  const alongX = Math.max(HALL_WIDTH, lengthOf("x"));
  const alongY = Math.max(HALL_WIDTH, lengthOf("y"));
  const hall: CellRect[] = [
    { x: LOBBY_SIZE, y: ROOM_DEPTH, w: alongX, d: HALL_WIDTH },
    { x: ROOM_DEPTH, y: LOBBY_SIZE, w: HALL_WIDTH, d: alongY },
    { x: LOBBY_SIZE, y: LOBBY_SIZE, w: HALL_WIDTH, d: HALL_WIDTH },
  ];
  // One lane hugging the fronts of the rooms, round the corner of the lobby.
  const lanes: Cell[][] = [
    [
      [LOBBY_SIZE + alongX - 1, ROOM_DEPTH],
      [LOBBY_SIZE, ROOM_DEPTH],
      [LOBBY_SIZE, LOBBY_SIZE],
      [ROOM_DEPTH, LOBBY_SIZE],
      [ROOM_DEPTH, LOBBY_SIZE + alongY - 1],
    ],
  ];
  return assembleLayout({ template: "rooms", rooms: built, hall, lanes }, { reception: options.receptionist ?? false });
}
