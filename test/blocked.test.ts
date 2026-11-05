import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { POST as closeRoute } from "../src/app/api/blocked/close/route";
import { POST as relaunchRoute } from "../src/app/api/blocked/relaunch/route";
import { closeBlocked, listBlocked, relaunchBlocked, stuckAgents, type BlockedEntry } from "../src/server/blocked";
import type { HqConfig } from "../src/server/config";
import { getDbAt, type Db, type RunRow, type TaskRow } from "../src/server/db";
import { DeskCommands } from "../src/server/desk-command";
import { resolveDesk } from "../src/server/desk";
import type { Engine, RunEvent, RunInput } from "../src/server/engine";
import { HqError } from "../src/server/errors";
import { loadHome } from "../src/server/rooms";
import { strings } from "../src/ui/strings";
import { makeHome, waitForRun } from "./helpers";

// The Standard: the `blocked` source of the desk (what is stuck at the
// agents), its count, and its two actions, « Relancer » and « Clore ».

const saved = process.env.MYHQ_HOME;
afterEach(() => {
  if (saved === undefined) delete process.env.MYHQ_HOME;
  else process.env.MYHQ_HOME = saved;
});

const reasons = strings.deskModules.standard.reasons;
const usage = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const done: RunEvent = { type: "end", status: "done", reason: "success", summary: "ok", usage, costUsd: 0 };

function engine(seen: RunInput[] = []): Engine {
  return {
    name: "claude",
    async *run(input) {
      seen.push(input);
      yield done;
    },
  };
}

/** A room of five agents: two share the GPU, one queues its messages. */
function office(overrides: Partial<HqConfig> = {}): HqConfig {
  const base = { role: "roles/scout.md", model: "haiku", allowedTools: ["mcp__hq__*"] };
  return makeHome(overrides, {
    name: "demo",
    targetRepo: "../demo-project",
    color: "#ff3d7f",
    agents: [
      { id: "scout", name: "Scout", ...base, resources: ["gpu"] },
      { id: "painter", name: "Painter", ...base, resources: ["gpu"] },
      { id: "writer", name: "Writer", ...base, onMessage: "queue" },
      { id: "editor", name: "Editor", ...base },
      { id: "critic", name: "Critic", ...base },
    ],
  });
}

const ago = (minutes: number, from = Date.now()) => new Date(from - minutes * 60_000).toISOString();

function addRun(db: Db, agent: string, status: RunRow["status"], startedMinutesAgo: number, endedMinutesAgo: number | null, extra: Partial<RunRow> = {}): RunRow {
  const id = Number(
    db
      .prepare(
        "INSERT INTO runs (room, agent_id, engine, task, status, started_at, ended_at, summary, resources) VALUES ('demo', ?, 'claude', ?, ?, ?, ?, ?, ?)",
      )
      .run(
        agent,
        extra.task ?? "Do the routine work described in your role.",
        status,
        ago(startedMinutesAgo),
        endedMinutesAgo === null ? null : ago(endedMinutesAgo),
        extra.summary ?? null,
        extra.resources ?? "[]",
      ).lastInsertRowid,
  );
  return db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow;
}

function addTask(
  db: Db,
  agent: string,
  fields: { source?: TaskRow["source"]; status: TaskRow["status"]; created: string; updated?: string; note?: string; runId?: number; text?: string; fromAgent?: string },
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO tasks (room, agent_id, source, text, status, note, run_id, from_room, from_agent, created_at, updated_at)
         VALUES ('demo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        agent,
        fields.source ?? "message",
        fields.text ?? `A task of ${agent}`,
        fields.status,
        fields.note ?? null,
        fields.runId ?? null,
        fields.fromAgent ? "demo" : null,
        fields.fromAgent ?? null,
        fields.created,
        fields.updated ?? fields.created,
      ).lastInsertRowid,
  );
}

const list = (config: HqConfig, db: Db): BlockedEntry[] => listBlocked(db, loadHome(config.home), config);
const taskOf = (db: Db, id: number) => db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow;

test("blocked: a blocked task with its note, a failed run of the day with its instruction and the tasks it gave back", () => {
  const config = office();
  const db = getDbAt(config.dbPath);
  const finished = addRun(db, "scout", "done", 50, 45);
  const blocked = addTask(db, "scout", { status: "blocked", created: ago(60), updated: ago(45), note: "Needs the API key.", runId: finished.id });
  const noNote = addTask(db, "critic", { status: "blocked", created: ago(30), updated: ago(20), runId: finished.id });

  // A failed run two hours ago: its own instruction stays blocked, its mailbox task was given back at its end.
  const failed = addRun(db, "editor", "failed", 125, 120, { summary: "Budget exceeded." });
  const instruction = addTask(db, "editor", { source: "manual", status: "blocked", created: failed.started_at, updated: failed.ended_at!, note: "Budget exceeded.", runId: failed.id });
  const givenBack = addTask(db, "editor", { status: "pending", created: ago(130), updated: failed.ended_at! });

  // Left out: a failed run of two days ago, an interrupted run whose work a later run did.
  const old = addRun(db, "painter", "failed", 48 * 60, 48 * 60 - 1);
  addTask(db, "painter", { source: "manual", status: "blocked", created: old.started_at, note: "x", runId: old.id });
  const cancelled = addRun(db, "critic", "cancelled", 90, 89, { task: "Write the report." });
  addTask(db, "critic", { source: "manual", status: "blocked", created: cancelled.started_at, runId: cancelled.id });
  addRun(db, "critic", "done", 80, 70, { task: "Write the report." });

  const entries = list(config, db);
  assert.deepEqual(
    entries.map((entry) => [entry.entry, entry.agentId, entry.state, entry.taskIds]),
    [
      ["task", "critic", "blocked", [noNote]],
      ["task", "scout", "blocked", [blocked]],
      ["run", "editor", "failed", [instruction, givenBack]],
    ],
    "newest first; the instruction and the given-back task belong to the run",
  );
  assert.equal(entries[1]!.reason, reasons.blocked("Needs the API key."));
  assert.equal(entries[1]!.since, taskOf(db, blocked).updated_at, "since it was blocked");
  assert.equal(entries[0]!.reason, reasons.blockedNoNote);
  assert.equal(entries[2]!.reason, reasons.runFailed(failed.id, "Budget exceeded."));
  assert.equal(entries[2]!.since, failed.ended_at);
  assert.equal(entries[2]!.text, `${failed.task}\n\n- A task of editor`, "the instruction, then the tasks it gave back");
  assert.equal(stuckAgents(entries), 3);
});

test("pending: stuck after 15 minutes when nothing takes it, with the probable reason; a queued message is not a block", () => {
  const config = office();
  const db = getDbAt(config.dbPath);
  // The painter holds the GPU: the scout's message waits for it.
  addRun(db, "painter", "running", 30, null, { resources: '["gpu"]' });
  const gpu = addTask(db, "scout", { status: "pending", created: ago(20), fromAgent: "editor" });
  // The writer asked for `onMessage: "queue"`: its message waits for its next run by design.
  addTask(db, "writer", { status: "pending", created: ago(60), fromAgent: "editor" });
  // Fresh: under 15 minutes.
  addTask(db, "critic", { source: "chat", status: "pending", created: ago(5) });
  // The editor works: a task newer than its run is taken at its end; an older one, put back since, is not.
  const busyRun = addRun(db, "editor", "running", 40, null);
  addTask(db, "editor", { status: "pending", created: ago(20), fromAgent: "scout" });
  const older = addTask(db, "editor", { source: "chat", status: "pending", created: ago(60), updated: ago(10) });

  const entries = list(config, db);
  assert.deepEqual(
    entries.map((entry) => [entry.entry, entry.id, entry.reason]),
    [
      ["pending", gpu, reasons.resource("gpu", 1, "demo / painter")],
      ["pending", older, reasons.busy(busyRun.id)],
    ],
  );
  assert.equal(entries[0]!.since, taskOf(db, gpu).created_at, "since the task was created");
  assert.equal(entries[0]!.agentName, "Scout");
  assert.equal(stuckAgents(entries), 2);
});

test("pending: the daily cap, a run that gave it back, two interruptions, the anti ping-pong window", () => {
  const config = office({ maxRunsPerDay: 2 });
  const db = getDbAt(config.dbPath);
  const capped = addTask(db, "scout", { status: "pending", created: ago(30) });
  addRun(db, "painter", "done", 25, 24);
  addRun(db, "painter", "done", 23, 22);
  let entries = list(config, db);
  assert.deepEqual(entries.map((entry) => [entry.id, entry.reason]), [[capped, reasons.cap(2, 2)]]);

  const config2 = office();
  const db2 = getDbAt(config2.dbPath);
  // Older than a run that failed: given back, no wake-up takes it again.
  const back = addTask(db2, "critic", { status: "pending", created: ago(200) });
  const failed = addRun(db2, "critic", "failed", 150, 149);
  // Two interrupted runs since it came.
  const twice = addTask(db2, "editor", { status: "pending", created: ago(200) });
  addRun(db2, "editor", "cancelled", 150, 149);
  addRun(db2, "editor", "cancelled", 100, 99);
  // Older than a run that ended done: only the agent's next run takes it.
  const next = addTask(db2, "scout", { source: "chat", status: "pending", created: ago(200) });
  addRun(db2, "scout", "done", 150, 149);
  entries = list(config2, db2);
  assert.deepEqual(
    new Map(entries.map((entry) => [entry.id, entry.reason])),
    new Map([
      [back, reasons.givenBack(failed.id)],
      [twice, reasons.interruptedTwice],
      [next, reasons.noWake],
    ]),
  );

  // The editor woke the scout for a message 9 minutes ago: the next message of the pair waits for the window.
  const config3 = office();
  const db3 = getDbAt(config3.dbPath);
  const wake = addRun(db3, "scout", "done", 9, 8.5);
  db3.prepare("UPDATE runs SET reason = 'message' WHERE id = ?").run(wake.id);
  addTask(db3, "scout", { status: "done", created: ago(9.5), runId: wake.id, fromAgent: "editor" });
  const pong = addTask(db3, "scout", { status: "pending", created: ago(8), fromAgent: "editor" });
  // Read as if 8 minutes later, so that the message is past the 15 minutes (the window itself is read on the clock).
  const late = listBlocked(db3, loadHome(config3.home), config3, new Date(Date.now() + 8 * 60_000));
  assert.deepEqual(late.map((entry) => [entry.id, entry.reason]), [[pong, reasons.pingPong("Editor", 10)]]);
});

test("relaunch: the task goes back to pending and the agent is woken at once, by a run that takes it", async () => {
  const config = office();
  const db = getDbAt(config.dbPath);
  const seen: RunInput[] = [];
  const task = addTask(db, "critic", { status: "blocked", created: ago(60), note: "Stuck.", text: "Check the links." });
  const result = relaunchBlocked(config, db, { kind: "task", id: task }, { engine: engine(seen), send: async () => true });
  assert.deepEqual(result.tasks, [task]);
  assert.equal(result.waiting, null);
  assert.equal(result.run?.reason, "relaunch");
  await waitForRun(db, result.run!.id);
  assert.match(seen[0]!.prompt, /\[task \d+, message\] Check the links\./);
  assert.equal(taskOf(db, task).status, "done", "taken by the run, done with it");
  assert.equal(list(config, db).length, 0);
});

test("relaunch: when the agent cannot be woken (a resource held), the task stays pending and the answer says why", () => {
  const config = office();
  const db = getDbAt(config.dbPath);
  addRun(db, "painter", "running", 5, null, { resources: '["gpu"]' });
  const task = addTask(db, "scout", { status: "blocked", created: ago(60) });
  const result = relaunchBlocked(config, db, { kind: "task", id: task }, { engine: engine(), send: async () => true });
  assert.equal(result.run, null);
  assert.equal(result.waiting?.code, "RESOURCE_BUSY");
  const row = taskOf(db, task);
  assert.equal(row.status, "pending");
  assert.equal(row.run_id, null);
  assert.deepEqual(
    list(config, db).map((entry) => [entry.entry, entry.reason]),
    [["pending", reasons.resource("gpu", 1, "demo / painter")]],
    "still on the Standard, with the reason",
  );
});

test("relaunch and close of a failed run act on its instruction and on the tasks it gave back", async () => {
  const config = office();
  const db = getDbAt(config.dbPath);
  const failed = addRun(db, "editor", "failed", 30, 20, { summary: "Engine error." });
  const instruction = addTask(db, "editor", { source: "manual", status: "blocked", created: failed.started_at, updated: failed.ended_at!, runId: failed.id });
  const givenBack = addTask(db, "editor", { status: "pending", created: ago(40), updated: failed.ended_at! });
  const seen: RunInput[] = [];
  const result = relaunchBlocked(config, db, { kind: "run", id: failed.id }, { engine: engine(seen), send: async () => true });
  assert.deepEqual(result.tasks, [instruction, givenBack]);
  await waitForRun(db, result.run!.id);
  assert.match(seen[0]!.prompt, new RegExp(`\\[task ${instruction}, manual\\][\\s\\S]*\\[task ${givenBack}, message\\]`));

  const second = addRun(db, "critic", "failed", 30, 20, { summary: "Engine error." });
  const own = addTask(db, "critic", { source: "manual", status: "blocked", created: second.started_at, updated: second.ended_at!, runId: second.id });
  const back = addTask(db, "critic", { status: "pending", created: ago(40), updated: second.ended_at! });
  assert.deepEqual(closeBlocked(db, { kind: "run", id: second.id }), { tasks: [own, back] });
  for (const id of [own, back]) {
    assert.equal(taskOf(db, id).status, "done");
    assert.equal(taskOf(db, id).note, strings.deskModules.standard.closedNote);
  }
  assert.equal(list(config, db).length, 0);
  assert.throws(() => closeBlocked(db, { kind: "run", id: second.id }), (error) => error instanceof HqError && error.code === "NOT_BLOCKED");
  assert.throws(() => closeBlocked(db, { kind: "task", id: 999 }), (error) => error instanceof HqError && error.code === "TASK_NOT_FOUND");
  assert.throws(() => relaunchBlocked(config, db, { kind: "run", id: 999 }), (error) => error instanceof HqError && error.code === "RUN_NOT_FOUND");
});

test("POST /api/blocked/close and /relaunch: zod bodies, the answer of each action, the errors", async () => {
  const config = office();
  process.env.MYHQ_HOME = config.home;
  // No run may start in this test: the cap of the home is 0.
  fs.writeFileSync(path.join(config.home, "myhq.json"), JSON.stringify({ maxRunsPerDay: 0 }));
  const db = getDbAt(config.dbPath);
  const one = addTask(db, "critic", { status: "blocked", created: ago(60) });
  const two = addTask(db, "editor", { status: "blocked", created: ago(60) });
  const post = (body: unknown) => new Request("http://127.0.0.1/api/blocked", { method: "POST", body: JSON.stringify(body) });

  const closed = await closeRoute(post({ kind: "task", id: one }));
  assert.equal(closed.status, 200);
  assert.deepEqual(await closed.json(), { tasks: [one] });
  assert.equal((await closeRoute(post({ kind: "task", id: one }))).status, 409);
  assert.equal((await closeRoute(post({ kind: "task", id: 404 }))).status, 404);
  const invalid = await closeRoute(post({ kind: "approval", id: one, extra: 1 }));
  assert.equal(invalid.status, 400);
  assert.equal(((await invalid.json()) as { error: { code: string } }).error.code, "INVALID_INPUT");

  const relaunched = await relaunchRoute(post({ kind: "task", id: two }));
  assert.equal(relaunched.status, 200);
  const body = (await relaunched.json()) as { tasks: number[]; run: unknown; waiting: { code: string } | null };
  assert.deepEqual(body.tasks, [two]);
  assert.equal(body.run, null);
  assert.equal(body.waiting?.code, "DAILY_CAP_REACHED");
  assert.equal(taskOf(db, two).status, "pending");
});

test("the desk: the Standard is the default phone, counts the agents stuck, and lists its entries with their room colour", async () => {
  const config = office();
  const db = getDbAt(config.dbPath);
  addTask(db, "critic", { status: "blocked", created: ago(60), note: "Waiting for a file." });
  addTask(db, "critic", { status: "blocked", created: ago(50) });
  addTask(db, "scout", { status: "blocked", created: ago(40) });
  addTask(db, "writer", { status: "pending", created: ago(60), fromAgent: "editor" });
  const desk = await resolveDesk({ config, db, commands: new DeskCommands({ env: {} }) });
  const phone = desk.objects.find((object) => object.id === "telephone")!;
  assert.equal(phone.label, "Standard");
  assert.equal(phone.source, "blocked");
  assert.equal(phone.count, 2, "two agents stuck, three entries; the queued message is not counted");
  assert.equal(phone.items.length, 3);
  const first = phone.items[0]!;
  assert.equal(first.title, "Scout");
  assert.equal(first.color, "#ff3d7f");
  assert.equal(first.href, `/bureau/telephone#${first.id}`);
  assert.equal(first.ref?.kind, "blocked");
  assert.match(first.id, /^blocked-task-\d+$/);
});
