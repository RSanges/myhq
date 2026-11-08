import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { getDbAt } from "../src/server/db";
import { getState } from "../src/server/feed";
import { loadHome } from "../src/server/rooms";
import { layoutFloor } from "../src/ui/floor-plan";
import { floorSetSchema, JANITOR_SHEET } from "../src/ui/iso-floor";
import { groupOf } from "../src/ui/agent-groups";
import { buildTour, HALL_SWEEP_MS, ROAM_ORIGIN, ROOM_SWEEP_MS, tourPose } from "../src/ui/roam";
import { CELL, officeOf, type Point, type RoomLayout } from "../src/ui/room-layout";
import { applyInput, ASLEEP_AFTER_MS, createRoomModel, FLOOR_MODEL, snapshotRoom, type AgentSeed, type RoomInput, type RoomModel, type RunSeed } from "../src/ui/room-model";
import type { HqEvent } from "../src/ui/schemas";
import { makeHome } from "./helpers";

// An agent with `floor.behaviour: "roam"` (the janitor of the single floor):
// no desk, a broom closet in the lobby, a round of every room during its runs,
// sweeping on the way, back to the closet after, and still with reduced motion.

const root = path.join(import.meta.dirname, "..");
const T0 = Date.parse("2026-11-06T04:00:00.000Z");
const JANITOR = "office/janitor";

const seed = (id: string, extra: Partial<AgentSeed> = {}): AgentSeed => ({ id, name: id.toUpperCase(), lastRun: null, ...extra });
const run = (id: number, status: RunSeed["status"], startedAt = T0): RunSeed => ({
  id,
  room: "office",
  agentId: "janitor",
  status,
  startedAt: new Date(startedAt).toISOString(),
  endedAt: status === "running" ? null : new Date(startedAt + 60_000).toISOString(),
});
const hydrate = (lastRun: RunSeed | null = null): RoomInput => ({
  type: "hydrate-floor",
  rooms: [
    { name: "office", color: "#035dd3", agents: [seed("mail"), seed("brief"), seed("janitor", { roam: true, lastRun })] },
    { name: "shop", color: "#ff3d7f", agents: [seed("dev"), seed("seo"), seed("social")] },
  ],
  approvals: [],
  reception: { room: "office", agent: seed("onboarding") },
});

/** Whether a point lies on an edge of the floor's graph (the aisles and lanes): nobody walks anywhere else. */
function onGraph(layout: RoomLayout, p: Point): boolean {
  return layout.graph.edges.some(([i, j]) => {
    const a = layout.graph.nodes[i]!;
    const b = layout.graph.nodes[j]!;
    const within = (v: number, s: number, t: number) => v >= Math.min(s, t) - 0.01 && v <= Math.max(s, t) + 0.01;
    return (Math.abs(a.x - b.x) < 0.01 && Math.abs(p.x - a.x) < 0.01 && within(p.y, a.y, b.y)) || (Math.abs(a.y - b.y) < 0.01 && Math.abs(p.y - a.y) < 0.01 && within(p.x, a.x, b.x));
  });
}

test("room.json floor.behaviour: desk or roam, nothing else, and the state says which agents roam", () => {
  const agent = { id: "janitor", name: "Janitor", role: "roles/scout.md", model: "haiku", allowedTools: ["mcp__hq__*"] };
  const config = makeHome({}, { name: "demo", targetRepo: "x", agents: [{ ...agent, floor: { behaviour: "roam" } }, { ...agent, id: "dev", name: "Dev", floor: { behaviour: "desk" } }] });
  const home = loadHome(config.home);
  assert.deepEqual(home.invalid, []);
  assert.deepEqual(home.rooms[0]!.agents.map((each) => each.roam), [true, false]);
  const state = getState(getDbAt(config.dbPath), home, { enabled: false, running: false, timeZone: "Europe/Paris" });
  assert.deepEqual(state.rooms[0]!.agents.map((each) => each.roam), [true, false]);
  const bad = makeHome({}, { name: "demo", targetRepo: "x", agents: [{ ...agent, floor: { behaviour: "wander" } }] });
  assert.match(loadHome(bad.home).invalid[0]!.error, /floor/);
});

test("the janitor's sheet is shipped in the format of the others, its type row sweeping", () => {
  const json = JSON.parse(fs.readFileSync(path.join(root, "public", "sprites", "iso-characters.json"), "utf8")) as { sheets: { id: string; file: string }[] };
  assert.ok(json.sheets.some((sheet) => sheet.id === "janitor" && sheet.file === "iso-janitor.png"));
  const png = fs.readFileSync(path.join(root, "public", JANITOR_SHEET));
  // IHDR: width and height, big-endian, at bytes 16 and 20: 8 columns by 12 rows of 96 x 136 frames.
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [8 * 96, 12 * 136]);
  const floor = floorSetSchema.parse(JSON.parse(fs.readFileSync(path.join(root, "public", "iso", "floor", "floor.json"), "utf8")));
  assert.deepEqual(Object.keys(floor.furniture["broom-closet"]!.turns), ["0", "1"], "the broom closet is in the floor set");
});

test("a roaming agent has no desk: its suite is sized without it, it rests by the broom closet of the lobby", () => {
  const rooms = [
    { name: "office", color: null, keys: ["office/mail", "office/brief"] },
    { name: "shop", color: null, keys: ["shop/dev"] },
  ];
  const plain = layoutFloor(rooms, { reception: "office", receptionist: true });
  const roaming = layoutFloor(rooms, { reception: "office", receptionist: true, roamers: [JANITOR] });
  assert.ok(!plain.pieces.some((piece) => piece.name === "broom-closet"), "no closet without a roaming agent");
  const closets = roaming.pieces.filter((piece) => piece.name === "broom-closet");
  assert.equal(closets.length, 1);
  const lobby = roaming.rooms[closets[0]!.room]!;
  assert.equal(lobby.kind, "lobby");
  const spot = officeOf(roaming, JANITOR)!;
  assert.equal(spot.chair, null, "it stands, it has no chair");
  assert.ok(spot.node >= 0 && onGraph(roaming, spot.stand), "its spot is on the aisles");
  assert.equal(roaming.offices.filter((office) => office.chair !== null).length, 3, "the others keep their desks");
  assert.deepEqual(
    roaming.rooms.map((room) => room.w),
    plain.rooms.map((room) => room.w),
    "the suites are the same size",
  );
  // The closet is against the back wall, in front of no window, on a cell nobody else uses.
  const [cx, cy] = closets[0]!.cell;
  assert.equal(cy, lobby.y);
  assert.equal(lobby.back.y[cx - lobby.x], "plain");
  const taken = roaming.pieces.filter((piece) => piece !== closets[0] && piece.cell[0] === cx && piece.cell[1] === cy);
  assert.deepEqual(taken, []);
});

test("its round: into every room of the floor along the aisles and corridors, sweeping in each, round after round", () => {
  let model = applyInput(createRoomModel(FLOOR_MODEL), hydrate(), T0);
  const spot = officeOf(model.layout, JANITOR)!;
  const tour = buildTour(model.layout, spot);
  assert.ok(tour.loopMs > 0);
  const sweeps = tour.loop.filter((step) => step.kind === "sweep");
  for (const [index, room] of model.layout.rooms.entries()) {
    const inside = sweeps.some((step) => step.kind === "sweep" && step.at.x > room.x * CELL && step.at.x < (room.x + room.w) * CELL && step.at.y > room.y * CELL && step.at.y < (room.y + room.d) * CELL);
    assert.ok(inside, `it sweeps in room ${index} (${room.kind})`);
  }
  assert.ok(sweeps.some((step) => step.ms === ROOM_SWEEP_MS) && sweeps.some((step) => step.ms === HALL_SWEEP_MS), "in the rooms and in the corridor");

  // Asleep by the closet before the run; on its round during the run, always on the aisles.
  const before = snapshotRoom(model, T0 - 1, false).agents.find((agent) => agent.key === JANITOR)!;
  assert.deepEqual([before.x, before.y, before.status.kind], [spot.seat.x, spot.seat.y, "asleep"]);
  model = applyInput(model, { type: "run", run: run(7, "running") }, T0);
  const kinds = new Set<string>();
  let moved = false;
  for (let t = 0; t < tour.introMs + tour.loopMs * 2; t += 250) {
    const view = snapshotRoom(model, T0 + t, false).agents.find((agent) => agent.key === JANITOR)!;
    kinds.add(view.status.kind);
    assert.ok(onGraph(model.layout, view), `on the aisles at ${t} ms`);
    if (view.status.kind === "sweeping") assert.equal(view.animation, "type", "sweeping is the type row of its sheet");
    if (view.x !== spot.seat.x || view.y !== spot.seat.y) moved = true;
    assert.equal(view.seated, false);
  }
  assert.ok(moved);
  assert.deepEqual([...kinds].sort(), ["roaming", "sweeping"]);
  // Deterministic: the same moment of the round gives the same place.
  const at = T0 + tour.introMs + 1234;
  const place = (t: number) => {
    const view = snapshotRoom(model, t, false).agents.find((agent) => agent.key === JANITOR)!;
    return [view.x, view.y, view.direction, view.status.kind];
  };
  assert.deepEqual(place(at), place(at + tour.loopMs));
  const { stepEnd, ...pose } = tourPose(tour, at - T0);
  const { stepEnd: later, ...again } = tourPose(tour, at - T0 + tour.loopMs);
  assert.deepEqual(pose, again, "the loop repeats");
  assert.equal(later - stepEnd, tour.loopMs);
});

test("after its run it walks back to the closet and rests; with reduced motion it never leaves it", () => {
  let model = applyInput(createRoomModel(FLOOR_MODEL), hydrate(), T0);
  const spot = officeOf(model.layout, JANITOR)!;
  const tour = buildTour(model.layout, spot);
  model = applyInput(model, { type: "run", run: run(7, "running") }, T0);
  const end = T0 + tour.introMs + Math.floor(tour.loopMs / 2);
  const away = snapshotRoom(model, end, false).agents.find((agent) => agent.key === JANITOR)!;
  assert.ok(away.x !== spot.seat.x || away.y !== spot.seat.y, "away from the closet when the run ends");

  // Reduced motion: by the closet the whole run, standing, its status the round's.
  const still = snapshotRoom(model, end, true);
  const janitor = still.agents.find((agent) => agent.key === JANITOR)!;
  assert.deepEqual([janitor.x, janitor.y, janitor.pose, janitor.status.kind, janitor.frame], [spot.seat.x, spot.seat.y, "stand", "roaming", 0]);
  assert.equal(still.fps, 0, "nothing to animate");

  model = applyInput(model, { type: "run", run: run(7, "done") }, end);
  const back = snapshotRoom(model, end + 100, false).agents.find((agent) => agent.key === JANITOR)!;
  assert.equal(back.status.kind, "stowing");
  assert.equal(back.pose, "walk");
  assert.ok(Math.hypot(back.x - away.x, back.y - away.y) < 16, "from where it was");
  let home = Number.POSITIVE_INFINITY;
  for (let t = end; t < end + 120_000; t += 200) {
    const view = snapshotRoom(model, t, false).agents.find((agent) => agent.key === JANITOR)!;
    assert.ok(onGraph(model.layout, view));
    if (view.status.kind === "closet") {
      home = t;
      assert.deepEqual([view.x, view.y, view.pose, view.animation], [spot.seat.x, spot.seat.y, "stand", "idle"]);
      break;
    }
  }
  assert.ok(Number.isFinite(home), "it gets back to the closet");
  assert.equal(snapshotRoom(model, end + 61_000 + 120_000, false).agents.find((agent) => agent.key === JANITOR)!.status.kind, "asleep");
});

test("a roaming agent runs no errands: a message or an item it sends is not walked over", () => {
  let model = applyInput(createRoomModel(FLOOR_MODEL), hydrate(run(7, "running")), T0);
  const event = (name: string, input: Record<string, unknown>): HqEvent => ({
    id: 10,
    runId: 7,
    room: "office",
    agentId: "janitor",
    type: "tool_call",
    data: { id: "toolu_1", name, input },
    createdAt: new Date(T0).toISOString(),
  });
  model = applyInput(model, { type: "event", event: event("mcp__hq__hq_message", { to: "mail", text: "done" }) }, T0 + 10);
  model = applyInput(model, { type: "event", event: event("mcp__hq__hq_submit", {}) }, T0 + 20);
  const janitor = model.agents.find((agent) => agent.key === JANITOR)!;
  assert.deepEqual(janitor.trips, []);
  const view = snapshotRoom(model, T0 + 30, false).agents.find((agent) => agent.key === JANITOR)!;
  assert.ok(view.status.kind === "roaming" || view.status.kind === "sweeping");
});

// `floor.always`: the round goes on between the runs too, on a clock anchored at ROAM_ORIGIN.
const hydrateAlways = (lastRun: RunSeed | null = null): RoomInput => {
  const input = hydrate(lastRun);
  if (input.type !== "hydrate-floor") throw new Error("hydrate-floor expected");
  return {
    ...input,
    rooms: input.rooms.map((room) => ({ ...room, agents: room.agents.map((agent) => (agent.roam ? { ...agent, roamAlways: true } : agent)) })),
  };
};

test("room.json floor.always: roam only, and the state says which agents are always on their round", () => {
  const agent = { id: "janitor", name: "Janitor", role: "roles/scout.md", model: "haiku", allowedTools: ["mcp__hq__*"] };
  const config = makeHome({}, { name: "demo", targetRepo: "x", agents: [{ ...agent, floor: { behaviour: "roam", always: true } }, { ...agent, id: "dev", name: "Dev", floor: { behaviour: "roam" } }] });
  const home = loadHome(config.home);
  assert.deepEqual(home.invalid, []);
  assert.deepEqual(home.rooms[0]!.agents.map((each) => each.roamAlways), [true, false]);
  const state = getState(getDbAt(config.dbPath), home, { enabled: false, running: false, timeZone: "Europe/Paris" });
  assert.deepEqual(state.rooms[0]!.agents.map((each) => each.roamAlways), [true, false]);
  const bad = makeHome({}, { name: "demo", targetRepo: "x", agents: [{ ...agent, floor: { behaviour: "desk", always: true } }] });
  assert.match(loadHome(bad.home).invalid[0]!.error, /always/);
});

test("always on its round: between its runs too, the same place for every client, its status patrolling; reduced motion keeps it by the closet", () => {
  // Two clients that loaded the floor at different times draw it at the same place.
  const a = applyInput(createRoomModel(FLOOR_MODEL), hydrateAlways(), T0);
  const b = applyInput(createRoomModel(FLOOR_MODEL), hydrateAlways(), T0 + 3_600_000);
  const spot = officeOf(a.layout, JANITOR)!;
  const tour = buildTour(a.layout, spot);
  const view = (model: RoomModel, at: number, reduced = false) => snapshotRoom(model, at, reduced).agents.find((agent) => agent.key === JANITOR)!;
  let moved = false;
  for (let t = 0; t < tour.loopMs; t += 500) {
    const at = T0 + 7_200_000 + t;
    const one = view(a, at);
    const other = view(b, at);
    assert.deepEqual([one.x, one.y, one.direction, one.pose], [other.x, other.y, other.direction, other.pose]);
    const { x, y, sweeping } = tourPose(tour, at - ROAM_ORIGIN, spot.faces);
    assert.deepEqual([one.x, one.y, one.pose], [x, y, sweeping ? "sweep" : "walk"], "a pure function of the clock");
    assert.equal(one.status.kind, "patrolling");
    assert.equal(one.coarse.kind, "patrolling");
    assert.equal(groupOf(one.status), "resting", "no turn in progress");
    assert.ok(onGraph(a.layout, one));
    if (one.x !== spot.seat.x || one.y !== spot.seat.y) moved = true;
  }
  assert.ok(moved);
  assert.ok(Number.isFinite(snapshotRoom(a, T0).nextChangeAt), "the next step is scheduled");

  // A run changes the status, not the place; its end sends nobody home.
  let model = applyInput(a, { type: "run", run: run(7, "running", T0 + 100) }, T0 + 100);
  const at = T0 + 200_000;
  const running = view(model, at);
  assert.ok(running.status.kind === "roaming" || running.status.kind === "sweeping");
  assert.deepEqual([running.x, running.y], [view(a, at).x, view(a, at).y]);
  model = applyInput(model, { type: "run", run: run(7, "done", T0 + 100) }, at);
  const after = view(model, at + 100);
  assert.equal(after.status.kind, "patrolling");
  assert.deepEqual([after.x, after.y], [view(a, at + 100).x, view(a, at + 100).y]);

  // Reduced motion: by the closet as before, standing after its run, then asleep.
  const still = view(model, at + 100, true);
  assert.deepEqual([still.x, still.y, still.pose, still.status.kind], [spot.seat.x, spot.seat.y, "stand", "closet"]);
  assert.equal(view(model, at + ASLEEP_AFTER_MS + 1000, true).status.kind, "asleep");
});
