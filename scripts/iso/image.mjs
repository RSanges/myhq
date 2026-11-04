// RGBA images for the iso pipeline: render to sprite and tint mask, crop,
// blit, upscale, hover rings, runtime style tinting (for previews), a tiny
// font and PNG output. No dependency.
import { writeFileSync } from "node:fs";
import { COLORS, PALETTE } from "./palette.mjs";
import { TINT_FACTORS, TINT_MODES } from "./engine.mjs";
import { encodePng } from "./png.mjs";

export class Img {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.data = new Uint8ClampedArray(w * h * 4);
  }
  alpha(x, y) {
    return x < 0 || y < 0 || x >= this.w || y >= this.h ? 0 : this.data[(y * this.w + x) * 4 + 3];
  }
  set(x, y, [r, g, b], a = 255) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    this.data[i] = r; this.data[i + 1] = g; this.data[i + 2] = b; this.data[i + 3] = a;
  }
  get(x, y) {
    const i = (y * this.w + x) * 4;
    return [this.data[i], this.data[i + 1], this.data[i + 2], this.data[i + 3]];
  }
}

export const rgb = (hex) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
export const colour = (name) => rgb(COLORS[name]);

export function filled(w, h, fill) {
  const img = new Img(w, h);
  if (fill) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img.set(x, y, fill);
  return img;
}

/**
 * Splits a render into a sprite and its tint masks. `keep(i)` selects the
 * pixels (default: all). Masks are keyed "mode:slot" (for example
 * "room:0"): grey = multiply factor, opaque where tinted.
 */
export function fromRender(r, keep = () => true) {
  const sprite = new Img(r.w, r.h);
  const masks = {};
  for (let i = 0; i < r.w * r.h; i++) {
    if (r.idx[i] < 0 || !keep(i)) continue;
    const x = i % r.w, y = (i - x) / r.w;
    sprite.set(x, y, PALETTE[r.idx[i]]);
    if (!r.tint[i]) continue;
    const code = r.tint[i] - 1;
    const level = code % 5, mode = Math.floor(code / 5) % 2, slot = Math.floor(code / 10);
    const key = `${TINT_MODES[mode]}:${slot}`;
    masks[key] ??= new Img(r.w, r.h);
    const g = Math.round(TINT_FACTORS[TINT_MODES[mode]][level] * 255);
    masks[key].set(x, y, [g, g, g]);
  }
  return { sprite, masks };
}

/** Bounding box of the opaque pixels of some images (same size), or null. */
export function bbox(...imgs) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (const img of imgs) {
    for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
      if (!img.alpha(x, y)) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export function crop(img, { x, y, w, h }) {
  const out = new Img(w, h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    if (x + i < 0 || y + j < 0 || x + i >= img.w || y + j >= img.h) continue;
    const s = ((y + j) * img.w + x + i) * 4, d = (j * w + i) * 4;
    for (let k = 0; k < 4; k++) out.data[d + k] = img.data[s + k];
  }
  return out;
}

/** Draws src over dst at (x, y), alpha blended. */
export function blit(dst, src, x, y) {
  for (let j = 0; j < src.h; j++) for (let i = 0; i < src.w; i++) {
    const s = (j * src.w + i) * 4;
    const a = src.data[s + 3];
    const tx = x + i, ty = y + j;
    if (!a || tx < 0 || ty < 0 || tx >= dst.w || ty >= dst.h) continue;
    const d = (ty * dst.w + tx) * 4;
    if (a === 255) { for (let k = 0; k < 4; k++) dst.data[d + k] = src.data[s + k]; continue; }
    const da = dst.data[d + 3] / 255, sa = a / 255, oa = sa + da * (1 - sa);
    for (let k = 0; k < 3; k++) dst.data[d + k] = Math.round((src.data[s + k] * sa + dst.data[d + k] * da * (1 - sa)) / oa);
    dst.data[d + 3] = Math.round(oa * 255);
  }
}

/**
 * The runtime tint recipe, for previews: every opaque mask pixel becomes
 * colour x grey / 255 (multiply), drawn over dst at (x, y).
 */
export function tintOnto(dst, mask, x, y, hex) {
  const c = rgb(hex);
  for (let j = 0; j < mask.h; j++) for (let i = 0; i < mask.w; i++) {
    const [g, , , a] = mask.get(i, j);
    if (a) dst.set(x + i, y + j, c.map((v) => Math.round((v * g) / 255)));
  }
}

/** Pastel version of a room colour, for "pastel" masks: 55 % towards paper white. */
export function pastel(hex) {
  const c = rgb(hex), p = rgb("#fffaf0");
  return "#" + c.map((v, k) => Math.round(v + (p[k] - v) * 0.55).toString(16).padStart(2, "0")).join("");
}

/** Nearest neighbour integer upscale. */
export function upscale(img, k) {
  const out = new Img(img.w * k, img.h * k);
  for (let y = 0; y < out.h; y++) for (let x = 0; x < out.w; x++) {
    const s = (Math.floor(y / k) * img.w + Math.floor(x / k)) * 4, d = (y * out.w + x) * 4;
    for (let c = 0; c < 4; c++) out.data[d + c] = img.data[s + c];
  }
  return out;
}

/**
 * Hover rings: each colour of `rings` becomes a 1 px ring around the
 * opaque pixels of `shape` (4-neighbour), the first one touching it. The
 * result is the rings only, same size as shape.
 */
export function rings(shape, ringColours) {
  const out = new Img(shape.w, shape.h);
  let inside = new Uint8Array(shape.w * shape.h);
  for (let i = 0; i < inside.length; i++) inside[i] = shape.data[i * 4 + 3] ? 1 : 0;
  for (const c of ringColours) {
    const next = inside.slice();
    for (let y = 0; y < shape.h; y++) for (let x = 0; x < shape.w; x++) {
      const i = y * shape.w + x;
      if (inside[i]) continue;
      const near = (x > 0 && inside[i - 1]) || (x < shape.w - 1 && inside[i + 1]) || (y > 0 && inside[i - shape.w]) || (y < shape.h - 1 && inside[i + shape.w]);
      if (near) { out.set(x, y, c); next[i] = 1; }
    }
    inside = next;
  }
  return out;
}

/** Pads an image by p transparent pixels on every side. */
export function pad(img, p) {
  const out = new Img(img.w + 2 * p, img.h + 2 * p);
  blit(out, img, p, p);
  return out;
}

export function writePng(file, img) {
  writeFileSync(file, encodePng(img.w, img.h, img.data));
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
  "-": "000000111000000", " ": "000000000000000", ".": "000000000000010", "/": "001001010100100",
};

/** Writes text with a 3 x 5 pixel font, 4 px per character. */
export function text(img, str, x, y, c) {
  let cx = x;
  for (const ch of str.toUpperCase()) {
    const glyph = GLYPHS[ch] ?? GLYPHS[" "];
    for (let i = 0; i < 15; i++) if (glyph[i] === "1") img.set(cx + (i % 3), y + Math.floor(i / 3), c);
    cx += 4;
  }
}

/**
 * Packs frames into one atlas, shelf by shelf, in the given order (so the
 * layout is deterministic). Returns { img, rects } with rects[i] = {x, y, w, h}.
 */
export function pack(frames, maxW = 1024, gap = 1) {
  const rects = [];
  let x = 0, y = 0, rowH = 0, w = 0;
  for (const f of frames) {
    if (x + f.w > maxW && x > 0) { x = 0; y += rowH + gap; rowH = 0; }
    rects.push({ x, y, w: f.w, h: f.h });
    x += f.w + gap;
    rowH = Math.max(rowH, f.h);
    w = Math.max(w, x - gap);
  }
  const img = new Img(Math.max(1, w), Math.max(1, y + rowH));
  frames.forEach((f, i) => blit(img, f, rects[i].x, rects[i].y));
  return { img, rects };
}

/** A labelled contact sheet of images on a paper background. */
export function contactSheet(items, { maxW = 560, gap = 8, background = colour("ink5"), label = colour("ink2") } = {}) {
  const LABEL = 9;
  const rows = [];
  let row = { items: [], w: gap, h: 0 };
  for (const item of items) {
    const cellW = Math.max(item.img.w, item.name.length * 4);
    if (row.w + cellW + gap > maxW && row.items.length) { rows.push(row); row = { items: [], w: gap, h: 0 }; }
    row.items.push({ ...item, cellW });
    row.w += cellW + gap;
    row.h = Math.max(row.h, item.img.h);
  }
  rows.push(row);
  const sheet = filled(Math.max(...rows.map((r) => r.w)), rows.reduce((sum, r) => sum + r.h + LABEL + gap, gap), background);
  let y = gap;
  for (const r of rows) {
    let x = gap;
    for (const item of r.items) {
      blit(sheet, item.img, x + Math.floor((item.cellW - item.img.w) / 2), y + r.h - item.img.h);
      text(sheet, item.name, x + Math.floor((item.cellW - item.name.length * 4) / 2), y + r.h + 3, label);
      x += item.cellW + gap;
    }
    y += r.h + LABEL + gap;
  }
  return sheet;
}
