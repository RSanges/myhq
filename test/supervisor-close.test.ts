import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { POST as reopenRoute } from "../src/app/api/blocked/reopen/route";
import { hqBlockedClose, hqBlockedNote, hqBlocked, type HqContext } from "../src/mcp/tools";
import { listBlocked } from "../src/server/blocked";
import { CLOSURES_SHOWN_MS, listClosures, reopenClosure } from "../src/server/closures";
import type { HqConfig } from "../src/server/config";
import { getDbAt, type Db, type TaskRow } from "../src/server/db";
import { DeskCommands } from "../src/server/desk-command";
import { resolveDesk } from "../src/server/desk";
import { HqError } from "../src/server/errors";
import { loadHome, syncHome } from "../src/server/rooms";
import { newEntriesTask, reviewTask, watchStandard } from "../src/server/supervisor";
import { strings } from "../src/ui/strings";
import type { Engine } from "../src/server/engine";
import { makeHome, waitForRun } from "./helpers";

// The supervisor closes what it settled (hq_blocked_close), with a reason the
// owner reads; every closure is recorded with what undoes it, and the owner
// reopens it from the Standard (POST /api/blocked/reopen): the entry comes
// back as it was, handed to the owner, so that nothing closes or relaunches it
// again on its own.

const saved = process.env.MYHQ_HOME;
afterEach(() => {
  if (saved === undefined) delete process.env.MYHQ_HOME;
  else process.env.MYHQ_HOME = saved;
});

const s = strings.deskModules.standard;
const usage = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const engine = (): Engine => ({
  name: "claude",
  async *run() {
    yield { type: "end", status: "done", reason: "success", summary: "ok", usage, costUsd: 0 };
  },
});

/** Room "demo" with two agents, room "assistant" with the supervisor and another agent. */
function office(): { config: HqConfig; db: Db } {
  const base = { role: "roles/scout.md", model: "haiku", allowedTools: ["mcp__hq__*"] };
  const config = makeHome(
    {},
    {
      name: "demo",
      targetRepo: "../demo-project",
      color: "#ff3d7f",
      agents: [
        { id: "scout", name: "Scout", ...base },
        { id: "social", name: "Social", ...base },
      ],
    },
  );
  const dir = path.join(config.home, "rooms", "assistant");
  fs.mkdirSync(path.join(dir, "roles"), { recursive: true });
  fs.writeFileSync(path.join(dir, "roles", "supervisor.md"), "You supervise the Standard.\n");
  const role = { role: "roles/supervisor.md", allowedTools: ["mcp__hq__*"] };
  fs.writeFileSync(
    path.join(dir, "room.json"),
    JSON.stringify({
      name: "assistant",
      targetRepo: "../vault",
      agents: [
        { id: "watcher", name: "Vigie", model: "sonnet", supervisor: true, ...role },
        { id: "courrier", name: "Courrier", model: "haiku", ...role },
      ],
    }),
  );
  const db = getDbAt(config.dbPath);
  syncHome(db, loadHome(config.home));
  return { config, db };
}

function ctxOf(config: HqConfig, db: Db, room: string, agentId: string): HqContext {
  const runId = Number(
    db
      .prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at, ended_at) VALUES (?, ?, 'claude', 't', 'done', ?, ?)")
      .run(room, agentId, new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() - 30_000).toISOString()).lastInsertRowid,
  );
  return { dbPath: config.dbPath, runId, agentId, room, home: config.home, appEnv: {} };
}

const ago = (minutes: number, from = Date.now()) => new Date(from - minutes * 60_000).toISOString();

function addTask(db: Db, room: string, agent: string, fields: Partial<TaskRow> & { status: TaskRow["status"] }): number {
  const at = fields.created_at ?? ago(30);
  return Number(
    db
      .prepare(
        `INSERT INTO tasks (room, agent_id, source, text, status, note, run_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(room, agent, fields.source ?? "message", fields.text ?? `A task of ${agent}`, fields.status, fields.note ?? null, fields.run_id ?? null, at, fields.updated_at ?? at)
      .lastInsertRowid,
  );
}

const taskOf = (db: Db, id: number) => db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow;
const count = (db: Db, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const REASON = "Social a publié le script approuvé (#39), la tâche n'a plus lieu d'être.";

function refusal(call: () => unknown): string {
  try {
    call();
  } catch (error) {
    return (error as Error).message;
  }
  assert.fail("the call was expected to be refused");
}

test("hq_blocked_close: refused to any other agent, on an entry handed to the owner, on its own entries, on what is not on the Standard, without a reason", () => {
  const { config, db } = office();
  const sup = ctxOf(config, db, "assistant", "watcher");
  const courrier = ctxOf(config, db, "assistant", "courrier");
  const blocked = addTask(db, "demo", "scout", { status: "blocked", note: "Which version?" });

  // Another agent.
  assert.match(refusal(() => hqBlockedClose(db, courrier, { kind: "task", id: blocked, reason: REASON })), /^hq_blocked_close is reserved for the supervisor of the Standard/);

  // The reason: required, one sentence of reasonable length.
  for (const reason of [undefined, "", "   ", "Fait.", "x".repeat(501)]) {
    assert.throws(() => hqBlockedClose(db, sup, { kind: "task", id: blocked, reason } as never), /reason/, String(reason));
  }

  // Handed to the owner: by the supervisor itself, or by MyHQ in its name.
  const handed = addTask(db, "demo", "social", { status: "blocked", note: "No approval." });
  hqBlockedNote(db, sup, { kind: "task", id: handed, text: "À toi de choisir.", handOff: true });
  assert.match(refusal(() => hqBlockedClose(db, sup, { kind: "task", id: handed, reason: REASON })), /handed to the owner: it is the owner's to close/);

  // Its own entry, on the Standard but left out of hq_blocked.
  const own = addTask(db, "assistant", "watcher", { status: "blocked", note: "My own trouble." });
  assert.ok(listBlocked(db, loadHome(config.home), config).some((entry) => entry.id === own));
  assert.match(refusal(() => hqBlockedClose(db, sup, { kind: "task", id: own, reason: REASON })), /This entry is yours/);

  // Not on the Standard: a pending task too young to be stuck, a task done, an unknown one.
  const young = addTask(db, "demo", "scout", { status: "pending", source: "manual", created_at: ago(2) });
  assert.match(refusal(() => hqBlockedClose(db, sup, { kind: "task", id: young, reason: REASON })), /not on the Standard/);
  const done = addTask(db, "demo", "scout", { status: "done" });
  assert.match(refusal(() => hqBlockedClose(db, sup, { kind: "task", id: done, reason: REASON })), /neither blocked nor pending/);
  assert.match(refusal(() => hqBlockedClose(db, sup, { kind: "task", id: 9999, reason: REASON })), /No task #9999/);

  // A task of a failed run's entry, taken as a task: the entry is the run, as hq_blocked gives it.
  const failed = Number(
    db
      .prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at, ended_at, summary) VALUES ('demo', 'social', 'claude', 'Post it.', 'failed', ?, ?, 'Budget exceeded.')")
      .run(ago(50), ago(40)).lastInsertRowid,
  );
  const instruction = addTask(db, "demo", "social", { status: "blocked", source: "manual", run_id: failed, created_at: ago(50), updated_at: ago(40) });
  assert.match(refusal(() => hqBlockedClose(db, sup, { kind: "task", id: instruction, reason: REASON })), /not on the Standard.*\{ kind: "run", id: \d+ \}/);

  // Nothing changed.
  for (const id of [blocked, handed, own, young, instruction]) assert.notEqual(taskOf(db, id).status, "done", `task ${id}`);
  assert.equal(count(db, "supervisor_closes"), 0);
});

test("hq_blocked_close: the tasks are done as with « Clore », the closure is recorded, and the entry leaves the Standard and its count", async () => {
  const { config, db } = office();
  const sup = ctxOf(config, db, "assistant", "watcher");
  const blocked = addTask(db, "demo", "social", { status: "blocked", note: "No approval for the script.", text: "Post the script.", updated_at: ago(12) });
  const other = addTask(db, "demo", "scout", { status: "blocked", note: "Which format?" });
  const before = taskOf(db, blocked);

  const answer = hqBlockedClose(db, sup, { kind: "task", id: blocked, reason: `  ${REASON}  ` });
  assert.deepEqual(answer.tasks, [blocked]);
  assert.match(answer.note, /reopen/);
  const after = taskOf(db, blocked);
  assert.equal(after.status, "done");
  assert.equal(after.note, s.closedBySupervisor("Vigie", REASON));
  assert.equal(after.run_id, before.run_id, "the run is untouched, as with « Clore »");

  const row = db.prepare("SELECT * FROM supervisor_closes").get() as Record<string, unknown>;
  assert.equal(row.id, answer.closure);
  assert.deepEqual(
    { kind: row.target_kind, id: row.target_id, room: row.room, agent: row.agent_id, reason: row.reason, by: `${row.by_room}/${row.by_agent}`, run: row.by_run },
    { kind: "task", id: blocked, room: "demo", agent: "social", reason: REASON, by: "assistant/watcher", run: sup.runId },
  );
  assert.deepEqual(JSON.parse(String(row.tasks)), [
    { id: blocked, status: "blocked", note: "No approval for the script.", run_id: null, updated_at: before.updated_at },
  ]);
  assert.equal(row.closed_at, after.updated_at);
  assert.equal(row.reopened_at, null);
  assert.equal(row.entry_reason, s.reasons.blocked("No approval for the script."));

  // Off the Standard and off its count; closed again: not on the Standard any more.
  assert.deepEqual(listBlocked(db, loadHome(config.home), config).map((entry) => entry.id), [other]);
  assert.match(refusal(() => hqBlockedClose(db, sup, { kind: "task", id: blocked, reason: REASON })), /neither blocked nor pending/);
  const desk = await resolveDesk({ config, db, commands: new DeskCommands({ env: {} }) });
  const phone = desk.objects.find((object) => object.source === "blocked")!;
  assert.equal(phone.count, 1, "only the agent still stuck");
  assert.equal(phone.items.length, 1);
  assert.deepEqual(phone.closures, [
    {
      id: answer.closure,
      room: "demo",
      agentId: "social",
      agentName: "Social",
      by: "Vigie",
      reason: REASON,
      entryReason: s.reasons.blocked("No approval for the script."),
      text: "Post the script.",
      color: "#ff3d7f",
      closedAt: after.updated_at,
      reopenedAt: null,
    },
  ]);
  // Another object of the desk carries no closures.
  assert.equal(desk.objects.find((object) => object.source === "approvals")?.closures, undefined);

  // The supervisor is not woken for it: only the other entry is new.
  const run = watchStandard(config, db, { engine: engine() });
  assert.ok(run);
  assert.doesNotMatch(run.task, new RegExp(`\\[task ${blocked}\\]`));
  assert.match(run.task, new RegExp(`\\[task ${other}\\]`));
  await waitForRun(db, run.id);
});

test("close then reopen: a failed run comes back as it was, handed to the owner, and neither MyHQ's rules nor the supervisor close or relaunch it again", () => {
  const { config, db } = office();
  const sup = ctxOf(config, db, "assistant", "watcher");
  const home = loadHome(config.home);
  // An interrupted run, which MyHQ's rules would relaunch: its instruction blocked, a mailbox task given back.
  const ended = ago(40);
  const cancelled = Number(
    db
      .prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at, ended_at) VALUES ('demo', 'scout', 'claude', 'Render the trailer.', 'cancelled', ?, ?)")
      .run(ago(50), ended).lastInsertRowid,
  );
  const instruction = addTask(db, "demo", "scout", { status: "blocked", source: "manual", run_id: cancelled, note: "Interrupted.", created_at: ago(50), updated_at: ended });
  const given = addTask(db, "demo", "scout", { status: "pending", source: "message", created_at: ago(55), updated_at: ended });
  const before = [taskOf(db, instruction), taskOf(db, given)];
  const target = { kind: "run" as const, id: cancelled };
  assert.deepEqual(hqBlocked(db, sup).entries.map((entry) => entry.target), [target]);

  const closed = hqBlockedClose(db, sup, { ...target, reason: "Le rendu a été refait à la main par le propriétaire hier soir." });
  assert.deepEqual(closed.tasks, [instruction, given]);
  assert.deepEqual(listBlocked(db, home, config), []);

  const reopened = reopenClosure(db, home, closed.closure);
  assert.deepEqual(reopened.tasks, [instruction, given]);
  // The tasks exactly as they were: status, note, run and time, so the run's entry is recognized again.
  assert.deepEqual([taskOf(db, instruction), taskOf(db, given)], before);
  const [entry, ...others] = listBlocked(db, home, config);
  assert.equal(others.length, 0);
  assert.deepEqual({ entry: entry!.entry, id: entry!.id, taskIds: entry!.taskIds, handedOff: entry!.handedOff }, { entry: "run", id: cancelled, taskIds: [instruction, given], handedOff: true });
  assert.equal(entry!.note?.text, s.reopenedNote("Vigie", "Le rendu a été refait à la main par le propriétaire hier soir."));
  assert.equal(entry!.note?.agentName, "MyHQ");
  // The trace is kept.
  const row = db.prepare("SELECT * FROM supervisor_closes WHERE id = ?").get(closed.closure) as Record<string, unknown>;
  assert.notEqual(row.reopened_at, null);
  assert.equal(listClosures(db, home)[0]!.reopenedAt, row.reopened_at);

  // Neither relaunched by a rule nor given to the supervisor, nor closed by it again; reopened once only.
  assert.equal(watchStandard(config, db, { engine: engine() }), null);
  assert.equal(count(db, "supervisor_relaunches"), 0);
  assert.equal(count(db, "runs WHERE reason = 'standard'"), 0);
  assert.match(refusal(() => hqBlockedClose(db, sup, { ...target, reason: REASON })), /handed to the owner/);
  assert.throws(() => reopenClosure(db, home, closed.closure), (error) => error instanceof HqError && error.code === "ALREADY_REOPENED");
});

test("reopen: refused when a task changed since the closure, and nothing is restored", () => {
  const { config, db } = office();
  const sup = ctxOf(config, db, "assistant", "watcher");
  const home = loadHome(config.home);
  const blocked = addTask(db, "demo", "social", { status: "blocked", note: "Waiting for the brief." });
  const { closure } = hqBlockedClose(db, sup, { kind: "task", id: blocked, reason: REASON });

  // The owner relaunched the agent, which took the task again in a run.
  db.prepare("UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = ?").run(new Date(Date.now() + 1_000).toISOString(), blocked);
  assert.throws(
    () => reopenClosure(db, home, closure),
    (error) => error instanceof HqError && error.code === "STATE_CHANGED" && error.status === 409 && /#\d+ changed since the closure/.test(error.message),
  );
  assert.equal(taskOf(db, blocked).status, "in_progress");
  assert.equal(count(db, "blocked_notes"), 0);
  assert.equal((db.prepare("SELECT reopened_at FROM supervisor_closes").get() as { reopened_at: string | null }).reopened_at, null);
  assert.throws(() => reopenClosure(db, home, 9999), (error) => error instanceof HqError && error.code === "CLOSURE_NOT_FOUND" && error.status === 404);
});

test("the closures shown: those of the last 7 days, newest first, reopened ones marked", () => {
  const { config, db } = office();
  const sup = ctxOf(config, db, "assistant", "watcher");
  const home = loadHome(config.home);
  const first = hqBlockedClose(db, sup, { kind: "task", id: addTask(db, "demo", "scout", { status: "blocked", note: "a" }), reason: REASON });
  const second = hqBlockedClose(db, sup, { kind: "task", id: addTask(db, "demo", "social", { status: "blocked", note: "b" }), reason: REASON });
  db.prepare("UPDATE supervisor_closes SET closed_at = ? WHERE id = ?").run(new Date(Date.now() - CLOSURES_SHOWN_MS - 60_000).toISOString(), first.closure);
  assert.deepEqual(listClosures(db, home).map((each) => each.id), [second.closure]);
  assert.equal(count(db, "supervisor_closes"), 2, "no row is deleted");
});

test("POST /api/blocked/reopen: a zod body, the entry back on the Standard, the errors", async () => {
  const { config, db } = office();
  process.env.MYHQ_HOME = config.home;
  const sup = ctxOf(config, db, "assistant", "watcher");
  const blocked = addTask(db, "demo", "social", { status: "blocked", note: "Waiting." });
  const { closure } = hqBlockedClose(db, sup, { kind: "task", id: blocked, reason: REASON });
  const post = (body: unknown) =>
    new Request("http://127.0.0.1/api/blocked/reopen", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  for (const body of [{}, { id: "1" }, { id: closure, extra: true }, { id: 0 }]) {
    const invalid = await reopenRoute(post(body));
    assert.equal(invalid.status, 400, JSON.stringify(body));
    assert.equal(((await invalid.json()) as { error: { code: string } }).error.code, "INVALID_INPUT");
  }
  const plain = await reopenRoute(new Request("http://127.0.0.1/api/blocked/reopen", { method: "POST", body: JSON.stringify({ id: closure }) }));
  assert.equal(plain.status, 415, "a JSON request only");

  const reopened = await reopenRoute(post({ id: closure }));
  assert.equal(reopened.status, 200);
  assert.deepEqual(await reopened.json(), { closure, tasks: [blocked] });
  assert.equal(taskOf(db, blocked).status, "blocked");
  assert.equal(((await (await reopenRoute(post({ id: closure }))).json()) as { error: { code: string } }).error.code, "ALREADY_REOPENED");
  assert.equal((await reopenRoute(post({ id: 4040 }))).status, 404);
});

test("the supervisor is told to close what it settled, with the reason, and to hand over only what needs the owner", () => {
  const { config, db } = office();
  const blocked = addTask(db, "demo", "scout", { status: "blocked", note: "Stuck." });
  const entries = listBlocked(db, loadHome(config.home), config);
  for (const task of [newEntriesTask(entries, entries.length), reviewTask(entries)]) {
    assert.match(task, /hq_blocked_close/);
    assert.match(task, /reason/);
    assert.match(task, /hand to the owner only what needs/i);
    assert.match(task, new RegExp(`\\[task ${blocked}\\]`));
  }
});
