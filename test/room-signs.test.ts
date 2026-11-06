import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { floorSetSchema, hiddenByWalls } from "../src/ui/iso-floor";
import { layoutFloor, OFFICE_LENGTH, ROOM_DEPTH } from "../src/ui/floor-plan";
import { CELL, COUNTER_FROM, COUNTER_LENGTH, COUNTER_SEGMENTS, SIGN_TOP } from "../src/ui/room-layout";
import {
  boardLength,
  faceColumns,
  faceWidth,
  GLYPH_SCALE,
  inkFor,
  paintFace,
  placeSign,
  planSign,
  shrinkLogo,
  SIGN_INK,
  SIGN_PADDING,
  signText,
  textWidth,
  type Pixels,
} from "../src/ui/room-signs";

const root = path.join(import.meta.dirname, "..");
const floorSet = floorSetSchema.parse(JSON.parse(fs.readFileSync(path.join(root, "public", "iso", "floor", "floor.json"), "utf8")));
const { sign, font } = floorSet;

test("the signboards of the floor set: as high as the layout rules assume, a face over every column, a font for room names", () => {
  assert.equal(sign.top, SIGN_TOP, "SIGN_TOP of room-layout.ts follows floor.json");
  for (const segments of [1, 2, 5]) {
    const columns = faceColumns(sign, segments);
    assert.equal(columns.length, faceWidth(sign, segments));
    // One face, left to right without a gap, its top falling one pixel every two columns (the wall's slope).
    columns.forEach((col, i) => {
      if (i === 0) return;
      assert.equal(col.x, columns[i - 1]!.x + 1, `${segments} segments: column ${i} follows`);
      assert.ok(col.top - columns[i - 1]!.top === 0 || col.top - columns[i - 1]!.top === 1, `${segments} segments: column ${i} on the stairs`);
      assert.equal(col.h, columns[0]!.h);
    });
  }
  assert.ok(sign.middle.face.cols.every((col) => col !== null), "a middle segment is face all along");
  for (const char of "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_") {
    const glyph = font.glyphs[char];
    assert.ok(glyph && glyph.length === font.height, `glyph ${char}`);
  }
});

test("the sign font: the zero is a plain ring (a slash made it read as a crossed O on the counters), and 0, O and 8 stay apart", () => {
  const zero = font.glyphs["0"]!;
  const o = font.glyphs["O"]!;
  const eight = font.glyphs["8"]!;
  // Hollow: inside its outline, a zero has no ink at all.
  zero.slice(1, -1).forEach((row, y) => assert.equal(row.slice(1, -1), ".".repeat(row.length - 2), `the zero is empty inside, row ${y + 1}`));
  // The zero is narrower than the O, and the 8 has the waist the zero lacks.
  assert.ok(zero[0]!.length < o[0]!.length, "a zero narrower than the O");
  assert.ok(eight[3]!.slice(1, -1).includes("#"), "the 8 is pinched in its middle");
  assert.equal(new Set([zero, o, eight].map((glyph) => glyph.join("/"))).size, 3, "0, O and 8 are three different glyphs");
});

test("a board as long as its name and logo need, in whole segments, and the name never cut", () => {
  const short = planSign(sign, font, "art", 0, 10 * CELL);
  const long = planSign(sign, font, "planygo", 0, 10 * CELL);
  assert.ok(short.segments <= long.segments);
  assert.equal(long.text, "PLANYGO");
  const need = 2 * SIGN_PADDING + textWidth(font, "PLANYGO");
  assert.ok(faceWidth(sign, long.segments) >= need, "the name fits");
  assert.ok(long.segments === 1 || faceWidth(sign, long.segments - 1) < need, "and no segment more than needed");
  const logo = planSign(sign, font, "planygo", 14, 10 * CELL);
  assert.equal(logo.logoWidth, 14);
  assert.ok(logo.segments >= long.segments);
  // A wall too short: the logo goes, the name stays whole, and the board grows past the wall, centred over it.
  const tight = planSign(sign, font, "a-very-long-room-name", 14, 5 * CELL);
  assert.equal(tight.logoWidth, 0);
  assert.equal(tight.text, "A-VERY-LONG-ROOM-NAME", "never a letter cut");
  assert.ok(faceWidth(sign, tight.segments) >= 2 * SIGN_PADDING + textWidth(font, tight.text));
  const over = placeSign(sign, font, "a-very-long-room-name", 14, 5 * CELL, false);
  assert.ok(over.from < 0 && over.from + over.length > 5 * CELL, "it overhangs both ends of its wall, centred");
  assert.equal(signText(font, "été"), "T", "characters the font lacks are left out");
  assert.equal(textWidth(font, "I"), GLYPH_SCALE * 3);
});

test("the name reads on the board: light ink on a dark colour, dark ink on a light one", () => {
  assert.equal(inkFor(0x1e2a55), SIGN_INK.light);
  assert.equal(inkFor(0xfff0b8), SIGN_INK.dark);
  assert.equal(inkFor(0x8c96a8), SIGN_INK.dark, "the neutral board");
});

test("the face is painted on its stairs: glyph pixels are whole squares, inside the face", () => {
  const plan = planSign(sign, font, "hq", 0, 8 * CELL);
  const columns = faceColumns(sign, plan.segments);
  const face = paintFace(columns, plan, font, SIGN_INK.dark, null)!;
  const { pixels } = face;
  let inked = 0;
  for (let c = 0; c < pixels.width; c += 1) {
    const col = columns[c]!;
    for (let y = 0; y < pixels.height; y += 1) {
      if (pixels.data[(y * pixels.width + c) * 4 + 3] === 0) continue;
      inked += 1;
      const row = y - (col.top - face.top);
      assert.ok(row >= 0 && row < col.h, `column ${c}: ink inside the face`);
    }
  }
  const dots = [...(font.glyphs.H ?? []), ...(font.glyphs.Q ?? [])].join("").split("#").length - 1;
  assert.equal(inked, dots * GLYPH_SCALE * GLYPH_SCALE, "every glyph pixel a GLYPH_SCALE square");
});

test("a logo is reduced without blending: pure colours, a detail kept, transparency kept", () => {
  // 40 x 40: a pink square with a dark 10 x 10 eye in a corner, and a transparent border.
  const size = 40;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      if (x < 4 || y < 4 || x >= 36 || y >= 36) continue;
      const eye = x >= 8 && x < 18 && y >= 8 && y < 18;
      [data[i], data[i + 1], data[i + 2], data[i + 3]] = eye ? [20, 20, 30, 255] : [255, 61, 127, 255];
    }
  }
  const source: Pixels = { width: size, height: size, data };
  const small = shrinkLogo(source, 10)!;
  assert.deepEqual([small.width, small.height], [10, 10]);
  const colours = new Set<string>();
  for (let i = 0; i < small.data.length; i += 4) if (small.data[i + 3]) colours.add(`${small.data[i]},${small.data[i + 1]},${small.data[i + 2]}`);
  assert.deepEqual([...colours].sort(), ["20,20,30", "255,61,127"], "only the colours of the source");
  assert.equal(small.data[3], 0, "the transparent border stays transparent");
  assert.equal(shrinkLogo({ width: 6, height: 6, data: new Uint8ClampedArray(144) }, 10)!.width, 6, "a small logo keeps its size");
});

test("the user's office: a block beside the lobby, drawn whole from the floor set, a signboard, nothing hidden by the signs", () => {
  const rooms = [3, 9, 2].map((count, i) => ({ name: `p${i}`, color: null, keys: Array.from({ length: count }, (_, k) => `p${i}/a${k}`) }));
  const layout = layoutFloor(rooms, { reception: "p0", receptionist: true });
  assert.ok(layout.office, "an office");
  const office = layout.rooms[layout.office.room]!;
  const lobby = layout.rooms[0]!;
  assert.deepEqual([office.kind, office.w, office.d, office.project], ["owner", OFFICE_LENGTH, ROOM_DEPTH, null]);
  assert.equal(office.y + office.d, lobby.y + lobby.d, "on the front row, with the lobby");
  assert.ok(office.x + office.w < lobby.x, "beside the lobby");
  // The hub's scene is one sprite of the floor set, at the office's size: no piece of the floor set in it.
  assert.ok(!layout.pieces.some((piece) => piece.room === layout.office!.room), "nothing of the floor set in the office");
  assert.deepEqual(floorSet.office.cells, [OFFICE_LENGTH, ROOM_DEPTH], "the office art is the size of the office");
  assert.equal(floorSet.office.states.pile.length, 15, "a pile state from 0 to 14 items");
  assert.equal(floorSet.office.states.mail.length, 6, "a letter tray state from 0 to 5 letters");
  assert.ok(layout.rooms.every((room) => room.sign), "every block of the single floor has its signboard");
  // A point right behind a back wall, under the top of its sign but over the top of the wall, is hidden.
  const behind = { x: (office.x + 1) * CELL, y: office.y * CELL - 70 };
  assert.ok(hiddenByWalls(layout, behind.x, behind.y), "a sign hides what is right behind it");
});

test("the counters: a board of the floor set as long as the layout assumes, by the back corner, as high as a sign", () => {
  assert.equal(boardLength(sign, COUNTER_SEGMENTS), COUNTER_LENGTH, "COUNTER_LENGTH of room-layout.ts follows floor.json");
  // Two digits fit on its face with the padding of a name.
  assert.ok(faceWidth(sign, COUNTER_SEGMENTS) >= textWidth(font, "99") + 2 * SIGN_PADDING, "99 fits");
  const rooms = [3, 9, 2].map((count, i) => ({ name: `p${i}`, color: null, keys: Array.from({ length: count }, (_, k) => `p${i}/a${k}`) }));
  const layout = layoutFloor(rooms, { reception: "p0", receptionist: true });
  const suite = layout.rooms.find((room) => room.project === "p1")!;
  assert.ok(suite.counter);
  // Right behind the side wall where the counter stands, over the top of the wall: hidden; further along the wall: not.
  const x = suite.x * CELL - 70;
  assert.ok(hiddenByWalls(layout, x, suite.y * CELL + COUNTER_FROM + 10 - 70), "the counter hides what is right behind it");
  assert.ok(!hiddenByWalls(layout, x, (suite.y + 5) * CELL - 70), "the rest of the side wall only hides up to its own top");
});

/** The rooms of a real home (names and team sizes), the user's office and the lobby: every name whole, on its own wall. */
test("the signboards of real rooms hold their whole name and stand on their room's back wall, their counter too", () => {
  const rooms = [
    ["assistant", 6],
    ["creation", 6],
    ["enseignes", 2],
    ["planygo", 9],
    ["portfolio", 2],
  ] as const;
  const layout = layoutFloor(
    rooms.map(([name, count]) => ({ name, color: null, keys: Array.from({ length: count }, (_, k) => `${name}/a${k}`) })),
    { reception: "assistant", receptionist: true },
  );
  const names = new Map<string | null, string>([["_hq", "Accueil"]]);
  let checked = 0;
  for (const room of layout.rooms) {
    if (!room.sign) continue;
    const name = room.kind === "owner" ? "Votre bureau" : (names.get(room.project) ?? room.project!);
    const wall = room.w * CELL;
    // With no logo, a small one and the widest a logo can be (three times its height).
    for (const logo of [0, 14, 42]) {
      const { plan, from, length, counter } = placeSign(sign, font, name, logo, wall, room.counter);
      assert.equal(plan.text, signText(font, name), `${name}: the whole name`);
      assert.equal(plan.text.length, name.replace(/[^a-z0-9 &'._-]/gi, "").length, `${name}: no letter left out`);
      const content = (plan.logoWidth > 0 ? plan.logoWidth + 4 : 0) + textWidth(font, plan.text);
      assert.ok(plan.start >= SIGN_PADDING - 1 && plan.start + content <= faceWidth(sign, plan.segments), `${name}: the text inside its face`);
      // Painted, every glyph pixel lands on a column of the face (nothing drawn past its end).
      const columns = faceColumns(sign, plan.segments);
      const face = paintFace(columns, { ...plan, logoWidth: 0 }, font, 0xffffff, null);
      const inked = face ? [...face.pixels.data].filter((_, i) => i % 4 === 3 && face.pixels.data[i] === 255).length : 0;
      const glyphs = [...plan.text].reduce((sum, char) => sum + (font.glyphs[char] ?? []).join("").split("#").length - 1, 0);
      assert.equal(inked, glyphs * GLYPH_SCALE * GLYPH_SCALE, `${name}: every letter painted whole`);
      assert.ok(from >= 0 && from + length <= wall, `${name}: on its own back wall (${from} to ${from + length} of ${wall})`);
      if (counter?.beside) assert.ok(counter.from + COUNTER_LENGTH <= wall, `${name}: its counter beside it, on the same wall`);
      if (counter && !counter.beside) assert.ok(counter.from + COUNTER_LENGTH <= room.d * CELL, `${name}: its counter on the other back wall`);
    }
    checked += 1;
  }
  assert.equal(checked, rooms.length + 2, "every room, the user's office and the lobby");
});

test("a counter's digits are as tall as the letters of the names, on a face as tall as theirs", () => {
  const digit = font.glyphs["7"]!;
  const letter = font.glyphs["A"]!;
  assert.equal(digit.length, letter.length);
  const counter = faceColumns(sign, COUNTER_SEGMENTS);
  const name = faceColumns(sign, 6);
  assert.equal(Math.min(...counter.map((col) => col.h)), Math.min(...name.map((col) => col.h)));
});
