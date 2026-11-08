import assert from "node:assert/strict";
import { test } from "node:test";
import { recentRuns } from "../src/ui/agent-runs";
import { agentKey, initialModel, reducer, selectAgents } from "../src/ui/model";
import { buildBoard } from "../src/ui/room-board";
import { snapshotRoom } from "../src/ui/room-model";
import { createRoomStore } from "../src/ui/room-store";
import type { Firing, HqEvent, Run, State, Usage } from "../src/ui/schemas";

const run = (over: Partial<Run> = {}): Run => ({
  id: 1,
  room: "demo",
  agentId: "scout",
  engine: "claude",
  task: "t",
  status: "done",
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  costUsd: 0.05,
  startedAt: "2026-11-02T10:00:00.000Z",
  endedAt: "2026-11-02T10:01:00.000Z",
  summary: null,
  ...over,
});

const state: State = {
  cursor: 3,
  rooms: [
    {
      name: "demo",
      color: null,
      agents: [
        {
          id: "scout",
          name: "Scout",
          model: "haiku",
          role: "rooms/demo/roles/scout.md",
          allowedTools: ["WebSearch"],
          sprite: null,
          armed: true,
          routines: [{ cron: "0 7 * * *", task: null, nextAt: "2026-11-03T06:00:00.000Z" }],
          lastRun: run({ status: "running", endedAt: null }),
        },
        {
          id: "writer",
          name: "Writer",
          model: "haiku",
          role: "rooms/demo/roles/writer.md",
          allowedTools: [],
          sprite: null,
          armed: false,
          routines: [{ cron: "0 8 * * *", task: null, nextAt: "2026-11-03T07:00:00.000Z" }],
          lastRun: null,
        },
      ],
    },
  ],
  invalidRooms: [],
  reception: { room: null, sprite: null, runs: [] },
  floor: { layout: "floor-per-project", owner: null },
  scheduler: { enabled: true, running: true, timeZone: "Europe/Paris" },
  firings: [],
  approvals: { pending: [], unseen: [], history: [] },
  recent: { events: [], messages: [] },
};

const usage: Usage = {
  today: { runs: 3, inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, costUsd: 0.17 },
  week: { runs: 3, inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, costUsd: 0.4 },
  cap: { maxRunsPerDay: 12, runsToday: 3, remaining: 9 },
  budget: null,
  agents: null,
  chat: null,
};

const firing = (over: Partial<Firing> = {}): Firing => ({
  id: 1,
  room: "demo",
  agentId: "scout",
  cron: "0 7 * * *",
  task: null,
  scheduledAt: "2026-11-02T06:00:00.000Z",
  outcome: "started",
  runId: 1,
  detail: null,
  createdAt: "2026-11-02T06:00:04.000Z",
  ...over,
});

const agentsOf = () => selectAgents(reducer(initialModel, { type: "state", state }));

test("the whiteboard: runs against the cap, cost, week, routines armed, next fire and last firing", () => {
  const rows = buildBoard({ room: "demo", agents: agentsOf(), usage, firings: [firing()], schedulerEnabled: true });
  const byKey = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  assert.deepEqual(
    rows.map((row) => row.key),
    ["runs", "cost", "week", "routines", "next", "last"],
  );
  assert.equal(byKey.runs, "3 sur 12");
  assert.match(byKey.cost!, /0,17/);
  assert.match(byKey.week!, /0,40/);
  assert.equal(byKey.routines, "1 armée sur 2");
  assert.match(byKey.next!, /^Scout, /, "only an armed agent counts for the next fire");
  assert.match(byKey.last!, /^Scout, .*\(Lancée\)$/);
});

test("the whiteboard shows the budget share when there is one, and says when the scheduler is off", () => {
  const rows = buildBoard({
    room: "demo",
    agents: agentsOf(),
    usage: { ...usage, budget: { weeklyUsd: 10, spentUsd: 1.7, share: 0.17 } },
    firings: [],
    schedulerEnabled: false,
  });
  const byKey = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  assert.equal(byKey.budget, "17 %");
  assert.equal(byKey.week, undefined);
  assert.equal(byKey.next, "planificateur éteint");
  assert.equal(byKey.last, "aucun");
  const unknown = buildBoard({ room: "demo", agents: agentsOf(), usage: null, firings: [], schedulerEnabled: true });
  assert.equal(unknown[0]!.value, "...");
});

const event = (id: number, runId: number, type: HqEvent["type"], data: Record<string, unknown> = {}): HqEvent => ({
  id,
  runId,
  room: "demo",
  agentId: "scout",
  type,
  data,
  createdAt: `2026-11-02T10:0${id}:00.000Z`,
});

test("recent runs are rebuilt from the events, newest first, with status and cost", () => {
  const events = [
    event(1, 1, "start"),
    event(2, 1, "end", { status: "failed", summary: "x", costUsd: 0 }),
    event(3, 2, "start"),
    event(4, 2, "text", { text: "hello" }),
    event(5, 2, "end", { status: "done", summary: "ok", costUsd: 0.12 }),
    event(6, 3, "start"),
    { ...event(7, 9, "start"), agentId: "writer" },
  ];
  const runs = recentRuns(events, agentKey("demo", "scout"));
  assert.deepEqual(
    runs.map((r) => [r.runId, r.status, r.costUsd, r.events.length]),
    [
      [3, "running", null, 1],
      [2, "done", 0.12, 3],
      [1, "failed", 0, 2],
    ],
  );
  assert.equal(recentRuns(events, agentKey("demo", "scout"), null, 2).length, 2);
  // The agent's last run, as the API gives it, wins for that run (a cancelled run has no end event).
  const cancelled = recentRuns(events, agentKey("demo", "scout"), run({ id: 3, status: "cancelled", costUsd: 0.01 }));
  assert.deepEqual([cancelled[0]!.status, cancelled[0]!.costUsd], ["cancelled", 0.01]);
});

test("the store hydrates a model per room from the state, then follows the stream", () => {
  const store = createRoomStore();
  let notified = 0;
  const stop = store.subscribe(() => {
    notified += 1;
  });
  const at = Date.parse("2026-11-02T10:00:00.000Z");
  store.ingest({ kind: "state", state }, at);
  assert.equal(notified, 1);
  assert.deepEqual(
    snapshotRoom(store.get("demo"), at).agents.map((a) => [a.name, a.status.kind]),
    [
      ["Scout", "seated"],
      ["Writer", "asleep"],
    ],
  );
  store.ingest({ kind: "run", run: run({ id: 2, agentId: "writer", status: "running", endedAt: null }) }, at + 1000);
  assert.equal(snapshotRoom(store.get("demo"), at + 1001).agents[1]!.status.kind, "seated");
  assert.equal(notified, 2);
  // A change of a room the store does not know changes nothing and tells nobody.
  store.ingest({ kind: "run", run: run({ room: "ghost" }) }, at + 2000);
  assert.equal(notified, 2);
  stop();
  store.ingest({ kind: "run", run: run({ id: 3, agentId: "writer", status: "done" }) }, at + 3000);
  assert.equal(notified, 2);
  assert.equal(snapshotRoom(store.get("ghost"), at).agents.length, 0);
});
