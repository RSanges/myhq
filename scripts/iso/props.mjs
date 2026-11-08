// The props of the hub (the desk scene). Each prop is a function `(b, options)` that
// draws voxels with the builder `b` in its own local frame: x and y on the
// floor (footprint from 0), z up from 0 at ground contact. One voxel is
// about 3 cm; small desk items are drawn about 1.4 times larger than life so
// they stay readable.
import { LEFT, RIGHT, TOP, hash, material } from "./engine.mjs";

const frac = (value) => value - Math.floor(value);
/** True when c is inside the half-open band [from, from + width). */
const band = (c, from, width = 0.5) => c >= from && c < from + width;
const within = (c, from, to) => c >= from && c < to;

// ---------------------------------------------------------------- materials

const ink = material({ ramp: "ink", top: 3, left: 2, right: 1 });
const inkSoft = material({ ramp: "ink", top: 4, left: 3, right: 2 });
const chrome = material({ ramp: "ink", top: 5, left: 4, right: 3 });
const deskWood = material({ ramp: "wood", top: 3, left: 2, right: 1 });
const gold = material({ ramp: "gold", top: 3, left: 2, right: 1 });
const leather = material({ ramp: "wood", top: 4, left: 3, right: 2 });
const soil = material({ ramp: "wood", top: 1, left: 1, right: 1, rim: false });
const leafA = material({ ramp: "leaf", top: 4, left: 3, right: 2 });
const leafB = material({ ramp: "leaf", top: 3, left: 2, right: 1 });
const stem = material({ ramp: "leaf", top: 2, left: 2, right: 1, rim: false });
const bulb = material({ ramp: "gold", top: 4, left: 4, right: 4, emissive: true, rim: false });


// --------------------------------------------------------------------- room

/** Floor, two cut away back walls, skirting boards and a window. */
export function room(b, { size = 80, height = 72, thick = 4, window: win = { y: 20, z: 30, w: 28, h: 32 } } = {}) {
  const floor = material({
    ramp: "wood", top: 4, left: 3, right: 2,
    paint(face, x, y, z, level) {
      if (face !== TOP) return z < -1 ? level - 1 : level;
      const board = Math.floor(y / 5);
      if (band(frac(y / 5) * 5, 0)) return level - 1; // seam between boards
      const offset = Math.floor(hash(board, 7) * 24);
      if (band((x + offset) % 24, 0)) return level - 1; // board ends
      return level;
    },
  });
  const wall = material({
    ramp: "sage", top: 3, left: 2, right: 1,
    paint(face, x, y, z, level) {
      if (face === TOP) return { ramp: "paper", level: 3 };
      return level;
    },
  });
  const skirting = material({ ramp: "paper", top: 4, left: 3, right: 2 });
  const frame = material({ ramp: "paper", top: 4, left: 3, right: 3 });
  const glass = material({
    ramp: "sky", transparent: true, emissive: true, rim: false,
    paint(face, x, y, z) {
      const wy = y - win.y, wz = z - win.z;
      const hills = 3 + (Math.floor(wy / 3) % 3 === 0 ? 1 : 0) + (within(wy, 6, 15) ? 2 : 0) + (within(wy, 9, 12) ? 1 : 0);
      if (wz < hills) return { ramp: "leaf", level: wz < hills - 1 ? 2 : 3 };
      const cloud = (within(wy, 14, 22) && band(wz, 22, 1.5)) || (within(wy, 16, 20) && band(wz, 23.5, 1));
      if (cloud) return { level: 3 };
      return { level: wz < 12 ? 2 : 1 };
    },
  });

  b.box(-thick, -thick, -3, size + thick, size + thick, 3, floor);
  b.box(-thick, -thick, 0, thick, size + thick, height, wall);
  b.box(0, -thick, 0, size, thick, height, wall);
  b.box(0, 0, 0, 1, size, 3, skirting);
  b.box(1, 0, 0, size - 1, 1, 3, skirting);

  // Window opening in the left wall, glass towards the outside, a frame and
  // a cross of mullions in front of it, a sill inside.
  b.clear(-thick, win.y, win.z, thick, win.w, win.h);
  b.box(-thick + 1, win.y, win.z, 1, win.w, win.h, glass);
  const fx = -thick + 2;
  b.box(fx, win.y, win.z, 1, win.w, 2, frame);
  b.box(fx, win.y, win.z + win.h - 2, 1, win.w, 2, frame);
  b.box(fx, win.y, win.z, 1, 2, win.h, frame);
  b.box(fx, win.y + win.w - 2, win.z, 1, 2, win.h, frame);
  b.box(fx, win.y + win.w / 2 - 1, win.z, 1, 2, win.h, frame);
  b.box(fx, win.y, win.z + Math.floor(win.h * 0.55), 1, win.w, 1, frame);
  b.box(-1, win.y - 2, win.z - 2, 4, win.w + 4, 2, skirting);
}

// --------------------------------------------------------------------- desk

/** A walnut desk, 52 x 28, top surface at z = 25, drawers on the right. */
export function desk(b) {
  const front = material({
    ramp: "wood", top: 3, left: 2, right: 1,
    paint(face, x, y, z, level) {
      if (face !== LEFT) return level;
      if (band(z, 7.5) || band(z, 15.5)) return level - 1; // drawer gaps
      return level;
    },
  });
  b.box(0, 0, 23, 52, 28, 2, deskWood);
  b.box(1, 1, 0, 2, 26, 23, deskWood);
  b.box(3, 1, 9, 34, 1, 14, deskWood);
  b.box(37, 1, 0, 14, 26, 23, front);
  for (const z of [4, 11, 19]) b.box(42, 27, z, 4, 1, 1, chrome);
}

// ------------------------------------------------------------------ monitor

/** Monitor on a stand, a soft glowing screen (post-its: see postIts). */
export function monitor(b) {
  const body = material({
    ramp: "ink", top: 2, left: 2, right: 1,
    paint(face, x, y, z, level) {
      if (face !== LEFT || !within(x, 1, 21) || !within(z, 7, 20)) return level;
      const screen = (lvl, ramp = "sky") => ({ ramp, level: lvl, emissive: true });
      if (z >= 19) return screen(1); // title bar
      if (within(x, 1, 4)) return within(z, 16, 18) && within(x, 1.5, 3.5) ? screen(0, "pink") : screen(2);
      if (within(x, 5, 20) && within(z, 8, 18)) {
        if (within(x, 6, 9) && within(z, 9, 12)) return screen(2, "pink");
        if (within(x, 10, 13) && within(z, 9, 12)) return screen(2, "blue");
        for (const [row, len] of [[16, 11], [14.5, 8], [13, 10]]) if (band(z, row) && within(x, 6, 6 + len)) return screen(1);
        return screen(3);
      }
      return screen(2);
    },
  });
  b.box(7, 1, 0, 8, 6, 1, inkSoft);
  b.box(10, 2, 1, 2, 2, 7, chrome);
  b.box(0, 4, 6, 22, 2, 15, body);
}

/** Where the post-its go, in monitor local coordinates, in order of arrival. */
const POST_ITS = [
  { at: [18, 6, 6], ramp: "pink", level: 3, strokes: 1 },
  { at: [14, 6, 18], ramp: "leaf", level: 4, strokes: 2 },
  { at: [2, 6, 10], ramp: "gold", level: 3, strokes: 2 },
  { at: [19, 6, 12], ramp: "blue", level: 3, strokes: 2 },
  { at: [8, 6, 18], ramp: "gold", level: 4, strokes: 1 },
];

/** `count` post-its (0 to 5) stuck on the monitor, placed at the monitor origin. */
export function postIts(b, { count = 3 } = {}) {
  for (const { at, ramp, level, strokes } of POST_ITS.slice(0, Math.max(0, Math.min(5, count)))) {
    const note = material({
      ramp, top: level, left: level, right: level - 1, rim: false,
      paint(face, x, y, z, lvl) {
        if (face !== LEFT) return lvl;
        const lz = z - at[2], lx = x - at[0];
        if (lz >= 3.5) return lvl + 1; // the glue strip, a tone lighter
        for (let s = 0; s < strokes; s++) if (band(lz, 2.5 - s * 1.5) && within(lx, 0.5, 3.5 - s)) return { ramp: "ink", level: 2 };
        return lvl;
      },
    });
    b.box(...at, 4, 1, 4, note);
  }
}

// --------------------------------------------------------------- doc pile

/**
 * Sheet offsets of the pile, in voxels: the pile drifts in short runs
 * instead of alternating, so its edges read as a stack of folders and not
 * as a zigzag. dy never grows going up: a folder pushed towards the viewer
 * would hide the spine of the one below.
 */
export const PILE_OFFSETS = [[0, 1], [0, 1], [1, 1], [1, 1], [1, 1], [0, 0], [0, 0], [0, 0], [1, 0], [1, 0], [1, 0], [0, 0], [0, 0], [1, 0]];
/** Example spine colours, shown when the runtime does not tint. */
const SPINE_EXAMPLES = ["pink", "blue", "leaf", "gold"];

/**
 * A pile of `count` folders to sign (0 to 14), one voxel each, so its
 * height shows the real number of items. Folder k has its spine in tint
 * slot k: the runtime paints the colour of the room of item k there. The
 * top folder shows a page with a signature line; gold "sign here" flags
 * stick out of the right side of every third folder.
 */
export function docPile(b, { count = 5 } = {}) {
  const n = Math.max(0, Math.min(14, count));
  const flag = material({ ramp: "gold", top: 4, left: 3, right: 3, rim: false });
  for (let k = 0; k < n; k++) {
    const [dx, dy] = PILE_OFFSETS[k];
    const top = k === n - 1;
    const ramp = SPINE_EXAMPLES[k % SPINE_EXAMPLES.length];
    const spine = material({ ramp, top: 3, left: 2, right: 1, rim: false, tint: "room", slot: k });
    const doc = material({
      ramp: "paper", top: 4, left: 3, right: 3,
      paint(face, x, y, z, level) {
        if (face === RIGHT) return within(y - dy, 0, 1) ? { ramp: "paper", level: 2 } : level; // page edges
        if (face !== TOP || !top) return level;
        const lx = x - dx, ly = y - dy;
        if (within(ly, 1, 2.5) && within(lx, 1, 7)) return { ramp: "ink", level: 2 }; // title
        for (const [row, len] of [[3.5, 6], [5, 5], [6.5, 6]]) if (band(ly, row) && within(lx, 1, 1 + len)) return 2;
        if (band(ly, 9) && within(lx, 3.5, 8)) return { ramp: "ink", level: 2 }; // signature line
        if (within(ly, 7.5, 9) && within(lx, 1, 2.5)) return { ramp: "gold", level: 3 }; // sign here mark
        return level;
      },
    });
    b.box(dx, dy, k, 9, 11, 1, doc);
    b.box(dx, dy + 11, k, 9, 1, 1, spine); // the spine is the +y edge of the folder
    if (k % 3 === 1) b.box(dx + 9, dy + 2 + (k % 2) * 3, k, 2, 1, 1, flag);
  }
}

/** A leather desk pad under the pile, so an empty pile still shows a place. */
export function deskPad(b) {
  const pad = material({
    ramp: "wood", top: 2, left: 1, right: 1, rim: false,
    paint(face, x, y, z, level) {
      if (face === TOP && (x < 1 || y < 1 || x >= 13 || y >= 16)) return level + 1; // stitched border
      return level;
    },
  });
  b.box(0, 0, 0, 14, 17, 1, pad);
}

// ---------------------------------------------------------------- mail tray

/** A letter tray (bannette) with `letters` envelopes (0 to 5), fanned out of the front. */
export function mailTray(b, { letters = 3 } = {}) {
  const tray = material({ ramp: "ink", top: 4, left: 3, right: 2 });
  b.box(0, 0, 0, 12, 14, 1, tray);
  b.box(0, 0, 1, 1, 14, 3, tray);
  b.box(11, 0, 1, 1, 14, 3, tray);
  b.box(1, 0, 1, 10, 1, 3, tray);
  b.box(1, 13, 1, 10, 1, 1, tray);
  b.clear(0, 8, 2, 1, 6, 2);
  b.clear(11, 8, 2, 1, 6, 2);
  const n = Math.max(0, Math.min(5, letters));
  for (let k = 0; k < n; k++) {
    const y0 = 1 + k * 2;
    const x0 = 1 + (k % 2);
    const kraft = k % 2 === 1;
    const envelope = material({
      ramp: kraft ? "wood" : "paper", top: kraft ? 5 : 4, left: kraft ? 4 : 3, right: kraft ? 3 : 2,
      paint(face, x, y, z, level) {
        if (face !== TOP) return level;
        const lx = x - x0, ly = y - y0;
        if (within(lx, 6.5, 8.5) && within(ly, 1, 3)) return { ramp: k % 3 === 1 ? "blue" : "pink", level: 2 };
        if ((band(ly, 6.5) && within(lx, 2, 7)) || (band(ly, 8) && within(lx, 2, 6))) return level - 2;
        return level;
      },
    });
    b.box(x0, y0, 1 + k, 9, 11, 1, envelope);
  }
}

// ---------------------------------------------------------------- newspaper

/**
 * A folded daily lying flat, landscape (13 x 10): black masthead along the
 * far edge, a rule, a two line headline, a photo and text columns. The near
 * edge is the fold, two sheets thick with a shaded crease.
 */
export function newspaper(b) {
  const W = 13, D = 10;
  const page = material({
    ramp: "paper", top: 4, left: 3, right: 3,
    paint(face, x, y, z, level) {
      if (face === LEFT) return band(z, 1, 0.5) ? level - 1 : level; // the fold
      if (face === RIGHT) return band(z, 1, 0.5) ? level - 1 : level; // two sheets
      if (face !== TOP || z < 1.5) return level;
      const ink = (l) => ({ ramp: "ink", level: l });
      if (within(y, 0.5, 2) && within(x, 1, 12)) return ink(1); // masthead
      if (band(y, 2.5) && within(x, 1, 12)) return ink(3); // rule
      if (within(y, 3.5, 4.5) && within(x, 1, 10)) return ink(2); // headline
      if (within(x, 1, 5.5) && within(y, 5.5, 9)) return y > 8 - (within(x, 2, 4) ? 1 : 0) ? ink(2) : ink(3); // photo
      if ((within(x, 6.5, 9) || within(x, 9.5, 12)) && within(y, 5.5, 9.5) && band(frac(y), 0.5)) return ink(4); // columns
      return level;
    },
  });
  b.box(0, 0, 0, W, D, 1, page);
  b.box(0, 0, 1, W, D, 1, page);
}

// -------------------------------------------------------------------- phone

/**
 * A dark office desk phone facing +y: the handset in its cradle on the
 * left, a light keypad on the right, a small display, and a message light
 * that glows pink (and a pink envelope on the display) when `unread`.
 */
export function deskPhone(b, { unread = false } = {}) {
  const shell = material({ ramp: "ink", top: 2, left: 2, right: 1 });
  const keypad = material({
    ramp: "ink", top: 2, left: 2, right: 1,
    paint(face, x, y, z, level) {
      if (face !== TOP) return level;
      const kx = x - 6.5, ky = y - 4.5;
      if (kx >= 0 && ky >= 0 && kx < 4.5 && ky < 5 && band(frac(kx / 1.5) * 1.5, 0, 1) && band(frac(ky / 1.25) * 1.25, 0, 0.75)) return 5;
      return level;
    },
  });
  const display = material({
    ramp: "sky", top: unread ? 2 : 1, left: 1, right: 1, rim: false, emissive: true,
    paint(face, x, y) {
      if (face !== TOP) return { ramp: "ink", level: 2, emissive: false };
      if (unread && within(x, 7, 10) && within(y, 0.5, 2)) return { ramp: "pink", level: within(y, 1, 1.5) && within(x, 8, 9) ? 4 : 2 };
      return unread ? 3 : 2;
    },
  });
  const handset = material({ ramp: "ink", top: 5, left: 4, right: 3 });
  const light = unread
    ? material({ ramp: "pink", top: 4, left: 3, right: 2, emissive: true, rim: false })
    : material({ ramp: "ink", top: 2, left: 2, right: 1, rim: false });
  b.box(0, 0, 0, 12, 10, 2, shell);
  b.box(0, 0, 2, 12, 4, 1, shell); // raised back
  b.box(6, 4, 1, 6, 6, 1, keypad);
  b.box(6, 0, 3, 5, 3, 1, display);
  b.box(11, 4, 2, 1, 1, 1, light);
  // Handset: earpiece and mouthpiece on the cradle, a grip between them.
  b.box(0, 0, 3, 5, 3, 2, handset);
  b.box(0, 7, 2, 5, 3, 2, handset);
  b.box(1, 3, 4, 3, 4, 1, handset);
}

// ------------------------------------------------------------------ calendar

/** Calendar grid: 7 columns (Monday first) x 6 rows of days. */
export const CALENDAR = { cols: 7, rows: 6 };
const cellOf = (x, z) => {
  const cx = x - 1, cz = 9.5 - z;
  if (cx < 0 || cz < 0) return null;
  const col = Math.floor(cx / 2), row = Math.floor(cz / 1.5);
  if (col >= CALENDAR.cols || row >= CALENDAR.rows) return null;
  const line = band(frac(cx / 2) * 2, 1.5) || band(frac(cz / 1.5) * 1.5, 0, 0.5);
  return { col, row, line };
};

/**
 * A wall calendar facing +y: a picture, a month bar, a 7 x 6 day grid,
 * weekends shaded, and the day at cell `today` (row * 7 + col, or -1)
 * circled in pink. `lift` hangs it that many voxels above the floor (on a wall).
 */
export function calendar(b, { today = -1, lift = 0 } = {}) {
  const sheet = material({
    ramp: "paper", top: 4, left: 4, right: 3, rim: false,
    paint(face, x, y, zWorld, level) {
      if (face !== LEFT) return level;
      const z = zWorld - lift;
      if (z >= 19) return { ramp: "ink", level: 2 };
      if (within(z, 11.5, 19)) { // picture: hills under a sky, a sun
        if (!within(x, 1, 15) || z >= 18.5) return level;
        const hill = 13 + (within(x, 3, 9) ? 1 : 0) + (within(x, 4.5, 7.5) ? 1 : 0) + (within(x, 10, 15) ? 0.5 : 0);
        if (z < hill) return { ramp: "leaf", level: z < 12.5 ? 2 : 3 };
        if (within(x, 11, 13) && within(z, 15.5, 17)) return { ramp: "gold", level: 3 };
        return { ramp: "sky", level: 2 };
      }
      if (within(z, 10, 11.5)) return within(x, 4, 12) && band(z, 10.5) && band(frac(x / 2) * 2, 0, 1.5) ? { ramp: "pink", level: 3 } : { ramp: "pink", level: 1 };
      const c = cellOf(x, z);
      if (!c) return level;
      if (c.line) return 3;
      if (c.row * CALENDAR.cols + c.col === today) return { ramp: "pink", level: 2 };
      if (c.col >= 5) return { ramp: "pink", level: 4 };
      return level;
    },
  });
  b.box(0, 0, lift, 16, 1, 20, sheet);
  b.set(4, 1, lift + 19, gold);
  b.set(11, 1, lift + 19, gold);
}

// ---------------------------------------------------------------------- mug

/** A cream mug with a gold band, coffee inside, handle on the right. */
export function mug(b) {
  const cream = material({
    ramp: "paper", top: 4, left: 3, right: 2, round: [3, 3],
    paint(face, x, y, z, level) {
      return face !== TOP && within(z, 2, 3) ? { ramp: "gold", level: level - 1 } : level;
    },
  });
  const coffee = material({ ramp: "wood", top: 1, left: 1, right: 1, rim: false });
  b.cylinder(3, 3, 0, 2.7, 6, cream);
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 6; j++) {
      if ((i + 0.5 - 3) ** 2 + (j + 0.5 - 3) ** 2 <= 1.6 ** 2) { b.del(i, j, 5); b.set(i, j, 4, coffee); }
    }
  }
  for (const [x, z] of [[6, 1], [7, 2], [7, 3], [6, 4]]) b.set(x, 3, z, cream);
}

// --------------------------------------------------------------------- keyboard

export function keyboard(b) {
  const keys = material({
    ramp: "ink", top: 5, left: 4, right: 3,
    paint(face, x, y, z, level) {
      if (face !== TOP) return level;
      if (!within(x, 0.5, 14.5) || !within(y, 0.5, 5.5)) return level - 1;
      const row = Math.floor((y - 0.5) / 1.5);
      return band(frac((y - 0.5) / 1.5) * 1.5, 1) || band(frac((x + row * 0.5) / 2) * 2, 1.5) ? level - 1 : level + 1;
    },
  });
  b.box(0, 0, 0, 15, 6, 1, keys);
}

// --------------------------------------------------------------------- chair

/**
 * An office chair with cognac leather, seen from behind (faces -y). `part`:
 * "seat" (base and cushion) or "back" (backrest and armrests), to draw a
 * sitter between them (the user's office of the floor, build-floor.mjs).
 */
export function chair(b, { part = "all" } = {}) {
  if (part !== "back") {
    for (const [x, y] of [[1, 7], [14, 8], [7, 1], [8, 14]]) b.set(x, y, 0, ink);
    b.box(2, 7, 1, 12, 2, 1, chrome);
    b.box(7, 2, 1, 2, 12, 1, chrome);
    b.box(7, 7, 2, 2, 2, 8, chrome);
    b.box(3, 3, 10, 10, 10, 1, ink);
    b.box(2, 2, 11, 12, 12, 3, leather);
    for (const [x, y] of [[2, 2], [13, 2], [2, 13], [13, 13]]) b.clear(x, y, 11, 1, 1, 3);
  }
  if (part === "seat") return;
  b.box(7, 13, 11, 2, 2, 8, ink);
  const back = material({
    ramp: "wood", top: 4, left: 3, right: 2,
    paint(face, x, y, z, level) {
      return face === LEFT && (band(x, 5.5) || band(x, 10)) && within(z, 20, 31) ? level - 1 : level; // stitched panels
    },
  });
  b.box(3, 14, 18, 10, 2, 15, back);
  b.clear(3, 14, 32, 1, 2, 1);
  b.clear(12, 14, 32, 1, 2, 1);
  b.clear(3, 14, 18, 1, 2, 1);
  b.clear(12, 14, 18, 1, 2, 1);
  for (const x of [1, 14]) {
    b.box(x, 9, 14, 1, 1, 3, ink);
    b.box(x, 4, 17, 1, 8, 1, ink);
  }
}

// ------------------------------------------------------------ wall and floor

/** A woven rug, 1 voxel thick, cream with a terracotta border. */
export function rug(b, { w = 40, d = 30 } = {}) {
  const weave = material({
    ramp: "paper", top: 3, left: 2, right: 2, rim: false,
    paint(face, x, y, z, level) {
      const edge = Math.min(x, y, w - x, d - y);
      if (within(edge, 1.5, 3)) return { ramp: "wood", level: face === TOP ? 3 : 2 };
      if (face === TOP && edge >= 4.5 && (band(frac((x + y) / 4) * 4, 0, 1) && band(frac((x - y) / 8) * 8, 0, 4))) return { ramp: "wood", level: 4 };
      return level;
    },
  });
  b.box(0, 0, 0, w, d, 1, weave);
}

/** Maps a wall item drawn facing +y to one facing +x (`facing: "x"`). */
function onWall(facing, width, draw) {
  const face = facing === "x" ? RIGHT : LEFT;
  return (f, x, y, z, level) => (f === face ? draw(facing === "x" ? width - y : x, z, level) : level);
}

/** A framed print on a wall: a sun over terracotta hills. */
export function poster(b, { facing = "y" } = {}) {
  const print = material({
    ramp: "paper", top: 4, left: 3, right: 3, rim: false,
    paint: onWall(facing, 14, (x, z, level) => {
      if (!within(x, 1, 13) || !within(z, 1, 17)) return { ramp: "wood", level: 2 }; // frame
      if (!within(x, 2, 12) || !within(z, 2, 16)) return 4; // mat
      const hill = 5 + (within(x, 3, 9) ? 2 : 0) + (within(x, 4.5, 7.5) ? 1.5 : 0);
      if (z < 5) return { ramp: "wood", level: 3 };
      if (z < hill) return { ramp: "wood", level: 4 };
      if ((x - 8.75) ** 2 * 1 + (z - 11.5) ** 2 * 1.2 < 4.2) return { ramp: "gold", level: 3 };
      return { ramp: "paper", level: 3 };
    }),
  });
  if (facing === "x") b.box(0, 0, 0, 1, 14, 18, print);
  else b.box(0, 0, 0, 14, 1, 18, print);
}

/** A round wall clock facing +y, ten past ten. */
export function clock(b) {
  const face = material({
    ramp: "paper", top: 4, left: 4, right: 3, rim: false,
    paint(f, x, y, z, level) {
      if (f !== LEFT) return level;
      const dx = x - 4, dz = z - 4;
      const r = Math.hypot(dx, dz);
      if (r > 3.1) return { ramp: "ink", level: 2 };
      if (r < 0.5) return { ramp: "pink", level: 2 };
      if (within(x, 3.75, 4.25) && within(z, 4, 6.75)) return { ramp: "ink", level: 1 };
      if (within(dz, 0, 0.5) && within(dx, 0.25, 2.25)) return { ramp: "ink", level: 1 };
      return level;
    },
  });
  for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) if ((x + 0.5 - 4) ** 2 + (z + 0.5 - 4) ** 2 <= 16) b.set(x, 0, z, face);
}

// --------------------------------------------------------------------- plant

/**
 * One leaf from `base` towards `angle`: a pointed blade, a darker midrib,
 * the tip bending down. Exported for the floor plants.
 */
export function leaf(b, base, angle, length, width, droop, m, rib, rise = 0.6) {
  const dir = [Math.cos(angle), Math.sin(angle)];
  const side = [-dir[1], dir[0]];
  for (let s = 0; s <= length; s += 0.3) {
    const w = width * Math.sin(Math.PI * Math.min(1, (s + 0.4) / (length + 0.4))) ** 0.8;
    const z = base[2] + s * rise - droop * (s / length) ** 2;
    for (let t = -w; t <= w; t += 0.3) {
      const x = base[0] + dir[0] * s + side[0] * t;
      const y = base[1] + dir[1] * s + side[1] * t;
      b.set(Math.floor(x), Math.floor(y), Math.floor(z), Math.abs(t) < 0.35 && s > 1 && s < length - 1 ? rib : m);
    }
  }
}

/**
 * A potted plant (a dracaena like palm), about 46 voxels tall: many narrow
 * arching blades that end in a lighter tip, without rim light or creases,
 * so it reads as foliage and not as blocks.
 */
export function plant(target, { blades = 26, height = 26, spread = 1 } = {}) {
  // Leaves never replace voxels of other objects (wall, sill, furniture).
  const b = { ...target, set: (x, y, z, m) => { if (!target.has(x, y, z)) target.set(x, y, z, m); } };
  const terracotta = material({ ramp: "wood", top: 4, left: 3, right: 2, round: [8, 8] });
  const rim = material({ ramp: "wood", top: 5, left: 4, right: 3, round: [8, 8] });
  const tones = [
    material({ ramp: "leaf", top: 2, left: 2, right: 1, rim: false }),
    material({ ramp: "leaf", top: 3, left: 2, right: 1, rim: false }),
    material({ ramp: "leaf", top: 4, left: 3, right: 2, rim: false }),
  ];
  b.cylinder(8, 8, 0, 4.6, 8, terracotta);
  b.cylinder(8, 8, 8, 5.4, 2, rim, 4.2);
  b.cylinder(8, 8, 8, 4.2, 1, soil);
  for (let i = 0; i < blades; i++) {
    const a = i * 2.39996 + 0.3;
    const t = i / (blades - 1); // 0: outer, low blades; 1: inner, upright ones
    const dir = [Math.cos(a), Math.sin(a)];
    const length = (15 + 13 * t + (i % 3)) * spread * (height / 26);
    const up = (52 + 34 * t) * (Math.PI / 180), down = (-20 - 40 * (1 - t)) * (Math.PI / 180);
    let p = [8 + dir[0] * 0.8, 8 + dir[1] * 0.8, 9];
    for (let s = 0; s <= length; s += 0.25) {
      const q = s / length;
      const e = up + (down - up) * q ** 1.6;
      p = [p[0] + dir[0] * Math.cos(e) * 0.25, p[1] + dir[1] * Math.cos(e) * 0.25, p[2] + Math.sin(e) * 0.25];
      const m = tones[q > 0.7 ? 2 : q > 0.3 ? 1 : 0];
      const w = q < 0.85 ? 0.5 : 0.2;
      for (let o = -w; o <= w; o += 0.25) b.set(Math.floor(p[0] - dir[1] * o), Math.floor(p[1] + dir[0] * o), Math.floor(p[2]), m);
    }
  }
}

// ---------------------------------------------------------------- desk lamp

/** An articulated desk lamp in mustard, its shade pointing down at (12, 5). */
export function lamp(b) {
  const base = material({ ramp: "gold", top: 3, left: 2, right: 1, round: [3, 3] });
  const shade = material({ ramp: "gold", top: 3, left: 3, right: 2, round: [12, 5] });
  b.cylinder(3, 3, 0, 2.8, 1, base);
  b.box(2, 2, 1, 2, 2, 1, ink);
  b.line([2.5, 2.5, 2], [5.5, 3.5, 16], ink);
  b.set(5, 3, 16, gold);
  b.line([6, 3.8, 17], [11, 4.8, 19], ink);
  // A can shaped shade opening downwards, the bulb inside.
  b.cylinder(12, 5, 14, 2.9, 4, shade, 1.9);
  b.cylinder(12, 5, 17, 1.9, 1, shade);
  b.cylinder(12, 5, 16, 1.9, 1, bulb);
}
/** Where the lamp light comes from, in lamp local coordinates. */
export const LAMP_BULB = [12, 5, 14.5];

// ---------------------------------------------------------------- bookshelf

/** A small bookshelf against a wall at x = 0, open towards +x. */
export function bookshelf(b) {
  const shelfWood = material({ ramp: "wood", top: 4, left: 3, right: 3 });
  b.box(0, 0, 0, 11, 1, 30, shelfWood);
  b.box(0, 23, 0, 11, 1, 30, shelfWood);
  b.box(0, 1, 0, 1, 22, 30, shelfWood);
  b.box(0, 1, 0, 11, 22, 2, shelfWood);
  b.box(1, 1, 14, 10, 22, 1, shelfWood);
  b.box(0, 0, 28, 11, 24, 2, shelfWood);
  const ramps = ["pink", "blue", "leaf", "gold", "paper", "wood", "blue", "ink"];
  const bookMaterials = ramps.map((ramp) => material({
    ramp, top: ramp === "ink" ? 4 : 3, left: ramp === "ink" ? 3 : 2, right: ramp === "ink" ? 3 : 2,
    paint(face, x, y, z, level) {
      // A light label band low on each spine.
      return face === RIGHT && (band(z, 4) || band(z, 17)) ? level + 1 : level;
    },
  }));
  let k = 0;
  for (const shelf of [2, 15]) {
    let y = 1 + (shelf === 15 ? 1 : 0);
    while (y < 22) {
      const w = 1 + Math.floor(hash(k, shelf) * 3);
      if (y + w > 23) break;
      const h = 7 + Math.floor(hash(k, 3) * 5);
      if (hash(k, 9) > 0.85 && y > 4) { y += 2; k++; continue; }
      const m = bookMaterials[k % bookMaterials.length];
      b.box(2, y, shelf, 7, w, h, m);
      y += w;
      k++;
    }
  }
  // On top: two books lying flat and a tiny succulent.
  b.box(2, 3, 30, 7, 8, 1, bookMaterials[1]);
  b.box(3, 4, 31, 6, 7, 1, bookMaterials[3]);
  const tiny = material({ ramp: "wood", top: 4, left: 3, right: 2, round: [6, 17] });
  b.cylinder(6, 17, 30, 2.2, 3, tiny);
  b.cylinder(6, 17, 32, 1.4, 1, soil);
  for (let i = 0; i < 5; i++) leaf(b, [6, 17, 33], i * 1.26 + 0.3, 3.5, 1.2, 1.5, i % 2 ? leafA : leafB, leafB);
}

/** A floor lamp with a glowing fabric drum shade, about 62 voxels tall. */
export function floorLamp(b) {
  const foot = material({ ramp: "ink", top: 3, left: 2, right: 1, round: [6, 6] });
  // The fabric glows and lets the light through, so the corner gets a halo.
  const fabric = material({ ramp: "gold", top: 3, left: 4, right: 3, emissive: true, transparent: true, round: [6, 6] });
  b.cylinder(6, 6, 0, 3, 1, foot);
  b.box(5, 5, 1, 2, 2, 1, foot);
  b.box(5, 5, 2, 1, 1, 50, chrome);
  b.cylinder(6, 6, 50, 5.4, 10, fabric, 4.4);
  b.cylinder(6, 6, 59, 4.4, 1, fabric);
}
/** Where the floor lamp light comes from, in its local coordinates. */
export const FLOOR_LAMP_LIGHT = [5.5, 5.5, 55];
