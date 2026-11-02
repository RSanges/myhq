import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { parseStreamLine } from "../src/server/claude-engine";
import type { HqEvent } from "../src/ui/schemas";
import { agentKey } from "../src/ui/model";
import {
  CORRIDOR_H,
  layoutRoom,
  officeOf,
  pointOnRoute,
  routeLength,
  routeToOffice,
  routeToUser,
  type Point,
  type RoomLayout,
} from "../src/ui/room-layout";
import {
  applyInput,
  ASLEEP_AFTER_MS,
  createRoomModel,
  DROP_STAY_MS,
  FOLDER_DROP_MS,
  IDLE_FPS,
  MAX_QUEUED_TRIPS,
  nextChangeAt,
  snapshotRoom,
  THOUGHT_CHARS,
  THOUGHT_MS,
  TYPING_MS,
  VISIT_STAY_MS,
  WALK_SPEED,
  type AgentView,
  type RoomInput,
  type RoomModel,
  type RoomView,
} from "../src/ui/room-model";

// The room replayed on the fixtures of test/fixtures with a fake clock, like
// scripts/replay-fixture.ts does against the real stream: one event per second.

const T0 = Date.parse("2026-11-02T10:00:00.000Z");
const ROOM = "demo";
const STEP = 1_000;
const seeds = [
  { id: "scout", name: "Scout", lastRun: null },
  { id: "writer", name: "Writer", lastRun: null },
  { id: "analyst", name: "Analyst", lastRun: null },
];
const SCOUT = agentKey(ROOM, "scout");
const WRITER = agentKey(ROOM, "writer");

type Step = { at: number; input: RoomInput };

const run = (id: number, status: "running" | "done" | "failed", agentId = "scout") => ({
  id,
  room: ROOM,
  agentId,
  status,
  startedAt: new Date(T0).toISOString(),
  endedAt: status === "running" ? null : new Date(T0).toISOString(),
});

function hydrated(): RoomModel {
  return applyInput(createRoomModel(ROOM), { type: "hydrate", agents: seeds, approvals: [] }, T0 - 600_000);
}

const toolCall = (id: number, name: string, input: unknown, agentId = "scout"): HqEvent => ({
  id,
  runId: 1,
  room: ROOM,
  agentId,
  type: "tool_call",
  data: { id: `toolu_${id}`, name, input },
  createdAt: new Date(T0).toISOString(),
});

/** The events of a fixture as the API stores them (`data` is the event without its type). */
function fixtureEvents(name: string, agentId = "scout"): HqEvent[] {
  return fs
    .readFileSync(path.join(import.meta.dirname, "fixtures", name), "utf8")
    .split("\n")
    .flatMap(parseStreamLine)
    .map((event, index) => {
      const { type, ...data } = event;
      return {
        id: index + 1,
        runId: 1,
        room: ROOM,
        agentId,
        type,
        data: data as Record<string, unknown>,
        createdAt: new Date(T0 + (index + 1) * STEP).toISOString(),
      };
    });
}

/** What scripts/replay-fixture.ts does: the run starts, then one event per second, an approval at the result of hq_submit. */
function replaySteps(events: HqEvent[], final: "done" | "failed" = "done"): Step[] {
  const agentId = events[0]!.agentId;
  const steps: Step[] = [{ at: T0, input: { type: "run", run: run(1, "running", agentId) } }];
  events.forEach((event, index) => {
    const at = T0 + (index + 1) * STEP;
    steps.push({ at, input: { type: "event", event } });
    const previous = events[index - 1];
    if (
      event.type === "tool_result" &&
      previous?.type === "tool_call" &&
      (previous.data as { name?: string }).name === "mcp__hq__hq_submit"
    ) {
      steps.push({ at, input: { type: "approval", approval: { id: 1, room: ROOM, agentId, status: "pending" } } });
    }
  });
  steps.push({ at: T0 + (events.length + 1) * STEP, input: { type: "run", run: run(1, final, agentId) } });
  return steps;
}

/** Applies the steps due at each probe time, in order, then reads the room at that time. */
function probe(model: RoomModel, steps: Step[], times: number[], reduced = false) {
  const pending = steps.slice().sort((a, b) => a.at - b.at);
  const views: RoomView[] = [];
  let current = model;
  for (const time of times) {
    while (pending.length > 0 && pending[0]!.at <= time) {
      const step = pending.shift()!;
      current = applyInput(current, step.input, step.at);
    }
    views.push(snapshotRoom(current, time, reduced));
  }
  return { views, model: current };
}

const agent = (view: RoomView, key = SCOUT): AgentView => view.agents.find((a) => a.key === key)!;
const legMs = (route: Point[]) => Math.max(500, (routeLength(route) / WALK_SPEED) * 1000);
const last = (route: Point[]) => route[route.length - 1]!;

test("a room of three agents starts asleep, offices on both sides of the corridor, nothing in the tray", () => {
  const view = snapshotRoom(hydrated(), T0);
  assert.deepEqual(view.agents.map((a) => a.status.kind), ["asleep", "asleep", "asleep"]);
  assert.deepEqual(view.agents.map((a) => a.pose), ["sleep", "sleep", "sleep"]);
  assert.equal(view.agents[0]!.bubble?.kind, "zzz");
  assert.equal(view.pending, 0);
  assert.deepEqual(view.layout.offices.map((o) => o.side), ["top", "bottom", "top"]);
  assert.equal(view.fps, IDLE_FPS);
  assert.equal(view.nextChangeAt, Number.POSITIVE_INFINITY);
});

test("onboarding run: types on each read, thinks on text, carries the item to the user's desk, the tray rises on the drop", () => {
  const events = fixtureEvents("stream-json-onboarding.jsonl");
  assert.equal(events.length, 24);
  const steps = replaySteps(events);
  const submitAt = T0 + 19 * STEP; // event 18 is the hq_submit call
  const layout = hydrated().layout;
  const office = layout.offices[0]!;
  const seat = office.seat;
  const route = routeToUser(layout, office);
  const leg = legMs(route);
  const times = [
    T0 + 500, // the run has started, nothing happened yet
    T0 + 2 * STEP + 100, // text
    T0 + 3 * STEP + 100, // first Read
    T0 + 3 * STEP + TYPING_MS + 100, // the next Read came at +2 s, typing goes on
    T0 + 15 * STEP + 100, // text before the last Read
    submitAt + 400, // walking to the user's desk
    submitAt + 1500, // the approval event came, the folder is still in hand
    submitAt + leg - 1,
    submitAt + leg + FOLDER_DROP_MS - 1,
    submitAt + leg + FOLDER_DROP_MS,
    submitAt + leg + DROP_STAY_MS - 1,
    submitAt + 2 * leg + DROP_STAY_MS + 1,
  ];
  const { views } = probe(hydrated(), steps, times);
  const [started, thinking, reading, stillReading, thinkingAgain, walking, carrying, arriving, beforeDrop, dropped, leaving, home] =
    views as [RoomView, RoomView, RoomView, RoomView, RoomView, RoomView, RoomView, RoomView, RoomView, RoomView, RoomView, RoomView];

  assert.equal(agent(started).status.kind, "seated");
  assert.equal(agent(started, WRITER).status.kind, "asleep");

  assert.equal(agent(thinking).status.kind, "thinking");
  assert.equal(agent(thinking).pose, "think");
  const bubble = agent(thinking).bubble;
  assert.equal(bubble?.kind, "thought");
  assert.match(bubble?.kind === "thought" ? bubble.text : "", /^I'll read the tinylog repository/);

  assert.equal(agent(reading).status.kind, "typing");
  assert.equal(agent(reading).pose, "type");
  assert.equal(agent(reading).bubble, null);
  assert.equal(agent(stillReading).status.kind, "typing");
  assert.equal(agent(thinkingAgain).status.kind, "thinking");

  const walker = agent(walking);
  assert.equal(walker.status.kind, "carrying");
  assert.equal(walker.pose, "walk");
  assert.equal(walker.seated, false);
  assert.equal(walker.carrying, true);
  assert.equal(walker.facing, 1);
  assert.ok(walker.x > seat.x && walker.x < layout.user.stand.x, "on its way");
  assert.equal(walking.pending, 0);

  assert.equal(agent(carrying).status.kind, "carrying");
  assert.equal(carrying.pending, 0, "the approval is known but the folder is not in the tray yet");
  assert.equal(agent(arriving).status.kind, "carrying");
  assert.equal(agent(beforeDrop).status.kind, "dropping");
  assert.equal(agent(beforeDrop).carrying, true);
  assert.equal(beforeDrop.pending, 0);
  assert.equal(agent(dropped).carrying, false);
  assert.equal(dropped.pending, 1, "the counter rises when the folder is dropped");
  assert.deepEqual([agent(dropped).x, agent(dropped).y], [layout.user.stand.x, layout.user.stand.y]);
  assert.equal(agent(leaving).status.kind, "dropping");
  assert.equal(agent(home).seated, true);
  assert.deepEqual([agent(home).x, agent(home).y], [seat.x, seat.y]);
});

test("after its run an agent stays awake for a minute, then sleeps", () => {
  const events = fixtureEvents("stream-json-tool-run.jsonl");
  assert.deepEqual(events.map((e) => e.type), ["start", "tool_call", "tool_result", "text", "end"]);
  const endAt = T0 + (events.length + 1) * STEP;
  const { views } = probe(hydrated(), replaySteps(events), [
    T0 + 2 * STEP + 100, // hq_task_update: a tool call like any other
    T0 + 4 * STEP + 100, // the final text
    endAt + ASLEEP_AFTER_MS - 1,
    endAt + ASLEEP_AFTER_MS,
  ]);
  assert.equal(agent(views[0]!).status.kind, "typing");
  assert.equal(agent(views[1]!).status.kind, "thinking");
  assert.equal(agent(views[2]!).status.kind, "seated");
  assert.equal(agent(views[3]!).status.kind, "asleep");
  assert.equal(agent(views[3]!).bubble?.kind, "zzz");
});

test("an hq_message walks to the table of the recipient, stays there, and comes back", () => {
  const events = fixtureEvents("stream-json-message.synthetic.jsonl");
  assert.deepEqual(
    events.map((e) => e.type),
    ["start", "text", "tool_call", "tool_result", "tool_call", "tool_result", "text", "end"],
  );
  assert.equal((events[2]!.data as { name: string }).name, "mcp__hq__hq_message");
  const model = hydrated();
  const scout = model.layout.offices[0]!;
  const writer = model.layout.offices[1]!;
  const route = routeToOffice(scout, writer);
  const stand = last(route);
  const leg = legMs(route);
  const messageAt = T0 + 3 * STEP;
  const { views } = probe(model, replaySteps(events), [
    messageAt + 100,
    messageAt + leg / 2,
    messageAt + leg + 1,
    messageAt + leg + VISIT_STAY_MS - 1,
    messageAt + leg + VISIT_STAY_MS + 100,
    messageAt + 2 * leg + VISIT_STAY_MS + 1,
  ]);
  const [leaving, middle, arrived, talking, returning, back] = views.map((v) => agent(v)) as AgentView[] & { length: 6 };
  assert.deepEqual(leaving.status, { kind: "visiting", target: "Writer" });
  assert.equal(leaving.pose, "walk");
  assert.deepEqual(leaving.coarse, { kind: "visiting", target: "Writer" });
  assert.ok(Math.hypot(middle.x - scout.seat.x, middle.y - scout.seat.y) > 20, "on its way");
  assert.ok(Math.hypot(middle.x - stand.x, middle.y - stand.y) > 20);
  assert.deepEqual(arrived.status, { kind: "talking", target: "Writer" });
  assert.equal(arrived.pose, "stand");
  assert.deepEqual(arrived.bubble, { kind: "talk" });
  assert.deepEqual([arrived.x, arrived.y], [stand.x, stand.y]);
  assert.equal(arrived.facing, 1, "facing the desk of the recipient");
  assert.equal(talking.status.kind, "talking");
  assert.deepEqual(returning.status, { kind: "returning" });
  assert.equal(returning.carrying, false);
  assert.deepEqual([back.x, back.y], [scout.seat.x, scout.seat.y]);
  assert.equal(back.seated, true);
  // The recipient did nothing: it sleeps.
  assert.equal(agent(views[2]!, WRITER).status.kind, "asleep");
});

test("a message to somebody who is not in the room is only a tool call", () => {
  const events = fixtureEvents("stream-json-message.synthetic.jsonl");
  (events[2]!.data as { input: { to: string } }).input.to = "nobody";
  const { views } = probe(hydrated(), replaySteps(events), [T0 + 3 * STEP + 100]);
  assert.equal(agent(views[0]!).status.kind, "typing");
});

test("a failed run shows a question mark until the next run or an action of the user", () => {
  const events = fixtureEvents("stream-json-auth-error.jsonl");
  assert.deepEqual(events.map((e) => e.type), ["start", "text", "end"]);
  const endAt = T0 + (events.length + 1) * STEP;
  const { views, model } = probe(hydrated(), replaySteps(events, "failed"), [endAt, endAt + 10 * ASLEEP_AFTER_MS]);
  for (const view of views) {
    assert.equal(agent(view).status.kind, "failed");
    assert.deepEqual(agent(view).bubble, { kind: "question" });
    assert.deepEqual(agent(view).coarse, { kind: "stuck" });
  }

  const nextRun = applyInput(model, { type: "run", run: run(2, "running") }, endAt + 1000);
  assert.equal(agent(snapshotRoom(nextRun, endAt + 1001)).status.kind, "seated");

  const decided = applyInput(
    model,
    { type: "approval", approval: { id: 9, room: ROOM, agentId: "scout", status: "approved" } },
    endAt + 5000,
  );
  assert.equal(agent(snapshotRoom(decided, endAt + 5001)).bubble, null);
});

test("a task update with status blocked raises a question mark that tool calls do not hide", () => {
  const model = applyInput(hydrated(), { type: "run", run: run(1, "running") }, T0);
  let current = applyInput(
    model,
    { type: "event", event: toolCall(1, "mcp__hq__hq_task_update", { status: "blocked", note: "Need a decision." }) },
    T0 + 1000,
  );
  assert.deepEqual(agent(snapshotRoom(current, T0 + 1100)).status, { kind: "blocked" });
  current = applyInput(current, { type: "event", event: toolCall(2, "WebSearch", { query: "x" }) }, T0 + 2000);
  assert.equal(agent(snapshotRoom(current, T0 + 2100)).status.kind, "blocked");
  current = applyInput(current, { type: "run", run: run(1, "done") }, T0 + 3000);
  assert.equal(agent(snapshotRoom(current, T0 + 600_000)).status.kind, "blocked", "a question mark does not fall asleep");
  // An update with another status does not raise it.
  const fine = applyInput(model, { type: "event", event: toolCall(3, "mcp__hq__hq_task_update", { status: "done" }) }, T0 + 1000);
  assert.equal(agent(snapshotRoom(fine, T0 + 1100)).status.kind, "typing");
});

test("a thought is cut to the start of the text, and ends by itself", () => {
  const long = `${"word ".repeat(40)}end`;
  const text: HqEvent = {
    id: 1,
    runId: 1,
    room: ROOM,
    agentId: "scout",
    type: "text",
    data: { text: `  ${long}\n\nsecond paragraph` },
    createdAt: "",
  };
  let model = applyInput(hydrated(), { type: "run", run: run(1, "running") }, T0);
  model = applyInput(model, { type: "event", event: text }, T0 + 1000);
  const bubble = agent(snapshotRoom(model, T0 + 1100)).bubble;
  assert.equal(bubble?.kind, "thought");
  const shown = bubble?.kind === "thought" ? bubble.text : "";
  assert.ok(shown.length <= THOUGHT_CHARS && shown.endsWith("..."));
  assert.ok(!shown.includes("\n"));
  assert.equal(agent(snapshotRoom(model, T0 + 1000 + THOUGHT_MS)).status.kind, "seated");
});

test("the tray counts pending items, shows what the snapshot already holds, and drops decided ones", () => {
  let model = applyInput(
    hydrated(),
    {
      type: "hydrate",
      agents: seeds,
      approvals: [
        { id: 1, room: ROOM, agentId: "scout", status: "pending" },
        { id: 2, room: ROOM, agentId: "writer", status: "pending" },
        { id: 3, room: ROOM, agentId: "writer", status: "approved" },
      ],
    },
    T0,
  );
  assert.equal(snapshotRoom(model, T0).pending, 2);
  model = applyInput(model, { type: "approval", approval: { id: 1, room: ROOM, agentId: "scout", status: "rejected" } }, T0 + 1);
  assert.equal(snapshotRoom(model, T0 + 1).pending, 1);
  // An item that no agent is carrying shows at once.
  model = applyInput(model, { type: "approval", approval: { id: 4, room: ROOM, agentId: "scout", status: "pending" } }, T0 + 2);
  assert.equal(snapshotRoom(model, T0 + 2).pending, 2);
  // An item of another room is not ours.
  model = applyInput(model, { type: "approval", approval: { id: 5, room: "other", agentId: "scout", status: "pending" } }, T0 + 3);
  assert.equal(snapshotRoom(model, T0 + 3).pending, 2);
});

test("a snapshot of the home reads the last run: running is awake, failed asks, a recent end is awake, an old one sleeps", () => {
  const iso = (ms: number) => new Date(ms).toISOString();
  const model = applyInput(
    createRoomModel(ROOM),
    {
      type: "hydrate",
      agents: [
        { id: "scout", name: "Scout", lastRun: { ...run(1, "running"), startedAt: iso(T0 - 5000) } },
        { id: "writer", name: "Writer", lastRun: { ...run(2, "failed", "writer"), endedAt: iso(T0 - 10 * 60_000) } },
        { id: "analyst", name: "Analyst", lastRun: { ...run(3, "done", "analyst"), endedAt: iso(T0 - 20_000) } },
        { id: "late", name: "Late", lastRun: { ...run(4, "done", "late"), endedAt: iso(T0 - 2 * ASLEEP_AFTER_MS) } },
      ],
      approvals: [],
    },
    T0,
  );
  assert.deepEqual(snapshotRoom(model, T0).agents.map((a) => a.status.kind), ["seated", "failed", "seated", "asleep"]);
});

test("reduced motion: no walking, held poses, a move is a crossfade and nothing is drawn while still", () => {
  const events = fixtureEvents("stream-json-message.synthetic.jsonl");
  const model = hydrated();
  const scout = model.layout.offices[0]!;
  const writer = model.layout.offices[1]!;
  const stand = last(routeToOffice(scout, writer));
  const leg = legMs(routeToOffice(scout, writer));
  const messageAt = T0 + 3 * STEP;
  const times = [messageAt + 10, messageAt + leg / 2, messageAt + leg - 10, messageAt + leg + 500];
  const { views } = probe(model, replaySteps(events), times, true);
  const [start, middle, end, staying] = views.map((v) => agent(v)) as AgentView[] & { length: 4 };
  assert.deepEqual([start.x, start.y, start.alpha], [scout.seat.x, scout.seat.y, 1], "still at its desk, fully visible");
  assert.ok(middle.alpha < 0.05, "invisible in the middle of the move");
  assert.ok(end.alpha > 0.9);
  assert.deepEqual([end.x, end.y], [stand.x, stand.y], "no point between the two offices");
  assert.deepEqual([staying.x, staying.y], [stand.x, stand.y]);
  for (const view of [start, middle, end, staying]) assert.equal(view.frame, 0);
  assert.equal(views[3]!.fps, 0, "redrawn only when something changes");
  assert.ok(views[1]!.fps > 0, "a fade asks for frames");

  assert.equal(snapshotRoom(hydrated(), T0, true).fps, 0);
  assert.ok(snapshotRoom(hydrated(), T0, false).fps > 0);
});

test("frames of a pose follow the clock, and hold in reduced motion", () => {
  const model = applyInput(hydrated(), { type: "run", run: run(1, "running") }, T0);
  const typing = applyInput(model, { type: "event", event: toolCall(1, "Read", {}) }, T0);
  const frames = new Set<number>();
  for (let t = 0; t < 600; t += 50) frames.add(agent(snapshotRoom(typing, T0 + t)).frame);
  assert.deepEqual([...frames].sort(), [0, 1]);
  assert.equal(agent(snapshotRoom(typing, T0 + 300, true)).frame, 0);
});

test("nextChangeAt names the next moment something ends by itself", () => {
  const model = applyInput(hydrated(), { type: "run", run: run(1, "running") }, T0);
  const typing = applyInput(model, { type: "event", event: toolCall(1, "Read", {}) }, T0 + 1000);
  assert.equal(nextChangeAt(typing, T0 + 1000), T0 + 1000 + TYPING_MS);
  const done = applyInput(typing, { type: "run", run: run(1, "done") }, T0 + 2000);
  assert.equal(nextChangeAt(done, T0 + 1000 + TYPING_MS), T0 + 2000 + ASLEEP_AFTER_MS);
});

test("trips queue behind each other, up to a limit", () => {
  let model = applyInput(hydrated(), { type: "run", run: run(1, "running") }, T0);
  for (let i = 1; i <= MAX_QUEUED_TRIPS + 4; i += 1) {
    model = applyInput(
      model,
      { type: "event", event: toolCall(i, "mcp__hq__hq_message", { to: "writer", text: "hi" }) },
      T0 + i * 10,
    );
  }
  const trips = model.agents[0]!.trips;
  assert.ok(trips.length >= 2 && trips.length <= MAX_QUEUED_TRIPS + 1);
  for (let i = 1; i < trips.length; i += 1) {
    const before = trips[i - 1]!;
    assert.ok(trips[i]!.start >= before.start + before.legMs * 2 + before.stayMs);
  }
});

test("an event of another room, or of an agent that is not in the room, changes nothing", () => {
  const model = hydrated();
  assert.equal(applyInput(model, { type: "event", event: { ...toolCall(1, "Read", {}), room: "other" } }, T0), model);
  assert.equal(applyInput(model, { type: "event", event: toolCall(1, "Read", {}, "ghost") }, T0), model);
});

const inRect = (p: Point, r: { x: number; y: number; w: number; h: number }) =>
  p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

/** A route never crosses the wall of the corridor or of the user's office outside a door. */
function assertThroughDoors(layout: RoomLayout, route: Point[], label: string) {
  const sides = [layout.corridor.y, layout.corridor.y + CORRIDOR_H];
  const gaps = layout.offices.map((o) => o.door);
  for (let i = 1; i < route.length; i += 1) {
    const a = route[i - 1]!;
    const b = route[i]!;
    for (const wallY of sides) {
      if ((a.y - wallY) * (b.y - wallY) < 0) {
        const t = (wallY - a.y) / (b.y - a.y);
        const x = a.x + (b.x - a.x) * t;
        if (x >= layout.user.room.x) continue; // inside the user's office
        assert.ok(
          gaps.some((door) => door.y === wallY && Math.abs(x - door.x) <= door.w / 2),
          `${label}: crosses a wall at ${x.toFixed(0)},${wallY}`,
        );
      }
    }
    const wallX = layout.user.room.x;
    if ((a.x - wallX) * (b.x - wallX) < 0) {
      const t = (wallX - a.x) / (b.x - a.x);
      const y = a.y + (b.y - a.y) * t;
      assert.ok(Math.abs(y - layout.user.door.y) <= layout.user.door.w / 2, `${label}: crosses the user's wall at ${y.toFixed(0)}`);
    }
  }
}

test("layout: offices on both sides of a corridor, built from the number of agents, routes through the doors", () => {
  for (let count = 1; count <= 12; count += 1) {
    const layout = layoutRoom(Array.from({ length: count }, (_, i) => `r/a${i}`));
    assert.equal(layout.offices.length, count);
    assert.equal(layout.vacant.length, count % 2);
    assert.equal(new Set(layout.offices.map((o) => `${o.room.x},${o.room.y}`)).size, count, "no two offices share a place");
    for (const [index, office] of layout.offices.entries()) {
      assert.equal(office.side, index % 2 === 0 ? "top" : "bottom");
      for (const p of [office.seat, office.plate, ...office.exit, ...office.visit]) {
        assert.ok(p.x > 0 && p.x < layout.width && p.y > 0 && p.y < layout.height);
      }
      assert.ok(inRect(office.seat, office.room), "the desk is inside the office");
      assert.equal(office.exit[office.exit.length - 1]!.y, layout.lineY);
      assertThroughDoors(layout, office.exit, `exit of ${office.key}`);
      assertThroughDoors(layout, routeToUser(layout, office), `to the user from ${office.key}`);
      for (const other of layout.offices) {
        if (other !== office) assertThroughDoors(layout, routeToOffice(office, other), `${office.key} to ${other.key}`);
      }
    }
    assert.ok(inRect(layout.user.stand, layout.user.room));
    assert.ok(layout.user.room.w > layout.offices[0]!.room.w, "the user's office is the larger one");
    assert.ok(layout.width / layout.height > 1.4 && layout.width / layout.height < 4.5, "a plan that fits a wide screen");
  }
  assert.ok(layoutRoom(Array.from({ length: 9 }, (_, i) => `r/a${i}`)).width > layoutRoom(["r/a", "r/b"]).width);
  assert.equal(officeOf(layoutRoom(["r/a"]), "r/zzz"), null);
});

test("a route is walked at a fraction of its length, facing the way it goes", () => {
  const route = [
    { x: 0, y: 0 },
    { x: 0, y: 10 },
    { x: 30, y: 10 },
    { x: 30, y: 0 },
  ];
  assert.equal(routeLength(route), 50);
  assert.deepEqual(pointOnRoute(route, 0).point, { x: 0, y: 0 });
  assert.deepEqual(pointOnRoute(route, 1).point, { x: 30, y: 0 });
  const half = pointOnRoute(route, 0.5);
  assert.deepEqual(half.point, { x: 15, y: 10 });
  assert.equal(half.facing, 1);
  assert.equal(pointOnRoute(route, 0.1).facing, 1, "a vertical segment keeps the nearest horizontal direction");
  assert.equal(pointOnRoute([{ x: 20, y: 0 }, { x: 0, y: 0 }], 0.5).facing, -1);
});
