import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  hqBlocked,
  hqBlockedNote,
  hqItems,
  hqMessage,
  hqRelaunch,
  hqSubmit,
  ToolError,
  type HqContext,
} from "../src/mcp/tools";
import { listBlocked } from "../src/server/blocked";
import type { HqConfig } from "../src/server/config";
import { getDbAt, type Db, type RunRow, type TaskRow } from "../src/server/db";
import { DeskCommands } from "../src/server/desk-command";
import { resolveDesk } from "../src/server/desk";
import type { Engine, RunEvent, RunInput } from "../src/server/engine";
import { loadHome, loadRoom, syncHome } from "../src/server/rooms";
import { wakeAgents } from "../src/server/runner";
import { OWNER_NOTE, STANDARD_REASON, STANDARD_REVIEW_MS, watchStandard } from "../src/server/supervisor";
import { strings } from "../src/ui/strings";
import { makeHome, waitForRun } from "./helpers";

// The supervisor of the Standard: its rights (hq_blocked, hq_message to any
// room, hq_relaunch, hq_items of every room, nothing to approve), the refusals
// for any other agent, its notes for the owner, its wake-ups, and the guard
// against loops (once per task, then the owner).

const usage = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const ended = (status: "done" | "failed"): RunEvent => ({
  type: "end",
  status,
  reason: status === "done" ? "success" : "error",
  summary: status === "done" ? "ok" : "Server too slow.",
  usage,
  costUsd: 0,
});

/** An engine that ends each run with the next status of `statuses` (then done), and records its inputs. */
function engine(seen: RunInput[] = [], statuses: ("done" | "failed")[] = []): Engine {
  return {
    name: "claude",
    async *run(input) {
      seen.push(input);
      yield ended(statuses.shift() ?? "done");
    },
  };
}

/** Room "demo" (not shared) with three agents, room "assistant" with the supervisor and another agent. */
function office(): { config: HqConfig; db: Db } {
  const base = { role: "roles/scout.md", model: "haiku", allowedTools: ["mcp__hq__*"] };
  const config = makeHome(
    {},
    {
      name: "demo",
      targetRepo: "../demo-project",
      agents: [
        { id: "scout", name: "Scout", ...base },
        { id: "painter", name: "Painter", ...base, resources: ["gpu"] },
        { id: "social", name: "Social", ...base },
      ],
    },
  );
  const dir = path.join(config.home, "rooms", "assistant");
  fs.mkdirSync(path.join(dir, "roles"), { recursive: true });
  fs.writeFileSync(path.join(dir, "roles", "regisseur.md"), "You supervise the Standard.\n");
  const role = { role: "roles/regisseur.md", allowedTools: ["mcp__hq__*"] };
  fs.writeFileSync(
    path.join(dir, "room.json"),
    JSON.stringify({
      name: "assistant",
      targetRepo: "../vault",
      agents: [
        { id: "regisseur", name: "Régisseur", model: "sonnet", supervisor: true, ...role },
        { id: "courrier", name: "Courrier", model: "haiku", ...role },
      ],
    }),
  );
  const db = getDbAt(config.dbPath);
  syncHome(db, loadHome(config.home));
  return { config, db };
}

/** The context of a run of this agent, as its HQ MCP server reads it (the run is recorded, done). */
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
const runsOf = (db: Db, room: string, agent: string) =>
  db.prepare("SELECT * FROM runs WHERE room = ? AND agent_id = ? ORDER BY id").all(room, agent) as RunRow[];

/** Calls a tool and returns the text of its ToolError (or of any Error), failing when it does not throw. */
function refusal(call: () => unknown): string {
  try {
    call();
  } catch (error) {
    return (error as Error).message;
  }
  assert.fail("the call was expected to be refused");
}

test("supervisor: room.json takes supervisor, and syncHome mirrors it for the HQ MCP server", () => {
  const { config, db } = office();
  const room = loadRoom(config.home, path.join(config.home, "rooms", "assistant"));
  assert.equal(room.agents.find((agent) => agent.id === "regisseur")?.supervisor, true);
  assert.equal(room.agents.find((agent) => agent.id === "courrier")?.supervisor, false);
  assert.deepEqual(db.prepare("SELECT room, agent_id FROM supervisors").all(), [{ room: "assistant", agent_id: "regisseur" }]);

  const file = path.join(config.home, "rooms", "assistant", "room.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { agents: Record<string, unknown>[] };
  raw.agents[0]!.supervisor = "yes";
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.throws(() => loadRoom(config.home, path.dirname(file)), /supervisor/);
  // An invalid room, or a supervisor no longer one, is no longer a supervisor for the HQ MCP server.
  syncHome(db, loadHome(config.home));
  assert.deepEqual(db.prepare("SELECT room, agent_id FROM supervisors").all(), []);
});

test("supervisor: any other agent is refused the supervisor's tools, the other rooms and their items, with a clear error", () => {
  const { config, db } = office();
  const blocked = addTask(db, "demo", "scout", { status: "blocked", note: "Waiting for the approval." });
  const item = Number(
    db
      .prepare("INSERT INTO approvals (room, agent_id, type, title, body, status, created_at) VALUES ('demo', 'social', 'script', 'Script', 'body', 'approved', ?)")
      .run(ago(5)).lastInsertRowid,
  );
  const courrier = ctxOf(config, db, "assistant", "courrier");
  for (const [tool, call] of [
    ["hq_blocked", () => hqBlocked(db, courrier)],
    ["hq_relaunch", () => hqRelaunch(db, courrier, { kind: "task", id: blocked })],
    ["hq_blocked_note", () => hqBlockedNote(db, courrier, { kind: "task", id: blocked, text: "Pour le propriétaire." })],
  ] as const) {
    const text = refusal(call);
    assert.match(text, new RegExp(`^${tool} is reserved for the supervisor of the Standard`), tool);
    assert.match(text, /"supervisor": true/);
  }
  assert.throws(() => hqMessage(db, courrier, { to: "scout", room: "demo", text: "Hello" }), (error: unknown) => {
    assert.ok(error instanceof ToolError);
    assert.match(error.message, /Room "demo" is not shared/);
    return true;
  });
  assert.match(refusal(() => hqItems(db, courrier, { id: item })), /outside what you may read/);
  // Nothing changed.
  assert.equal(taskOf(db, blocked).status, "blocked");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM blocked_notes").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM supervisor_relaunches").get() as { n: number }).n, 0);
});

test("supervisor: hq_blocked gives the Standard of every room but its own; it reads every item, writes anywhere, and submits only a note", () => {
  const { config, db } = office();
  const sup = ctxOf(config, db, "assistant", "regisseur");
  const blocked = addTask(db, "demo", "social", {
    status: "blocked",
    note: "No approval for the script.",
    text: "Post the script once it is approved.",
    updated_at: ago(12),
  });
  addTask(db, "assistant", "regisseur", { status: "blocked", note: "My own trouble." });
  const item = Number(
    db
      .prepare("INSERT INTO approvals (room, agent_id, type, title, body, status, decided_at, created_at) VALUES ('demo', 'social', 'script', 'Script', 'The text.', 'approved', ?, ?)")
      .run(ago(60), ago(90)).lastInsertRowid,
  );

  const { entries } = hqBlocked(db, sup);
  assert.equal(entries.length, 1, "its own entry is left out");
  const entry = entries[0]!;
  assert.deepEqual(entry.target, { kind: "task", id: blocked });
  assert.equal(entry.room, "demo");
  assert.equal(entry.agent, "social");
  assert.equal(entry.agentName, "Social");
  assert.equal(entry.state, "blocked");
  assert.equal(entry.since, taskOf(db, blocked).updated_at);
  assert.equal(entry.reason, strings.deskModules.standard.reasons.blocked("No approval for the script."));
  assert.equal(entry.text, "Post the script once it is approved.");
  assert.deepEqual(entry.taskIds, [blocked]);
  assert.equal(entry.note, null);
  assert.equal(entry.handedOff, false);
  assert.equal(entry.relaunched, false);

  // The facts: the item of another room, by id and in the list.
  const read = hqItems(db, sup, { id: item }) as { status: string; body: string };
  assert.equal(read.status, "approved");
  assert.equal(read.body, "The text.");
  const listed = hqItems(db, sup, {}) as { items: { id: number }[] };
  assert.ok(listed.items.some((each) => each.id === item));

  // A message to an agent of a room that is not shared, which wakes it as any message.
  const { messageId } = hqMessage(db, sup, { to: "social", room: "demo", text: "Approuvé par le propriétaire, #39." });
  const task = db.prepare("SELECT * FROM tasks WHERE source = 'message' AND ref_id = ?").get(messageId) as TaskRow;
  assert.equal(task.room, "demo");
  assert.equal(task.from_room, "assistant");
  assert.equal(task.from_agent, "regisseur");
  assert.match(task.text, /^Message from regisseur of room "assistant" \(answer with hq_message to "regisseur", room "assistant"\): Approuvé par le propriétaire, #39\.$/);
  // And the agent may answer it.
  assert.ok(hqMessage(db, ctxOf(config, db, "demo", "social"), { to: "regisseur", room: "assistant", text: "Merci." }).messageId > 0);

  // Nothing to approve: only a note to the owner, informational.
  assert.match(
    refusal(() => hqSubmit(db, sup, { type: "community_reply", title: "A reply", body: "Text" })),
    /submit nothing to approve, only a note to the owner \(type "owner_note"\)/,
  );
  const note = hqSubmit(db, sup, { type: OWNER_NOTE, title: "Point du Standard", body: "Deux blocages remis." });
  assert.equal(note.status, "unseen");
});

test("supervisor: hq_relaunch puts the tasks back, the app starts the run with its message, and never twice for the same task", async () => {
  const { config, db } = office();
  const sup = ctxOf(config, db, "assistant", "regisseur");
  const blocked = addTask(db, "demo", "scout", { status: "blocked", note: "Server too slow.", text: "Render the trailer." });

  const asked = hqRelaunch(db, sup, { kind: "task", id: blocked, message: "Le serveur répond de nouveau, reprends." });
  assert.equal(asked.relaunched, true);
  assert.deepEqual(asked.tasks, [blocked]);
  assert.equal(taskOf(db, blocked).status, "pending");
  const request = db.prepare("SELECT * FROM supervisor_relaunches").get() as Record<string, unknown>;
  assert.equal(request.room, "demo");
  assert.equal(request.agent_id, "scout");
  assert.equal(request.by_agent, "regisseur");
  assert.equal(request.by_run, sup.runId);
  assert.equal(request.handled_at, null);

  // The tool result of that call wakes: the run takes the relaunched task and the message together.
  const seen: RunInput[] = [];
  const started = wakeAgents(config, db, { engine: engine(seen, ["failed"]) });
  assert.equal(started.length, 1, "one run, not one more for the message");
  assert.equal(started[0]!.reason, "relaunch");
  await waitForRun(db, started[0]!.id);
  assert.match(seen[0]!.prompt, new RegExp(`\\[task ${blocked}, message\\] Render the trailer\\.`));
  assert.match(seen[0]!.prompt, /Message from regisseur of room "assistant".*Le serveur répond de nouveau, reprends\./);
  const handled = db.prepare("SELECT * FROM supervisor_relaunches").get() as Record<string, unknown>;
  assert.equal(handled.run_id, started[0]!.id);
  assert.notEqual(handled.handled_at, null);

  // The run failed: the entry is back, as a run, and a second relaunch is refused.
  const back = hqBlocked(db, sup).entries.find((entry) => entry.taskIds.includes(blocked));
  assert.ok(back);
  assert.equal(back.relaunched, true);
  assert.deepEqual(back.target, { kind: "run", id: started[0]!.id });
  assert.match(refusal(() => hqRelaunch(db, sup, back.target)), /Already relaunched once by a supervisor .*hand the entry to the owner/i);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM supervisor_relaunches").get() as { n: number }).n, 1);
});

test("supervisor: a guard that holds the agent (busy, resource, cap) changes nothing and does not count as a relaunch", () => {
  const { config, db } = office();
  const sup = ctxOf(config, db, "assistant", "regisseur");
  const blocked = addTask(db, "demo", "painter", { status: "blocked", note: "GPU busy." });
  const running = (agent: string, resources = "[]") =>
    Number(
      db
        .prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at, resources) VALUES ('demo', ?, 'claude', 't', 'running', ?, ?)")
        .run(agent, ago(1), resources).lastInsertRowid,
    );

  const holder = running("scout", '["gpu"]');
  const held = hqRelaunch(db, sup, { kind: "task", id: blocked });
  assert.equal(held.relaunched, false);
  assert.equal(!held.relaunched && held.waiting.code, "RESOURCE_BUSY");
  assert.match(held.note, /does not count as a relaunch/);
  assert.equal(taskOf(db, blocked).status, "blocked");

  db.prepare("UPDATE runs SET status = 'done', ended_at = ? WHERE id = ?").run(ago(0), holder);
  const own = running("painter");
  const busy = hqRelaunch(db, sup, { kind: "task", id: blocked });
  assert.equal(!busy.relaunched && busy.waiting.code, "AGENT_BUSY");
  db.prepare("UPDATE runs SET status = 'done', ended_at = ? WHERE id = ?").run(ago(0), own);

  const capped = hqRelaunch(db, { ...sup, appEnv: { HQ_MAX_RUNS_PER_DAY: "2" } }, { kind: "task", id: blocked });
  assert.equal(!capped.relaunched && capped.waiting.code, "DAILY_CAP_REACHED");

  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM supervisor_relaunches").get() as { n: number }).n, 0);
  assert.equal(hqRelaunch(db, sup, { kind: "task", id: blocked }).relaunched, true, "once free, it relaunches");
});

test("supervisor: hq_blocked_note shows on the Standard line, and an entry handed to the owner comes first, marked apart", async () => {
  const { config, db } = office();
  const sup = ctxOf(config, db, "assistant", "regisseur");
  const older = addTask(db, "demo", "scout", { status: "blocked", note: "Which version?", updated_at: ago(40) });
  const newer = addTask(db, "demo", "social", { status: "blocked", note: "No approval.", updated_at: ago(5) });

  hqBlockedNote(db, sup, { kind: "task", id: newer, text: "J'ai écrit à Social : le script est approuvé (#39)." });
  hqBlockedNote(db, sup, { kind: "task", id: older, text: "Il faut choisir entre la version A et la B.", handOff: true });

  const entries = listBlocked(db, loadHome(config.home), config);
  assert.deepEqual(
    entries.map((entry) => entry.id),
    [older, newer],
    "the entry handed to the owner first, though older",
  );
  assert.equal(entries[0]!.handedOff, true);
  assert.equal(entries[0]!.note?.text, "Il faut choisir entre la version A et la B.");
  assert.equal(entries[0]!.note?.agentName, "Régisseur");
  assert.equal(entries[1]!.handedOff, false);
  assert.equal(entries[1]!.note?.text, "J'ai écrit à Social : le script est approuvé (#39).");

  const desk = await resolveDesk({ config, db, commands: new DeskCommands({ env: {} }) });
  const phone = desk.objects.find((object) => object.source === "blocked")!;
  const first = phone.items[0]!.ref as { kind: string; note: { text: string; by: string } | null; handedOff: boolean };
  assert.equal(first.kind, "blocked");
  assert.equal(first.handedOff, true);
  assert.deepEqual({ text: first.note?.text, by: first.note?.by }, { text: "Il faut choisir entre la version A et la B.", by: "Régisseur" });
  // An unknown target is refused.
  assert.match(refusal(() => hqBlockedNote(db, sup, { kind: "task", id: 9999, text: "x" })), /No task #9999/);
});

test("supervisor: a new entry wakes it with a task that lists it, once; a review every 30 minutes at most while entries remain open", async () => {
  const { config, db } = office();
  const seen: RunInput[] = [];
  const deps = { engine: engine(seen) };
  assert.equal(watchStandard(config, db, deps), null, "nothing stuck, nothing to do");

  const blocked = addTask(db, "demo", "social", { status: "blocked", note: "No approval for the script.", text: "Post the script." });
  const first = watchStandard(config, db, deps);
  assert.ok(first);
  assert.equal(first.room, "assistant");
  assert.equal(first.agent_id, "regisseur");
  assert.equal(first.reason, STANDARD_REASON);
  assert.match(first.task, /^New on the Standard: 1 entry\./);
  assert.match(first.task, new RegExp(`- \\[task ${blocked}\\] demo/social \\(Social\\), blocked since .*No approval for the script\\..* Text: Post the script\\.`));
  await waitForRun(db, first.id);

  // The same entry does not wake it again before the review.
  assert.equal(watchStandard(config, db, deps), null);
  // A second entry does, and the task says the first one is still open.
  const second = addTask(db, "demo", "scout", { status: "blocked", note: "MCP server not connected." });
  const next = watchStandard(config, db, deps);
  assert.ok(next);
  assert.match(next.task, new RegExp(`\\[task ${second}\\]`));
  assert.doesNotMatch(next.task, new RegExp(`\\[task ${blocked}\\]`));
  assert.match(next.task, /Also open, already given to you: 1 entry/);
  await waitForRun(db, next.id);
  assert.equal(watchStandard(config, db, deps), null);

  // Thirty minutes after its last run for the Standard, the review lists what is still open.
  const later = new Date(Date.parse(next.started_at) + STANDARD_REVIEW_MS + 1_000);
  const review = watchStandard(config, db, deps, later);
  assert.ok(review);
  assert.match(review.task, /^Review of the Standard: 2 entries still open/);
  await waitForRun(db, review.id);

  // Handed to the owner: no review for it any more.
  const sup = ctxOf(config, db, "assistant", "regisseur");
  hqBlockedNote(db, sup, { kind: "task", id: blocked, text: "Décision du propriétaire.", handOff: true });
  hqBlockedNote(db, sup, { kind: "task", id: second, text: "Bug de MyHQ.", handOff: true });
  const muchLater = new Date(Date.parse(review.started_at) + STANDARD_REVIEW_MS + 1_000);
  assert.equal(watchStandard(config, db, deps, muchLater), null);
  assert.equal(runsOf(db, "assistant", "regisseur").filter((run) => run.reason === STANDARD_REASON).length, 3);
});

test("supervisor: a busy supervisor is not given the entry yet; the next tick does", async () => {
  const { config, db } = office();
  const running = Number(
    db
      .prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at, resources) VALUES ('assistant', 'regisseur', 'claude', 't', 'running', ?, '[]')")
      .run(ago(1)).lastInsertRowid,
  );
  const blocked = addTask(db, "demo", "social", { status: "blocked", note: "Stuck." });
  assert.equal(watchStandard(config, db, { engine: engine() }), null);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM standard_announced").get() as { n: number }).n, 0);
  db.prepare("UPDATE runs SET status = 'done', ended_at = ? WHERE id = ?").run(ago(0), running);
  const run = watchStandard(config, db, { engine: engine() });
  assert.ok(run);
  assert.match(run.task, new RegExp(`\\[task ${blocked}\\]`));
  await waitForRun(db, run.id);
});

test("supervisor: an entry it relaunched that is stuck again goes to the owner, and it is not woken for it", async () => {
  const { config, db } = office();
  const sup = ctxOf(config, db, "assistant", "regisseur");
  const blocked = addTask(db, "demo", "scout", { status: "blocked", note: "Server too slow." });
  const announced = watchStandard(config, db, { engine: engine() });
  assert.ok(announced);
  await waitForRun(db, announced.id);

  assert.equal(hqRelaunch(db, sup, { kind: "task", id: blocked }).relaunched, true);
  const [relaunch] = wakeAgents(config, db, { engine: engine([], ["failed"]) });
  assert.ok(relaunch);
  await waitForRun(db, relaunch.id);

  // The second failure: MyHQ hands it to the owner in the supervisor's name, and wakes nobody.
  const later = new Date(Date.now() + STANDARD_REVIEW_MS + 60_000);
  assert.equal(watchStandard(config, db, { engine: engine() }, later), null);
  const entry = listBlocked(db, loadHome(config.home), config).find((each) => each.taskIds.includes(blocked));
  assert.ok(entry);
  assert.equal(entry.handedOff, true);
  assert.equal(entry.note?.text, strings.deskModules.standard.secondFailure("Régisseur"));
  assert.equal(runsOf(db, "assistant", "regisseur").filter((run) => run.reason === STANDARD_REASON).length, 1);
});

test("supervisor: its messages go through the anti ping-pong window like any other", async () => {
  const { config, db } = office();
  const sup = ctxOf(config, db, "assistant", "regisseur");
  hqMessage(db, sup, { to: "social", room: "demo", text: "Approuvé par le propriétaire, #39." });
  const [first] = wakeAgents(config, db, { engine: engine() });
  assert.ok(first);
  assert.equal(first.reason, "message");
  await waitForRun(db, first.id);

  hqMessage(db, sup, { to: "social", room: "demo", text: "Tu as pu publier ?" });
  assert.deepEqual(wakeAgents(config, db, { engine: engine() }), [], "the second message waits for the window");
  assert.equal(runsOf(db, "demo", "social").length, 1);
});
