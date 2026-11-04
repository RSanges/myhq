// Builds the hub (the owner's desk scene) into public/iso/hub/.
//
//   node scripts/iso/build-hub.mjs
//
// The scene is rendered once without its dynamic objects (the background),
// then once per state of each dynamic object: the pixels that change are
// that state's sprite (the object, its outline, the shadows it casts), so
// drawing it over the background gives exactly the full render. Hover
// frames lift the object by 2 px and ring it. See README.md for the format.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { World, render } from "./engine.mjs";
import { Img, bbox, blit, colour, crop, fromRender, pack, rings, tintOnto, upscale, writePng } from "./image.mjs";
import * as P from "./props.mjs";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "public", "iso", "hub");
const SCALE = 3;

// Lights, shared by every render of the scene.
const SUN = [0, 0.55, 1]; // key light from the front left: shadows fall towards -y
const WINDOW_LIGHT = { dir: [-1, 0, 1], outside: (x) => x <= -4 }; // daylight through the left wall
const COVER = 24; // contact shadow under things up to desk height
const DESK_TOP = 25;

/** Hover: the object rises by LIFT px and gets one ring per colour, inside out. */
export const HOVER = { lift: 2, rings: [colour("ink6"), colour("gold2")] };

// ---------------------------------------------------------------- layout

const STATIC = [
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
  ["lamp", P.lamp, [21, 1, DESK_TOP], {}, { cover: false }],
  ["monitor", P.monitor, [36, 1, DESK_TOP]],
  ["keyboard", P.keyboard, [39, 13, DESK_TOP]],
  ["mug", P.mug, [34, 20, DESK_TOP]],
];

const MONITOR_AT = [36, 1, DESK_TOP];

/**
 * Dynamic objects: `states` lists the prop options of each state, keyed by
 * the state name the runtime uses. A state whose prop draws nothing has no
 * frame (an absent newspaper, no post-its).
 */
const DYNAMIC = [
  {
    name: "pile", at: [58, 2, DESK_TOP], module: "approvals",
    build: (count) => (b) => { P.deskPad(b); P.docPile(b.at(2, 2, 1), { count }); },
    states: Object.fromEntries(Array.from({ length: 15 }, (_, n) => [String(n), n])),
  },
  {
    name: "mail", at: [22, 14, DESK_TOP], module: "mail",
    build: (letters) => (b) => P.mailTray(b, { letters }),
    states: Object.fromEntries(Array.from({ length: 6 }, (_, n) => [String(n), n])),
  },
  {
    name: "postits", at: MONITOR_AT, module: "notes",
    build: (count) => (b) => P.postIts(b, { count }),
    states: Object.fromEntries(Array.from({ length: 6 }, (_, n) => [String(n), n])),
  },
  {
    name: "newspaper", at: [56, 19, DESK_TOP], module: "news",
    build: (present) => (b) => { if (present) P.newspaper(b); },
    states: { absent: false, present: true },
  },
  {
    name: "calendar", at: [56, 0, 42], module: "calendar",
    build: (today) => (b) => P.calendar(b, { today }),
    states: { default: -1 },
  },
  {
    name: "phone", at: [27, 2, DESK_TOP], module: "phone",
    build: (unread) => (b) => P.deskPhone(b, { unread }),
    states: { idle: false, unread: true },
  },
];

function world(extra = []) {
  const w = new World();
  const ids = {};
  for (const [name, prop, at, options = {}, more = {}] of STATIC) ids[name] = w.add(name, at, (b) => prop(b, options), more).id;
  for (const { name, at, build } of extra) ids[name] = w.add(name, at, build).id;
  return { w, ids };
}

function lights() {
  const lampAt = STATIC.find(([name]) => name === "lamp")[2];
  const floorAt = STATIC.find(([name]) => name === "floor-lamp")[2];
  return {
    sun: SUN, cover: COVER, windows: [WINDOW_LIGHT],
    lamps: [
      { at: P.LAMP_BULB.map((c, k) => c + lampAt[k]), radius: 22, topOnly: true },
      { at: P.FLOOR_LAMP_LIGHT.map((c, k) => c + floorAt[k]), radius: 20 },
    ],
  };
}

// ---------------------------------------------------------------- render

export function buildHub() {

  const LIGHTS = lights();
  const base = world();
  const bg = render(base.w, LIGHTS);
  const FRAME = { uMin: bg.uMin, vMin: bg.vMin, w: bg.w, h: bg.h };
  const background = fromRender(bg).sprite;

  /** Full frame images of one state: sprite, masks, the object's own pixels. */
  function stateImages(object, value) {
    const { w, ids } = world([{ name: object.name, at: object.at, build: object.build(value) }]);
    const r = render(w, { ...LIGHTS, frame: FRAME });
    const id = ids[object.name];
    const changed = (i) => r.owner[i] === id || r.idx[i] !== bg.idx[i] || r.tint[i] !== bg.tint[i];
    const all = fromRender(r, changed);
    const own = fromRender(r, (i) => r.owner[i] === id);
    return { r, id, all, own };
  }

  /** The hover frame: shadows in place, the object lifted, rings around it. */
  function hoverImages(all, own) {
    const out = new Img(all.sprite.w, all.sprite.h);
    const shadowOnly = new Img(out.w, out.h);
    for (let y = 0; y < out.h; y++) for (let x = 0; x < out.w; x++) {
      if (all.sprite.alpha(x, y) && !own.sprite.alpha(x, y)) shadowOnly.set(x, y, all.sprite.get(x, y));
    }
    const lifted = new Img(out.w, out.h);
    blit(lifted, own.sprite, 0, -HOVER.lift);
    blit(out, shadowOnly, 0, 0);
    blit(out, lifted, 0, 0);
    blit(out, rings(lifted, HOVER.rings), 0, 0);
    const masks = {};
    for (const [key, mask] of Object.entries(own.masks)) {
      masks[key] = new Img(out.w, out.h);
      blit(masks[key], mask, 0, -HOVER.lift);
    }
    return { sprite: out, masks };
  }

  // ---------------------------------------------------------------- atlas

  const frames = [];
  /** Adds a cropped frame to the atlas, returns its index. */
  const addFrame = (img) => frames.push(img) - 1;
  const rect = (box) => (box ? [box.x, box.y, box.w, box.h] : null);

  /** Crops a full frame image set to its pixels; null when empty. */
  function placed(images) {
    const box = bbox(images.sprite);
    if (!box) return null;
    const out = { frame: addFrame(crop(images.sprite, box)), at: [box.x, box.y], masks: [] };
    for (const [key, mask] of Object.entries(images.masks).sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }))) {
      const mb = bbox(mask);
      if (!mb) continue;
      const [mode, slot] = key.split(":");
      out.masks.push({ frame: addFrame(crop(mask, mb)), at: [mb.x, mb.y], mode, slot: Number(slot) });
    }
    return out;
  }

  const objects = {};
  for (const object of DYNAMIC) {
    const entry = { module: object.module, states: {} };
    for (const [state, value] of Object.entries(object.states)) {
      const { all, own } = stateImages(object, value);
      for (const [key, mask] of Object.entries(all.masks)) {
        const box = bbox(mask);
        if (!box || box.w < 12) throw new Error(`${object.name} ${state}: tint mask ${key} is almost hidden`);
      }
      const normal = placed(all);
      const hover = normal && placed(hoverImages(all, own));
      entry.states[state] = normal ? { ...normal, hit: rect(bbox(own.sprite)), hover } : null;
    }
    objects[object.name] = entry;
  }

  /** The state shown in the previews. */
  function preferredState(object) {
    return { pile: "9", mail: "3", postits: "3", newspaper: "present", calendar: "default", phone: "unread" }[object.name];
  }

  // The calendar "today" mark: the cells differ only by a translation, so one
  // frame and one offset per cell (row * 7 + col) are enough.
  const calendar = DYNAMIC.find((o) => o.name === "calendar");
  const plain = stateImages(calendar, -1);
  const marks = [];
  for (let cell = 0; cell < P.CALENDAR.cols * P.CALENDAR.rows; cell++) {
    const { r } = stateImages(calendar, cell);
    const mark = fromRender(r, (i) => r.idx[i] !== plain.r.idx[i]).sprite;
    const box = bbox(mark);
    marks.push({ img: crop(mark, box), at: [box.x, box.y] });
  }
  const same = (a, b) => a.w === b.w && a.h === b.h && a.data.every((v, i) => v === b.data[i]);
  if (!marks.every((m) => same(m.img, marks[0].img))) throw new Error("calendar marks differ between cells");
  const today = { frame: addFrame(marks[0].img), cells: marks.map((m) => m.at) };
  objects.calendar.today = today;

  // ---------------------------------------------------------------- outputs

  mkdirSync(OUT, { recursive: true });
  const atlas = pack(frames, 512);
  writePng(path.join(OUT, "background.png"), background);
  writePng(path.join(OUT, "hub.png"), atlas.img);
  const json = {
    version: 1,
    scale: 1,
    background: { file: "background.png", w: background.w, h: background.h },
    atlas: { file: "hub.png", w: atlas.img.w, h: atlas.img.h, frames: atlas.rects.map((r) => [r.x, r.y, r.w, r.h]) },
    hover: { lift: HOVER.lift, rings: HOVER.rings.length },
    calendar: { cols: P.CALENDAR.cols, rows: P.CALENDAR.rows, firstDay: "monday" },
    objects,
  };
  writeFileSync(path.join(OUT, "hub.json"), JSON.stringify(json, null, 1).replace(/\n\s+(-?\d+,?)(?=\n)/g, " $1").replace(/\[\s+/g, "[").replace(/\s+\]/g, "]") + "\n");

  // Previews, composed the way the runtime does it (atlas frames, masks tinted).
  const EXAMPLE_ROOMS = ["#ff3d7f", "#4f93e0", "#74b84e", "#f2c14e", "#9b5de5", "#ff8c42"];
  function compose(hoverAll) {
    const img = crop(background, { x: 0, y: 0, w: background.w, h: background.h });
    const frameImg = (k) => crop(atlas.img, { x: atlas.rects[k].x, y: atlas.rects[k].y, w: atlas.rects[k].w, h: atlas.rects[k].h });
    for (const object of DYNAMIC) {
      const state = objects[object.name].states[preferredState(object)];
      if (!state) continue;
      const drawn = hoverAll ? state.hover : state;
      blit(img, frameImg(drawn.frame), ...drawn.at);
      for (const m of drawn.masks) tintOnto(img, frameImg(m.frame), ...m.at, EXAMPLE_ROOMS[m.slot % EXAMPLE_ROOMS.length]);
      if (object.name === "calendar") {
        const [x, y] = today.cells[10];
        blit(img, frameImg(today.frame), x, y - (hoverAll ? HOVER.lift : 0));
      }
    }
    return img;
  }
  const preview = compose(false);
  const previewHover = compose(true);
  writePng(path.join(OUT, "preview.png"), preview);
  writePng(path.join(OUT, "preview@3x.png"), upscale(preview, SCALE));
  writePng(path.join(OUT, "preview-hover.png"), previewHover);
  writePng(path.join(OUT, "preview-hover@3x.png"), upscale(previewHover, SCALE));
  console.log(`hub ${background.w}x${background.h}, atlas ${atlas.img.w}x${atlas.img.h}, ${frames.length} frames`);
}

if (process.argv[1]?.endsWith("build-hub.mjs")) buildHub();
