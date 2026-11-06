import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { behind, buildFloorScene, characterBox, depthOrder, floorSetSchema, moverDepths, type Box, type ScreenRect } from "../src/ui/iso-floor";
import { layoutFloor } from "../src/ui/floor-plan";
import { officeOf, pointOnRoute, routeToUser, screenOf } from "../src/ui/room-layout";

// The depth order of a floor while characters walk: the walls and furniture
// keep one order in every frame (it used to be recomputed with the characters
// in it, and pieces swapped places for a frame as someone walked by), the
// characters are slotted in between; and the atlas a page loads is always the
// one its floor.json was built with.

const root = path.join(import.meta.dirname, "..");
const floorDir = path.join(root, "public", "iso", "floor");
const set = floorSetSchema.parse(JSON.parse(fs.readFileSync(path.join(floorDir, "floor.json"), "utf8")));

/** A character standing at (x, y) voxels: its footprint and what it covers on the screen (as the renderer does). */
const mover = (x: number, y: number): { box: Box; rect: ScreenRect } => {
  const feet = screenOf(x, y);
  return { box: characterBox(x, y), rect: { x0: feet.x - 24, y0: feet.y - 110, x1: feet.x + 24, y1: feet.y + 16 } };
};
const rectOf = (box: Box, height: number): ScreenRect => {
  const corners = [screenOf(box.x0, box.y0), screenOf(box.x1, box.y0), screenOf(box.x0, box.y1), screenOf(box.x1, box.y1)];
  return { x0: Math.min(...corners.map((p) => p.x)), x1: Math.max(...corners.map((p) => p.x)), y0: Math.min(...corners.map((p) => p.y)) - height, y1: Math.max(...corners.map((p) => p.y)) };
};

test("a character walking between two desks: the desks keep their order, the character stays between them in every frame", () => {
  const back = { x0: 0, y0: 0, x1: 64, y1: 16 };
  const front = { x0: 0, y0: 48, x1: 64, y1: 64 };
  const statics = [front, back].map((box) => ({ box, rect: rectOf(box, 60) }));
  const rank = (() => {
    const out: number[] = [];
    depthOrder(statics.map((item) => item.box)).forEach((index, z) => (out[index] = z));
    return out;
  })();
  assert.deepEqual(rank, [1, 0], "the back desk first");
  const depths: number[] = [];
  for (let x = 16; x <= 56; x += 1) {
    const [z] = moverDepths(statics, rank, [mover(x, 32)]);
    assert.ok(z! > rank[1]! && z! < rank[0]!, `between the desks at x = ${x}`);
    depths.push(z!);
  }
  assert.equal(new Set(depths).size, 1, "the same depth all along: nothing changes order as it walks");
  // In front of the front desk, it is drawn after it; behind the back desk, before it.
  assert.ok(moverDepths(statics, rank, [mover(32, 72)])[0]! > rank[0]!);
  assert.ok(moverDepths(statics, rank, [mover(32, -12)])[0]! < rank[1]!);
  // Two characters side by side get two distinct depths in the same slot, back one first.
  const [a, b] = moverDepths(statics, rank, [mover(40, 32), mover(24, 34)]);
  assert.ok(a! !== b! && Math.floor(a!) === Math.floor(b!));
});

test("on a real floor, a character walking to its desk's drop spot is always in front of what it stands in front of", () => {
  const keys = (room: string, n: number) => Array.from({ length: n }, (_, i) => `${room}/a${i}`);
  const layout = layoutFloor(
    [
      { name: "assistant", color: null, keys: keys("assistant", 6) },
      { name: "creation", color: null, keys: keys("creation", 6) },
      { name: "planygo", color: null, keys: keys("planygo", 9) },
    ],
    { reception: "assistant", receptionist: true },
  );
  const scene = buildFloorScene(set, layout, true);
  const statics = scene.sorted.map((item) => {
    const xs = item.draws.flatMap((d) => [d.x, d.x + set.atlas.frames[d.frame]![2]]);
    const ys = item.draws.flatMap((d) => [d.y, d.y + set.atlas.frames[d.frame]![3]]);
    return { box: item.box, rect: { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) } };
  });
  const rank: number[] = [];
  depthOrder(statics.map((item) => item.box)).forEach((index, z) => (rank[index] = z));
  for (const key of ["planygo/a3", "assistant/a2", "creation/a4"]) {
    const route = routeToUser(layout, officeOf(layout, key)!, null);
    for (let f = 0; f <= 100; f += 1) {
      const { point } = pointOnRoute(route, f / 100);
      const walker = mover(Math.round(point.x), Math.round(point.y));
      const [z] = moverDepths(statics, rank, [walker]);
      statics.forEach((item, index) => {
        const overlaps = item.rect.x0 < walker.rect.x1 && walker.rect.x0 < item.rect.x1 && item.rect.y0 < walker.rect.y1 && walker.rect.y0 < item.rect.y1;
        if (overlaps && behind(item.box, walker.box) && !behind(walker.box, item.box)) assert.ok(z! > rank[index]!, `${key} at ${f}%: in front of item ${index}`);
      });
    }
  }
});

test("floor.json names the atlas it was built with: the runtime loads floor.png?v=<hash>", () => {
  const png = fs.readFileSync(path.join(floorDir, set.atlas.file));
  assert.equal(set.atlas.hash, createHash("sha256").update(png).digest("hex").slice(0, 16));
});
