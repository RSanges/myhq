import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { getDbAt } from "../src/server/db";
import { HqError } from "../src/server/errors";
import { getState } from "../src/server/feed";
import { readFloorLayout, readFloorOwner } from "../src/server/home-settings";
import { loadHome } from "../src/server/rooms";
import { spriteResponse, SPRITE_MAX_BYTES } from "../src/server/sprites";
import { layoutFloor, OFFICE_SEAT } from "../src/ui/floor-plan";
import { floorSetSchema } from "../src/ui/iso-floor";
import { OWNER_AGENT, OWNER_KEY, RECEPTION_ROOM } from "../src/ui/reception";
import { CELL, OFFICE_CHAIR, officeOf, screenOf } from "../src/ui/room-layout";
import { applyInput, ASLEEP_AFTER_MS, createRoomModel, FLOOR_MODEL, snapshotRoom, type AgentSeed, type RoomInput } from "../src/ui/room-model";
import { makeHome } from "./helpers";

// The owner of the floor (myhq.json `floor.owner`): seated in the chair of the
// user's own office of the single floor, typing while a turn of the chat is in
// progress, served their own sheet from the validated setting only.

const root = path.join(import.meta.dirname, "..");
const T0 = Date.parse("2026-11-08T09:00:00.000Z");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("sheet")]);

function homeWith(myhq: unknown, files: Record<string, Buffer | string> = {}) {
  const config = makeHome();
  fs.writeFileSync(path.join(config.home, "myhq.json"), JSON.stringify(myhq));
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(config.home, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return config;
}

const ownerSheet = (config: ReturnType<typeof makeHome>) =>
  spriteResponse(new Request(`http://localhost/api/sprites/${RECEPTION_ROOM}/${OWNER_AGENT}?sheet=iso`), config, RECEPTION_ROOM, OWNER_AGENT, "iso");

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof HqError ? error.code : String(error);
  }
  return undefined;
};

test("floor.owner of myhq.json: a name and a sheet of the home, read apart from floor.layout", () => {
  const ok = homeWith({ floor: { layout: "room-per-project", owner: { name: "Ada", isoSprite: "me/iso-ada.png" } } });
  const read = readFloorOwner(ok.home);
  assert.deepEqual(read, { owner: { name: "Ada", isoSprite: path.resolve(ok.home, "me/iso-ada.png") }, error: null });
  assert.deepEqual(readFloorLayout(ok.home), { layout: "room-per-project", error: null }, "the owner does not change the layout");
  assert.deepEqual(readFloorOwner(homeWith({ floor: { owner: { name: "Ada" } } }).home).owner, { name: "Ada", isoSprite: null });
  assert.deepEqual(readFloorOwner(homeWith({ floor: { layout: "room-per-project" } }).home), { owner: null, error: null });

  for (const owner of [{ name: "" }, { name: "Ada", isoSprite: "/abs/ada.png" }, { name: "Ada", isoSprite: "ada.gif" }, { name: "Ada", extra: 1 }]) {
    const bad = homeWith({ floor: { layout: "room-per-project", owner } });
    const { owner: none, error } = readFloorOwner(bad.home);
    assert.equal(none, null);
    assert.match(error ?? "", /floor\.owner/);
    assert.equal(readFloorLayout(bad.home).layout, "room-per-project", "a wrong owner leaves the layout as it is");
  }
});

test("the owner's sheet is served from the setting only, inside the home, under the size limit; the state gives its URL", async () => {
  const config = homeWith({ floor: { layout: "room-per-project", owner: { name: "Ada", isoSprite: "me/iso-ada.png" } } }, { "me/iso-ada.png": PNG });
  const response = ownerSheet(config);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
  const state = getState(getDbAt(config.dbPath), loadHome(config.home), { enabled: false, running: false, timeZone: "Europe/Paris" });
  assert.deepEqual(state.floor.owner, { name: "Ada", isoSprite: `/api/sprites/${RECEPTION_ROOM}/${OWNER_AGENT}?sheet=iso` });

  // No sheet set, or a missing file: no URL (a neutral person), and nothing served.
  const plain = homeWith({ floor: { owner: { name: "Ada" } } });
  assert.equal(code(() => ownerSheet(plain)), "SPRITE_NOT_FOUND");
  assert.deepEqual(getState(getDbAt(plain.dbPath), loadHome(plain.home), { enabled: false, running: false, timeZone: "UTC" }).floor.owner, { name: "Ada", isoSprite: null });
  const missing = homeWith({ floor: { owner: { name: "Ada", isoSprite: "me/none.png" } } });
  assert.equal(getState(getDbAt(missing.dbPath), loadHome(missing.home), { enabled: false, running: false, timeZone: "UTC" }).floor.owner?.isoSprite, null);
  assert.equal(code(() => ownerSheet(missing)), "SPRITE_NOT_FOUND");
  // Without the setting there is no owner at all.
  const empty = homeWith({});
  assert.equal(getState(getDbAt(empty.dbPath), loadHome(empty.home), { enabled: false, running: false, timeZone: "UTC" }).floor.owner, null);

  const big = homeWith({ floor: { owner: { name: "Ada", isoSprite: "me/big.png" } } }, { "me/big.png": Buffer.concat([PNG, Buffer.alloc(SPRITE_MAX_BYTES)]) });
  assert.equal(code(() => ownerSheet(big)), "SPRITE_NOT_FOUND");
  const fake = homeWith({ floor: { owner: { name: "Ada", isoSprite: "me/fake.png" } } }, { "me/fake.png": "not a png" });
  assert.equal(code(() => ownerSheet(fake)), "SPRITE_NOT_FOUND");
  // A link that leaves the home is refused once resolved.
  const outside = homeWith({ floor: { owner: { name: "Ada", isoSprite: "me/link.png" } } });
  const elsewhere = path.join(path.dirname(outside.home), `outside-${path.basename(outside.home)}.png`);
  fs.writeFileSync(elsewhere, PNG);
  fs.mkdirSync(path.join(outside.home, "me"), { recursive: true });
  try {
    fs.symlinkSync(elsewhere, path.join(outside.home, "me/link.png"));
  } catch {
    return; // No symbolic links on this machine (Windows without the privilege): nothing more to check.
  }
  assert.equal(code(() => ownerSheet(outside)), "SPRITE_NOT_FOUND");
});

test("the owner sits in the chair of the user's office, which the floor set draws at the same seat", () => {
  const rooms = [{ name: "office", color: null, keys: ["office/mail"] }];
  const empty = layoutFloor(rooms, { reception: "office", receptionist: true });
  assert.equal(officeOf(empty, OWNER_KEY), null, "without an owner the office stays empty");
  const layout = layoutFloor(rooms, { reception: "office", receptionist: true, owner: true });
  const seat = officeOf(layout, OWNER_KEY)!;
  const office = layout.rooms[layout.office!.room]!;
  assert.equal(office.kind, "owner");
  assert.equal(seat.chair, OFFICE_CHAIR);
  assert.equal(seat.faces, "NE", "facing the desk");
  assert.deepEqual(seat.seat, { x: office.x * CELL + OFFICE_SEAT.x, y: office.y * CELL + OFFICE_SEAT.y });
  assert.ok(seat.node >= 0, "the spot by the chair is on the aisles");
  // The floor set's chair: the same seat on the screen (raised by the voxel its cushion stands above the floor chairs').
  const floor = floorSetSchema.parse(JSON.parse(fs.readFileSync(path.join(root, "public", "iso", "floor", "floor.json"), "utf8")));
  const screen = screenOf(OFFICE_SEAT.x, OFFICE_SEAT.y);
  assert.deepEqual(floor.office.chair.seat, [screen.x, screen.y - 2]);
  assert.ok(floor.office.chair.over[0] < floor.atlas.frames.length, "the chair's back is in the atlas");
});

const seed = (id: string): AgentSeed => ({ id, name: id.toUpperCase(), lastRun: null });
const hydrate = (owner: { name: string } | null): RoomInput => ({
  type: "hydrate-floor",
  rooms: [{ name: "office", color: null, agents: [seed("mail")] }],
  approvals: [],
  reception: { room: "office", agent: seed("onboarding") },
  owner,
});

test("the owner types while a turn of the chat is in progress, sits quietly otherwise, and never falls asleep", () => {
  assert.ok(!snapshotRoom(applyInput(createRoomModel(FLOOR_MODEL), hydrate(null), T0), T0).agents.some((agent) => agent.key === OWNER_KEY));
  let model = applyInput(createRoomModel(FLOOR_MODEL), hydrate({ name: "Ada" }), T0);
  const view = (at: number, reduced = false) => snapshotRoom(model, at, reduced).agents.find((agent) => agent.key === OWNER_KEY)!;
  const seat = officeOf(model.layout, OWNER_KEY)!;
  const idle = view(T0);
  assert.equal(idle.name, "Ada");
  assert.deepEqual([idle.x, idle.y, idle.direction, idle.seated], [seat.seat.x, seat.seat.y, "NE", true]);
  assert.deepEqual([idle.pose, idle.animation, idle.frame, idle.status.kind], ["sit", "type", 0, "seated"]);
  assert.equal(view(T0 + 10 * ASLEEP_AFTER_MS).status.kind, "seated", "no sleep for the owner");
  assert.equal(view(T0 + 10 * ASLEEP_AFTER_MS).bubble, null);

  model = applyInput(model, { type: "owner", busy: true }, T0 + 1000);
  const frames = new Set<number>();
  for (let t = 0; t < 600; t += 150) {
    const busy = view(T0 + 1000 + t);
    assert.deepEqual([busy.pose, busy.status.kind, busy.coarse.kind], ["type", "typing", "working"]);
    frames.add(busy.frame);
  }
  assert.ok(frames.size > 1, "it types: the frames go round");
  assert.equal(view(T0 + 1000, true).frame, 0, "held with reduced motion");

  // A new snapshot of the floor keeps the turn in progress; the end of the turn sits it back.
  model = applyInput(model, hydrate({ name: "Ada" }), T0 + 2000);
  assert.equal(view(T0 + 2000).status.kind, "typing");
  model = applyInput(model, { type: "owner", busy: false }, T0 + 3000);
  assert.equal(view(T0 + 3000).status.kind, "seated");
  // Without the owner any more, the office is empty again.
  model = applyInput(model, hydrate(null), T0 + 4000);
  assert.equal(officeOf(model.layout, OWNER_KEY), null);
  assert.ok(!snapshotRoom(model, T0 + 4000).agents.some((agent) => agent.key === OWNER_KEY));
});
