import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { badgeText, fitScale, hubSchema, NEUTRAL_SPINE, pastel, sceneObjects, stateOf, todayCell } from "../src/ui/hub-scene";
import type { Desk, DeskObject } from "../src/ui/schemas";

const object = (overrides: Partial<DeskObject> & Pick<DeskObject, "id" | "object">): DeskObject => ({
  label: overrides.id,
  source: "approvals",
  status: "ok",
  error: null,
  count: 0,
  items: [],
  slots: null,
  note: null,
  spines: null,
  updatedAt: "2026-11-04T10:00:00.000Z",
  ...overrides,
});

test("the hub of the repository matches the format the scene reads", () => {
  const file = path.join(process.cwd(), "public", "iso", "hub", "hub.json");
  const parsed = hubSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3)));
  for (const name of ["background", "atlas"] as const) {
    assert.ok(fs.existsSync(path.join(path.dirname(file), parsed.data[name].file)), parsed.data[name].file);
  }
  // State k of the pile has one spine mask per folder, in slots 0 to k - 1.
  for (const [key, state] of Object.entries(parsed.data.objects.pile.states)) {
    assert.deepEqual(state?.masks.map((mask) => mask.slot), Array.from({ length: Number(key) }, (_, index) => index), `pile ${key}`);
  }
});

test("a hub with a frame outside the atlas is refused", () => {
  const file = path.join(process.cwd(), "public", "iso", "hub", "hub.json");
  const hub = JSON.parse(fs.readFileSync(file, "utf8")) as { atlas: { frames: unknown[] } };
  hub.atlas.frames = hub.atlas.frames.slice(0, 10);
  assert.equal(hubSchema.safeParse(hub).success, false);
});

test("the states follow the counts, clamped to what the art draws", () => {
  assert.equal(stateOf("pile", object({ id: "a", object: "pile", count: 3 })), "3");
  assert.equal(stateOf("pile", object({ id: "a", object: "pile", count: 40 })), "14");
  assert.equal(stateOf("mail", object({ id: "a", object: "tray", count: 9 })), "5");
  assert.equal(stateOf("postits", object({ id: "a", object: "postits", count: 0 })), "0");
  assert.equal(stateOf("newspaper", object({ id: "a", object: "newspaper", count: 2 })), "present");
  assert.equal(stateOf("newspaper", object({ id: "a", object: "newspaper", count: 0 })), "absent");
  assert.equal(stateOf("phone", object({ id: "a", object: "phone", count: 1 })), "unread");
  assert.equal(stateOf("calendar", object({ id: "a", object: "calendar", count: 4 })), "default");
});

test("an object in error, or not configured, is drawn empty", () => {
  assert.equal(stateOf("mail", object({ id: "a", object: "tray", count: 3, status: "error" })), "0");
  assert.equal(stateOf("phone", null), "idle");
  assert.equal(stateOf("newspaper", null), "absent");
});

test("each folder of the pile takes the room colour of its pending item, in order, and a neutral grey without one", () => {
  const desk: Desk = {
    configError: null,
    objects: [
      object({
        id: "signer",
        object: "pile",
        count: 3,
        spines: [
          { approvalId: 1, room: "a", color: "#FF3D7F" },
          { approvalId: 2, room: "b", color: null },
          { approvalId: 3, room: "c", color: "#4f93e0" },
        ],
      }),
    ],
  };
  const pile = sceneObjects(desk).find((each) => each.name === "pile");
  assert.equal(pile?.state, "3");
  assert.deepEqual(pile?.tints, ["#ff3d7f", NEUTRAL_SPINE, "#4f93e0"]);
});

test("the scene has every object, the ones the home does not configure without an object", () => {
  const desk: Desk = { configError: null, objects: [object({ id: "courrier", object: "tray", count: 2 })] };
  const scene = sceneObjects(desk);
  assert.deepEqual(
    scene.map((each) => [each.name, each.object?.id ?? null, each.state]),
    [
      ["pile", null, "0"],
      ["mail", "courrier", "2"],
      ["postits", null, "0"],
      ["newspaper", null, "absent"],
      ["calendar", null, "default"],
      ["phone", null, "idle"],
    ],
  );
});

test("the calendar cell of a day counts from the Monday of the first week", () => {
  // November 2026 starts on a Sunday (cell 6): the 4th is cell 9.
  assert.equal(todayCell(new Date(2026, 10, 1)), 6);
  assert.equal(todayCell(new Date(2026, 10, 4)), 9);
  // June 2026 starts on a Monday.
  assert.equal(todayCell(new Date(2026, 5, 1)), 0);
  // A 31-day month starting on a Sunday (March 2026) ends on the last cell the art draws a mark for (36).
  assert.equal(todayCell(new Date(2026, 2, 31)), 36);
});

test("the badge shows the count, 99+ beyond, ! for an error, nothing for an empty or absent object", () => {
  assert.equal(badgeText(object({ id: "a", object: "pile", count: 7 })), "7");
  assert.equal(badgeText(object({ id: "a", object: "pile", count: 120 })), "99+");
  assert.equal(badgeText(object({ id: "a", object: "pile", count: 0 })), null);
  assert.equal(badgeText(object({ id: "a", object: "pile", status: "error" })), "!");
  assert.equal(badgeText(null), null);
});

test("pastel matches the build's: 55 % of the way to paper white", () => {
  assert.equal(pastel("#ff3d7f"), "#ffa5bd");
});

test("the scale is the largest integer that fits, in device pixels, never under 1", () => {
  const size = { w: 340, h: 322 };
  assert.equal(fitScale(size, { width: 1120 }, 1), 3);
  assert.equal(fitScale(size, { width: 1120, height: 700 }, 1), 2);
  assert.equal(fitScale(size, { width: 343 }, 3), 3);
  assert.equal(fitScale(size, { width: 300 }, 1), 1);
});
