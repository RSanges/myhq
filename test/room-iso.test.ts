import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  behind,
  buildFloorScene,
  depthOrder,
  floorSetSchema,
  hiddenByWalls,
  neutralPersonFor,
  NEUTRAL_PEOPLE,
  pastel,
  sheetRow,
  turnOf,
} from "../src/ui/iso-floor";
import { FLOOR_TEMPLATES } from "../src/ui/floor-templates";
import {
  CELL,
  layoutRoom,
  routeToOffice,
  routeToUser,
  type Point,
  type RoomLayout,
} from "../src/ui/room-layout";
import { RECEPTION_KEY } from "../src/ui/reception";

const root = path.join(import.meta.dirname, "..");
const floorSet = floorSetSchema.parse(JSON.parse(fs.readFileSync(path.join(root, "public", "iso", "floor", "floor.json"), "utf8")));

const keys = (count: number) => Array.from({ length: count }, (_, i) => `r/a${i}`);
const layouts = (): RoomLayout[] =>
  [1, 3, 4, 6, 7, 9, 12].flatMap((count) => [layoutRoom(keys(count)), layoutRoom(keys(count), { reception: true })]);

/** Cells covered by a non-flat piece of furniture. */
function occupied(layout: RoomLayout): Set<string> {
  const cells = new Set<string>();
  for (const piece of layout.pieces) {
    const turn = turnOf(floorSet, piece.name, piece.turn);
    if (turn.flat) continue;
    for (let i = 0; i < turn.cells[0]; i += 1) for (let j = 0; j < turn.cells[1]; j += 1) cells.add(`${piece.cell[0] + i},${piece.cell[1] + j}`);
  }
  return cells;
}

const cellOf = (p: Point) => `${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)}`;

/** Points every half cell along a route. */
function samples(route: Point[]): Point[] {
  const out: Point[] = [route[0]!];
  for (let i = 1; i < route.length; i += 1) {
    const a = route[i - 1]!;
    const b = route[i]!;
    const steps = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / (CELL / 2)));
    for (let s = 1; s <= steps; s += 1) out.push({ x: a.x + ((b.x - a.x) * s) / steps, y: a.y + ((b.y - a.y) * s) / steps });
  }
  return out;
}

/** Whether a segment crosses the boundary of a room anywhere but through one of its openings. */
function crossesWall(layout: RoomLayout, a: Point, b: Point): boolean {
  const inside = (p: Point, room: RoomLayout["rooms"][number]) =>
    p.x > room.x * CELL && p.x < (room.x + room.w) * CELL && p.y > room.y * CELL && p.y < (room.y + room.d) * CELL;
  for (const room of layout.rooms) {
    if (inside(a, room) === inside(b, room)) continue;
    // Leaving or entering: only through an opening of the front rim, along the axis.
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const ix = Math.floor(mid.x / CELL) - room.x;
    const iy = Math.floor(mid.y / CELL) - room.y;
    const throughFrontY = Math.abs(a.x - b.x) < 0.01 && room.open.y.includes(ix) && Math.max(a.y, b.y) >= (room.y + room.d) * CELL;
    const throughFrontX = Math.abs(a.y - b.y) < 0.01 && room.open.x.includes(iy) && Math.max(a.x, b.x) >= (room.x + room.w) * CELL;
    if (!throughFrontY && !throughFrontX) return true;
  }
  return false;
}

function checkRoute(layout: RoomLayout, route: Point[], label: string) {
  const blocked = occupied(layout);
  for (let i = 1; i < route.length; i += 1) {
    const a = route[i - 1]!;
    const b = route[i]!;
    assert.ok(Math.abs(a.x - b.x) < 0.01 || Math.abs(a.y - b.y) < 0.01, `${label}: axis-aligned`);
    assert.ok(!crossesWall(layout, a, b), `${label}: through a wall near ${cellOf(b)}`);
  }
  // The first point is the seat (in a chair); everything after walks on free cells, seen from the viewer.
  for (const point of samples(route).slice(2)) {
    assert.ok(!blocked.has(cellOf(point)), `${label}: through furniture at ${cellOf(point)}`);
    assert.ok(!hiddenByWalls(layout, point.x, point.y), `${label}: behind a wall at ${cellOf(point)}`);
  }
}

test("the floor set parses and has every piece the templates use", () => {
  for (const template of Object.values(FLOOR_TEMPLATES)) {
    for (const room of template.rooms) {
      for (const piece of room.pieces) assert.ok(turnOf(floorSet, piece.name, piece.turn), `${piece.name} ${piece.turn}`);
    }
  }
  for (const name of ["workstation", "desk-chair", "filing-cabinet", "reception-counter"]) assert.ok(floorSet.furniture[name], name);
});

test("no room hides another: every cell of a room and of the hall is in front of the other rooms' back walls", () => {
  for (const layout of layouts()) {
    for (const room of layout.rooms) {
      for (let cx = room.x; cx < room.x + room.w; cx += 1) {
        for (let cy = room.y; cy < room.y + room.d; cy += 1) {
          for (const [fx, fy] of [
            [0.5, 0.5],
            [0.1, 0.1],
            [0.9, 0.9],
            [0.1, 0.9],
            [0.9, 0.1],
          ] as const) {
            assert.ok(!hiddenByWalls(layout, (cx + fx) * CELL, (cy + fy) * CELL), `${layout.template}: ${room.kind} at ${cx},${cy} is hidden`);
          }
        }
      }
    }
  }
});

test("rooms do not overlap, pieces stay inside their room and never share a cell", () => {
  for (const layout of layouts()) {
    const cells = new Map<string, string>();
    layout.rooms.forEach((room, index) => {
      for (let cx = room.x; cx < room.x + room.w; cx += 1) {
        for (let cy = room.y; cy < room.y + room.d; cy += 1) {
          const id = `${cx},${cy}`;
          assert.ok(!cells.has(id), `${layout.template}: rooms overlap at ${id}`);
          cells.set(id, String(index));
        }
      }
    });
    const taken = new Map<string, string>();
    for (const piece of layout.pieces) {
      const turn = turnOf(floorSet, piece.name, piece.turn);
      if (turn.flat) continue;
      for (let i = 0; i < turn.cells[0]; i += 1) {
        for (let j = 0; j < turn.cells[1]; j += 1) {
          const id = `${piece.cell[0] + i},${piece.cell[1] + j}`;
          assert.equal(cells.get(id), String(piece.room), `${layout.template}: ${piece.name} at ${id} outside its room`);
          assert.ok(!taken.has(id), `${layout.template}: ${piece.name} and ${taken.get(id)} share ${id}`);
          taken.set(id, piece.name);
        }
      }
    }
  }
});

test("routes walk the aisles and lanes only: axis-aligned, through openings, around furniture, never behind a wall", () => {
  for (const layout of layouts()) {
    const spots = [...layout.offices, ...(layout.reception ? [layout.reception.office] : [])];
    for (const office of spots) {
      checkRoute(layout, routeToUser(layout, office), `${layout.template}: ${office.key} to the tray`);
      for (const other of spots) {
        if (other !== office) checkRoute(layout, routeToOffice(layout, office, other), `${layout.template}: ${office.key} to ${other.key}`);
      }
    }
  }
});

test("a template by size, agents in the desks in order, the counter on request only", () => {
  const expected = (count: number) => (count <= 3 ? "small" : count <= 6 ? "medium" : "large");
  for (let count = 1; count <= 12; count += 1) {
    const layout = layoutRoom(keys(count));
    assert.equal(layout.template, expected(count));
    assert.equal(layout.offices.length, count);
    assert.equal(new Set(layout.offices.map((o) => `${o.seat.x},${o.seat.y}`)).size, count, "no two agents share a chair");
    for (const office of layout.offices) assert.equal(layout.pieces[office.chair!]!.name, "desk-chair");
    assert.equal(layout.reception, null);
    assert.ok(layout.board !== null, "a whiteboard");
    assert.ok(layout.coffee !== null, "a coffee corner");
    assert.ok(layout.bounds.w > layout.bounds.h, "a floor wider than tall");
  }
  const withDesk = layoutRoom(keys(2), { reception: true });
  assert.equal(withDesk.reception?.office.key, RECEPTION_KEY);
  assert.equal(withDesk.reception?.office.chair, null, "the receptionist stands behind the counter");
  assert.equal(withDesk.pieces[withDesk.reception!.counter]!.name, "reception-counter");
  assert.ok(layoutRoom(keys(1)).rooms.some((room) => room.kind === "office" && !room.vacant));
  assert.equal(layoutRoom(keys(13)).offices.length, 12, "agents beyond the desks have no office");
});

test("the scene: tiles first in depth order, walls and furniture sorted, masks tinted", () => {
  const layout = layoutRoom(keys(9), { reception: true });
  const scene = buildFloorScene(floorSet, layout, true);
  const cells = layout.hall.length + layout.rooms.reduce((total, room) => total + room.w * room.d, 0);
  assert.ok(scene.flat.length >= cells, "a tile per cell");
  assert.ok(scene.flat.some((draw) => draw.tint === "pastel"), "room carpets take the pastel of the colour");
  assert.ok(scene.sorted.some((item) => item.draws.some((draw) => draw.tint === "room")), "sofas and the counter take the colour");
  assert.ok(buildFloorScene(floorSet, layout, false).flat.every((draw) => draw.tint !== "pastel"), "no colour: neutral carpet and tiles");
  for (const draw of [...scene.flat, ...scene.sorted.flatMap((item) => item.draws)]) {
    assert.ok(Number.isInteger(draw.x) && Number.isInteger(draw.y), "whole pixels");
    assert.ok(draw.frame < floorSet.atlas.frames.length);
  }
});

test("depth order: a box that ends before another on x or y is drawn first", () => {
  const desk = { x0: 0, y0: 0, x1: 32, y1: 16 };
  const chair = { x0: 0, y0: 16, x1: 16, y1: 32 };
  const walker = { x0: 20, y0: 36, x1: 28, y1: 44 };
  const behindWall = { x0: 0, y0: -4, x1: 16, y1: 0 };
  assert.ok(behind(desk, chair) && !behind(chair, desk));
  assert.deepEqual(depthOrder([walker, chair, desk, behindWall]), [3, 2, 1, 0]);
});

test("sheets: rows by direction and animation, a neutral person per agent, the pastel of a colour", () => {
  assert.equal(sheetRow("NE", "idle"), 0);
  assert.equal(sheetRow("SE", "walk"), 4);
  assert.equal(sheetRow("NW", "type"), 11);
  assert.equal(neutralPersonFor("r/a"), neutralPersonFor("r/a"));
  assert.ok(new Set(keys(12).map(neutralPersonFor)).size > 1, "not everybody looks the same");
  for (const sheet of NEUTRAL_PEOPLE) assert.ok(fs.existsSync(path.join(root, "public", sheet)), sheet);
  assert.equal(pastel(0xff3d7f), 0xffa5bd);
});
