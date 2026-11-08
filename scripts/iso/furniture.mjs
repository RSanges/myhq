// The floor set: tiles, walls and furniture for the office floor, where
// each room is a cutaway box (back walls at full height, front walls as a
// low rim). Every piece is drawn in its model frame, front facing +y
// (towards the lower left of the screen), inside a footprint of whole
// floor cells (16 x 16 voxels); the build turns it a quarter turn for the
// other orientation (front facing +x), never mirrors it.
//
// One voxel is about 3 cm and furniture is life size: a desk top is at
// z = 25 (75 cm), a seat at z = 14, a standing character about 52 voxels.
import { LEFT, NX, NY, RIGHT, TOP, hash, material } from "./engine.mjs";
import { floorLamp as hubFloorLamp, leaf, plant as hubPlant } from "./props.mjs";

export const CELL = 16;
export const WALL = { height: 64, thick: 4, rim: 6 };
export const DESK_TOP = 25;
export const SEAT_TOP = 14;

const frac = (value) => value - Math.floor(value);
const band = (c, from, width = 0.5) => c >= from && c < from + width;
const within = (c, from, to) => c >= from && c < to;

// ---------------------------------------------------------------- materials

const ink = material({ ramp: "ink", top: 3, left: 2, right: 1 });
const inkSoft = material({ ramp: "ink", top: 4, left: 3, right: 2 });
const chrome = material({ ramp: "ink", top: 5, left: 4, right: 3 });
const oak = material({ ramp: "wood", top: 4, left: 3, right: 2 });
const walnut = material({ ramp: "wood", top: 3, left: 2, right: 1 });
const paper = material({ ramp: "paper", top: 4, left: 3, right: 2 });
const white = material({ ramp: "paper", top: 4, left: 4, right: 3 });
const soil = material({ ramp: "wood", top: 1, left: 1, right: 1, rim: false });
const gold = material({ ramp: "gold", top: 3, left: 2, right: 1 });
const leafA = material({ ramp: "leaf", top: 4, left: 3, right: 2, rim: false });
const leafB = material({ ramp: "leaf", top: 3, left: 2, right: 1, rim: false });
const fabric = material({ ramp: "ink", top: 3, left: 2, right: 1, rim: false });

/** A screen material for a monitor body facing +y, the screen at x [x0, x1), z [z0, z1). */
function screenBody([x0, x1], [z0, z1], { face = LEFT } = {}) {
  return material({
    ramp: "ink", top: 2, left: 2, right: 1,
    paint(f, x, y, z, level) {
      if (f !== face || !within(x, x0, x1) || !within(z, z0, z1)) return level;
      const s = (lvl, ramp = "sky") => ({ ramp, level: lvl, emissive: true });
      const lx = x - x0, lz = z1 - z;
      if (lz < 1) return s(1);
      if (within(lx, 1, 4) && within(lz, 2, 4)) return s(2, "pink");
      for (const [row, len] of [[5, 0.6], [6.5, 0.45], [8, 0.55]]) if (band(lz, row) && within(lx, 1, 1 + (x1 - x0 - 2) * len)) return s(1);
      return s(3);
    },
  });
}

// ---------------------------------------------------------------- tiles

/**
 * Floor tiles, one cell each, a voxel thick: oak boards, carpet, ceramic
 * tiles. `variant` (0 to 2) moves board ends or speckles, so a floor of
 * many cells does not repeat visibly. The *-room kinds take the room colour
 * at runtime (pastel tint).
 */
export function tile(b, { kind = "wood", variant = 0 } = {}) {
  const defs = {
    wood: {
      ramp: "wood", top: 4, left: 3, right: 2,
      paint(face, x, y, z, level) {
        if (face !== TOP) return level;
        const board = Math.floor(y / 4);
        if (band(frac(y / 4) * 4, 0)) return level - 1; // seams between boards
        const end = Math.floor(hash(board, variant, 7) * 16);
        if (band((x + end) % 16, 0)) return level - 1; // board ends
        return level;
      },
    },
    carpet: {
      ramp: "ink", top: 4, left: 3, right: 2, rim: false,
      paint(face, x, y, z, level) {
        if (face !== TOP) return level;
        return hash(Math.floor(x * 2), Math.floor(y * 2), variant) < 0.12 ? level - 1 : level;
      },
    },
    tiles: {
      ramp: "paper", top: 4, left: 3, right: 2,
      paint(face, x, y, z, level) {
        if (face !== TOP) return level;
        if (band(frac(x / 8) * 8, 0) || band(frac(y / 8) * 8, 0)) return level - 1; // grout
        return level;
      },
    },
    "carpet-room": {
      ramp: "pink", top: 3, left: 2, right: 1, rim: false, tint: "pastel",
      paint(face, x, y, z, level) {
        if (face !== TOP) return level;
        return hash(Math.floor(x * 2), Math.floor(y * 2), variant) < 0.12 ? level - 1 : level;
      },
    },
    // The garden between the suites of the single floor: short grass, a few lighter blades and darker tufts.
    grass: {
      ramp: "leaf", top: 2, left: 1, right: 0, rim: false,
      paint(face, x, y, z, level) {
        if (face !== TOP) return level;
        const h = hash(Math.floor(x), Math.floor(y), variant + 11);
        if (h < 0.07) return level + 1;
        if (h > 0.9) return level - 1;
        return level;
      },
    },
    "tiles-room": {
      ramp: "paper", top: 4, left: 3, right: 2,
      paint(face, x, y, z, level) {
        if (face !== TOP) return level;
        if (band(frac(x / 8) * 8, 0) || band(frac(y / 8) * 8, 0)) return level - 1;
        return level;
      },
    },
  };
  const m = material(defs[kind]);
  b.box(0, 0, -1, CELL, CELL, 1, m);
  if (kind === "tiles-room") {
    // Two of the four ceramic tiles in the room colour, a checkerboard.
    const accent = material({ ramp: "pink", top: 3, left: 2, right: 1, tint: "pastel", paint: defs.tiles.paint });
    for (const [x, y] of [[0, 0], [8, 8]]) b.box(x, y, -1, 8, 8, 1, accent);
  }
}

// ---------------------------------------------------------------- walls

const wallPaint = material({
  ramp: "sage", top: 3, left: 2, right: 1,
  paint(face, x, y, z, level) {
    if (face === TOP) return { ramp: "paper", level: 3 };
    return level;
  },
});
const skirting = material({ ramp: "paper", top: 4, left: 3, right: 2 });
const frame = material({ ramp: "paper", top: 4, left: 3, right: 3 });

/**
 * A back wall segment for one cell, in the model frame: it runs along x
 * over [0, 16) at y in [-4, 0) (behind the cell), its painted face towards
 * +y. `kind`: plain, window or door. Turned once, it runs along y behind
 * x = 0, face towards +x.
 */
export function wall(b, { kind = "plain" } = {}) {
  const { height: H, thick: T } = WALL;
  b.box(0, -T, 0, CELL, T, H, wallPaint);
  b.box(0, 0, 0, CELL, 1, 3, skirting);
  if (kind === "window") {
    const win = { x: 2, z: 26, w: 12, h: 26 };
    const glass = material({
      ramp: "sky", transparent: true, emissive: true, rim: false,
      paint(face, x, y, z) {
        const wx = x - win.x, wz = z - win.z;
        const hills = 3 + (within(wx, 2, 8) ? 2 : 0) + (within(wx, 4, 6) ? 1 : 0);
        if (wz < hills) return { ramp: "leaf", level: wz < hills - 1 ? 2 : 3 };
        if ((within(wx, 6, 11) && band(wz, 18, 1.5)) || (within(wx, 7, 10) && band(wz, 19.5, 1))) return { level: 3 };
        return { level: wz < 10 ? 2 : 1 };
      },
    });
    b.clear(win.x, -T, win.z, win.w, T, win.h);
    b.box(win.x, -T + 1, win.z, win.w, 1, win.h, glass);
    const fy = -2;
    b.box(win.x, fy, win.z, win.w, 1, 2, frame);
    b.box(win.x, fy, win.z + win.h - 2, win.w, 1, 2, frame);
    b.box(win.x, fy, win.z, 2, 1, win.h, frame);
    b.box(win.x + win.w - 2, fy, win.z, 2, 1, win.h, frame);
    b.box(win.x + win.w / 2 - 1, fy, win.z, 2, 1, win.h, frame);
    b.box(win.x, fy, win.z + 15, win.w, 1, 1, frame);
    b.box(win.x - 1, -1, win.z - 2, win.w + 2, 3, 2, skirting); // sill
  }
  if (kind === "door") {
    const door = { x: 2, w: 12, h: 40 };
    b.clear(door.x, -T, 0, door.w, T + 1, door.h);
    b.box(door.x - 1, -T, 0, 1, T + 1, door.h + 1, frame);
    b.box(door.x + door.w, -T, 0, 1, T + 1, door.h + 1, frame);
    b.box(door.x - 1, -T, door.h, door.w + 2, T + 1, 2, frame);
  }
}

/** The post where two back walls meet, behind the cell corner: x and y in [-4, 0). */
export function wallCorner(b) {
  b.box(-WALL.thick, -WALL.thick, 0, WALL.thick, WALL.thick, WALL.height, wallPaint);
}

const rimMaterial = material({
  ramp: "sage", top: 3, left: 2, right: 1,
  paint(face, x, y, z, level) {
    if (face === TOP) return { ramp: "paper", level: 4 };
    if (z >= WALL.rim - 1) return { ramp: "paper", level: face === LEFT ? 3 : 2 }; // the cut, a paper cap
    return level;
  },
});

/**
 * The low front rim of a cutaway room for one cell: along x over [0, 16)
 * at y in [16, 20) (in front of the cell), WALL.rim voxels high. Turned
 * once, it runs along y in front of x = 16.
 */
export function rim(b) {
  b.box(0, CELL, 0, CELL, WALL.thick, WALL.rim, rimMaterial);
}

/** The rim post at the front corner of a cell: x and y in [16, 20). */
export function rimCorner(b) {
  b.box(CELL, CELL, 0, WALL.thick, WALL.thick, WALL.rim, rimMaterial);
}

// ---------------------------------------------------------------- desks

/**
 * A workstation, 2 x 1 cells: an oak desk (top at z = 25) with a monitor
 * facing +y over the left cell, a keyboard, a mouse, a mug, papers and a
 * small plant on the right. The chair goes in the cell in front of the
 * left cell (see WORKSTATION_SEAT); the sitter faces the screen (-y).
 */
export function workstation(target) {
  const b = target;
  b.box(1, 1, 23, 30, 14, 2, oak);
  for (const x of [1, 29]) b.box(x, 1, 0, 2, 14, 23, walnut);
  b.box(3, 1, 12, 26, 1, 11, walnut); // modesty panel
  // Monitor on a stand, screen towards +y, centred on the sitter.
  b.box(5, 3, DESK_TOP, 7, 4, 1, inkSoft);
  b.box(8, 4, DESK_TOP + 1, 2, 2, 6, chrome);
  b.box(0, 5, DESK_TOP + 5, 18, 2, 13, screenBody([1, 17], [DESK_TOP + 6, DESK_TOP + 17]));
  b.del(0, 5, DESK_TOP + 5); b.del(0, 6, DESK_TOP + 5);
  const keys = material({
    ramp: "ink", top: 5, left: 4, right: 3,
    paint(face, x, y, z, level) {
      if (face !== TOP) return level;
      return band(frac(x / 1.5) * 1.5, 1) || band(frac(y), 0.5) ? level - 1 : level;
    },
  });
  b.box(3, 9, DESK_TOP, 12, 4, 1, keys);
  b.box(17, 10, DESK_TOP, 2, 3, 1, chrome);
  const mugM = material({ ramp: "paper", top: 4, left: 3, right: 2, round: [21.5, 6.5] });
  b.cylinder(21.5, 6.5, DESK_TOP, 1.8, 4, mugM);
  b.set(21, 6, DESK_TOP + 3, soil);
  b.box(23, 8, DESK_TOP, 6, 5, 1, white);
  b.box(24, 7, DESK_TOP + 1, 6, 5, 1, paper);
  const pot = material({ ramp: "sage", top: 3, left: 2, right: 1, round: [27, 4] });
  b.cylinder(27, 4, DESK_TOP, 2, 3, pot);
  const plantTarget = { ...b, set: (x, y, z, m) => { if (!b.has(x, y, z)) b.set(x, y, z, m); } };
  for (let i = 0; i < 6; i++) leaf(plantTarget, [27, 4, DESK_TOP + 3], i * 1.05 + 0.2, 3.5, 1, 1.5, i % 2 ? leafA : leafB, leafB);
}
/** The chair of a workstation: model cell offset from the desk's first cell, and the chair turn (same as the desk's). */
export const WORKSTATION_SEAT = [0, 1];

/**
 * An office chair, 1 x 1 cell, seat top at z = 14, centred in the cell.
 * The backrest is on the +y side: turn 0 seats someone facing -y (towards
 * a desk behind the chair). `part` draws only the "seat" (base, seat) or
 * the "back" (backrest, armrests), for drawing a sitter between them.
 */
export function deskChair(b, { part = "all" } = {}) {
  const seat = material({ ramp: "ink", top: 3, left: 2, right: 1 });
  const back = material({
    ramp: "ink", top: 3, left: 2, right: 1,
    paint(face, x, y, z, level) {
      return (face === LEFT || face === NY) && band(z, 22) ? level + 1 : level; // a seam
    },
  });
  if (part !== "back") {
    for (const [x, y] of [[1, 7], [14, 8], [7, 1], [8, 14]]) b.set(x, y, 0, ink);
    b.box(2, 7, 1, 12, 2, 1, chrome);
    b.box(7, 2, 1, 2, 12, 1, chrome);
    b.box(7, 7, 2, 2, 2, 9, chrome);
    b.box(3, 3, 11, 10, 10, 3, seat);
    for (const [x, y] of [[3, 3], [12, 3], [3, 12], [12, 12]]) b.clear(x, y, 11, 1, 1, 3);
  }
  if (part !== "seat") {
    // A low back, so a sitter seen from behind still shows above it.
    b.box(7, 13, 12, 2, 2, 6, ink);
    b.box(3, 13, 17, 10, 2, 10, back);
    b.clear(3, 13, 26, 1, 2, 1);
    b.clear(12, 13, 26, 1, 2, 1);
    for (const x of [2, 13]) {
      b.box(x, 8, 14, 1, 1, 3, ink);
      b.box(x, 4, 17, 1, 8, 1, ink);
    }
  }
}
/** Where a sitter's anchor goes, in chair model voxels (the seat centre on the ground). */
export const CHAIR_SEAT = [8, 8];

/**
 * A meeting table for six, 3 x 2 cells: an oak top on two trestles, a laptop,
 * papers and a water jug, three chairs on each long side.
 */
export function meetingTable(b) {
  b.box(4, 6, 23, 40, 20, 2, oak);
  for (const x of [8, 38]) {
    b.box(x, 9, 0, 2, 14, 2, walnut);
    b.box(x, 15, 2, 2, 2, 21, walnut);
  }
  b.box(10, 15, 3, 28, 2, 2, walnut);
  const lid = screenBody([20, 28], [DESK_TOP + 1, DESK_TOP + 7], { face: NY });
  b.box(19, 10, DESK_TOP, 10, 6, 1, chrome); // laptop base, screen towards -y
  b.box(19, 15, DESK_TOP + 1, 10, 1, 7, lid);
  b.box(8, 18, DESK_TOP, 6, 5, 1, white);
  b.box(34, 9, DESK_TOP, 5, 6, 1, paper);
  const glass = material({ ramp: "sky", top: 3, left: 2, right: 1, round: [40, 18] });
  b.cylinder(40, 18, DESK_TOP, 1.8, 6, glass);
  // Chairs: simple shells on a column, facing the table.
  const shell = material({ ramp: "paper", top: 4, left: 3, right: 2 });
  for (const x of [8, 20, 32]) {
    for (const side of [-1, 1]) {
      const cy = side < 0 ? 2 : 30;
      const by = side < 0 ? 0 : 31;
      b.box(x + 3, cy - 1, 0, 2, 2, 1, ink);
      b.box(x + 3, cy - 1, 1, 2, 2, 11, chrome);
      b.box(x, cy - 3, 12, 8, 7, 2, shell);
      b.box(x, by, 14, 8, 1, 12, shell);
    }
  }
}

// ---------------------------------------------------------------- lounge

/**
 * A sofa, 2 x 1 cells, facing +y: grey fabric, seat cushions, rounded arms,
 * and two throw pillows in the room colour.
 */
export function sofa(b) {
  const cushion = material({
    ramp: "ink", top: 4, left: 3, right: 2, rim: false,
    paint(face, x, y, z, level) {
      return face === TOP && band(x, 15.5, 1) ? level - 1 : level; // gap between cushions
    },
  });
  b.box(1, 2, 0, 30, 13, 2, ink); // plinth
  b.box(2, 3, 2, 28, 12, 7, fabric);
  b.box(4, 4, 9, 24, 11, 3, cushion);
  b.box(2, 2, 2, 28, 4, 20, fabric); // back
  b.box(1, 2, 2, 3, 13, 13, fabric);
  b.box(28, 2, 2, 3, 13, 13, fabric);
  const pillow = (slot) => material({ ramp: "pink", top: 3, left: 2, right: 1, rim: false, tint: "room", slot });
  b.box(5, 6, 12, 6, 3, 7, pillow(0));
  b.box(21, 6, 12, 6, 3, 7, pillow(0));
}

/**
 * A coffee corner, 2 x 1 cells, against the back: an oak counter with
 * doors, an espresso machine, cups, a kettle and a jar of beans.
 */
export function coffeeCorner(b) {
  const doors = material({
    ramp: "wood", top: 4, left: 3, right: 2,
    paint(face, x, y, z, level) {
      if (face !== LEFT) return level;
      if (band(x, 15.5) || band(z, 20.5)) return level - 1;
      if (within(z, 15, 18) && (band(x, 13.5) || band(x, 17.5))) return { ramp: "ink", level: 4 };
      return level;
    },
  });
  b.box(1, 2, 0, 30, 13, 22, doors);
  b.box(0, 1, 22, 32, 15, 2, walnut);
  // Espresso machine.
  const machine = material({
    ramp: "ink", top: 2, left: 2, right: 1,
    paint(face, x, y, z, level) {
      if (face === LEFT && within(x, 5, 9) && within(z, DESK_TOP + 9, DESK_TOP + 11)) return { ramp: "sky", level: 2, emissive: true };
      return level;
    },
  });
  b.box(3, 3, 24, 10, 8, 14, machine);
  b.clear(5, 9, 25, 6, 2, 5);
  b.box(6, 9, 30, 4, 2, 1, chrome);
  b.box(7, 9, 24, 2, 2, 2, white);
  b.box(3, 3, 38, 10, 8, 1, chrome);
  for (const [x, y] of [[5, 4], [8, 4]]) b.box(x, y, 39, 2, 2, 2, white);
  // Kettle, jar and cups.
  const kettle = material({ ramp: "gold", top: 3, left: 2, right: 1, round: [19, 8] });
  b.cylinder(19, 8, 24, 3, 6, kettle);
  b.box(18, 7, 30, 2, 2, 1, ink);
  b.box(22, 7, 26, 2, 1, 2, kettle);
  const jar = material({ ramp: "sky", top: 3, left: 2, right: 1, round: [26, 6], transparent: true });
  b.cylinder(26, 6, 24, 2.4, 6, jar);
  b.cylinder(26, 6, 24, 1.8, 4, soil);
  b.box(25, 5, 30, 2, 2, 1, walnut);
  const cup = material({ ramp: "paper", top: 4, left: 3, right: 2 });
  for (const x of [21, 25, 28]) b.box(x, 11, 24, 2, 2, 2, cup);
}

/** A standing whiteboard, 2 x 1 cells, facing +y: a chart, boxes, post-its. */
export function whiteboard(b) {
  const board = material({
    ramp: "paper", top: 4, left: 4, right: 3, rim: false,
    paint(face, x, y, z, level) {
      if (face !== LEFT) return level;
      if (!within(x, 3, 29) || !within(z, 17, 43)) return { ramp: "ink", level: 4 }; // frame
      const lx = x - 3, lz = z - 17;
      const curve = 4 + lx * 0.45 + Math.sin(lx / 2) * 1.5;
      if (within(lx, 1, 13) && Math.abs(lz - curve) < 0.6) return { ramp: "pink", level: 2 };
      if (within(lx, 1, 13) && band(lz, 2)) return { ramp: "ink", level: 2 };
      if (band(lx, 1) && within(lz, 2, 15)) return { ramp: "ink", level: 2 };
      if (within(lx, 15, 20) && within(lz, 15, 19)) return { ramp: "blue", level: band(lz, 15.5, 2.5) && within(lx, 15.5, 19.5) ? 4 : 2 };
      if (within(lx, 21, 25) && within(lz, 15, 19)) return { ramp: "blue", level: band(lz, 15.5, 2.5) && within(lx, 21.5, 24.5) ? 4 : 2 };
      if (within(lx, 17, 23) && band(lz, 12)) return { ramp: "ink", level: 3 };
      if (within(lx, 15, 25) && (band(lz, 9) || band(lz, 7.5) || band(lz, 6))) return within(lx, 15, 15 + (lz * 7) % 9 + 2) ? { ramp: "ink", level: 3 } : level;
      return level;
    },
  });
  b.box(2, 7, 16, 28, 1, 28, board);
  for (const x of [4, 26]) {
    b.box(x, 7, 2, 2, 1, 14, chrome);
    b.box(x - 1, 3, 0, 4, 9, 2, ink);
  }
  const note = (ramp) => material({ ramp, top: 3, left: 3, right: 2, rim: false });
  b.box(20, 8, 33, 4, 1, 4, note("gold"));
  b.box(25, 8, 31, 4, 1, 4, note("pink"));
  b.box(5, 8, 16, 22, 2, 1, ink); // marker tray
  b.box(8, 8, 17, 3, 1, 1, material({ ramp: "pink", top: 2, left: 2, right: 1 }));
  b.box(12, 8, 17, 3, 1, 1, material({ ramp: "blue", top: 2, left: 2, right: 1 }));
}

/** A tall bookshelf, 2 x 1 cells, open towards +y, four shelves of books. */
export function bookshelf(b) {
  const shelfWood = material({ ramp: "wood", top: 4, left: 3, right: 3 });
  const H = 46;
  b.box(1, 1, 0, 30, 10, 2, shelfWood);
  b.box(1, 1, H - 2, 30, 10, 2, shelfWood);
  b.box(1, 1, 0, 1, 10, H, shelfWood);
  b.box(30, 1, 0, 1, 10, H, shelfWood);
  b.box(2, 1, 0, 28, 1, H, material({ ramp: "wood", top: 3, left: 2, right: 2 }));
  const ramps = ["pink", "blue", "leaf", "gold", "paper", "wood", "blue", "ink", "sage"];
  const books = ramps.map((ramp) => material({
    ramp, top: ramp === "ink" ? 4 : 3, left: ramp === "ink" ? 3 : 2, right: ramp === "ink" ? 3 : 2,
    paint(face, x, y, z, level) {
      return face === LEFT && band(frac(z / 3) * 3, 0) ? level + 1 : level; // a label band
    },
  }));
  let k = 0;
  for (const shelf of [2, 13, 24, 35]) {
    if (shelf > 2) b.box(2, 2, shelf - 1, 28, 9, 1, shelfWood);
    let x = 2;
    while (x < 29) {
      const w = 1 + Math.floor(hash(k, shelf) * 3);
      if (x + w > 30) break;
      const h = 6 + Math.floor(hash(k, 3) * 4);
      if (hash(k, 9) > 0.82 && x > 4) { x += 3; k++; continue; }
      b.box(x, 3, shelf, w, 7, h, books[k % books.length]);
      x += w;
      k++;
    }
  }
}

// ---------------------------------------------------------------- plants

/** A tall potted palm (the hub plant), 1 x 1 cell. */
export function plantTall(b) {
  hubPlant(b);
}

/** A small round bush in a sage pot, 1 x 1 cell, about 20 voxels tall. */
export function plantSmall(target) {
  const b = { ...target, set: (x, y, z, m) => { if (!target.has(x, y, z)) target.set(x, y, z, m); } };
  const pot = material({ ramp: "sage", top: 3, left: 2, right: 1, round: [8, 8] });
  b.cylinder(8, 8, 0, 4, 7, pot);
  b.cylinder(8, 8, 7, 4.4, 1, pot, 3.4);
  b.cylinder(8, 8, 7, 3.4, 1, soil);
  for (let i = 0; i < 14; i++) {
    const a = i * 2.39996;
    const t = i / 13;
    leaf(b, [8 + Math.cos(a) * t * 2, 8 + Math.sin(a) * t * 2, 8 + t * 5], a, 4.5 + (i % 3), 1.4, 3 + t * 2, i % 2 ? leafA : leafB, leafB, 1.2);
  }
}

// ---------------------------------------------------------------- equipment

/** A printer on a small grey cabinet, 1 x 1 cell, paper out towards +y. */
export function printer(b) {
  const cabinet = material({
    ramp: "ink", top: 4, left: 3, right: 2,
    paint(face, x, y, z, level) {
      return face === LEFT && band(z, 8) ? level - 1 : face === LEFT && within(z, 12, 13) && within(x, 6, 10) ? 5 : level;
    },
  });
  b.box(2, 2, 0, 12, 12, 16, cabinet);
  const body = material({
    ramp: "paper", top: 4, left: 3, right: 2,
    paint(face, x, y, z, level) {
      if (face === TOP && within(x, 9, 12) && within(y, 4, 6)) return { ramp: "sky", level: 2, emissive: true }; // display
      if (face === TOP && within(x, 9.5, 10.5) && within(y, 7, 8)) return { ramp: "leaf", level: 3, emissive: true };
      if (face === LEFT && band(z, 20.5, 1) && within(x, 4, 11)) return { ramp: "ink", level: 2 }; // paper slot
      return level;
    },
  });
  b.box(2, 3, 16, 12, 10, 8, body);
  b.box(4, 12, 19, 7, 3, 1, white); // printed sheets
  b.box(4, 13, 20, 7, 2, 1, white);
  b.box(3, 4, 24, 6, 6, 1, material({ ramp: "ink", top: 3, left: 2, right: 1 })); // scanner lid
}

/** A water cooler, 1 x 1 cell: a cabinet, a blue bottle, taps and cups. */
export function waterCooler(b) {
  const cab = material({
    ramp: "paper", top: 4, left: 3, right: 2,
    paint(face, x, y, z, level) {
      if (face === LEFT && within(z, 18, 22) && within(x, 6, 10)) return { ramp: "ink", level: 2 }; // tap recess
      return level;
    },
  });
  b.box(3, 3, 0, 10, 10, 26, cab);
  b.set(6, 13, 20, material({ ramp: "blue", top: 2, left: 2, right: 1 }));
  b.set(9, 13, 20, material({ ramp: "pink", top: 2, left: 2, right: 1 }));
  const bottle = material({ ramp: "sky", top: 3, left: 2, right: 1, round: [8, 8], transparent: true, rim: false });
  b.cylinder(8, 8, 26, 1.5, 2, bottle);
  b.cylinder(8, 8, 28, 4.2, 12, bottle);
  b.cylinder(8, 8, 40, 3.2, 1, bottle);
  const cups = material({ ramp: "paper", top: 4, left: 4, right: 3, round: [14, 8] });
  b.cylinder(14, 8, 14, 1.4, 7, cups);
}

/** A grey four drawer filing cabinet, 1 x 1 cell, drawers towards +y. */
export function filingCabinet(b) {
  const body = material({
    ramp: "ink", top: 4, left: 3, right: 2,
    paint(face, x, y, z, level) {
      if (face !== LEFT) return level;
      const dz = frac(z / 8) * 8;
      if (band(dz, 0)) return level - 1; // drawer gaps
      if (within(x, 6, 10) && band(dz, 5.5, 1)) return 5; // handles
      if (within(x, 6.5, 9.5) && within(dz, 2, 3.5)) return { ramp: "paper", level: 4 }; // label cards
      return level;
    },
  });
  b.box(2, 3, 0, 12, 11, 32, body);
  b.box(4, 6, 32, 6, 5, 1, material({ ramp: "gold", top: 4, left: 3, right: 2 })); // a box file on top
}

/**
 * A broom closet, 1 x 1 cell: a tall oak cupboard, its door towards +y (a
 * gold knob, a vent at the bottom) and a spare broom leaning on its right
 * side. The janitor of the floor rests beside it.
 */
export function broomCloset(b) {
  const body = material({
    ramp: "wood", top: 4, left: 3, right: 2,
    paint(face, x, y, z, level) {
      if (face !== LEFT) return level;
      if (band(x, 3) || band(x, 12.5) || band(z, 1) || band(z, 41)) return level - 1; // the door's frame
      if ((band(x, 5) || band(x, 10.5)) && within(z, 12, 38)) return level - 1; // the panel
      if ((band(z, 12) || band(z, 37.5)) && within(x, 5, 11)) return level - 1;
      if (within(z, 4, 9) && within(x, 5, 11) && band(frac(z / 2) * 2, 0, 1)) return level - 1; // vent slats
      if (within(x, 11, 12) && within(z, 22, 24)) return { ramp: "gold", level: 3 }; // knob
      return level;
    },
  });
  b.box(2, 4, 0, 12, 10, 44, body);
  b.box(1, 3, 44, 14, 12, 2, walnut); // cornice
  // The spare broom, leaning on the front right corner, its brush on the floor.
  const handle = material({ ramp: "wood", top: 5, left: 4, right: 3, rim: false, crease: false });
  b.capsule([12.5, 15, 4], [14.5, 14.5, 38], 0.8, handle);
  b.box(10, 14, 2, 6, 2, 2, walnut); // brush head
  b.box(10, 14, 0, 6, 2, 2, gold); // bristles
}

// ---------------------------------------------------------------- rug and reception

/** A rug, 3 x 2 cells: a room colour border, a woven neutral field. */
export function rug(b) {
  const W = 44, D = 28;
  const field = material({
    ramp: "paper", top: 4, left: 3, right: 3, rim: false,
    paint(face, x, y, z, level) {
      const ex = Math.min(x - 2, y - 2, 2 + W - x, 2 + D - y);
      if (face === TOP && ex >= 4 && band(frac((x + y) / 4) * 4, 0, 1) && band(frac((x - y) / 8) * 8, 0, 4)) return 3;
      return level;
    },
  });
  const border = material({ ramp: "pink", top: 3, left: 2, right: 1, rim: false, tint: "room" });
  b.box(2, 2, 0, W, D, 1, border);
  b.box(5, 5, 0, W - 6, D - 6, 1, field);
  const line = material({ ramp: "wood", top: 3, left: 2, right: 2, rim: false });
  for (let x = 7; x < W - 1; x++) { b.set(x, 7, 0, line); b.set(x, D - 4, 0, line); }
  for (let y = 7; y <= D - 4; y++) { b.set(7, y, 0, line); b.set(W - 2, y, 0, line); }
}

/**
 * A reception counter, 3 x 1 cells: a raised front panel towards +y (the
 * visitors' side, a room colour band), a worktop behind it at desk height,
 * a monitor facing -y for the receptionist, who stands or sits at -y.
 */
export function receptionCounter(b) {
  const panel = material({
    ramp: "wood", top: 4, left: 3, right: 2,
    paint(face, x, y, z, level) {
      if (face === LEFT && band(frac(x / 6) * 6, 0)) return level - 1; // slats
      return level;
    },
  });
  const accent = material({ ramp: "pink", top: 3, left: 2, right: 1, tint: "room" });
  b.box(1, 9, 0, 46, 5, 34, panel);
  b.box(1, 9, 22, 46, 6, 4, accent);
  b.box(0, 8, 34, 48, 8, 2, white); // transaction top
  b.box(1, 1, 23, 46, 8, 2, oak); // worktop behind
  b.box(1, 1, 0, 2, 8, 23, walnut);
  b.box(45, 1, 0, 2, 8, 23, walnut);
  const screen = screenBody([21, 33], [DESK_TOP + 6, DESK_TOP + 14], { face: NY });
  b.box(24, 4, DESK_TOP, 6, 4, 1, inkSoft);
  b.box(26, 5, DESK_TOP + 1, 2, 2, 5, chrome);
  b.box(20, 3, DESK_TOP + 5, 14, 2, 10, screen);
  // A bell and a small plant on the transaction top.
  b.cylinder(10, 12, 36, 1.6, 1, gold);
  b.set(9, 11, 37, gold);
  const pot = material({ ramp: "wood", top: 4, left: 3, right: 2, round: [40, 12] });
  b.cylinder(40, 12, 36, 2, 3, pot);
  for (let i = 0; i < 6; i++) leaf(b, [40, 12, 39], i * 1.05, 3.5, 1, 1.5, i % 2 ? leafA : leafB, leafB);
}

// ---------------------------------------------------------------- library

/**
 * Book spines of the library: deep leathers and cloths of the shared ramps,
 * [ramp, level of the spine]. Every other one gets gilt bands (`gilt`).
 */
const BOOK_SPECS = [
  ["pink", 1], ["wood", 1], ["blue", 1], ["leaf", 1], ["wood", 2], ["sage", 1], ["gold", 2], ["ink", 1],
  ["paper", 3], ["blue", 2], ["pink", 2], ["wood", 3], ["leaf", 2], ["sage", 2], ["ink", 2], ["gold", 3],
];
/** Height between two shelf boards of a library shelf, and the top of its plinth (the first row). */
const SHELF_PITCH = 10;
const SHELF_PLINTH = 3;
const SHELF_ROWS = 5;
/** The top of a library shelf, in voxels (the wall is 64): taller than a person. */
export const LIBRARY_SHELF_TOP = SHELF_PLINTH + SHELF_ROWS * SHELF_PITCH + 2;
const bookMaterial = ([ramp, level], gilt) =>
  material({
    ramp, top: level + 1, left: level, right: Math.max(0, level - 1), rim: false,
    paint(face, x, y, z, lvl) {
      if (face !== LEFT || !gilt) return lvl;
      // Gilt bands near the foot and the head of the spine, at the same height on every row.
      const dz = (z - SHELF_PLINTH) % SHELF_PITCH;
      return band(dz, 1.5, 0.5) || band(dz, 6.5, 0.5) ? { ramp: "gold", level: 3 } : lvl;
    },
  });
const BOOKS = BOOK_SPECS.map((spec, i) => bookMaterial(spec, i % 2 === 0));
const libraryWood = material({ ramp: "wood", top: 3, left: 2, right: 1 });
const libraryBack = material({ ramp: "wood", top: 1, left: 1, right: 0, rim: false });
const libraryTrim = material({ ramp: "wood", top: 4, left: 3, right: 2 });
const brass = material({ ramp: "gold", top: 4, left: 3, right: 2 });

/**
 * One row of books standing on a board at height z, from x0 to x1, the
 * fronts near y = 10: spines of one or two voxels (now and then a thick
 * folio), heights and depths that vary, and here and there a book leaning on
 * its neighbour, a small stack lying flat or a gap with a bookend.
 */
function bookRow(b, z, x0, x1, seed) {
  let x = x0;
  let k = 0;
  const pick = () => BOOKS[Math.floor(hash(seed, k, 5) * BOOKS.length)];
  while (x < x1) {
    const roll = hash(seed, k, 1);
    const room = x1 - x;
    if (roll > 0.9 && room >= 5 && k > 0) {
      // A small stack lying flat: three books, the longest at the bottom.
      for (let s = 0; s < 3; s++) {
        b.box(x + (s === 1 ? 1 : 0), 3 + (s % 2), z + s, s === 2 ? 3 : 4, 5, 1, pick());
        k++;
      }
      x += 5;
      continue;
    }
    if (roll > 0.84 && room >= 4 && k > 0) {
      // A book leaning on its right neighbour, in the gap left by a borrowed one.
      const m = pick();
      for (let dz = 0; dz < 8; dz++) b.box(x + Math.min(2, Math.floor(dz / 3)), 3, z + dz, 1, 6, 1, m);
      x += 3;
      k++;
      continue;
    }
    const w = roll < 0.06 && room >= 3 ? 3 : 1 + Math.floor(hash(seed, k, 2) * 2);
    if (w > room) break;
    const h = 6 + Math.floor(hash(seed, k, 3) * 4); // 6 to 9: the board above is at z + 9
    const d = 5 + Math.floor(hash(seed, k, 4) * 3);
    const front = hash(seed, k, 6) < 0.25 ? 8 : 9;
    b.box(x, front - d, z, w, d, h, pick());
    x += w;
    k++;
  }
}

/**
 * A tall library shelf, 1 x 1 cell, against the wall, open towards +y: a dark
 * oak carcass with a plinth and a cornice, five rows of books packed tight.
 * Shelves side by side join into a wall of books. `seed` changes the books;
 * `ladder` leans a library ladder on it, hooked to a brass rail.
 */
export function libraryShelf(b, { seed = 0, ladder = false } = {}) {
  const H = LIBRARY_SHELF_TOP;
  b.box(0, 1, 0, CELL, 1, H, libraryBack);
  b.box(0, 1, 0, 1, 9, H, libraryWood);
  b.box(CELL - 1, 1, 0, 1, 9, H, libraryWood);
  b.box(0, 1, 0, CELL, 9, SHELF_PLINTH, libraryWood);
  b.box(0, 1, H - 2, CELL, 10, 2, libraryWood); // cornice, a voxel proud
  b.box(0, 10, H - 3, CELL, 1, 1, libraryTrim);
  for (let row = 0; row < SHELF_ROWS; row++) {
    const z = SHELF_PLINTH + row * SHELF_PITCH;
    if (row > 0) {
      b.box(1, 2, z - 1, CELL - 2, 7, 1, libraryWood);
      b.box(1, 9, z - 1, CELL - 2, 1, 1, libraryTrim); // the lit front edge of the board
    }
    bookRow(b, z, 1, CELL - 1, seed * 31 + row);
  }
  if (!ladder) return;
  // The brass rail along the cornice, and the ladder leaning on it, its feet towards +y.
  b.box(0, 10, H - 6, CELL, 1, 1, brass);
  const rail = material({ ramp: "wood", top: 5, left: 4, right: 3, crease: false });
  const top = H - 5;
  for (const x of [3, 12]) {
    b.capsule([x + 0.5, 14.5, 0], [x + 0.5, 10.6, top], 0.7, rail);
    b.set(x, 10, top + 1, brass); // the hook on the rail
  }
  for (let z = 6; z < top; z += 7) {
    const y = Math.floor(14.5 - (3.9 * z) / top);
    b.box(4, y, z, 8, 1, 1, rail);
  }
}

/**
 * A leather club armchair, 1 x 1 cell, facing +y: cognac leather, rolled arms,
 * a seat cushion and a small cushion in the room colour.
 */
export function armchair(b) {
  const leather = material({ ramp: "wood", top: 3, left: 2, right: 1 });
  const seat = material({
    ramp: "wood", top: 4, left: 3, right: 2, rim: false,
    paint(face, x, y, z, level) {
      return face === LEFT && band(z, 9) ? level - 1 : level; // the seam of the cushion
    },
  });
  const feet = material({ ramp: "wood", top: 1, left: 1, right: 0 });
  for (const [x, y] of [[2, 3], [13, 3], [2, 13], [13, 13]]) b.box(x, y, 0, 1, 1, 2, feet);
  b.box(2, 3, 2, 12, 11, 6, leather); // the body
  b.box(4, 5, 8, 8, 9, 3, seat); // the seat cushion
  b.box(2, 2, 2, 12, 4, 19, leather); // the back
  b.box(3, 2, 21, 10, 3, 1, leather); // its rounded top
  for (const x of [1, 12]) {
    b.box(x, 3, 2, 3, 12, 12, leather);
    b.box(x, 4, 14, 3, 10, 1, leather); // the rolled top of the arm
  }
  const cushion = material({ ramp: "pink", top: 3, left: 2, right: 1, rim: false, tint: "room" });
  b.box(5, 6, 11, 6, 2, 6, cushion);
}

/** A small round side table, 1 x 1 cell: a walnut top on a pedestal, two books and a cup of tea. */
export function sideTable(b) {
  const top = material({ ramp: "wood", top: 3, left: 2, right: 1, round: [8, 8] });
  b.cylinder(8, 8, 0, 3.5, 1, walnut);
  b.box(7, 7, 1, 2, 2, 16, walnut);
  b.cylinder(8, 8, 17, 5.5, 2, top);
  b.box(4, 5, 19, 6, 5, 1, BOOKS[2]);
  b.box(5, 6, 20, 5, 4, 1, BOOKS[6]);
  const cup = material({ ramp: "paper", top: 4, left: 3, right: 2, round: [11.5, 10.5] });
  b.cylinder(11.5, 10.5, 19, 2.2, 1, white); // saucer
  b.cylinder(11.5, 10.5, 20, 1.4, 2, cup);
  b.set(11, 10, 21, material({ ramp: "wood", top: 2, left: 2, right: 1, rim: false }));
}

/** Piles of books on the floor, 1 x 1 cell: three stacks of uneven books, waiting to be shelved. */
export function bookStacks(b) {
  const piles = [
    { x: 2, y: 3, count: 6 },
    { x: 9, y: 2, count: 4 },
    { x: 6, y: 9, count: 3 },
  ];
  let k = 0;
  for (const { x, y, count } of piles) {
    let z = 0;
    for (let i = 0; i < count; i++, k++) {
      const w = 5 + Math.floor(hash(k, 7) * 3);
      const d = 4 + Math.floor(hash(k, 8) * 2);
      const h = hash(k, 9) < 0.4 ? 2 : 1;
      const dx = Math.floor(hash(k, 10) * 2), dy = Math.floor(hash(k, 11) * 2);
      b.box(x + dx, y + dy, z, w, d, h, BOOKS[Math.floor(hash(k, 12) * BOOKS.length)]);
      z += h;
    }
  }
}

/** A floor lamp (the hub's), centred in its cell, 1 x 1: a glowing drum shade. */
export function floorLamp(b) {
  hubFloorLamp(b.at(2, 2, 0));
}

/**
 * A library globe, 1 x 1 cell: a walnut tripod, a brass meridian and the
 * globe itself, blue seas and green and sandy lands.
 */
export function globe(b) {
  const C = [8, 8, 25];
  const R = 6;
  const sphere = material({
    ramp: "blue", top: 3, left: 2, right: 1, rim: false,
    paint(face, x, y, z, level) {
      const land = hash(Math.floor((x + 1) / 4), Math.floor((y + 1) / 4), Math.floor((z - 1) / 4), 4);
      if (land > 0.66) return { ramp: "leaf", level: Math.min(3, level + 1) };
      if (land > 0.58) return { ramp: "wood", level: Math.min(5, level + 2) };
      return level;
    },
  });
  for (const [x, y] of [[3, 4], [12, 5], [8, 13]]) b.line([8, 8, 10], [x, y, 0], walnut);
  b.box(7, 7, 10, 2, 2, 5, walnut);
  b.cylinder(8, 8, 15, 3, 1, walnut);
  b.ellipsoid(C[0], C[1], C[2], R, R, R, sphere);
  // The meridian: a brass half ring around the globe, in the plane x = 7 (seen edge on from the side).
  for (let a = -Math.PI * 0.6; a <= Math.PI * 0.6; a += 0.03) {
    const r = R + 1;
    b.set(7, Math.floor(C[1] + 0.5 + Math.sin(a) * r), Math.floor(C[2] + 0.5 + Math.cos(a) * r), brass);
  }
}

/**
 * A long reading table, 2 x 1 cells: an oak top at desk height on turned
 * legs, an open book, a stack of books and a green banker's lamp.
 */
export function readingTable(b) {
  b.box(1, 2, 23, 30, 12, 2, oak);
  for (const x of [2, 28]) for (const y of [3, 12]) b.box(x, y, 0, 2, 2, 23, walnut);
  b.box(4, 3, 20, 24, 1, 3, walnut); // apron
  // The open book: two pages, the spine between them a voxel lower.
  b.box(6, 6, DESK_TOP, 5, 7, 1, white);
  b.box(12, 6, DESK_TOP, 5, 7, 1, paper);
  b.box(11, 6, DESK_TOP, 1, 7, 1, BOOKS[0]);
  b.box(6, 5, DESK_TOP, 11, 1, 1, BOOKS[0]); // the cover showing under the pages
  // A stack of three books.
  b.box(19, 5, DESK_TOP, 6, 7, 2, BOOKS[3]);
  b.box(19, 6, DESK_TOP + 2, 5, 6, 2, BOOKS[8]);
  b.box(20, 5, DESK_TOP + 4, 5, 6, 1, BOOKS[1]);
  // The banker's lamp: a brass foot and stem, a green glass shade lit from inside.
  b.cylinder(28, 7, DESK_TOP, 2, 1, brass);
  b.box(28, 7, DESK_TOP + 1, 1, 1, 6, brass);
  const shade = material({ ramp: "leaf", top: 3, left: 2, right: 1, round: [28, 9] });
  b.box(25, 8, DESK_TOP + 7, 6, 3, 2, shade);
  b.box(25, 10, DESK_TOP + 6, 6, 1, 1, material({ ramp: "gold", top: 4, left: 4, right: 3, emissive: true, rim: false }));
}

// ---------------------------------------------------------------- signboard

/**
 * The signboard of a room: a board standing on two short posts on top of
 * the back wall that runs along x (behind y = 0), facing +y. Its face and
 * its frame take the room colour at runtime (the frame a shade darker);
 * the name and the logo are drawn over the face at runtime, in the face's
 * pixel columns that floor.json lists. A board is a left end, `segments`
 * middle segments and a right end (SIGN, in voxels): the build slices one
 * long render into those parts so that boards of any length join without
 * a seam. `probe` paints the face in a colour of its own, to find its pixels.
 */
export const SIGN = { end: 4, segment: 8, post: 3, face: 10, frame: 1, depth: 2 };
export const SIGN_BOTTOM = WALL.height + SIGN.post;
/** The top of a signboard (voxels above the floor): what the rules about hiding must account for. */
export const SIGN_TOP = SIGN_BOTTOM + SIGN.face + 2 * SIGN.frame;

export function signBoard(b, { segments = 3, probe = false } = {}) {
  const L = 2 * SIGN.end + segments * SIGN.segment;
  const F = SIGN.frame;
  const z0 = SIGN_BOTTOM, z1 = SIGN_TOP;
  // The face, recessed one voxel behind its frame.
  const face = material({
    ramp: "pink", top: 3, left: 2, right: 1, tint: "room",
    paint: probe ? (f, x, y, z, level) => (f === LEFT ? { ramp: "blue", level: 2, emissive: true } : level) : undefined,
  });
  const frame = material({ ramp: "pink", top: 2, left: 1, right: 1, tint: "room" });
  b.box(0, -SIGN.depth, z0, L, SIGN.depth - 1, z1 - z0, face);
  b.box(0, -SIGN.depth, z0, L, SIGN.depth, F, frame);
  b.box(0, -SIGN.depth, z1 - F, L, SIGN.depth, F, frame);
  b.box(0, -SIGN.depth, z0, F, SIGN.depth, z1 - z0, frame);
  b.box(L - F, -SIGN.depth, z0, F, SIGN.depth, z1 - z0, frame);
  for (const x of [1, L - 3]) b.box(x, -SIGN.depth, WALL.height, 2, 1, SIGN.post, walnut);
}

// ---------------------------------------------------------------- catalogue

/**
 * Every floor piece: `cells` is the model footprint [w, d] in cells,
 * `turns` the quarter turns to export (turn 0: front towards +y, the lower
 * left of the screen; turn 1: front towards +x, the lower right).
 */
export const FURNITURE = [
  { name: "workstation", build: workstation, cells: [2, 1], turns: [0, 1], seat: WORKSTATION_SEAT },
  { name: "desk-chair", build: deskChair, cells: [1, 1], turns: [0, 1, 2, 3], layers: true },
  { name: "meeting-table", build: meetingTable, cells: [3, 2], turns: [0, 1] },
  { name: "sofa", build: sofa, cells: [2, 1], turns: [0, 1] },
  { name: "coffee-corner", build: coffeeCorner, cells: [2, 1], turns: [0, 1] },
  { name: "whiteboard", build: whiteboard, cells: [2, 1], turns: [0, 1] },
  { name: "bookshelf", build: bookshelf, cells: [2, 1], turns: [0, 1] },
  { name: "plant-tall", build: plantTall, cells: [1, 1], turns: [0, 1] },
  { name: "plant-small", build: plantSmall, cells: [1, 1], turns: [0, 1] },
  { name: "printer", build: printer, cells: [1, 1], turns: [0, 1] },
  { name: "water-cooler", build: waterCooler, cells: [1, 1], turns: [0, 1] },
  { name: "filing-cabinet", build: filingCabinet, cells: [1, 1], turns: [0, 1] },
  { name: "broom-closet", build: broomCloset, cells: [1, 1], turns: [0, 1] },
  { name: "rug", build: rug, cells: [3, 2], turns: [0, 1], flat: true },
  { name: "reception-counter", build: receptionCounter, cells: [3, 1], turns: [0, 1], staff: [1, -1] },
  // The library decor of a room (room.json `decor: "library"`): walls of books, a reading corner.
  { name: "library-shelf", build: (b) => libraryShelf(b, { seed: 0 }), cells: [1, 1], turns: [0, 1] },
  { name: "library-shelf-b", build: (b) => libraryShelf(b, { seed: 1 }), cells: [1, 1], turns: [0, 1] },
  { name: "library-shelf-c", build: (b) => libraryShelf(b, { seed: 2 }), cells: [1, 1], turns: [0, 1] },
  { name: "library-ladder", build: (b) => libraryShelf(b, { seed: 3, ladder: true }), cells: [1, 1], turns: [0, 1] },
  { name: "armchair", build: armchair, cells: [1, 1], turns: [0, 1, 2, 3] },
  { name: "side-table", build: sideTable, cells: [1, 1], turns: [0, 1] },
  { name: "book-stacks", build: bookStacks, cells: [1, 1], turns: [0, 1] },
  { name: "floor-lamp", build: floorLamp, cells: [1, 1], turns: [0, 1] },
  { name: "globe", build: globe, cells: [1, 1], turns: [0, 1] },
  { name: "reading-table", build: readingTable, cells: [2, 1], turns: [0, 1] },
];
