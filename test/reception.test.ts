import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseStreamLine } from "../src/server/claude-engine";
import { getDbAt } from "../src/server/db";
import type { Engine } from "../src/server/engine";
import { getState } from "../src/server/feed";
import { readReceptionRoom } from "../src/server/home-settings";
import { startOnboarding } from "../src/server/onboarding";
import { loadHome } from "../src/server/rooms";
import { schedulerInfo } from "../src/server/routines";
import { spriteResponse } from "../src/server/sprites";
import { FLOOR_TEMPLATES } from "../src/ui/floor-templates";
import { agentKey, initialModel, reducer } from "../src/ui/model";
import {
  onboardingTarget,
  onboardingTask,
  RECEPTION_AGENT,
  RECEPTION_KEY,
  RECEPTION_ROOM,
  resolveReceptionRoom,
} from "../src/ui/reception";
import { ReceptionSheet } from "../src/ui/reception-sheet";
import { layoutRoom, officeOf, routeLength, routeToOffice, routeToUser, type Point, type RoomLayout } from "../src/ui/room-layout";
import { applyInput, createRoomModel, DROP_STAY_MS, snapshotRoom, TYPING_MS, WALK_SPEED, type RoomModel } from "../src/ui/room-model";
import { createRoomStore } from "../src/ui/room-store";
import type { HqEvent, Run, State } from "../src/ui/schemas";
import { makeHome } from "./helpers";

// The receptionist: the onboarding agent drawn at a reception desk on one floor
// of the home (docs/architecture.md, section 7).

const T0 = Date.parse("2026-11-02T10:00:00.000Z");
const ROOM = "demo";
const seeds = [
  { id: "scout", name: "Scout", lastRun: null },
  { id: "writer", name: "Writer", lastRun: null },
];
const receptionist = { id: RECEPTION_AGENT, name: "Accueil", lastRun: null };

const onboardingRun = (id: number, status: Run["status"], over: Partial<Run> = {}): Run => ({
  id,
  room: RECEPTION_ROOM,
  agentId: RECEPTION_AGENT,
  engine: "claude",
  task: onboardingTask("../tinylog"),
  status,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  costUsd: 0,
  startedAt: new Date(T0).toISOString(),
  endedAt: status === "running" ? null : new Date(T0 + 1000).toISOString(),
  summary: null,
  ...over,
});

const toolCall = (id: number, name: string, input: unknown): HqEvent => ({
  id,
  runId: 1,
  room: RECEPTION_ROOM,
  agentId: RECEPTION_AGENT,
  type: "tool_call",
  data: { id: `toolu_${id}`, name, input },
  createdAt: new Date(T0).toISOString(),
});

function withReception(): RoomModel {
  return applyInput(createRoomModel(ROOM), { type: "hydrate", agents: seeds, approvals: [], reception: receptionist }, T0 - 600_000);
}

const seen = (model: RoomModel, at: number) => snapshotRoom(model, at).agents.find((agent) => agent.key === RECEPTION_KEY)!;

/** A state snapshot with just what these tests look at. */
const stateWith = (rooms: string[], reception: State["reception"]): State =>
  ({
    cursor: 1,
    rooms: rooms.map((name) => ({
      name,
      targetRepo: "x",
      agents: seeds.map((seed) => ({
        ...seed,
        model: "haiku",
        role: "r.md",
        allowedTools: [],
        sprite: null,
        armed: false,
        routines: [],
        state: "idle",
      })),
    })),
    invalidRooms: [],
    reception,
    scheduler: { enabled: false, running: false, timeZone: "UTC" },
    firings: [],
    approvals: { pending: [], unseen: [], history: [] },
    recent: { events: [], messages: [] },
  }) as unknown as State;

// ---- Templates and routes ---------------------------------------------------------------------------

const inside = (p: Point, r: { x: number; y: number; w: number; h: number }) =>
  p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

function crosses(a: Point, b: Point, c: Point, d: Point): boolean {
  const side = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return side(c, d, a) * side(c, d, b) < -1e-9 && side(a, b, c) * side(a, b, d) < -1e-9;
}

function assertNoWallCrossed(layout: RoomLayout, route: Point[], label: string) {
  for (let i = 1; i < route.length; i += 1) {
    for (const wall of layout.walls) {
      assert.ok(!crosses(route[i - 1]!, route[i]!, wall.a, wall.b), `${label}: crosses a wall near ${route[i]!.x.toFixed(0)},${route[i]!.y.toFixed(0)}`);
    }
  }
}

const onSegment = (p: Point, a: Point, b: Point) =>
  Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) < 1e-6 &&
  p.x >= Math.min(a.x, b.x) &&
  p.x <= Math.max(a.x, b.x) &&
  p.y >= Math.min(a.y, b.y) &&
  p.y <= Math.max(a.y, b.y);

test("every template places a reception desk in the lobby, clear of the furniture", () => {
  for (const template of Object.values(FLOOR_TEMPLATES)) {
    const { counter, seat, outside } = template.lobby.reception;
    const user = template.rooms.find((room) => room.kind === "user")!;
    assert.ok(counter.y > user.rect.y + user.rect.h, `${template.id}: the desk is in the lobby, below the user's office`);
    assert.ok(inside(seat, counter), `${template.id}: the receptionist sits behind the counter, feet inside it`);
    assert.ok(counter.x + counter.w < template.width - 10 && counter.y + counter.h < template.height - 10, `${template.id}: inside the building`);
    const onCorridor = template.corridors.some((line) => line.slice(1).some((b, i) => onSegment(outside, line[i]!, b)));
    assert.ok(onCorridor, `${template.id}: the receptionist joins a corridor straight ahead`);
    // No piece of lobby furniture under the counter or the receptionist behind it.
    for (const item of template.lobby.items) {
      const box = item.t === "disc" ? { x: item.x - item.r, y: item.y - item.r, w: 2 * item.r, h: 2 * item.r } : item;
      const clear =
        counter.x > box.x + box.w || counter.x + counter.w < box.x || counter.y - 24 > box.y + box.h || counter.y + counter.h < box.y;
      assert.ok(clear, `${template.id}: furniture at ${box.x},${box.y} is clear of the desk`);
    }
  }
});

test("the reception desk is only in the layout that asks for it", () => {
  const without = layoutRoom(["r/a", "r/b"]);
  assert.equal(without.reception, null);
  assert.equal(officeOf(without, RECEPTION_KEY), null);
  const withDesk = layoutRoom(["r/a", "r/b"], { reception: true });
  assert.ok(withDesk.reception);
  assert.equal(officeOf(withDesk, RECEPTION_KEY), withDesk.reception.office);
  assert.equal(withDesk.offices.length, 2, "the receptionist takes no desk of the room");
  assert.deepEqual(withDesk.walls, without.walls, "the lobby has no wall of its own");
});

test("the receptionist walks from the counter to the user's office through the lobby, never through a wall, with 1 to 12 agents", () => {
  for (let count = 1; count <= 12; count += 1) {
    const layout = layoutRoom(Array.from({ length: count }, (_, i) => `r/a${i}`), { reception: true });
    const desk = layout.reception!;
    const label = `${layout.template} with ${count}`;
    assert.deepEqual(desk.office.exit[0], desk.office.seat);
    for (const p of [desk.office.seat, ...desk.office.exit, desk.bell, desk.plate]) {
      assert.ok(p.x > 0 && p.x < layout.width && p.y > 0 && p.y < layout.height, `${label}: inside the plan`);
    }
    assertNoWallCrossed(layout, desk.office.exit, `exit of the receptionist, ${label}`);
    const toUser = routeToUser(layout, desk.office);
    assert.deepEqual(toUser[0], desk.office.seat);
    assert.deepEqual(toUser[toUser.length - 1], layout.user.stand, "it ends where a folder is dropped in the tray");
    assert.ok(toUser.length > 2 && routeLength(toUser) > 30, "a real walk");
    assertNoWallCrossed(layout, toUser, `to the user, ${label}`);
    // The walk stays in the lobby, under the user's office.
    assert.ok(toUser.every((p) => p.y >= layout.user.room.y + layout.user.room.h), `${label}: it walks the lobby, not the user's office`);
    for (const office of layout.offices) {
      assertNoWallCrossed(layout, routeToOffice(layout, desk.office, office), `to ${office.key}, ${label}`);
      assertNoWallCrossed(layout, routeToOffice(layout, office, desk.office), `from ${office.key}, ${label}`);
      assertNoWallCrossed(layout, routeToUser(layout, office), `${office.key} to the user, ${label}`);
    }
  }
});

// ---- The model ------------------------------------------------------------------------------------------

test("the model treats _hq/onboarding runs, events and approvals as the receptionist's, on the reception floor only", () => {
  const model = withReception();
  assert.deepEqual(model.agents.map((a) => a.key), [agentKey(ROOM, "scout"), agentKey(ROOM, "writer"), RECEPTION_KEY]);
  assert.equal(seen(model, T0).status.kind, "asleep", "asleep when idle");

  const running = applyInput(model, { type: "run", run: onboardingRun(1, "running") }, T0);
  assert.equal(seen(running, T0 + 100).status.kind, "seated");
  const typing = applyInput(running, { type: "event", event: toolCall(1, "Read", { file_path: "README.md" }) }, T0 + 200);
  const view = seen(typing, T0 + 300);
  assert.equal(view.status.kind, "typing");
  assert.equal(view.pose, "type");
  assert.equal(seen(typing, T0 + 200 + TYPING_MS + 100).status.kind, "seated");
  const others = snapshotRoom(typing, T0 + 300).agents.filter((a) => a.key !== RECEPTION_KEY);
  assert.ok(others.every((a) => a.status.kind === "asleep"), "the others are untouched");

  // A floor without the reception ignores the reserved room entirely.
  const plain = applyInput(createRoomModel(ROOM), { type: "hydrate", agents: seeds, approvals: [] }, T0 - 600_000);
  assert.equal(plain.reception, false);
  assert.equal(applyInput(plain, { type: "run", run: onboardingRun(1, "running") }, T0), plain);
  assert.equal(applyInput(plain, { type: "event", event: toolCall(1, "Read", {}) }, T0), plain);
  assert.equal(snapshotRoom(plain, T0).layout.reception, null);
});

test("on submitting a room_proposal the receptionist walks to the user's office, drops the folder in the tray and goes back", () => {
  let model = applyInput(withReception(), { type: "run", run: onboardingRun(1, "running") }, T0);
  model = applyInput(model, { type: "event", event: toolCall(2, "mcp__hq__hq_submit", { type: "room_proposal" }) }, T0 + 1000);
  const route = routeToUser(model.layout, model.layout.reception!.office);
  const leg = Math.max(500, (routeLength(route) / WALK_SPEED) * 1000);
  model = applyInput(model, { type: "approval", approval: { id: 7, room: RECEPTION_ROOM, agentId: RECEPTION_AGENT, status: "pending" } }, T0 + 1500);

  const walking = seen(model, T0 + 1000 + leg / 2);
  assert.equal(walking.status.kind, "carrying");
  assert.equal(walking.carrying, true);
  assert.equal(walking.seated, false);

  const arrived = seen(model, T0 + 1000 + leg + 100);
  assert.equal(arrived.status.kind, "dropping");
  assert.deepEqual([arrived.x, arrived.y], [model.layout.user.stand.x, model.layout.user.stand.y]);
  assert.equal(snapshotRoom(model, T0 + 1000 + leg + 100).pending, 0, "the folder is not in the tray yet");
  assert.equal(snapshotRoom(model, T0 + 1000 + leg + 900).pending, 1, "the receptionist's proposal counts in the tray");
  assert.equal(seen(model, T0 + 1000 + leg + DROP_STAY_MS + leg / 2).status.kind, "returning");
  assert.equal(seen(model, T0 + 1000 + 2 * leg + DROP_STAY_MS + 200).seated, true);
});

test("a failed onboarding run puts a question mark over the receptionist", () => {
  let model = applyInput(withReception(), { type: "run", run: onboardingRun(1, "running") }, T0);
  model = applyInput(model, { type: "run", run: onboardingRun(1, "failed") }, T0 + 500);
  const view = seen(model, T0 + 600);
  assert.equal(view.status.kind, "failed");
  assert.equal(view.bubble?.kind, "question");
  // Hydrated from a state whose last onboarding run failed: the same.
  const hydrated = applyInput(
    createRoomModel(ROOM),
    { type: "hydrate", agents: seeds, approvals: [], reception: { ...receptionist, lastRun: onboardingRun(4, "failed") } },
    T0,
  );
  assert.equal(seen(hydrated, T0 + 10).status.kind, "failed");
});

test("the store sends the reserved room's changes to the floor that has the reception, and to no other", () => {
  const store = createRoomStore();
  store.ingest({ kind: "state", state: stateWith([ROOM, "other"], { room: "other", sprite: null, runs: [onboardingRun(3, "done")] }) }, T0 - 600_000);
  assert.equal(store.get("other").reception, true);
  assert.equal(store.get(ROOM).reception, false);
  store.ingest({ kind: "run", run: onboardingRun(4, "running") }, T0);
  const view = seen(store.get("other"), T0 + 10);
  assert.equal(view.status.kind, "seated");
  assert.equal(view.name, "Accueil");
  assert.ok(snapshotRoom(store.get(ROOM), T0 + 10).agents.every((a) => a.status.kind === "asleep"));
});

test("the recorded onboarding fixture makes the receptionist type, then walk to the user's office", () => {
  const events = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "stream-json-onboarding.jsonl"), "utf8").split("\n").flatMap(parseStreamLine);
  let model = applyInput(withReception(), { type: "run", run: onboardingRun(1, "running") }, T0);
  const kinds = new Set<string>();
  events.forEach((event, index) => {
    if (event.type !== "tool_call") return;
    const at = T0 + (index + 1) * 1000;
    model = applyInput(model, { type: "event", event: toolCall(index + 1, event.name, event.input) }, at);
    kinds.add(seen(model, at + 50).status.kind);
  });
  assert.ok(kinds.has("typing"), "it types while it reads the repository");
  assert.ok(kinds.has("carrying"), "it carries the proposal");
});

// ---- Which floor, and the state ------------------------------------------------------------------------------

test("the reception floor: the configured room, else assistant, else the first room, else none", () => {
  assert.equal(resolveReceptionRoom(["demo", "assistant", "zed"], "zed"), "zed");
  assert.equal(resolveReceptionRoom(["demo", "assistant"], null), "assistant");
  assert.equal(resolveReceptionRoom(["demo", "assistant"], "ghost"), "assistant", "an unknown room falls back to the default");
  assert.equal(resolveReceptionRoom(["demo", "zed"], null), "demo");
  assert.equal(resolveReceptionRoom([], "x"), null);
});

function addRoom(home: string, name: string) {
  const dir = path.join(home, "rooms", name);
  fs.mkdirSync(path.join(dir, "roles"), { recursive: true });
  fs.writeFileSync(path.join(dir, "roles", "bot.md"), "You are a test agent.\n");
  const agent = { id: "bot", name: "Bot", role: "roles/bot.md", model: "haiku", allowedTools: ["mcp__hq__*"] };
  fs.writeFileSync(path.join(dir, "room.json"), JSON.stringify({ name, targetRepo: "../x", agents: [agent] }));
}

test("the state says which floor has the reception (myhq.json, then assistant, then the first room) and lists the onboarding runs", () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const stateOf = () => getState(db, loadHome(config.home), schedulerInfo(config));
  assert.equal(stateOf().reception.room, "demo", "the first room by default");
  addRoom(config.home, "assistant");
  assert.equal(stateOf().reception.room, "assistant", "the room called assistant by default");
  fs.writeFileSync(path.join(config.home, "myhq.json"), JSON.stringify({ reception: { room: "demo" } }));
  assert.equal(readReceptionRoom(config.home), "demo");
  assert.equal(stateOf().reception.room, "demo", "myhq.json decides");
  fs.writeFileSync(path.join(config.home, "myhq.json"), JSON.stringify({ reception: { room: "ghost" } }));
  assert.equal(stateOf().reception.room, "assistant", "an unknown room falls back");

  const insert = db.prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at, cost_usd) VALUES (?, ?, 'claude', ?, ?, ?, ?)");
  insert.run(RECEPTION_ROOM, RECEPTION_AGENT, onboardingTask("../one"), "done", new Date(T0).toISOString(), 0.12);
  insert.run(RECEPTION_ROOM, RECEPTION_AGENT, onboardingTask("../two"), "failed", new Date(T0 + 1000).toISOString(), 0);
  insert.run("demo", "scout", "not onboarding", "done", new Date(T0).toISOString(), 0);
  const { runs } = stateOf().reception;
  assert.deepEqual(runs.map((run) => onboardingTarget(run.task)), ["../two", "../one"], "newest first, and only the receptionist's");
  assert.equal(runs[1]!.costUsd, 0.12);

  // No room: no floor.
  const empty = makeHome();
  fs.rmSync(path.join(empty.home, "rooms", "demo"), { recursive: true });
  assert.equal(getState(getDbAt(empty.dbPath), loadHome(empty.home), schedulerInfo(empty)).reception.room, null);
});

test("an onboarding run started from the API is the one the state lists, with its target", () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const repo = fs.mkdtempSync(path.join(config.home, "repo-"));
  const engine: Engine = {
    name: "test",
    async *run() {
      await new Promise((resolve) => setTimeout(resolve, 50));
    },
  } as unknown as Engine;
  const run = startOnboarding({ path: repo }, { config, engine, send: async () => true });
  assert.equal(run.room, RECEPTION_ROOM);
  const listed = getState(db, loadHome(config.home), schedulerInfo(config)).reception.runs;
  assert.equal(listed[0]!.id, run.id);
  assert.equal(onboardingTarget(listed[0]!.task), path.basename(repo));
});

test("the reducer keeps the onboarding runs newest first, from the state then from the stream", () => {
  let model = reducer(initialModel, {
    type: "state",
    state: stateWith([], { room: "demo", sprite: null, runs: [onboardingRun(2, "done"), onboardingRun(1, "done")] }),
  });
  model = reducer(model, { type: "run", run: onboardingRun(3, "running") });
  model = reducer(model, { type: "run", run: onboardingRun(3, "done", { costUsd: 0.2 }) });
  model = reducer(model, { type: "run", run: { ...onboardingRun(9, "done"), room: "demo", agentId: "scout" } });
  assert.deepEqual(model.reception.runs.map((run) => [run.id, run.status]), [[3, "done"], [2, "done"], [1, "done"]]);
});

test("the sheet of the receptionist lists the onboarding runs with their target and cost, and holds the add-a-room form", () => {
  const html = renderToStaticMarkup(
    ReceptionSheet({
      runs: [onboardingRun(5, "done", { task: onboardingTask("../tinylog"), costUsd: 0.31 }), onboardingRun(4, "failed", { task: "something else" })],
      dispatch: () => undefined,
      onClose: () => undefined,
    }),
  );
  assert.match(html, /aria-label="Fiche de Accueil"/);
  assert.match(html, /Tour #5 : Terminé/);
  assert.match(html, /Dépôt : \.\.\/tinylog/);
  assert.match(html, /Coût 0,31/);
  assert.match(html, /Tour #4 : Échoué/);
  assert.match(html, /Dépôt non précisé/);
  assert.match(html, /Ajouter une salle/);
  assert.match(html, /<form/);
  const empty = renderToStaticMarkup(ReceptionSheet({ runs: [], dispatch: () => undefined, onClose: () => undefined }));
  assert.match(empty, /Aucun tour d(&#x27;|')accueil/);
});

test("a home may give the receptionist its own sheet with onboarding.sprite", () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("sheet")]);
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const request = () => spriteResponse(new Request("http://localhost/api/sprites/_hq/onboarding"), config, RECEPTION_ROOM, RECEPTION_AGENT);
  assert.throws(request, /declares no sprite/);
  assert.equal(getState(db, loadHome(config.home), schedulerInfo(config)).reception.sprite, null);
  fs.mkdirSync(path.join(config.home, "sprites"));
  fs.writeFileSync(path.join(config.home, "sprites", "desk.png"), PNG);
  fs.writeFileSync(path.join(config.home, "myhq.json"), JSON.stringify({ onboarding: { sprite: "sprites/desk.png" } }));
  assert.equal(request().status, 200);
  assert.equal(getState(db, loadHome(config.home), schedulerInfo(config)).reception.sprite, "/api/sprites/_hq/onboarding");
});
