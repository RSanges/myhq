import assert from "node:assert/strict";
import { test } from "node:test";
import { focusZoom } from "../src/ui/floor-view";
import { formatWhen } from "../src/ui/format";
import { initialModel, reducer } from "../src/ui/model";
import { roomDigest, type SheetAgentInput } from "../src/ui/room-sheet-model";
import { scheduleText } from "../src/ui/schedule";
import type { Approval, HqEvent, Run, Schedule, State, Usage } from "../src/ui/schemas";

const schedule = (over: Partial<Schedule> = {}): Schedule => ({
  times: ["07:00"],
  weekdays: null,
  monthDays: null,
  months: null,
  dayRule: "and",
  ...over,
});

test("a routine's schedule reads in French, or as its expression when words would not help", () => {
  assert.equal(scheduleText(schedule()), "Tous les jours à 7 h");
  assert.equal(scheduleText(schedule({ times: ["08:00"], weekdays: [1, 2, 3, 4, 5] })), "Du lundi au vendredi à 8 h");
  assert.equal(scheduleText(schedule({ times: ["06:00"], weekdays: [2, 4] })), "Le mardi et le jeudi à 6 h");
  assert.equal(scheduleText(schedule({ times: ["17:00"], weekdays: [5] })), "Le vendredi à 17 h");
  assert.equal(scheduleText(schedule({ times: ["10:00"], weekdays: [0, 6] })), "Le samedi et le dimanche à 10 h");
  assert.equal(scheduleText(schedule({ times: ["09:00"], weekdays: [1, 3, 5] })), "Le lundi, le mercredi et le vendredi à 9 h");
  assert.equal(scheduleText(schedule({ times: ["10:00"], monthDays: [3] })), "Le 3 de chaque mois à 10 h");
  assert.equal(scheduleText(schedule({ times: ["06:00"], monthDays: [1, 15] })), "Le 1er et le 15 de chaque mois à 6 h");
  assert.equal(scheduleText(schedule({ times: ["07:00", "19:30"] })), "Tous les jours à 7 h et 19 h 30");
  assert.equal(scheduleText(schedule({ times: null })), null);
  assert.equal(scheduleText(schedule({ months: [1] })), null);
  assert.equal(scheduleText(schedule({ weekdays: [5], monthDays: [13], dayRule: "or" })), null);
  assert.equal(scheduleText(undefined), null);
});

test("a click on a room zooms to about the size of the view, by whole steps, closer than the overview", () => {
  // A small room that fits whole at 2 keeps 2; a big one that fits at 1.4 only still gets one step closer.
  assert.equal(focusZoom(1.98, 1, 1, 6), 2);
  assert.equal(focusZoom(1.4, 1, 1, 6), 2);
  assert.equal(focusZoom(1.2, 1, 1, 6), 2);
  // A big screen: the nearest whole step, over the overview's.
  assert.equal(focusZoom(2.6, 1, 1, 6), 3);
  assert.equal(focusZoom(4.1, 2, 1, 6), 4);
  // A room already far bigger than the view (a phone): no step that would push it out of sight.
  assert.equal(focusZoom(0.6, 1, 1, 6), 1);
  assert.equal(focusZoom(9, 1, 1, 6), 6);
});

test("near times read as today, yesterday, tomorrow or a date", () => {
  const at = new Date(2026, 10, 4, 21, 0).getTime();
  assert.equal(formatWhen(new Date(2026, 10, 4, 19, 0).toISOString(), at), "à 19:00");
  assert.equal(formatWhen(new Date(2026, 10, 3, 19, 0).toISOString(), at), "hier à 19:00");
  assert.equal(formatWhen(new Date(2026, 10, 5, 7, 0).toISOString(), at), "demain à 07:00");
  assert.match(formatWhen(new Date(2026, 10, 9, 6, 0).toISOString(), at), /^le 9 nov\.? à 06:00$/);
});

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
  costUsd: 0,
  startedAt: "2026-11-04T10:00:00.000Z",
  endedAt: null,
  summary: null,
  ...over,
});

const agent = (id: string, over: Partial<SheetAgentInput> = {}): SheetAgentInput => ({
  key: `demo/${id}`,
  id,
  name: id,
  lastRun: null,
  armed: false,
  routines: [],
  ...over,
});

const pendingItem = (id: number, agentId: string, room = "demo"): Approval => ({
  id,
  room,
  agentId,
  runId: null,
  type: "post",
  title: "x",
  body: "",
  payload: {},
  status: "pending",
  decisionNote: null,
  annotations: [],
  decisionHistory: [],
  actionDone: false,
  informational: false,
  decidedAt: null,
  createdAt: "2026-11-04T10:00:00.000Z",
});

const totals = { runs: 0, inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, costUsd: 0 };

test("the sheet of a room: decisions, cost of the day, and what each agent does", () => {
  const event = (id: number, runId: number, text: string): HqEvent => ({
    id,
    runId,
    room: "demo",
    agentId: "scout",
    type: "text",
    data: { text },
    createdAt: "2026-11-04T10:01:00.000Z",
  });
  const usage = {
    today: totals,
    week: totals,
    cap: { maxRunsPerDay: 12, runsToday: 3, remaining: 9 },
    budget: null,
    chat: null,
    agents: {
      today: [
        { ...totals, room: "demo", agentId: "scout", runs: 2, costUsd: 0.25 },
        { ...totals, room: "demo", agentId: "dev", runs: 1, costUsd: 0.5 },
        { ...totals, room: "other", agentId: "x", runs: 4, costUsd: 9 },
      ],
      week: [],
    },
  } as Usage;
  const digest = roomDigest({
    room: "demo",
    agents: [
      agent("scout", { lastRun: run({ id: 7, status: "running" }) }),
      agent("dev", { lastRun: run({ id: 5, summary: "\n  Merged the fix.\nThen more." }), waitingFor: ["gpu"] }),
      agent("writer", { lastRun: run({ id: 4, status: "failed" }) }),
      agent("social"),
      agent("analyst", { lastRun: run({ id: 3 }) }),
    ],
    pending: 3,
    approvals: [pendingItem(1, "social"), pendingItem(2, "social"), pendingItem(3, "writer", "other")],
    events: [event(1, 7, "Reading the forums"), event(2, 6, "an older run"), event(3, 7, "\nComparing two threads\nand more")],
    usage,
    blocked: new Set(["demo/analyst"]),
  });
  assert.equal(digest.pending, 3);
  assert.deepEqual(digest.today, { runs: 3, costUsd: 0.75 });
  assert.deepEqual(
    digest.agents.map((each) => [each.name, each.state, each.line]),
    [
      ["scout", { kind: "working" }, { kind: "thought", text: "Comparing two threads" }],
      ["dev", { kind: "resource", resources: ["gpu"] }, { kind: "summary", text: "Merged the fix." }],
      ["writer", { kind: "failed" }, { kind: "noSummary" }],
      ["social", { kind: "deciding", count: 2 }, { kind: "noRun" }],
      ["analyst", { kind: "stuck" }, { kind: "noSummary" }],
    ],
  );
  // A run that has not said anything yet: since when it runs.
  const quiet = roomDigest({
    room: "demo",
    agents: [agent("scout", { lastRun: run({ id: 9, status: "running" }) })],
    pending: 0,
    approvals: [],
    events: [],
    usage: null,
    blocked: new Set(),
  });
  assert.deepEqual(quiet.agents[0]!.line, { kind: "running", since: "2026-11-04T10:00:00.000Z" });
  assert.equal(quiet.today, null);
});

test("a refresh of the routines moves their next fire and their armed state", () => {
  const state = {
    cursor: 0,
    rooms: [
      {
        name: "demo",
        color: null,
        agents: [
          {
            id: "scout",
            name: "Scout",
            model: "haiku",
            role: "r.md",
            allowedTools: [],
            sprite: null,
            armed: false,
            routines: [{ cron: "0 7 * * *", task: null, nextAt: "2026-11-04T06:00:00.000Z" }],
            lastRun: null,
          },
          { id: "dev", name: "Dev", model: "haiku", role: "d.md", allowedTools: [], sprite: null, armed: false, routines: [], lastRun: null },
        ],
      },
    ],
    invalidRooms: [],
    reception: { room: null, sprite: null, runs: [] },
    floor: { layout: "room-per-project" },
    scheduler: { enabled: true, running: true, timeZone: "UTC" },
    firings: [],
    approvals: { pending: [], unseen: [], history: [] },
    recent: { events: [], messages: [] },
  } as unknown as State;
  let model = reducer(initialModel, { type: "state", state });
  const routine = { cron: "0 7 * * *", task: null, nextAt: "2026-11-05T06:00:00.000Z", schedule: schedule() };
  model = reducer(model, {
    type: "routines",
    scheduler: state.scheduler,
    firings: [],
    agents: [{ room: "demo", agentId: "scout", armed: true, routines: [routine] }],
  });
  const [scout, dev] = model.rooms[0]!.agents;
  assert.equal(scout!.armed, true);
  assert.deepEqual(scout!.routines, [routine]);
  assert.deepEqual(dev!.routines, []);
});
