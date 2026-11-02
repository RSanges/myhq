// Where things stand in the room, in world units (one unit is one pixel at a
// scale of 1). Pure: no canvas, no clock. The room view draws it, and the
// animation model walks between its points.

export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };

/** Desks per row, at most (the layout is automatic, there is no setting for it). */
export const MAX_COLUMNS = 3;
export const CELL_W = 192;
export const CELL_H = 136;
/** Height of the band above the first row: the whiteboard and the user's desk. */
export const TOP_H = 148;
/** Height of the band under the last row: the coffee corner. */
export const BOTTOM_H = 64;
export const WORLD_W = MAX_COLUMNS * CELL_W;
/** Displayed size of a character, in world units (its sheet cell is drawn at this size). */
export const SPRITE_SIZE = 64;
/** How far from the desk center a visitor stands, to the left or the right of the desk. */
const VISIT_OFFSET = 66;

export type DeskSpot = {
  key: string;
  /** Furniture. */
  desk: Rect;
  chair: Point;
  /** Where the character's feet are when it sits (center, bottom). */
  seat: Point;
  /** Where the name is written. */
  label: Point;
  /** Where a visitor stands, on the left and on the right of the desk. */
  standLeft: Point;
  standRight: Point;
};

export type RoomLayout = {
  width: number;
  height: number;
  desks: DeskSpot[];
  board: Rect;
  userDesk: Rect;
  userChair: Point;
  /** The "to approve" tray, on the user's desk. */
  tray: Rect;
  /** Where an agent stands to drop a folder in the tray. */
  trayStand: Point;
  coffee: Rect;
  plant: Point;
};

export function columnsFor(count: number): number {
  return Math.max(1, Math.min(MAX_COLUMNS, count));
}

/** The layout for the given agent keys, in order: row by row, three per row at most. */
export function layoutRoom(keys: string[]): RoomLayout {
  const rows = Math.max(1, Math.ceil(keys.length / MAX_COLUMNS));
  const height = TOP_H + rows * CELL_H + BOTTOM_H;
  const desks = keys.map((key, index): DeskSpot => {
    const col = index % MAX_COLUMNS;
    const row = Math.floor(index / MAX_COLUMNS);
    const ox = col * CELL_W;
    const oy = TOP_H + row * CELL_H;
    const cx = ox + CELL_W / 2;
    return {
      key,
      desk: { x: cx - 50, y: oy + 68, w: 100, h: 38 },
      chair: { x: cx, y: oy + 80 },
      seat: { x: cx, y: oy + 92 },
      label: { x: cx, y: oy + 112 },
      standLeft: { x: cx - VISIT_OFFSET, y: oy + 100 },
      standRight: { x: cx + VISIT_OFFSET, y: oy + 100 },
    };
  });
  const userDesk: Rect = { x: WORLD_W - 200, y: 42, w: 168, h: 44 };
  return {
    width: WORLD_W,
    height,
    desks,
    board: { x: 16, y: 12, w: 340, h: 108 },
    userDesk,
    userChair: { x: userDesk.x + userDesk.w - 40, y: userDesk.y - 10 },
    tray: { x: userDesk.x + 10, y: userDesk.y + 6, w: 44, h: 30 },
    trayStand: { x: userDesk.x + 32, y: userDesk.y + userDesk.h + 36 },
    coffee: { x: 28, y: height - BOTTOM_H + 8, w: 34, h: 44 },
    plant: { x: WORLD_W - 36, y: height - 30 },
  };
}

export function deskOf(layout: RoomLayout, key: string): DeskSpot | null {
  return layout.desks.find((desk) => desk.key === key) ?? null;
}

/**
 * Where a visitor from `from` stands to talk to the owner of `target`: on the
 * side of the desk that faces the visitor.
 */
export function visitSpot(from: DeskSpot, target: DeskSpot): Point {
  return from.seat.x <= target.seat.x ? target.standLeft : target.standRight;
}
