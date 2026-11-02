// The floor plan, in world units (one unit is one pixel at a scale of 1): a
// corridor with a closed office per agent on each side, a meeting room with
// the whiteboard and a coffee corner at one end, the user's office at the
// other. Pure: no canvas, no clock. The room view draws it and the animation
// model walks along its routes (through doors and along the corridor, never
// through a wall). The plan is built from the number of agents: nothing in it
// is fixed to a given count.

export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };

/** Outer margin of the plan. */
export const MARGIN = 14;
/** Thickness of a wall. */
export const WALL = 3;
export const CORRIDOR_H = 60;
export const OFFICE_W = 120;
/** Offices widen up to this when there are few of them, so that a small floor still fills a wide screen. */
export const MAX_OFFICE_W = 180;
/** Width of the meeting room and of the coffee corner, at the entrance end. */
export const SIDE_W = 200;
export const USER_W = 210;
export const DOOR_W = 30;
/** Displayed size of a character, in world units (its sheet cell is drawn at this size). */
export const SPRITE_SIZE = 26;
/** The plan is shaped for a screen about this much wider than tall (depth of the offices follows). */
export const TARGET_ASPECT = 2;
export const MIN_DEPTH = 130;
export const MAX_DEPTH = 230;

export type Door = {
  /** Center of the gap, on the wall. */
  x: number;
  y: number;
  /** Length of the gap. */
  w: number;
  /** The wall the gap is cut in. */
  wall: "top" | "bottom" | "left";
};

export type Office = {
  key: string;
  room: Rect;
  side: "top" | "bottom";
  door: Door;
  desk: Rect;
  chair: Point;
  /** Where the character's feet are when it sits (center, bottom). */
  seat: Point;
  /** The name plate, on the back wall. */
  plate: Point;
  /** From the seat out to the corridor, ending on its center line. */
  exit: Point[];
  /** From the corridor center line to where a visitor stands inside. */
  visit: Point[];
};

export type RoomLayout = {
  width: number;
  height: number;
  corridor: Rect;
  /** y of the center line of the corridor, where every route runs. */
  lineY: number;
  offices: Office[];
  /** Empty slots of the plan (an odd number of agents leaves one). */
  vacant: Rect[];
  meeting: { room: Rect; door: Door; board: Rect };
  coffee: { room: Rect; door: Door; machine: Rect; table: Point; plant: Point };
  user: {
    room: Rect;
    door: Door;
    desk: Rect;
    chair: Point;
    monitor: Rect;
    /** The "to approve" tray on the desk. */
    tray: Rect;
    /** Where an agent stands to drop a folder in the tray. */
    stand: Point;
    /** From the corridor center line, in front of the user's door, to `stand`. */
    approach: Point[];
  };
};

export function columnsFor(count: number): number {
  return Math.max(1, Math.ceil(count / 2));
}

const same = (a: Point, b: Point): boolean => Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;

/** A route without consecutive duplicate points. */
export function tidy(points: Point[]): Point[] {
  return points.filter((point, index) => index === 0 || !same(point, points[index - 1]!));
}

/** The floor plan for the given agent keys, in order: they alternate between the two sides of the corridor. */
export function layoutRoom(keys: string[]): RoomLayout {
  const cols = columnsFor(keys.length);
  const officesX = MARGIN + SIDE_W;
  const baseWidth = officesX + cols * OFFICE_W + USER_W + MARGIN;
  const depth = Math.max(
    MIN_DEPTH,
    Math.min(MAX_DEPTH, Math.round((baseWidth / TARGET_ASPECT - 2 * MARGIN - CORRIDOR_H) / 2)),
  );
  const height = 2 * MARGIN + 2 * depth + CORRIDOR_H;
  // Few offices: widen them until the plan has the shape of a wide screen.
  const officeW = Math.min(MAX_OFFICE_W, Math.max(OFFICE_W, Math.round((height * TARGET_ASPECT - baseWidth) / cols) + OFFICE_W));
  const userX = officesX + cols * officeW;
  const width = userX + USER_W + MARGIN;
  const topY = MARGIN;
  const bottomY = MARGIN + depth + CORRIDOR_H;
  const lineY = MARGIN + depth + CORRIDOR_H / 2;

  const offices = keys.map((key, index): Office => {
    const col = Math.floor(index / 2);
    const side = index % 2 === 0 ? "top" : "bottom";
    const room: Rect = { x: officesX + col * officeW, y: side === "top" ? topY : bottomY, w: officeW, h: depth };
    const cx = room.x + room.w / 2;
    const seatY = side === "top" ? room.y + 52 : room.y + depth - 34;
    const doorY = side === "top" ? room.y + depth : room.y;
    const doorIn = { x: cx, y: side === "top" ? room.y + depth - 14 : room.y + 14 };
    const entry = { x: cx, y: lineY };
    return {
      key,
      room,
      side,
      door: { x: cx, y: doorY, w: DOOR_W, wall: side === "top" ? "bottom" : "top" },
      desk: { x: cx - 30, y: seatY - 6, w: 60, h: 20 },
      chair: { x: cx, y: seatY - 7 },
      seat: { x: cx, y: seatY },
      plate: { x: cx, y: side === "top" ? room.y + 11 : room.y + depth - 11 },
      exit: tidy([
        { x: cx, y: seatY },
        { x: cx + 42, y: seatY },
        { x: cx + 42, y: doorIn.y },
        doorIn,
        entry,
      ]),
      visit: tidy([entry, doorIn, { x: cx - 42, y: doorIn.y }, { x: cx - 42, y: seatY + 3 }]),
    };
  });

  const vacant: Rect[] = [];
  if (keys.length % 2 === 1) {
    vacant.push({ x: officesX + (cols - 1) * officeW, y: bottomY, w: officeW, h: depth });
  }

  const meetingRoom: Rect = { x: MARGIN, y: topY, w: SIDE_W, h: depth };
  const coffeeRoom: Rect = { x: MARGIN, y: bottomY, w: SIDE_W, h: depth };

  const userRoom: Rect = { x: userX, y: topY, w: USER_W, h: 2 * depth + CORRIDOR_H };
  const deskX = userX + USER_W / 2 - 50;
  const deskY = topY + 40;
  const userDesk: Rect = { x: deskX, y: deskY, w: 100, h: 26 };
  const tray: Rect = { x: deskX + 6, y: deskY + 3, w: 34, h: 20 };
  const stand = { x: tray.x + tray.w / 2, y: deskY + userDesk.h + 24 };
  const doorOutside = { x: userX - 14, y: lineY };
  const doorInside = { x: userX + 26, y: lineY };

  return {
    width,
    height,
    corridor: { x: MARGIN, y: MARGIN + depth, w: userX - MARGIN, h: CORRIDOR_H },
    lineY,
    offices,
    vacant,
    meeting: {
      room: meetingRoom,
      door: { x: meetingRoom.x + meetingRoom.w / 2, y: topY + depth, w: DOOR_W, wall: "bottom" },
      board: { x: meetingRoom.x + 8, y: topY + 8, w: SIDE_W - 16, h: depth - 40 },
    },
    coffee: {
      room: coffeeRoom,
      door: { x: coffeeRoom.x + coffeeRoom.w / 2, y: bottomY, w: DOOR_W * 2, wall: "top" },
      machine: { x: coffeeRoom.x + 18, y: bottomY + depth - 52, w: 30, h: 38 },
      table: { x: coffeeRoom.x + SIDE_W - 56, y: bottomY + depth - 44 },
      plant: { x: coffeeRoom.x + SIDE_W - 20, y: bottomY + 30 },
    },
    user: {
      room: userRoom,
      door: { x: userX, y: lineY, w: DOOR_W + 6, wall: "left" },
      desk: userDesk,
      chair: { x: deskX + 70, y: deskY - 6 },
      monitor: { x: deskX + 58, y: deskY + 4, w: 28, h: 16 },
      tray,
      stand,
      approach: tidy([doorOutside, doorInside, { x: stand.x, y: lineY }, stand]),
    },
  };
}

export function officeOf(layout: RoomLayout, key: string): Office | null {
  return layout.offices.find((office) => office.key === key) ?? null;
}

/** The route from an agent's seat to where a visitor stands in another agent's office. */
export function routeToOffice(from: Office, to: Office): Point[] {
  return tidy([...from.exit, ...to.visit]);
}

/** The route from an agent's seat to the tray of the user's desk. */
export function routeToUser(layout: RoomLayout, from: Office): Point[] {
  return tidy([...from.exit, ...layout.user.approach]);
}

/** Total length of a route. */
export function routeLength(route: Point[]): number {
  let length = 0;
  for (let i = 1; i < route.length; i += 1) length += Math.hypot(route[i]!.x - route[i - 1]!.x, route[i]!.y - route[i - 1]!.y);
  return length;
}

/**
 * The point at `fraction` (0 to 1) of the length of a route, and the way the
 * character faces there (1 right, -1 left): the direction of its segment, or
 * of the nearest segment that is not straight up or down.
 */
export function pointOnRoute(route: Point[], fraction: number): { point: Point; facing: 1 | -1 } {
  const total = routeLength(route);
  let remaining = Math.min(1, Math.max(0, fraction)) * total;
  const direction = (index: number): 1 | -1 | 0 => {
    const dx = route[index]!.x - route[index - 1]!.x;
    return dx > 0.5 ? 1 : dx < -0.5 ? -1 : 0;
  };
  for (let i = 1; i < route.length; i += 1) {
    const a = route[i - 1]!;
    const b = route[i]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (remaining <= length || i === route.length - 1) {
      const t = length === 0 ? 1 : Math.min(1, remaining / length);
      let facing = direction(i);
      for (let j = i - 1; facing === 0 && j >= 1; j -= 1) facing = direction(j);
      for (let j = i + 1; facing === 0 && j < route.length; j += 1) facing = direction(j);
      return { point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, facing: facing === 0 ? 1 : facing };
    }
    remaining -= length;
  }
  return { point: route[0] ?? { x: 0, y: 0 }, facing: 1 };
}
