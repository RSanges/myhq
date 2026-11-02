// The floor plans: a few hand-designed templates by size, as plain data. Each
// one is a small agency's floor with every room placed and sized by hand (one
// agent per desk, offices sized to their desk, a corridor that loops, a meeting
// room, an open kitchen, a lounge, a lobby with the "to approve" tray, the
// user's own office). room-layout.ts turns a template into the layout the
// room view draws and the agents walk in; this file can be refined without
// touching the renderer or the model.
//
// World units: one unit is one pixel at a scale of 1. Rows of offices are 72
// deep, corridors 34 wide, a desk is 38 by 15 (the character sits behind it).
// A door is a gap in a wall, given by the wall it is in and its coordinate
// along that wall. Agents fill the desks in order, room after room.

export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };
export type Side = "top" | "bottom" | "left" | "right";

export type ItemTone = "wood" | "dark" | "soft" | "paper" | "chair" | "green" | "leaf";

export type Item =
  | { t: "box"; x: number; y: number; w: number; h: number; tone: ItemTone; r?: number }
  | { t: "disc"; x: number; y: number; r: number; tone: ItemTone };

export type RoomKind = "office" | "meeting" | "kitchen" | "lounge" | "closet" | "user";

export type RoomSpec = {
  kind: RoomKind;
  rect: Rect;
  door: { wall: Side; at: number; w?: number };
  /** Walls left out: the room is open on that side (a kitchen onto the corridor). */
  open?: Side[];
  /** Desks of agents: how many (placed along the wall opposite the door), or hand-placed rectangles. */
  desks?: number | Rect[];
  items?: Item[];
  /** The whiteboard of a meeting room. */
  board?: Rect;
  /** The coffee machine of a kitchen. */
  machine?: Rect;
  /** The user's desk, chair and monitor (the user's office only). */
  userDesk?: { desk: Rect; chair: Point; monitor: Rect };
};

export type FloorTemplate = {
  id: "small" | "medium" | "large";
  width: number;
  height: number;
  /** The envelope of the building. */
  outline: Point[];
  rooms: RoomSpec[];
  /** Center lines of the corridors: every door joins the nearest one, agents walk along them. */
  corridors: Point[][];
  /** Window bands along the outer walls. */
  windows: [Point, Point][];
  /** The lobby next to the user's office: the console with the "to approve" tray, and where an agent stands to drop a folder. */
  lobby: { tray: Rect; console: Rect; stand: Point; items: Item[] };
};

// ---- Small builders for furniture --------------------------------------------------------

const box = (x: number, y: number, w: number, h: number, tone: ItemTone, r = 2): Item => ({ t: "box", x, y, w, h, tone, r });
const disc = (x: number, y: number, r: number, tone: ItemTone): Item => ({ t: "disc", x, y, r, tone });
const plant = (x: number, y: number): Item[] => [disc(x, y, 6, "green"), disc(x + 2, y - 2, 3.4, "leaf")];
const shelf = (x: number, y: number, w = 26): Item => box(x, y, w, 7, "wood", 1);
const sofa = (x: number, y: number, w = 40): Item => box(x, y, w, 15, "soft", 4);
const table = (x: number, y: number, r = 12): Item[] => [disc(x, y, r, "wood"), disc(x - r - 6, y, 4.5, "chair"), disc(x + r + 6, y, 4.5, "chair")];

type Decor = { plant?: "left" | "right"; shelf?: "left" | "right"; sofa?: boolean };

/** An office on a corridor: the desks go on the wall opposite its door, the rest of the room is decorated. */
function office(rect: Rect, wall: "top" | "bottom", at: number, desks: number, decor: Decor = {}): RoomSpec {
  // The door side is the one the decoration leans on; the desks are on the other.
  const edge = wall === "bottom" ? rect.y + rect.h - 9 : rect.y + 3;
  const corner = wall === "bottom" ? rect.y + rect.h - 12 : rect.y + 12;
  const items: Item[] = [];
  if (decor.plant) items.push(...plant(decor.plant === "left" ? rect.x + 10 : rect.x + rect.w - 10, corner));
  if (decor.shelf) items.push(shelf(decor.shelf === "left" ? rect.x + 5 : rect.x + rect.w - 31, edge));
  if (decor.sofa) items.push(sofa(rect.x + rect.w - 48, wall === "bottom" ? rect.y + 8 : rect.y + rect.h - 23, 40));
  return { kind: "office", rect, door: { wall, at }, desks, items };
}

const lobbyItems = (x0: number, y0: number, x1: number, y1: number): Item[] => [
  sofa(x0 + 14, y1 - 44, 62),
  sofa(x1 - 86, y1 - 44, 62),
  ...plant(x1 - 18, y0 + 30),
  ...plant(x0 + 14, y1 - 14),
  ...plant(x1 - 18, y1 - 14),
  ...table((x0 + x1) / 2 + 6, y1 - 78, 11),
];

const kitchen = (x: number, y: number, w: number, h: number): RoomSpec => ({
  kind: "kitchen",
  rect: { x, y, w, h },
  door: { wall: "top", at: x + w / 2, w: w - 20 },
  open: ["top"],
  machine: { x: x + 14, y: y + h - 22, w: 20, h: 12 },
  items: [
    box(x + 6, y + h - 12, w - 12, 8, "wood", 1),
    ...table(x + w / 2 + 12, y + h - 50, 12),
    ...plant(x + w - 12, y + 18),
  ],
});

const meeting = (rect: Rect, at: number, board: Rect, tableRect: Rect): RoomSpec => {
  const chairs: Item[] = [];
  const count = Math.max(3, Math.floor(tableRect.w / 22));
  for (let i = 0; i < count; i += 1) {
    const x = tableRect.x + (tableRect.w * (i + 0.5)) / count;
    chairs.push(disc(x, tableRect.y - 6, 4.5, "chair"), disc(x, tableRect.y + tableRect.h + 6, 4.5, "chair"));
  }
  return {
    kind: "meeting",
    rect,
    door: { wall: "top", at },
    board,
    items: [box(tableRect.x, tableRect.y, tableRect.w, tableRect.h, "wood", 8), ...chairs, ...plant(rect.x + rect.w - 12, rect.y + rect.h - 12)],
  };
};

const lounge = (rect: Rect, wall: "top" | "bottom", at: number): RoomSpec => ({
  kind: "lounge",
  rect,
  door: { wall, at },
  items: [sofa(rect.x + 8, wall === "top" ? rect.y + rect.h - 22 : rect.y + 8, 52), ...table(rect.x + rect.w - 38, rect.y + rect.h / 2, 10), ...plant(rect.x + 12, wall === "top" ? rect.y + 14 : rect.y + rect.h - 14)],
});

const closet = (rect: Rect, wall: "top" | "bottom", at: number): RoomSpec => ({
  kind: "closet",
  rect,
  door: { wall, at },
  items: [shelf(rect.x + 4, wall === "top" ? rect.y + rect.h - 11 : rect.y + 4, rect.w - 8), box(rect.x + 8, rect.y + rect.h / 2 - 6, rect.w - 16, 10, "paper", 1)],
});

const userOffice = (rect: Rect, at: number): RoomSpec => {
  const cx = rect.x + rect.w / 2 - 18;
  return {
    kind: "user",
    rect,
    door: { wall: "bottom", at },
    userDesk: {
      desk: { x: cx - 24, y: rect.y + 26, w: 56, h: 17 },
      chair: { x: cx + 4, y: rect.y + 20 },
      monitor: { x: cx + 8, y: rect.y + 30, w: 20, h: 11 },
    },
    items: [shelf(rect.x + 6, rect.y + 6, 34), ...plant(rect.x + 14, rect.y + rect.h - 14), ...plant(rect.x + rect.w - 12, rect.y + 14), sofa(rect.x + rect.w - 56, rect.y + rect.h - 24, 44)],
  };
};

const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
const outlineOf = (x0: number, y0: number, x1: number, y1: number): Point[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
const p = (x: number, y: number): Point => ({ x, y });

// ---- Large: 7 to 12 agents ----------------------------------------------------------------
// Three bands: offices (and the user's office), a corridor, offices, a corridor,
// then the meeting room, the open kitchen and storage; a lobby on the right
// joins the two corridors.

const large: FloorTemplate = {
  id: "large",
  width: 800,
  height: 352,
  outline: outlineOf(10, 10, 790, 342),
  rooms: [
    office(rect(10, 10, 140, 72), "bottom", 80, 2, { plant: "left", shelf: "right" }),
    office(rect(150, 10, 76, 72), "bottom", 170, 1, { plant: "right" }),
    office(rect(226, 10, 140, 72), "bottom", 296, 2, { plant: "left", shelf: "right" }),
    office(rect(366, 10, 78, 72), "bottom", 386, 1, { shelf: "right" }),
    office(rect(444, 10, 146, 72), "bottom", 468, 1, { plant: "left", sofa: true }),
    userOffice(rect(590, 10, 200, 72), 740),
    office(rect(10, 116, 76, 72), "top", 30, 1, { plant: "right" }),
    office(rect(86, 116, 140, 72), "top", 156, 2, { plant: "left", shelf: "right" }),
    office(rect(226, 116, 76, 72), "top", 246, 1, { shelf: "right" }),
    office(rect(302, 116, 78, 72), "top", 322, 1, { plant: "right" }),
    lounge(rect(380, 116, 140, 72), "top", 450),
    closet(rect(520, 116, 70, 72), "top", 540),
    meeting(rect(10, 222, 280, 120), 262, rect(18, 232, 138, 100), rect(176, 262, 104, 30)),
    kitchen(290, 222, 150, 120),
    closet(rect(440, 222, 70, 120), "top", 460),
    lounge(rect(510, 222, 80, 120), "top", 530),
  ],
  corridors: [
    [p(14, 99), p(612, 99), p(748, 99)],
    [p(612, 99), p(612, 205), p(612, 330)],
    [p(14, 205), p(612, 205)],
  ],
  windows: [
    [p(24, 10), p(136, 10)],
    [p(160, 10), p(216, 10)],
    [p(240, 10), p(352, 10)],
    [p(376, 10), p(434, 10)],
    [p(458, 10), p(580, 10)],
    [p(604, 10), p(780, 10)],
    [p(790, 20), p(790, 72)],
    [p(790, 110), p(790, 330)],
    [p(606, 342), p(780, 342)],
  ],
  lobby: {
    console: rect(642, 84, 60, 10),
    tray: rect(648, 85, 36, 9),
    stand: p(664, 109),
    items: lobbyItems(590, 82, 790, 342),
  },
};

// ---- Medium: 4 to 7 agents ------------------------------------------------------------------

const medium: FloorTemplate = {
  id: "medium",
  width: 620,
  height: 352,
  outline: outlineOf(10, 10, 610, 342),
  rooms: [
    office(rect(10, 10, 140, 72), "bottom", 80, 2, { plant: "left", shelf: "right" }),
    office(rect(150, 10, 76, 72), "bottom", 170, 1, { plant: "right" }),
    office(rect(226, 10, 124, 72), "bottom", 250, 1, { plant: "left", sofa: true }),
    lounge(rect(350, 10, 90, 72), "bottom", 370),
    userOffice(rect(440, 10, 170, 72), 560),
    office(rect(10, 116, 76, 72), "top", 30, 1, { plant: "right" }),
    office(rect(86, 116, 140, 72), "top", 156, 2, { plant: "left", shelf: "right" }),
    lounge(rect(226, 116, 120, 72), "top", 260),
    closet(rect(346, 116, 94, 72), "top", 366),
    meeting(rect(10, 222, 250, 120), 236, rect(18, 232, 126, 100), rect(160, 262, 92, 30)),
    kitchen(260, 222, 130, 120),
    closet(rect(390, 222, 50, 120), "top", 410),
  ],
  corridors: [
    [p(14, 99), p(452, 99), p(568, 99)],
    [p(452, 99), p(452, 205), p(452, 330)],
    [p(14, 205), p(452, 205)],
  ],
  windows: [
    [p(24, 10), p(136, 10)],
    [p(160, 10), p(216, 10)],
    [p(240, 10), p(340, 10)],
    [p(364, 10), p(430, 10)],
    [p(454, 10), p(600, 10)],
    [p(610, 20), p(610, 72)],
    [p(610, 110), p(610, 330)],
    [p(466, 342), p(600, 342)],
  ],
  lobby: {
    console: rect(472, 84, 60, 10),
    tray: rect(478, 85, 36, 9),
    stand: p(494, 109),
    items: lobbyItems(440, 82, 610, 342),
  },
};

// ---- Small: 1 to 3 agents ----------------------------------------------------------------------

const small: FloorTemplate = {
  id: "small",
  width: 460,
  height: 240,
  outline: outlineOf(10, 10, 450, 230),
  rooms: [
    office(rect(10, 10, 140, 72), "bottom", 80, 2, { plant: "left", shelf: "right" }),
    office(rect(150, 10, 120, 72), "bottom", 174, 1, { plant: "right", sofa: true }),
    closet(rect(270, 10, 60, 72), "bottom", 290),
    userOffice(rect(330, 10, 120, 72), 400),
    meeting(rect(10, 116, 200, 114), 190, rect(16, 124, 116, 98), rect(142, 150, 62, 28)),
    kitchen(210, 116, 120, 114),
  ],
  corridors: [[p(14, 99), p(340, 99), p(408, 99)]],
  windows: [
    [p(24, 10), p(136, 10)],
    [p(160, 10), p(260, 10)],
    [p(344, 10), p(440, 10)],
    [p(450, 20), p(450, 72)],
    [p(450, 110), p(450, 220)],
    [p(346, 230), p(440, 230)],
  ],
  lobby: {
    console: rect(346, 84, 52, 10),
    tray: rect(351, 85, 32, 9),
    stand: p(367, 109),
    items: [sofa(344, 196, 54), sofa(400, 196, 40), ...plant(440, 140), ...plant(352, 150)],
  },
};

export const FLOOR_TEMPLATES: Record<FloorTemplate["id"], FloorTemplate> = { small, medium, large };

/** How many agents the template seats: one per desk of its offices. */
export function capacityOf(template: FloorTemplate): number {
  return template.rooms.reduce((total, room) => total + (typeof room.desks === "number" ? room.desks : (room.desks?.length ?? 0)), 0);
}

/** The smallest template that seats `count` agents (the largest when none does). */
export function templateFor(count: number): FloorTemplate {
  for (const template of [small, medium, large]) if (capacityOf(template) >= count) return template;
  return large;
}
