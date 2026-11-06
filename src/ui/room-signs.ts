import type { SignFont, SignSet } from "./iso-floor";
import { COUNTER_FROM, COUNTER_SEGMENTS } from "./room-layout";

// The signboards of the single floor (one on the back wall of each room, see
// scripts/iso/README.md, "Signboards"): how long a board must be for a name
// and a logo, where they go on its face, which ink reads on the room colour,
// and the logo reduced to the height of the face. Pure: pixel buffers, no
// canvas, so the rules are tested.

/** One glyph pixel of the font is this many face pixels each way (a voxel of the face: 2 by 2 on screen). */
export const GLYPH_SCALE = 2;
/** Face pixels kept free at each end of the face, and between the logo and the name. */
export const SIGN_PADDING = 4;
export const LOGO_GAP = 4;
/** Face pixels kept free above and below the logo. */
export const LOGO_MARGIN = 2;

/** The glyphs of `text` the font has (uppercase), the others dropped. */
export function signText(font: SignFont, text: string): string {
  return [...text.toUpperCase()].filter((char) => font.glyphs[char] !== undefined).join("");
}

/** Width of `text` on the face, in face pixels. */
export function textWidth(font: SignFont, text: string): number {
  const chars = [...text];
  const glyphs = chars.reduce((sum, char) => sum + (font.glyphs[char]?.[0]?.length ?? 0), 0);
  return GLYPH_SCALE * (glyphs + font.spacing * Math.max(0, chars.length - 1));
}

/** Face pixel columns of a board of `segments` middle segments (`segments` >= 1). */
export function faceWidth(set: SignSet, segments: number): number {
  const count = (cols: SignSet["left"]["face"]["cols"]) => cols.filter((col) => col !== null).length;
  return count(set.left.face.cols) + (segments - 1) * count(set.middle.face.cols) + count(set.right.face.cols);
}

/** Length of a board along its wall, in voxels. */
export const boardLength = (set: SignSet, segments: number): number => 2 * set.end + segments * set.segment;

export type SignPlan = {
  segments: number;
  /** The name as drawn (uppercase, the characters the font lacks left out): always whole. */
  text: string;
  /** Width of the logo on the face (0: no logo). */
  logoWidth: number;
  /** Where the content starts on the face (face pixels from its first column): centred. */
  start: number;
};

/**
 * The board for a name (and a logo `logoWidth` face pixels wide, 0 for none)
 * on a wall `wallVoxels` long: the fewest segments that hold the content.
 * The name is never cut: when the longest board the wall holds (with a
 * margin at each end) is too short for the logo and the name, the logo goes,
 * and when it is too short for the name alone, the board grows past the wall
 * (`placeSign` centres it, over the corner and the next wall).
 */
export function planSign(set: SignSet, font: SignFont, name: string, logoWidth: number, wallVoxels: number): SignPlan {
  const most = Math.max(1, Math.floor((wallVoxels - 8 - 2 * set.end) / set.segment));
  const text = signText(font, name);
  let logo = logoWidth;
  const need = () => 2 * SIGN_PADDING + (logo > 0 ? logo + (text ? LOGO_GAP : 0) : 0) + textWidth(font, text);
  if (need() > faceWidth(set, most)) logo = 0;
  let segments = 1;
  while (faceWidth(set, segments) < need()) segments += 1;
  const content = need() - 2 * SIGN_PADDING;
  return { segments, text, logoWidth: logo, start: Math.floor((faceWidth(set, segments) - content) / 2) };
}

/** Voxels between a name's board and its counter on the same wall. */
export const COUNTER_GAP = 4;

/**
 * Where the signboard of a room and its counter stand. `from` is where the
 * name's board starts along the back wall along x (voxels from the room's back
 * corner, negative when a name longer than its wall overhangs the corner). The
 * counter (when the room has one) stands beside the name on the same wall when
 * the wall holds both (the pair centred, `beside`), else on the back wall along
 * y, COUNTER_FROM voxels from the corner, the name's board then starting there
 * too. Without a counter the name is centred on its wall.
 */
export type SignPlacement = { plan: SignPlan; from: number; length: number; counter: { beside: boolean; from: number } | null };

export function placeSign(set: SignSet, font: SignFont, name: string, logoWidth: number, wallVoxels: number, counter: boolean): SignPlacement {
  const plan = planSign(set, font, name, logoWidth, wallVoxels);
  const length = boardLength(set, plan.segments);
  if (!counter) return { plan, from: Math.floor((wallVoxels - length) / 2), length, counter: null };
  const pair = length + COUNTER_GAP + boardLength(set, COUNTER_SEGMENTS);
  if (pair <= wallVoxels - 2 * COUNTER_FROM) {
    const from = Math.floor((wallVoxels - pair) / 2);
    return { plan, from, length, counter: { beside: true, from: from + length + COUNTER_GAP } };
  }
  return { plan, from: COUNTER_FROM, length, counter: { beside: false, from: COUNTER_FROM } };
}

const channel = (value: number) => {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
/** Relative luminance of 0xRRGGBB (WCAG). */
export function luminance(color: number): number {
  return 0.2126 * channel((color >> 16) & 255) + 0.7152 * channel((color >> 8) & 255) + 0.0722 * channel(color & 255);
}
export const contrast = (a: number, b: number): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

/** The ink of the palette (paper white or ink black) that reads best on a board of this colour. */
export const SIGN_INK = { light: 0xfffaf0, dark: 0x1b1424 } as const;
export function inkFor(board: number): number {
  return contrast(board, SIGN_INK.light) >= contrast(board, SIGN_INK.dark) ? SIGN_INK.light : SIGN_INK.dark;
}

/** An RGBA pixel buffer. */
export type Pixels = { width: number; height: number; data: Uint8ClampedArray };

/**
 * A logo reduced to `height` pixels high (its width in proportion, at most
 * three times its height), keeping a crisp pixel art look: no colour is
 * blended. Each pixel is opaque when COVERAGE of its block of the source is
 * (so that the thin lines of a drawn logo survive), and takes the colour that
 * covers most of the block, or a colour in strong contrast with it that covers
 * DETAIL of it (an eye, a letter), each the average of its own source pixels.
 * A logo smaller than that keeps its size. Null for an empty image.
 */
const COVERAGE = 0.12;
const DETAIL = 0.25;

export function shrinkLogo(source: Pixels, height: number): Pixels | null {
  if (source.width === 0 || source.height === 0) return null;
  const k = Math.max(1, source.height / height, source.width / (3 * height));
  const width = Math.max(1, Math.round(source.width / k));
  const tall = Math.max(1, Math.round(source.height / k));
  const out = new Uint8ClampedArray(width * tall * 4);
  for (let y = 0; y < tall; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor(x * k);
      const y0 = Math.floor(y * k);
      const x1 = Math.max(x0 + 1, Math.min(source.width, Math.floor((x + 1) * k)));
      const y1 = Math.max(y0 + 1, Math.min(source.height, Math.floor((y + 1) * k)));
      // Opaque pixels of the block by colour (16 levels a channel): how many, and their sum.
      const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
      let opaque = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const i = (sy * source.width + sx) * 4;
          if (source.data[i + 3]! < 128) continue;
          const [r, g, b] = [source.data[i]!, source.data[i + 1]!, source.data[i + 2]!];
          const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
          const bucket = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
          bucket.n += 1;
          bucket.r += r;
          bucket.g += g;
          bucket.b += b;
          buckets.set(key, bucket);
          opaque += 1;
        }
      }
      if (opaque / ((x1 - x0) * (y1 - y0)) < COVERAGE) continue;
      const colours = [...buckets.values()]
        .sort((a, b) => b.n - a.n)
        .map((bucket) => ({ n: bucket.n, color: (Math.round(bucket.r / bucket.n) << 16) | (Math.round(bucket.g / bucket.n) << 8) | Math.round(bucket.b / bucket.n) }));
      const main = colours[0]!;
      const detail = colours.find((each) => each.n >= DETAIL * opaque && contrast(each.color, main.color) >= 3);
      const chosen = (detail ?? main).color;
      const o = (y * width + x) * 4;
      out[o] = (chosen >> 16) & 255;
      out[o + 1] = (chosen >> 8) & 255;
      out[o + 2] = chosen & 255;
      out[o + 3] = 255;
    }
  }
  return { width, height: tall, data: out };
}

/** Under this contrast with its board, a logo is outlined. */
const OUTLINE_BELOW = 1.6;

/** The average colour of the opaque pixels (0xRRGGBB). */
export function averageColor(pixels: Pixels): number {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < pixels.data.length; i += 4) {
    if (pixels.data[i + 3]! < 128) continue;
    r += pixels.data[i]!;
    g += pixels.data[i + 1]!;
    b += pixels.data[i + 2]!;
    n += 1;
  }
  return n === 0 ? 0 : (Math.round(r / n) << 16) | (Math.round(g / n) << 8) | Math.round(b / n);
}

/** The face columns of a board, left to right: screen x (art pixels, from the anchor), top row and height. */
export type FaceColumn = { x: number; top: number; h: number };

export function faceColumns(set: SignSet, segments: number): FaceColumn[] {
  const out: FaceColumn[] = [];
  const add = (part: SignSet["left"], shift: number) => {
    part.face.cols.forEach((col, i) => {
      if (col) out.push({ x: part.face.x + i + shift * set.period[0], top: col[0] + shift * set.period[1], h: col[1] });
    });
  };
  add(set.left, 0);
  for (let k = 0; k < segments - 1; k += 1) add(set.middle, k);
  add(set.right, segments - 1);
  return out;
}

/**
 * The face of a board as a pixel buffer over its columns (`width` columns
 * from the first face column, rows from the highest top): the logo then the
 * name, drawn on the face's own stairs (each column at its own top), one
 * glyph pixel a GLYPH_SCALE square. A logo whose colours are close to the
 * board's (`board`) gets a one pixel outline in the ink. `left` and `top`
 * place the buffer from the board's anchor.
 */
export function paintFace(
  columns: FaceColumn[],
  plan: SignPlan,
  font: SignFont,
  ink: number,
  logo: Pixels | null,
  board: number = ink,
): { left: number; top: number; pixels: Pixels } | null {
  if (columns.length === 0) return null;
  const minTop = Math.min(...columns.map((col) => col.top));
  const maxBottom = Math.max(...columns.map((col) => col.top + col.h));
  const width = columns.length;
  const height = maxBottom - minTop;
  const data = new Uint8ClampedArray(width * height * 4);
  const put = (c: number, row: number, rgb: [number, number, number]) => {
    const col = columns[c];
    if (!col || row < 0 || row >= col.h) return;
    const y = col.top - minTop + row;
    const i = (y * width + c) * 4;
    [data[i], data[i + 1], data[i + 2], data[i + 3]] = [rgb[0], rgb[1], rgb[2], 255];
  };
  const face = columns[0]!.h;
  // Glyph pixels start on a column whose neighbour shares its top: each one is a clean square on the stairs.
  const pair = (c: number) => (columns[c] && columns[c + 1] && columns[c]!.top === columns[c + 1]!.top ? c : c + 1);
  const rgb: [number, number, number] = [(ink >> 16) & 255, (ink >> 8) & 255, ink & 255];
  let c = pair(plan.start);
  if (logo && plan.logoWidth > 0) {
    const row0 = Math.floor((face - logo.height) / 2);
    const opaque = (x: number, y: number) => x >= 0 && y >= 0 && x < logo.width && y < logo.height && logo.data[(y * logo.width + x) * 4 + 3]! >= 128;
    if (contrast(averageColor(logo), board) < OUTLINE_BELOW) {
      for (let x = -1; x <= logo.width; x += 1) {
        for (let y = -1; y <= logo.height; y += 1) {
          if (!opaque(x, y) && (opaque(x - 1, y) || opaque(x + 1, y) || opaque(x, y - 1) || opaque(x, y + 1))) put(c + x, row0 + y, rgb);
        }
      }
    }
    for (let x = 0; x < logo.width; x += 1) {
      for (let y = 0; y < logo.height; y += 1) {
        const i = (y * logo.width + x) * 4;
        if (logo.data[i + 3]! < 128) continue;
        put(c + x, row0 + y, [logo.data[i]!, logo.data[i + 1]!, logo.data[i + 2]!]);
      }
    }
    c = pair(c + logo.width + LOGO_GAP);
  }
  const row0 = Math.floor((face - font.height * GLYPH_SCALE) / 2);
  for (const char of plan.text) {
    const glyph = font.glyphs[char];
    if (!glyph) continue;
    glyph.forEach((line, gy) => {
      [...line].forEach((dot, gx) => {
        if (dot !== "#") return;
        for (let dx = 0; dx < GLYPH_SCALE; dx += 1) for (let dy = 0; dy < GLYPH_SCALE; dy += 1) put(c + gx * GLYPH_SCALE + dx, row0 + gy * GLYPH_SCALE + dy, rgb);
      });
    });
    c += ((glyph[0]?.length ?? 0) + font.spacing) * GLYPH_SCALE;
  }
  return { left: columns[0]!.x, top: minTop, pixels: { width, height, data } };
}
