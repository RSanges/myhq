// Builds the iso desk scene and its props into public/iso/.
//
//   node scripts/iso/build.mjs [--pile N]
//
// Outputs: scene-desk.png (1x), scene-desk@3x.png, scene-desk-hover.png (the
// document pile hovered), one transparent PNG per prop, props.json (atlas:
// size and ground anchor of each prop, boxes of the scene objects) and
// contact-sheet@3x.png. Deterministic: same code, same bytes.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { World, blank, blit, render, toPng, trim, upscale } from "./engine.mjs";
import { INDEX } from "./palette.mjs";
import * as P from "./props.mjs";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "public", "iso");
const SCALE = 3;
const args = process.argv.slice(2);
const pileArg = args.indexOf("--pile");
const PILE = pileArg >= 0 ? Number(args[pileArg + 1]) : 6;

// Lights, shared by the scene and documented in the README.
const SUN = [0, 0.55, 1]; // key light from the front left: shadows fall towards -y
const WINDOW_LIGHT = { dir: [-1, 0, 1], outside: (x) => x <= -4 }; // daylight through the left wall
const COVER = 24; // contact shadow under things up to desk height
const DESK_TOP = 25;

// ---------------------------------------------------------------- the scene

const LAYOUT = [
  // name, prop, world position of its local origin, prop options, object options
  ["room", P.room, [0, 0, 0], {}, { sunShadow: false }],
  ["rug", P.rug, [16, 32, 0]],
  ["floor-lamp", P.floorLamp, [2, 2, 0]],
  ["plant", P.plant, [3, 27, 0]],
  ["poster", P.poster, [0, 59, 40], { facing: "x" }],
  ["bookshelf", P.bookshelf, [0, 54, 0]],
  ["desk", P.desk, [20, 0, 0]],
  ["chair", P.chair, [30, 40, 1]],
  ["clock", P.clock, [26, 0, 54]],
  ["calendar", P.calendar, [60, 0, 44]],
  ["lamp", P.lamp, [21, 1, DESK_TOP], {}, { cover: false }],
  ["mail-tray", P.mailTray, [22, 14, DESK_TOP], { letters: 3 }],
  ["monitor", P.monitor, [36, 1, DESK_TOP]],
  ["keyboard", P.keyboard, [39, 13, DESK_TOP]],
  ["phone", P.phone, [40, 21, DESK_TOP]],
  ["newspaper", P.newspaper, [55, 17, DESK_TOP]],
  ["doc-pile", P.docPile, [60, 3, DESK_TOP], { count: PILE }],
  ["mug", P.mug, [64, 19, DESK_TOP]],
];

function buildScene() {
  const world = new World();
  const ids = {};
  for (const [name, prop, at, options = {}, extra = {}] of LAYOUT) {
    ids[name] = world.add(name, at, (b) => prop(b, options), extra).id;
  }
  const lampAt = LAYOUT.find(([name]) => name === "lamp")[2];
  const floorAt = LAYOUT.find(([name]) => name === "floor-lamp")[2];
  const lamps = [
    { at: P.LAMP_BULB.map((c, k) => c + lampAt[k]), radius: 22, topOnly: true },
    { at: P.FLOOR_LAMP_LIGHT.map((c, k) => c + floorAt[k]), radius: 20 },
  ];
  return { world, ids, lamps };
}

// ---------------------------------------------------------------- props

const PROPS = [
  ["room", P.room],
  ["desk", P.desk],
  ["monitor", P.monitor],
  ["doc-pile-1", P.docPile, { count: 1 }],
  ["doc-pile-3", P.docPile, { count: 3 }],
  ["doc-pile-6", P.docPile, { count: 6 }],
  ["doc-pile-10", P.docPile, { count: 10 }],
  ["mail-tray", P.mailTray, { letters: 3 }],
  ["newspaper", P.newspaper],
  ["phone", P.phone],
  ["mug", P.mug],
  ["keyboard", P.keyboard],
  ["calendar", P.calendar],
  ["lamp", P.lamp],
  ["chair", P.chair],
  ["plant", P.plant],
  ["bookshelf", P.bookshelf],
  ["rug", P.rug],
  ["floor-lamp", P.floorLamp],
  ["poster", P.poster, { facing: "x" }],
  ["clock", P.clock],
];

function renderProp(prop, options = {}) {
  const world = new World();
  world.add("prop", [0, 0, 0], (b) => prop(b, options));
  // Footprint of the lowest layer (the legs, the base, the pot).
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, zMin = Infinity;
  for (const key of world.cells.keys()) {
    const z = (key % 2048) - 1024;
    if (z < zMin) zMin = z;
  }
  for (const key of world.cells.keys()) {
    const z = (key % 2048) - 1024;
    if (z !== zMin) continue;
    const rest = Math.floor(key / 2048);
    const y = (rest % 2048) - 1024;
    const x = Math.floor(rest / 2048) - 1024;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x + 1); y0 = Math.min(y0, y); y1 = Math.max(y1, y + 1);
  }
  const image = render(world, { ground: true });
  const { img, dx, dy } = trim(image);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  // anchor: footprint centre on the ground plane z = 0; origin: local (0, 0, 0).
  const anchor = { x: 2 * (cx - cy) - image.uMin - dx, y: cx + cy - image.vMin - dy };
  const origin = { x: -image.uMin - dx, y: -image.vMin - dy };
  return { img, anchor, origin, footprint: [x1 - x0, y1 - y0] };
}

// ---------------------------------------------------------------- tiny font

const GLYPHS = {
  A: "010101111101101", B: "110101110101110", C: "011100100100011", D: "110101101101110",
  E: "111100110100111", F: "111100110100100", G: "011100101101011", H: "101101111101101",
  I: "111010010010111", J: "001001001101010", K: "101101110101101", L: "100100100100111",
  M: "101111111101101", N: "110101101101101", O: "010101101101010", P: "110101110100100",
  Q: "010101101110011", R: "110101110101101", S: "011100010001110", T: "111010010010010",
  U: "101101101101111", V: "101101101101010", W: "101101111111101", X: "101101010101101",
  Y: "101101010010010", Z: "111001010100111", 0: "111101101101111", 1: "010110010010111",
  2: "110001010100111", 3: "110001010001110", 4: "101101111001001", 5: "111100110001110",
  6: "011100111101111", 7: "111001010010010", 8: "111101111101111", 9: "111101111001110",
  "-": "000000111000000", " ": "000000000000000",
};

function text(img, str, x, y, colour) {
  let cx = x;
  for (const ch of str.toUpperCase()) {
    const glyph = GLYPHS[ch] ?? GLYPHS[" "];
    for (let i = 0; i < 15; i++) {
      if (glyph[i] !== "1") continue;
      const px = cx + (i % 3), py = y + Math.floor(i / 3);
      if (px >= 0 && py >= 0 && px < img.w && py < img.h) img.idx[py * img.w + px] = colour;
    }
    cx += 4;
  }
}

// ---------------------------------------------------------------- build

mkdirSync(OUT, { recursive: true });
const write = (name, img) => writeFileSync(path.join(OUT, name), toPng(img));

const { world, ids, lamps } = buildScene();
const sceneOptions = { sun: SUN, cover: COVER, windows: [WINDOW_LIGHT], lamps };
const scene = render(world, sceneOptions);
write("scene-desk.png", scene);
write("scene-desk@3x.png", upscale(scene, SCALE));
const hovered = render(world, { ...sceneOptions, hover: [ids["doc-pile"]] });
write("scene-desk-hover.png", hovered);
write("scene-desk-hover@3x.png", upscale(hovered, SCALE));

const boxes = {};
for (let i = 0; i < scene.w * scene.h; i++) {
  const id = scene.obj[i];
  if (!id) continue;
  const name = world.objects[id].name;
  const x = i % scene.w, y = Math.floor(i / scene.w);
  const box = (boxes[name] ??= { x, y, x1: x, y1: y });
  box.x = Math.min(box.x, x); box.y = Math.min(box.y, y); box.x1 = Math.max(box.x1, x); box.y1 = Math.max(box.y1, y);
}

const atlas = { scale: 1, voxel: { top: [4, 2], edge: 2 }, props: [], scene: { file: "scene-desk.png", w: scene.w, h: scene.h, pile: PILE, objects: [] } };
const rendered = [];
for (const [name, prop, options] of PROPS) {
  const { img, anchor, origin, footprint } = renderProp(prop, options);
  write(`${name}.png`, img);
  rendered.push({ name, img });
  atlas.props.push({ name, file: `${name}.png`, w: img.w, h: img.h, anchor, origin, footprint });
}
for (const [name, box] of Object.entries(boxes)) {
  atlas.scene.objects.push({ name, x: box.x, y: box.y, w: box.x1 - box.x + 1, h: box.y1 - box.y + 1 });
}
writeFileSync(path.join(OUT, "props.json"), JSON.stringify(atlas, null, 2) + "\n");

// Contact sheet: every prop on a warm paper background, its name below.
const GAP = 8, LABEL = 9, MAX_W = 520;
const rows = [];
let row = { items: [], w: GAP, h: 0 };
for (const item of rendered.filter((r) => r.name !== "room")) {
  if (row.w + item.img.w + GAP > MAX_W && row.items.length) { rows.push(row); row = { items: [], w: GAP, h: 0 }; }
  const cellW = Math.max(item.img.w, item.name.length * 4);
  row.items.push({ ...item, cellW });
  row.w += cellW + GAP;
  row.h = Math.max(row.h, item.img.h);
}
rows.push(row);
const sheetW = Math.max(...rows.map((r) => r.w));
const sheetH = rows.reduce((sum, r) => sum + r.h + LABEL + GAP, GAP);
const sheet = blank(sheetW, sheetH, INDEX.ink5);
let y = GAP;
for (const r of rows) {
  let x = GAP;
  for (const item of r.items) {
    blit(sheet, item.img, x + Math.floor((item.cellW - item.img.w) / 2), y + r.h - item.img.h);
    text(sheet, item.name, x + Math.floor((item.cellW - item.name.length * 4) / 2), y + r.h + 3, INDEX.ink2);
    x += item.cellW + GAP;
  }
  y += r.h + LABEL + GAP;
}
write("contact-sheet@3x.png", upscale(sheet, SCALE));

console.log(`scene ${scene.w}x${scene.h}, pile ${PILE}, ${PROPS.length} props, contact sheet ${sheet.w * SCALE}x${sheet.h * SCALE}`);
