// The MyHQ iso palette: 32 colours, crafted for this project (not taken from
// lospec), arranged as hue-shifted ramps: shadows lean cool and purple,
// highlights lean warm and yellow. It is free to reuse with the repository
// licence. The pink ramp is built around #ff3d7f, the example room colour,
// so a room spine shows that exact colour on its lit face.
//
// A ramp lists palette names from darkest to lightest. Index 0 of every ramp
// is its outline tone. Ramps may share colours (paper borrows the inks).

export const COLORS = {
  ink0: "#1b1424", ink1: "#352a3f", ink2: "#574a62", ink3: "#857891",
  ink4: "#b8adb9", ink5: "#e9e1dc", ink6: "#fffaf0",
  wood0: "#3d2224", wood1: "#643528", wood2: "#8f5232", wood3: "#b8743f",
  wood4: "#d9a05e", wood5: "#f2cd8e",
  sage0: "#34483f", sage1: "#4f6b5a", sage2: "#6f8c76", sage3: "#98b394",
  leaf0: "#2a5a36", leaf1: "#3f8a3e", leaf2: "#74b84e", leaf3: "#b8dc6e",
  pink0: "#5c1838", pink1: "#b02a5c", pink2: "#ff3d7f", pink3: "#ff9cc0",
  blue0: "#1e2a55", blue1: "#2f5aa8", blue2: "#4f93e0", blue3: "#a6d0f7",
  gold1: "#d08a2c", gold2: "#f2c14e", gold3: "#fff0b8",
};

export const RAMPS = {
  ink: ["ink0", "ink1", "ink2", "ink3", "ink4", "ink5", "ink6"],
  paper: ["ink2", "ink3", "ink4", "ink5", "ink6"],
  wood: ["wood0", "wood1", "wood2", "wood3", "wood4", "wood5"],
  sage: ["sage0", "sage1", "sage2", "sage3", "ink5"],
  leaf: ["sage0", "leaf0", "leaf1", "leaf2", "leaf3"],
  pink: ["pink0", "pink1", "pink2", "pink3", "ink6"],
  blue: ["blue0", "blue1", "blue2", "blue3", "ink6"],
  gold: ["wood0", "wood2", "gold1", "gold2", "gold3"],
  sky: ["blue1", "blue2", "blue3", "ink6"],
};

/** Palette as an array of [r, g, b], with a name to index map. */
export const PALETTE = [];
export const INDEX = {};
for (const [name, hex] of Object.entries(COLORS)) {
  INDEX[name] = PALETTE.length;
  PALETTE.push([1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)));
}
if (PALETTE.length > 32) throw new Error(`palette has ${PALETTE.length} colours, the limit is 32`);

/** Ramps resolved to palette indices, with a numeric id per ramp. */
export const RAMP_NAMES = Object.keys(RAMPS);
export const RAMP_LIST = RAMP_NAMES.map((name) => RAMPS[name].map((colour) => {
  if (!(colour in INDEX)) throw new Error(`ramp ${name} uses unknown colour ${colour}`);
  return INDEX[colour];
}));
export const RAMP_ID = Object.fromEntries(RAMP_NAMES.map((name, id) => [name, id]));
