// Builds the generic iso characters into public/sprites/: a neutral person
// in a few colour variants and the receptionist, one sheet each in the
// format of character.mjs, plus iso-characters.json. See README.md.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ANIMATIONS, DIRECTIONS, FRAME, frameOf, human, renderSheet, sheetFormat } from "./character.mjs";
import { blit, colour, contactSheet, filled, upscale, writePng } from "./image.mjs";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "public", "sprites");

const SKIN = {
  light: { ramp: "wood", top: 5, left: 5, right: 4 },
  medium: { ramp: "wood", top: 5, left: 4, right: 3 },
  dark: { ramp: "wood", top: 3, left: 2, right: 1 },
};
const HAIR = {
  black: { ramp: "ink", top: 2, left: 1, right: 0 },
  brown: { ramp: "wood", top: 2, left: 1, right: 1 },
  blond: { ramp: "wood", top: 5, left: 4, right: 3 },
  grey: { ramp: "ink", top: 5, left: 4, right: 3 },
};
const CLOTH = (ramp, top = 3, left = 2, right = 1) => ({ ramp, top, left, right });
const TRIM = { ramp: "paper", top: 4, left: 4, right: 3 };

/** The generic characters: file name, look. */
export const CHARACTERS = [
  { id: "person-blue", look: { skin: SKIN.light, hair: HAIR.brown, top: CLOTH("blue"), trim: TRIM, bottom: CLOTH("ink", 2, 2, 1), hairStyle: "short" } },
  { id: "person-green", look: { skin: SKIN.dark, hair: HAIR.black, top: CLOTH("leaf", 3, 2, 1), trim: TRIM, bottom: CLOTH("blue", 1, 1, 0), hairStyle: "short" } },
  { id: "person-mustard", look: { skin: SKIN.medium, hair: HAIR.black, top: CLOTH("gold", 3, 2, 1), trim: TRIM, bottom: CLOTH("ink", 2, 2, 1), hairStyle: "bun" } },
  { id: "person-grey", look: { skin: SKIN.light, hair: HAIR.blond, top: CLOTH("ink", 4, 3, 2), trim: CLOTH("blue"), bottom: CLOTH("blue", 1, 1, 0), hairStyle: "long" } },
  {
    id: "receptionist",
    look: { skin: SKIN.medium, hair: HAIR.brown, top: CLOTH("pink", 3, 2, 1), trim: TRIM, bottom: CLOTH("ink", 2, 2, 1), hairStyle: "bun", headset: true, extra: CLOTH("ink", 2, 2, 1) },
  },
];

export function buildCharacters() {
  return CHARACTERS.map((c) => ({ ...c, sheet: renderSheet(human(c.look)) }));
}

/** A preview of a few frames of each sheet: every direction of every animation, first frame. */
export function previewSheets(sheets) {
  const items = [];
  for (const { id, sheet } of sheets) {
    for (const dir of DIRECTIONS) {
      for (const anim of ANIMATIONS) {
        const f = anim.name === "walk" ? 2 : 0;
        items.push({ name: `${id.replace("person-", "")} ${dir.name} ${anim.name}`.slice(0, 24), img: frameOf(sheet, dir.name, anim.name, f) });
      }
    }
  }
  return contactSheet(items, { maxW: 1000, gap: 4 });
}

export function writeCharacters(sheets) {
  for (const { id, sheet } of sheets) writePng(path.join(OUT, `iso-${id}.png`), sheet);
  const json = { version: 1, format: sheetFormat(), walk: { voxelsPerFrame: 3 }, sheets: sheets.map(({ id }) => ({ id, file: `iso-${id}.png` })) };
  writeFileSync(path.join(OUT, "iso-characters.json"), JSON.stringify(json, null, 1) + "\n");
  const preview = previewSheets(sheets);
  writePng(path.join(OUT, "..", "iso", "characters-preview.png"), preview);
  // Walk cycle strip of the first sheet at 3x, to check the motion.
  const strip = filled(FRAME.w * 8, FRAME.h * 2, colour("ink5"));
  for (let f = 0; f < 8; f++) {
    blit(strip, frameOf(sheets[0].sheet, "SW", "walk", f), f * FRAME.w, 0);
    blit(strip, frameOf(sheets[0].sheet, "NE", "walk", f), f * FRAME.w, FRAME.h);
  }
  writePng(path.join(OUT, "..", "iso", "characters-walk@3x.png"), upscale(strip, 3));
  console.log(`characters: ${sheets.length} sheets of ${FRAME.w}x${FRAME.h} frames`);
}

if (process.argv[1]?.endsWith("build-characters.mjs")) writeCharacters(buildCharacters());
