import assert from "node:assert/strict";
import { test } from "node:test";
import { fitZoom, FLOOR_MIN_ZOOM, labelDetail, MAX_ZOOM, MIN_ZOOM, minZoomFor, nearestZoom, stepZoom, zoomLevels } from "../src/ui/floor-view";
import { layoutFloor } from "../src/ui/floor-plan";

// The zoom of the floor: the furthest level is the exact fit of the whole floor (a fraction), the levels between,
// and the text over the agents that goes when the floor is drawn too small for it.

const sevenRooms = () => {
  const rooms = Array.from({ length: 7 }, (_, i) => ({ name: `r${i}`, keys: [`r${i}/a`, `r${i}/b`, `r${i}/c`], color: null }));
  return layoutFloor(rooms, { reception: "r0", receptionist: true, owner: true });
};
const MARGIN = 20;

test("the furthest zoom fits the whole floor of seven rooms in a desktop canvas and a phone, with air around it", () => {
  const { bounds } = sevenRooms();
  for (const [width, height, ratio] of [
    [1100, 480, 1],
    [1100, 480, 2],
    [390, 520, 3],
    [390, 520, 2],
  ] as const) {
    const min = minZoomFor(fitZoom(bounds.w, bounds.h, MARGIN, width * ratio, height * ratio));
    assert.ok(min < MIN_ZOOM && min >= FLOOR_MIN_ZOOM, `${width}x${height}@${ratio}: ${min}`);
    // The floor, drawn at that zoom, is inside the canvas on both sides (in device pixels).
    assert.ok(bounds.w * min <= width * ratio, `${width}x${height}@${ratio} wide`);
    assert.ok(bounds.h * min <= height * ratio, `${width}x${height}@${ratio} high`);
  }
});

test("a floor that fits at one device pixel per art pixel or more keeps the whole steps it always had", () => {
  assert.equal(minZoomFor(3.2), MIN_ZOOM);
  assert.equal(minZoomFor(1), MIN_ZOOM);
  assert.deepEqual(zoomLevels(MIN_ZOOM, MAX_ZOOM), [1, 2, 3, 4, 5, 6]);
});

test("the furthest zoom never goes under the floor of the range, and a non finite fit falls back to one", () => {
  assert.equal(minZoomFor(0.02), FLOOR_MIN_ZOOM);
  assert.equal(minZoomFor(Number.NaN), MIN_ZOOM);
  assert.equal(minZoomFor(Number.POSITIVE_INFINITY), MIN_ZOOM);
});

test("the levels run from the exact fit, through a few fractions, to the whole steps", () => {
  assert.deepEqual(zoomLevels(0.42, 6), [0.42, 0.5, 0.75, 1, 2, 3, 4, 5, 6]);
  // A fraction a hair over the fit is not a level of its own.
  assert.deepEqual(zoomLevels(0.48, 6), [0.48, 0.75, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(zoomLevels(0.2, 3), [0.2, 0.25, 0.35, 0.5, 0.75, 1, 2, 3]);
  assert.deepEqual(zoomLevels(0.8, 2), [0.8, 1, 2]);
});

test("a step goes to the next level, from a level or from between two, and stops at both ends", () => {
  const levels = zoomLevels(0.42, 6);
  assert.equal(stepZoom(levels, 1, -1), 0.75);
  assert.equal(stepZoom(levels, 0.75, -1), 0.5);
  assert.equal(stepZoom(levels, 0.5, -1), 0.42);
  assert.equal(stepZoom(levels, 0.42, -1), 0.42);
  assert.equal(stepZoom(levels, 0.42, 1), 0.5);
  assert.equal(stepZoom(levels, 1, 1), 2);
  assert.equal(stepZoom(levels, 6, 1), 6);
  // A zoom between two levels (the canvas was resized under it) steps to the neighbours.
  assert.equal(stepZoom(levels, 0.6, 1), 0.75);
  assert.equal(stepZoom(levels, 0.6, -1), 0.5);
  assert.equal(stepZoom(levels, 3, 0), 3);
});

test("a zoom in flight is drawn at the nearest level on a log scale", () => {
  const levels = zoomLevels(0.42, 6);
  assert.equal(nearestZoom(levels, 0.45), 0.42);
  assert.equal(nearestZoom(levels, 0.6), 0.5);
  assert.equal(nearestZoom(levels, 0.9), 1);
  assert.equal(nearestZoom(levels, 1.4), 1);
  assert.equal(nearestZoom(levels, 1.5), 2);
  assert.equal(nearestZoom(levels, 99), 6);
});

test("from one device pixel per art pixel up, every label stays; under it the wide bubbles go first, then the names", () => {
  // The old range, whatever the screen density: nothing changes.
  assert.deepEqual(labelDetail(1, 0.33), { bubbles: true, names: true });
  assert.deepEqual(labelDetail(3, 1), { bubbles: true, names: true });
  // A far level on a 1x screen: names stay a while after the bubbles.
  assert.deepEqual(labelDetail(0.75, 0.75), { bubbles: true, names: true });
  assert.deepEqual(labelDetail(0.5, 0.5), { bubbles: false, names: true });
  assert.deepEqual(labelDetail(0.42, 0.42), { bubbles: false, names: false });
  // The same levels on a 3x phone are far smaller on screen: both go.
  assert.deepEqual(labelDetail(0.75, 0.25), { bubbles: false, names: false });
});
