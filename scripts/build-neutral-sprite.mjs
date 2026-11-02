// Draws the neutral character sheet shipped with MyHQ: public/sprites/neutral.png.
//
// Run by hand when the drawing changes (`node scripts/build-neutral-sprite.mjs`);
// the PNG is committed, so a clone never needs to run it. It uses `sharp`,
// which Next.js installs for image optimization: it is a build tool of this
// script only, not a dependency of MyHQ.
//
// The sheet follows the contract of docs/home-layout.md: 4 columns by 4 rows
// of 128 px cells, rows = sit and type (2 frames), walk (4), think (2), sleep
// (2), character facing right, feet at the horizontal center of the bottom of
// the cell. The body is near white so the room view can tint it per agent
// (multiply); the outline, hair and shoes are darker and keep their value.
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const CELL = 128;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "sprites", "neutral.png");

const BODY = "#f6f6f6";
const LIMB = "#e2e2e2";
const HAIR = "#c4c4c4";
const SHOE = "#a6a6a6";
const LINE = "#4a4a4a";

const n = (value) => Math.round(value * 10) / 10;

/** A thick limb: an outline stroke under a lighter one, round caps. */
function limb(x1, y1, x2, y2, width, fill = LIMB) {
  const d = `M${n(x1)} ${n(y1)}L${n(x2)} ${n(y2)}`;
  return (
    `<path d="${d}" stroke="${LINE}" stroke-width="${width + 3.5}" stroke-linecap="round" fill="none"/>` +
    `<path d="${d}" stroke="${fill}" stroke-width="${width}" stroke-linecap="round" fill="none"/>`
  );
}

/** Two-segment limb through a joint. */
function bent(x1, y1, jx, jy, x2, y2, width, fill = LIMB) {
  const d = `M${n(x1)} ${n(y1)}L${n(jx)} ${n(jy)}L${n(x2)} ${n(y2)}`;
  return (
    `<path d="${d}" stroke="${LINE}" stroke-width="${width + 3.5}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>` +
    `<path d="${d}" stroke="${fill}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`
  );
}

const shoe = (x, y) =>
  `<ellipse cx="${n(x)}" cy="${n(y)}" rx="9" ry="4.5" fill="${SHOE}" stroke="${LINE}" stroke-width="2.5"/>`;

function torso(x, top, bottom, lean = 0) {
  const w = 17;
  const d =
    `M${n(x - w + lean)} ${top + 6}Q${n(x - w + lean)} ${top} ${n(x - w + 8 + lean)} ${top}` +
    `H${n(x + w - 8 + lean)}Q${n(x + w + lean)} ${top} ${n(x + w + lean)} ${top + 6}` +
    `V${bottom - 6}Q${n(x + w)} ${bottom} ${n(x + w - 8)} ${bottom}H${n(x - w + 8)}Q${n(x - w)} ${bottom} ${n(x - w)} ${bottom - 6}Z`;
  return `<path d="${d}" fill="${BODY}" stroke="${LINE}" stroke-width="3" stroke-linejoin="round"/>`;
}

/** The head faces right: hair on the back and top, one eye and a small nose to the front. */
function head(cx, cy, { tilt = 0, asleep = false } = {}) {
  const eye = asleep
    ? `<path d="M${cx + 5} ${cy + 1}q4 3 8 0" stroke="${LINE}" stroke-width="2.4" fill="none" stroke-linecap="round"/>`
    : `<circle cx="${cx + 9}" cy="${cy + 0.5}" r="2.6" fill="${LINE}"/>`;
  return (
    `<g transform="rotate(${tilt} ${cx} ${cy + 14})">` +
    `<circle cx="${cx}" cy="${cy}" r="17" fill="${BODY}" stroke="${LINE}" stroke-width="3"/>` +
    `<path d="M${cx - 17} ${cy}A17 17 0 0 1 ${cx + 12} ${cy - 12}Q${cx - 2} ${cy - 5} ${cx - 17} ${cy + 4}Z" fill="${HAIR}" stroke="${LINE}" stroke-width="3" stroke-linejoin="round"/>` +
    eye +
    `<path d="M${cx + 16} ${cy + 3}l4 3h-4" stroke="${LINE}" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>` +
    `</g>`
  );
}

// ---- Row 0: seated, typing -------------------------------------------------

function typing(frame) {
  const up = frame === 0;
  return (
    // thighs forward, shins down
    bent(58, 100, 84, 100, 86, 119, 9, "#d4d4d4") +
    shoe(90, 120) +
    torso(62, 62, 102, 0) +
    head(66, 44) +
    // arms forward to the keyboard: one hand up, the other down, then swapped
    bent(62, 72, 74, 90, up ? 96 : 100, up ? 98 : 90, 8, "#d4d4d4") +
    bent(68, 72, 82, 82, up ? 100 : 96, up ? 84 : 94, 8)
  );
}

// ---- Row 1: walking ----------------------------------------------------------

function walking(frame) {
  const bob = frame % 2 === 0 ? 0 : -2;
  // legs: [back foot x, front foot x, lift]
  const poses = [
    { back: [58, 120], front: [70, 120], armBack: [58, 94], armFront: [72, 94] },
    { back: [46, 119], front: [82, 120], armBack: [76, 90], armFront: [50, 92] },
    { back: [60, 120], front: [68, 117], armBack: [58, 94], armFront: [72, 94] },
    { back: [82, 120], front: [46, 119], armBack: [50, 92], armFront: [76, 90] },
  ][frame];
  return (
    `<g transform="translate(0 ${bob})">` +
    limb(60, 96, poses.back[0], poses.back[1] - bob - 4, 10, "#d4d4d4") +
    shoe(poses.back[0] + 3, poses.back[1] - bob) +
    limb(poses.armBack[0] - (frame === 0 || frame === 2 ? 4 : 0), 92, poses.armBack[0], poses.armBack[1] - 4, 8, "#d4d4d4") +
    torso(64, 58, 100) +
    limb(68, 96, poses.front[0], poses.front[1] - bob - 4, 10) +
    shoe(poses.front[0] + 3, poses.front[1] - bob) +
    head(66, 40) +
    limb(66, 70, poses.armFront[0], poses.armFront[1] - 4, 8) +
    `</g>`
  );
}

// ---- Row 2: thinking -----------------------------------------------------------

function thinking(frame) {
  const sway = frame === 0 ? 0 : 1.5;
  return (
    `<g transform="translate(${sway} 0)">` +
    limb(60, 96, 58, 117, 10, "#d4d4d4") +
    shoe(61, 120) +
    limb(68, 96, 70, 117, 10) +
    shoe(73, 120) +
    // the other arm folded across
    bent(60, 72, 52, 86, 70, 90, 8, "#d4d4d4") +
    torso(64, 58, 100) +
    head(66, 40, { tilt: frame === 0 ? 4 : 7 }) +
    // the hand rests on the chin
    bent(70, 70, 82, 78, 76, 56 - frame * 1.5, 8)
    + `</g>`
  );
}

// ---- Row 3: asleep ------------------------------------------------------------

function sleeping(frame) {
  const breathe = frame === 0 ? 0 : 1.6;
  return (
    bent(54, 104, 82, 104, 84, 119, 9, "#d4d4d4") +
    shoe(90, 120) +
    `<g transform="translate(0 ${breathe})">` +
    torso(66, 70, 106, 8) +
    // arms folded forward, the head rests on them
    bent(70, 86, 92, 92, 100, 100, 8) +
    head(80, 66 + breathe * 0.5, { tilt: 24, asleep: true }) +
    `</g>`
  );
}

const rows = [
  [typing(0), typing(1)],
  [walking(0), walking(1), walking(2), walking(3)],
  [thinking(0), thinking(1)],
  [sleeping(0), sleeping(1)],
];

const cells = rows
  .flatMap((frames, row) =>
    frames.map((content, col) => `<g transform="translate(${col * CELL} ${row * CELL})">${content}</g>`),
  )
  .join("");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CELL * 4}" height="${CELL * 4}" viewBox="0 0 ${CELL * 4} ${CELL * 4}">${cells}</svg>`;

await sharp(Buffer.from(svg), { density: 72 }).png({ compressionLevel: 9 }).toFile(OUT);
console.log(`Wrote ${path.relative(process.cwd(), OUT)}`);
