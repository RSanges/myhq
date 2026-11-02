import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentState,
  buildFeed,
  initialModel,
  payloadUrl,
  branchHandover,
  pendingTitle,
  reducer,
  roleFileName,
  selectAgents,
  selectHistory,
  selectPending,
  upsertById,
  viewEvent,
} from "../src/ui/model";
import type { Approval, HqEvent, Message, Run, State } from "../src/ui/schemas";
import { stateSchema } from "../src/ui/schemas";

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
  startedAt: "2026-11-02T10:00:00.000Z",
  endedAt: null,
  summary: null,
  ...over,
});

const approval = (over: Partial<Approval> = {}): Approval => ({
  id: 1,
  room: "demo",
  agentId: "scout",
  runId: null,
  type: "post",
  title: "T",
  body: "B",
  payload: {},
  status: "pending",
  decisionNote: null,
  decidedAt: null,
  createdAt: "2026-11-02T10:00:00.000Z",
  ...over,
});

const event = (over: Partial<HqEvent> = {}): HqEvent => ({
  id: 1,
  runId: 1,
  room: "demo",
  agentId: "scout",
  type: "text",
  data: { text: "hello" },
  createdAt: "2026-11-02T10:00:00.000Z",
  ...over,
});

const message = (over: Partial<Message> = {}): Message => ({
  id: 1,
  room: "demo",
  from: "scout",
  to: "writer",
  text: "hi",
  runId: null,
  createdAt: "2026-11-02T10:00:01.000Z",
  ...over,
});

const baseState = (over: Partial<State> = {}): State => ({
  cursor: 5,
  rooms: [
    {
      name: "demo",
      agents: [
        {
          id: "scout",
          name: "Scout",
          model: "sonnet",
          role: "rooms/demo/roles/scout.md",
          allowedTools: [],
          sprite: null,
          armed: true,
          routines: [{ cron: "0 7 * * *", task: null, nextAt: "2026-11-03T06:00:00.000Z" }],
          lastRun: null,
        },
        {
          id: "writer",
          name: "Writer",
          model: "opus",
          role: "rooms/demo/roles/writer.md",
          allowedTools: [],
          sprite: null,
          armed: false,
          routines: [],
          lastRun: run({ agentId: "writer", status: "failed" }),
        },
      ],
    },
  ],
  invalidRooms: [],
  scheduler: { enabled: true, running: true, timeZone: "Europe/Paris" },
  firings: [],
  approvals: {
    pending: [approval({ id: 2 })],
    history: [approval({ id: 1, status: "approved", decidedAt: "2026-11-02T11:00:00.000Z" })],
  },
  recent: { events: [event()], messages: [message()] },
  ...over,
});

test("state loads the snapshot and computes agent states from the latest run", () => {
  const model = reducer(initialModel, { type: "state", state: baseState() });
  assert.equal(model.loaded, true);
  assert.equal(model.cursor, 5);
  const agents = selectAgents(model);
  assert.deepEqual(
    agents.map((a) => [a.id, a.state]),
    [
      ["scout", "idle"],
      ["writer", "failed"],
    ],
  );
});

test("a streamed run updates the agent state, an older run does not", () => {
  let model = reducer(initialModel, { type: "state", state: baseState() });
  model = reducer(model, { type: "run", run: run({ id: 7, status: "running" }) });
  assert.equal(selectAgents(model)[0]!.state, "working");
  model = reducer(model, { type: "run", run: run({ id: 3, status: "failed" }) });
  assert.equal(selectAgents(model)[0]!.state, "working");
  model = reducer(model, { type: "run", run: run({ id: 7, status: "done" }) });
  assert.equal(selectAgents(model)[0]!.state, "idle");
});

test("agentState treats cancelled and missing runs as idle", () => {
  assert.equal(agentState(null), "idle");
  assert.equal(agentState(run({ status: "cancelled" })), "idle");
});

test("an approval decided over the stream moves from pending to history", () => {
  let model = reducer(initialModel, { type: "state", state: baseState() });
  assert.deepEqual(
    selectPending(model).map((a) => a.id),
    [2],
  );
  model = reducer(model, {
    type: "approval",
    approval: approval({ id: 2, status: "rejected", decisionNote: "no", decidedAt: "2026-11-02T12:00:00.000Z" }),
  });
  assert.deepEqual(selectPending(model), []);
  assert.deepEqual(
    selectHistory(model).map((a) => a.id),
    [2, 1],
  );
});

test("upsertById replaces by id, keeps order and caps the length", () => {
  const list = [
    { id: 1, v: "a" },
    { id: 3, v: "c" },
  ];
  assert.deepEqual(
    upsertById(list, { id: 2, v: "b" }, 10).map((i) => i.id),
    [1, 2, 3],
  );
  assert.equal(upsertById(list, { id: 3, v: "z" }, 10)[1]!.v, "z");
  assert.deepEqual(
    upsertById(list, { id: 4, v: "d" }, 2).map((i) => i.id),
    [3, 4],
  );
});

test("the feed is newest first and filtered by agent", () => {
  const events = [
    event({ id: 1, createdAt: "2026-11-02T10:00:00.000Z" }),
    event({ id: 2, agentId: "writer", createdAt: "2026-11-02T10:00:02.000Z" }),
  ];
  const messages = [message({ id: 1, createdAt: "2026-11-02T10:00:01.000Z" })];
  assert.deepEqual(
    buildFeed(events, messages, null).map((e) => e.key),
    ["event:2", "message:1", "event:1"],
  );
  assert.deepEqual(
    buildFeed(events, messages, "demo/scout").map((e) => e.key),
    ["message:1", "event:1"],
  );
  assert.deepEqual(
    buildFeed(events, messages, "demo/writer").map((e) => e.key),
    ["event:2", "message:1"],
  );
  assert.deepEqual(buildFeed(events, messages, "other/scout"), []);
});

test("viewEvent reads each event type and falls back on unexpected data", () => {
  assert.deepEqual(viewEvent(event({ type: "start", data: { model: "sonnet" } })), {
    kind: "start",
    model: "sonnet",
  });
  assert.deepEqual(viewEvent(event({ type: "tool_call", data: { name: "WebSearch", input: { q: "x" } } })), {
    kind: "tool_call",
    name: "WebSearch",
    input: JSON.stringify({ q: "x" }),
  });
  assert.deepEqual(viewEvent(event({ type: "tool_result", data: { isError: true, content: "boom" } })), {
    kind: "tool_result",
    isError: true,
    content: "boom",
  });
  assert.equal(viewEvent(event({ type: "text", data: {} })).kind, "unknown");
});

test("payloadUrl only accepts http and https links", () => {
  assert.equal(payloadUrl({ url: "https://example.com/a" }), "https://example.com/a");
  assert.equal(payloadUrl({ url: "javascript:alert(1)" }), null);
  assert.equal(payloadUrl({ url: 3 }), null);
  assert.equal(payloadUrl({}), null);
});

test("small helpers", () => {
  assert.equal(roleFileName("rooms/demo/roles/scout.md"), "scout.md");
  assert.equal(pendingTitle("MyHQ", 3), "(3) MyHQ");
  assert.equal(pendingTitle("MyHQ", 0), "MyHQ");
});

test("the state schema accepts the documented snapshot and ignores extra fields", () => {
  const snapshot = {
    ...baseState(),
    rooms: [
      {
        name: "demo",
        targetRepo: "../x",
        agents: [
          {
            id: "scout",
            name: "Scout",
            model: "sonnet",
            role: "r.md",
            allowedTools: [],
            cron: null,
            state: "idle",
            lastRun: null,
          },
        ],
      },
    ],
  };
  assert.equal(stateSchema.safeParse(snapshot).success, true);
  assert.equal(stateSchema.safeParse({ cursor: "x" }).success, false);
});

test("branchHandover gives the push and gh pr create commands of a branch item", () => {
  const item = {
    type: "pull_request",
    title: "Fix the date picker",
    payload: { branch: "hq/dev-date-picker", sha: "0123456789abcdef", title: 'Fix "dates" $HOME', summary: "Line one\nline two" },
  };
  assert.deepEqual(branchHandover(item), {
    branch: "hq/dev-date-picker",
    sha: "0123456789abcdef",
    commands:
      "git push -u origin hq/dev-date-picker\n" +
      `gh pr create --head hq/dev-date-picker --title "Fix 'dates' 'HOME" --body "Line one line two"`,
  });
  assert.equal(branchHandover({ ...item, type: "blog_post", payload: { branch: "hq/writer-post" } })?.sha, null);
  assert.match(branchHandover({ ...item, payload: { branch: "hq/x" } })!.commands, /--title "Fix the date picker" --body "Fix the date picker"/);
  assert.equal(branchHandover({ ...item, type: "community_reply" }), null);
  assert.equal(branchHandover({ ...item, payload: { branch: "x; rm -rf /" } }), null);
  assert.equal(branchHandover({ ...item, payload: { branch: "--force" } }), null);
  assert.equal(branchHandover({ ...item, payload: {} }), null);
});

test("the reducer keeps the scheduler, the journal and the armed state", () => {
  let model = reducer(initialModel, { type: "state", state: baseState() });
  assert.equal(model.scheduler.running, true);
  model = reducer(model, { type: "armed", room: "demo", agentId: "scout", armed: false });
  assert.equal(selectAgents(model).find((a) => a.id === "scout")!.armed, false);
  assert.equal(selectAgents(model).find((a) => a.id === "writer")!.armed, false);
  const firing = {
    id: 1,
    room: "demo",
    agentId: "scout",
    cron: "0 7 * * *",
    task: null,
    scheduledAt: "2026-11-03T06:00:00.000Z",
    outcome: "skipped_unarmed" as const,
    runId: null,
    detail: null,
    createdAt: "2026-11-03T06:00:01.000Z",
  };
  model = reducer(model, { type: "routines", scheduler: { enabled: false, running: false, timeZone: "UTC" }, firings: [firing] });
  assert.equal(model.scheduler.enabled, false);
  assert.deepEqual(model.firings, [firing]);
});
