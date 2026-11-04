import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { getDbAt } from "../src/server/db";
import { getState } from "../src/server/feed";
import { readFloorLayout, readNotifyTypes } from "../src/server/home-settings";
import { loadHome } from "../src/server/rooms";
import { schedulerInfo } from "../src/server/routines";
import { DEFAULT_FLOOR_LAYOUT, pileHref } from "../src/ui/floor-mode";
import { agentKey, initialModel, reducer } from "../src/ui/model";
import { RECEPTION_AGENT, RECEPTION_ROOM } from "../src/ui/reception";
import { dropSpotOf } from "../src/ui/room-layout";
import { applyInput, createRoomModel, DROP_STAY_MS, FLOOR_MODEL, snapshotRoom, type RoomInput } from "../src/ui/room-model";
import { createRoomStore } from "../src/ui/room-store";
import { stateSchema, type HqEvent } from "../src/ui/schemas";
import { makeHome } from "./helpers";

// The single floor of the home (myhq.json `floor.layout: "room-per-project"`):
// the setting, the state that carries it, the model and the store that put
// every room on one floor, and where the user's desk of a room leads.

const T0 = Date.parse("2026-11-04T10:00:00.000Z");

const seed = (id: string) => ({ id, name: id.toUpperCase(), lastRun: null });
const hydrateFloor: RoomInput = {
  type: "hydrate-floor",
  rooms: [
    { name: "alpha", color: "#ff3d7f", agents: [seed("scout"), seed("writer")] },
    { name: "beta", color: null, agents: [seed("dev")] },
  ],
  approvals: [
    { id: 1, room: "beta", agentId: "dev", status: "pending" },
    { id: 2, room: RECEPTION_ROOM, agentId: RECEPTION_AGENT, status: "pending" },
  ],
  reception: { room: "beta", agent: seed(RECEPTION_AGENT) },
};

const submit = (room: string, agentId: string): HqEvent => ({
  id: 10,
  runId: 1,
  room,
  agentId,
  type: "tool_call",
  data: { id: "toolu_1", name: "mcp__hq__hq_submit", input: {} },
  createdAt: new Date(T0).toISOString(),
});

test("myhq.json floor.layout: the default without it, either layout with it, the default on a bad value, the rest untouched", () => {
  const config = makeHome();
  const write = (value: unknown) => fs.writeFileSync(path.join(config.home, "myhq.json"), JSON.stringify(value));
  assert.deepEqual(readFloorLayout(config.home), { layout: DEFAULT_FLOOR_LAYOUT, error: null }, "no file");
  write({ notifyTypes: ["brief"] });
  assert.deepEqual(readFloorLayout(config.home), { layout: "floor-per-project", error: null }, "no block");
  write({ floor: { layout: "room-per-project" } });
  assert.equal(readFloorLayout(config.home).layout, "room-per-project");
  write({ floor: { layout: "floor-per-project" } });
  assert.equal(readFloorLayout(config.home).layout, "floor-per-project");
  write({ notifyTypes: ["brief"], floor: { layout: "one-big-floor" } });
  const bad = readFloorLayout(config.home);
  assert.equal(bad.layout, DEFAULT_FLOOR_LAYOUT, "an unknown layout falls back");
  assert.match(bad.error ?? "", /floor\.layout/);
  assert.deepEqual(readNotifyTypes(config.home), ["brief"], "the rest of myhq.json still reads");
  write({ floor: "room-per-project" });
  assert.equal(readFloorLayout(config.home).layout, DEFAULT_FLOOR_LAYOUT, "a block of the wrong shape falls back");
  fs.writeFileSync(path.join(config.home, "myhq.json"), "{ not json");
  assert.equal(readFloorLayout(config.home).layout, DEFAULT_FLOOR_LAYOUT, "invalid JSON falls back");
});

test("the state carries the layout, and the interface reads it (an unknown one from a newer server is the default)", () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const stateOf = () => getState(db, loadHome(config.home), schedulerInfo(config));
  assert.deepEqual(stateOf().floor, { layout: "floor-per-project" });
  fs.writeFileSync(path.join(config.home, "myhq.json"), JSON.stringify({ floor: { layout: "room-per-project" } }));
  const state = stateSchema.parse(JSON.parse(JSON.stringify(stateOf())));
  assert.equal(state.floor.layout, "room-per-project");
  assert.equal(reducer(initialModel, { type: "state", state }).floorLayout, "room-per-project");
  const older = JSON.parse(JSON.stringify(stateOf())) as Record<string, unknown>;
  delete older.floor;
  assert.equal(stateSchema.parse(older).floor.layout, DEFAULT_FLOOR_LAYOUT, "a server without the key");
  assert.equal(stateSchema.parse({ ...older, floor: { layout: "newer" } }).floor.layout, DEFAULT_FLOOR_LAYOUT);
});

test("the model of the single floor holds every room, the receptionist, and a pile per room", () => {
  const model = applyInput(createRoomModel(FLOOR_MODEL), hydrateFloor, T0 - 600_000);
  assert.deepEqual(model.rooms, ["alpha", "beta"]);
  assert.equal(model.layout.template, "rooms");
  const view = snapshotRoom(model, T0);
  assert.deepEqual(
    view.agents.map((agent) => agent.key),
    ["alpha/scout", "alpha/writer", "beta/dev", `${RECEPTION_ROOM}/${RECEPTION_AGENT}`],
  );
  assert.deepEqual(view.pendingByRoom, { beta: 1, [RECEPTION_ROOM]: 1 });
  assert.equal(view.pending, 2);
  // The same rooms again (a reconnection): the same plan, so the canvas keeps its view.
  assert.equal(applyInput(model, hydrateFloor, T0).layout, model.layout);
});

test("on the single floor an agent carries its folder to the user's desk of its own room, and the pile grows at the drop", () => {
  let model = applyInput(createRoomModel(FLOOR_MODEL), hydrateFloor, T0 - 600_000);
  model = applyInput(model, { type: "run", run: { id: 1, room: "alpha", agentId: "writer", status: "running", startedAt: new Date(T0).toISOString(), endedAt: null } }, T0);
  model = applyInput(model, { type: "event", event: submit("alpha", "writer") }, T0);
  model = applyInput(model, { type: "approval", approval: { id: 3, room: "alpha", agentId: "writer", status: "pending" } }, T0 + 100);
  const spot = dropSpotOf(model.layout, agentKey("alpha", "writer"))!;
  assert.equal(model.layout.owners.find((owner) => owner === spot)?.room, "alpha");
  let arrived = null;
  for (let at = T0; at < T0 + 60_000; at += 100) {
    const writer = snapshotRoom(model, at).agents.find((agent) => agent.key === "alpha/writer")!;
    if (writer.status.kind === "dropping") {
      arrived = { at, writer };
      break;
    }
  }
  assert.ok(arrived, "it gets there");
  assert.deepEqual([arrived.writer.x, arrived.writer.y], [spot.stand.x, spot.stand.y]);
  assert.equal(snapshotRoom(model, arrived.at - 200).pendingByRoom.alpha ?? 0, 0, "not before the drop");
  assert.equal(snapshotRoom(model, arrived.at + DROP_STAY_MS).pendingByRoom.alpha, 1, "in the pile of its room");
  assert.equal(snapshotRoom(model, arrived.at + DROP_STAY_MS).pendingByRoom.beta, 1, "the other room's pile is unchanged");
});

test("the store puts the whole home on one floor when the home asks for it, and back to a floor per room", () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const store = createRoomStore();
  fs.writeFileSync(path.join(config.home, "myhq.json"), JSON.stringify({ floor: { layout: "room-per-project" } }));
  const single = stateSchema.parse(JSON.parse(JSON.stringify(getState(db, loadHome(config.home), schedulerInfo(config)))));
  store.ingest({ kind: "state", state: single }, T0);
  const floor = store.get(FLOOR_MODEL);
  assert.deepEqual(floor.rooms, ["demo"]);
  assert.ok(floor.agents.some((agent) => agent.key === "demo/scout"));
  assert.ok(floor.agents.some((agent) => agent.key === `${RECEPTION_ROOM}/${RECEPTION_AGENT}`));
  store.ingest({ kind: "approval", approval: { ...approval(5), room: "demo", agentId: "scout" } }, T0);
  assert.ok(store.get(FLOOR_MODEL).approvals[5], "a change of any room goes to the single floor");

  fs.writeFileSync(path.join(config.home, "myhq.json"), JSON.stringify({}));
  const perRoom = stateSchema.parse(JSON.parse(JSON.stringify(getState(db, loadHome(config.home), schedulerInfo(config)))));
  store.ingest({ kind: "state", state: perRoom }, T0);
  assert.deepEqual(store.get("demo").agents.map((agent) => agent.key), ["demo/scout", `${RECEPTION_ROOM}/${RECEPTION_AGENT}`]);
  assert.deepEqual(store.get(FLOOR_MODEL).rooms, [], "no single floor any more");
});

function approval(id: number) {
  return {
    id,
    room: "demo",
    agentId: "scout",
    runId: null,
    type: "post",
    title: "T",
    body: "B",
    payload: {},
    status: "pending" as const,
    decisionNote: null,
    annotations: [],
    decisionHistory: [],
    actionDone: false,
    informational: false,
    decidedAt: null,
    createdAt: new Date(T0).toISOString(),
  };
}

test("the user's desk of a room leads to the pile of decisions filtered to that room", () => {
  const objects = [
    { id: "courrier", source: "watch:mail_alert" },
    { id: "signer", source: "approvals" },
  ];
  assert.equal(pileHref(objects, "alpha"), "/bureau/signer?room=alpha");
  assert.equal(pileHref(objects, RECEPTION_ROOM), "/bureau/signer?room=_hq");
  assert.equal(pileHref([{ id: "pile", source: "approvals+summaries" }], "a b"), "/bureau/pile?room=a%20b");
  assert.equal(pileHref([{ id: "courrier", source: "watch:mail_alert" }], "alpha"), "/bureau", "no pile: the desk");
  assert.equal(pileHref(null, "alpha"), "/bureau");
});

test("an item a shared room delivers lands on the pile of the room that ordered it, carried there across the hall", () => {
  let model = applyInput(createRoomModel(FLOOR_MODEL), hydrateFloor, T0 - 600_000);
  // beta/dev works for alpha: hq_submit with forRoom.
  const order: HqEvent = { ...submit("beta", "dev"), data: { id: "toolu_2", name: "mcp__hq__hq_submit", input: { forRoom: "alpha" } } };
  model = applyInput(model, { type: "event", event: order }, T0);
  model = applyInput(model, { type: "approval", approval: { id: 7, room: "beta", agentId: "dev", status: "pending", forRoom: "alpha" } }, T0 + 100);
  const alphaDesk = model.layout.owners.find((owner) => owner.room === "alpha")!;
  let dropping = null;
  for (let at = T0; at < T0 + 120_000; at += 100) {
    const dev = snapshotRoom(model, at).agents.find((agent) => agent.key === "beta/dev")!;
    if (dev.status.kind === "dropping") {
      dropping = { at, dev };
      break;
    }
  }
  assert.ok(dropping, "it walks to the other room");
  assert.deepEqual([dropping.dev.x, dropping.dev.y], [alphaDesk.stand.x, alphaDesk.stand.y], "to alpha's desk, not its own");
  const after = snapshotRoom(model, dropping.at + DROP_STAY_MS).pendingByRoom;
  assert.equal(after.alpha, 1, "on alpha's pile");
  assert.equal(after.beta, 1, "beta's pile keeps only its own item");

  // A snapshot with the delivery already there.
  const hydrated = applyInput(
    createRoomModel(FLOOR_MODEL),
    { ...hydrateFloor, approvals: [{ id: 8, room: "beta", agentId: "dev", status: "pending", forRoom: "alpha" }] } as RoomInput,
    T0,
  );
  assert.deepEqual(snapshotRoom(hydrated, T0).pendingByRoom, { alpha: 1 });
});

test("on a floor per room, a delivery goes to the tray of the room that ordered it", () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const studio = path.join(config.home, "rooms", "studio");
  fs.mkdirSync(path.join(studio, "roles"), { recursive: true });
  fs.writeFileSync(path.join(studio, "roles", "maker.md"), "You make things.\n");
  fs.writeFileSync(
    path.join(studio, "room.json"),
    JSON.stringify({ name: "studio", targetRepo: "../studio", shared: true, agents: [{ id: "maker", name: "Maker", role: "roles/maker.md", model: "haiku", allowedTools: [] }] }),
  );
  const store = createRoomStore();
  const state = stateSchema.parse(JSON.parse(JSON.stringify(getState(db, loadHome(config.home), schedulerInfo(config)))));
  store.ingest({ kind: "state", state: { ...state, approvals: { ...state.approvals, pending: [{ ...approval(9), room: "studio", agentId: "maker", forRoom: "demo" }] } } }, T0);
  assert.equal(snapshotRoom(store.get("demo"), T0).pending, 1, "demo's tray, from the snapshot");
  assert.equal(snapshotRoom(store.get("studio"), T0).pending, 0);
  store.ingest({ kind: "approval", approval: { ...approval(10), room: "studio", agentId: "maker", forRoom: "demo" } }, T0);
  assert.equal(snapshotRoom(store.get("demo"), T0).pending, 2, "and from the stream");
  assert.equal(snapshotRoom(store.get("studio"), T0).pending, 0);
});

test("on the single floor a message to another room's agent is a walk through the hall to its desk", () => {
  let model = applyInput(createRoomModel(FLOOR_MODEL), hydrateFloor, T0 - 600_000);
  const message: HqEvent = { ...submit("alpha", "scout"), data: { id: "toolu_3", name: "mcp__hq__hq_message", input: { to: "dev", room: "beta", text: "hi" } } };
  model = applyInput(model, { type: "event", event: message }, T0);
  const target = model.layout.offices.find((office) => office.key === "beta/dev")!;
  let talking = null;
  for (let at = T0; at < T0 + 120_000 && !talking; at += 100) {
    const scout = snapshotRoom(model, at).agents.find((agent) => agent.key === "alpha/scout")!;
    if (scout.status.kind === "talking") talking = scout;
  }
  assert.ok(talking, "it gets there");
  assert.deepEqual([talking.x, talking.y], [target.stand.x, target.stand.y]);
  assert.equal(talking.status.kind === "talking" && talking.status.target, "DEV");
});
