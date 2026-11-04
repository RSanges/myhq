// Builds every iso asset of MyHQ, or one group.
//
//   node scripts/iso/build.mjs [hub|floor|characters|mock]...
//
// hub: public/iso/hub/; floor: public/iso/floor/; characters:
// public/sprites/iso-*.png; mock: a composed floor with two rooms and
// characters (public/iso/floor/mock-floor*.png), to check scale and depth.
// Deterministic: same code, same bytes. See README.md for the formats.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCharacters, writeCharacters } from "./build-characters.mjs";
import { buildFloor, writeFloor } from "./build-floor.mjs";
import { composeFloor } from "./compose.mjs";
import { upscale, writePng } from "./image.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const groups = process.argv.slice(2);
const want = (g) => groups.length === 0 || groups.includes(g);

if (want("hub")) {
  const { buildHub } = await import("./build-hub.mjs");
  buildHub();
}
const floor = want("floor") || want("mock") ? buildFloor() : null;
if (want("floor")) writeFloor(floor);
const characters = want("characters") || want("mock") ? buildCharacters() : null;
if (want("characters")) writeCharacters(characters);

if (want("mock")) {
  const sheet = (id) => characters.find((c) => c.id === id).sheet;
  const img = composeFloor(floor, mockScene(sheet));
  const out = path.join(HERE, "..", "..", "public", "iso", "floor");
  writePng(path.join(out, "mock-floor.png"), img);
  writePng(path.join(out, "mock-floor@3x.png"), upscale(img, 3));
  console.log(`mock floor ${img.w}x${img.h}`);
}

/**
 * Two cutaway rooms, the second one further back so that its full height
 * back wall does not hide the first one: a team room (wood, example colour pink)
 * with two people typing, and a lounge with the reception (room carpet,
 * example colour blue).
 */
function mockScene(sheet) {
  const rooms = [
    { x: 0, y: 0, w: 6, d: 5, tile: "wood", colour: "#ff3d7f", back: { y: ["plain", "window", "plain", "plain", "window", "plain"], x: ["plain", "plain", "door", "plain", "plain"] }, gaps: { y: [2] } },
    { x: 7, y: -5, w: 6, d: 5, tile: "carpet-room", colour: "#4f93e0", back: { y: ["plain", "window", "plain", "window", "plain", "plain"], x: ["plain", "plain", "door", "plain", "plain"] }, gaps: { y: [3] } },
  ];
  const pieces = [
    { name: "workstation", turn: 0, cell: [0, 0] },
    { name: "desk-chair", turn: 0, cell: [0, 1] },
    { name: "workstation", turn: 0, cell: [3, 0] },
    { name: "desk-chair", turn: 0, cell: [3, 1] },
    { name: "plant-tall", turn: 0, cell: [5, 0] },
    { name: "bookshelf", turn: 1, cell: [0, 2] },
    { name: "rug", turn: 0, cell: [2, 2] },
    { name: "whiteboard", turn: 1, cell: [5, 2] },
    { name: "filing-cabinet", turn: 0, cell: [2, 0] },
    { name: "coffee-corner", turn: 0, cell: [7, -5], room: 1 },
    { name: "water-cooler", turn: 0, cell: [9, -5], room: 1 },
    { name: "printer", turn: 1, cell: [7, -3], room: 1 },
    { name: "reception-counter", turn: 0, cell: [9, -3], room: 1 },
    { name: "sofa", turn: 1, cell: [12, -4], room: 1 },
    { name: "plant-small", turn: 0, cell: [12, -5], room: 1 },
    { name: "plant-small", turn: 0, cell: [7, -1], room: 1 },
  ];
  const characters = [
    { sheet: sheet("person-blue"), animation: "type", frame: 0, chair: 1 },
    { sheet: sheet("person-green"), animation: "type", frame: 2, chair: 3 },
    { sheet: sheet("person-mustard"), direction: "SW", animation: "walk", frame: 2, at: [56, 52] },
    { sheet: sheet("person-grey"), direction: "SE", animation: "idle", frame: 0, at: [28, 60] },
    { sheet: sheet("receptionist"), direction: "SW", animation: "idle", frame: 0, at: [168, -56] },
    { sheet: sheet("person-blue"), direction: "NW", animation: "walk", frame: 5, at: [176, -14] },
  ];
  return { rooms, pieces, characters };
}
