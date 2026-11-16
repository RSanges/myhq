import assert from "node:assert/strict";
import { test } from "node:test";
import { decideProposal, toQuestion, readDiscussion } from "../src/server/agent-questions";
import { decideApproval } from "../src/server/approvals";
import { listBlocked, relaunchBlocked } from "../src/server/blocked";
import { getDbAt, type Db, type RunRow, type TaskRow } from "../src/server/db";
import type { Engine, RunEvent, RunInput } from "../src/server/engine";
import { HqError } from "../src/server/errors";
import { startRelaunchRequests } from "../src/server/relaunch-requests";
import { loadHome } from "../src/server/rooms";
import { startRun, wakeAgents } from "../src/server/runner";
import { createSubject, settleSubject, updateSubject } from "../src/server/subjects";
import { makeHome, waitForRun } from "./helpers";

// Which run takes which task once an agent has subjects (docs/architecture.md,
// "A run" and "Wake-ups"): a run that names no subject is general, a relaunch
// works on the subject of its tasks, and a task that waits for the agent's
// next run is never left behind when that run goes to another subject.

const usage = { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const quiet = async () => false;

/** Records each run and ends it `status`; waits for `gate` when one is given. */
function engine(seen: RunInput[] = [], status: "done" | "failed" = "done", gate?: Promise<void>): Engine {
  return {
    name: "claude",
    async *run(input: RunInput): AsyncIterable<RunEvent> {
      seen.push(input);
      if (gate) await gate;
      yield { type: "end", status, reason: status === "done" ? "success" : "error", summary: "x", usage, costUsd: 0 };
    },
  };
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

function office(extra: Record<string, unknown> = {}, overrides: Parameters<typeof makeHome>[0] = {}) {
  return makeHome(overrides, {
    name: "demo",
    targetRepo: "../demo-project",
    agents: [{ id: "scout", name: "Scout", role: "roles/scout.md", model: "haiku", allowedTools: ["mcp__hq__*"], ...extra }],
  });
}

function task(db: Db, subject: number | null, text: string, source: string): number {
  const at = new Date().toISOString();
  return Number(
    db
      .prepare(
        `INSERT INTO tasks (room, agent_id, source, text, status, subject_id, created_at, updated_at) VALUES ('demo', 'scout', ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(source, text, subject, at, at).lastInsertRowid,
  );
}

function item(db: Db, subject: number | null, status = "pending"): number {
  return Number(
    db
      .prepare(
        `INSERT INTO approvals (room, agent_id, type, title, body, payload, status, created_at, subject_id)
         VALUES ('demo', 'scout', 'article', 'Sign', 'B', '{}', ?, ?, ?)`,
      )
      .run(status, new Date().toISOString(), subject).lastInsertRowid,
  );
}

/** An answered question of a subject whose answer proposes `proposal` (a run, or a revision of `reviseId`). */
function proposed(db: Db, subject: number | null, proposal: string, reviseId: number | null = null, at = new Date().toISOString()): number {
  const id = Number(
    db
      .prepare(
        `INSERT INTO agent_questions (room, agent_id, question, answer, status, engine, started_at, ended_at, subject_id)
         VALUES ('demo', 'scout', 'Can you?', 'Yes.', 'done', 'claude', ?, ?, ?)`,
      )
      .run(at, at, subject).lastInsertRowid,
  );
  db.prepare("INSERT INTO question_proposals (question_id, task, state, created_at, revise_id) VALUES (?, ?, 'pending', ?, ?)").run(
    id,
    proposal,
    at,
    reviseId,
  );
  return id;
}

const taskRow = (db: Db, id: number) => db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow;
const runsAfter = (db: Db, id: number) => db.prepare("SELECT * FROM runs WHERE id > ? ORDER BY id").all(id) as RunRow[];
const subjectStatus = (db: Db, id: number) => (db.prepare("SELECT status FROM subjects WHERE id = ?").get(id) as { status: string }).status;
const proposalOf = (db: Db, subject: number | null, questionId: number) =>
  toQuestion(readDiscussion(db, "demo", "scout", subject).find((row) => row.id === questionId)!).proposal;

function expectHqError(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof HqError, String(error));
    assert.equal(error.code, code);
    return true;
  };
}

test("a relaunch works on the subject of its tasks, whatever older task another subject holds; hq_relaunch too", async () => {
  const config = office();
  const db = getDbAt(config.dbPath);
  const sign = createSubject(db, "demo", "scout", "Sign");
  const general = task(db, null, "General note waiting for the next run.", "manual");
  await new Promise((resolve) => setTimeout(resolve, 5));
  const revise = task(db, sign.id, "Revise the sign.", "revise");
  const [failed] = wakeAgents(config, db, { engine: engine([], "failed"), send: quiet });
  assert.equal(failed?.subject_id, sign.id);
  await waitForRun(db, failed!.id);
  assert.equal(taskRow(db, revise).status, "pending", "given back");

  // « Relancer » on the failed run: its run is of the subject and takes the revision, not the older general note.
  const relaunched = relaunchBlocked(config, db, { kind: "run", id: failed!.id }, { engine: engine([], "failed"), send: quiet });
  assert.ok(relaunched.tasks.includes(revise));
  assert.equal(relaunched.run?.subject_id, sign.id);
  assert.equal(taskRow(db, revise).run_id, relaunched.run!.id);
  assert.equal(taskRow(db, general).status, "pending");
  await waitForRun(db, relaunched.run!.id);

  // A supervisor's hq_relaunch (recorded by the HQ server, which put the tasks back to pending): the same.
  const at = new Date().toISOString();
  db.prepare(
    `INSERT INTO supervisor_relaunches (target_kind, target_id, room, agent_id, task_ids, by_room, by_agent, created_at)
     VALUES ('run', ?, 'demo', 'scout', ?, 'demo', 'boss', ?)`,
  ).run(relaunched.run!.id, JSON.stringify([revise]), at);
  const [byRequest] = startRelaunchRequests(config, db, { engine: engine(), send: quiet });
  assert.equal(byRequest?.subject_id, sign.id);
  assert.equal(taskRow(db, revise).run_id, byRequest!.id);
  await waitForRun(db, byRequest!.id);
  assert.equal(taskRow(db, revise).status, "done");
  // Its end gave the general note its own run: it waited for the agent's next run, which went to the sign.
  const after = runsAfter(db, byRequest!.id);
  assert.deepEqual(after.map((run) => run.subject_id), [null]);
  await waitForRun(db, after[0]!.id);
  assert.equal(taskRow(db, general).status, "done");
});

test("a routine or a run by hand is general: no subject's discussion, the general tasks; then the subject's queued task wakes the agent", async () => {
  const config = office({ onApproval: "queue" });
  const db = getDbAt(config.dbPath);
  const sign = createSubject(db, "demo", "scout", "Sign");
  db.prepare(
    `INSERT INTO agent_questions (room, agent_id, question, answer, status, engine, started_at, ended_at, subject_id)
     VALUES ('demo', 'scout', 'SECRET-S-TOPIC: border 2mm', 'ok', 'done', 'claude', ?, ?, ?)`,
  ).run(new Date().toISOString(), new Date().toISOString(), sign.id);
  decideApproval(db, item(db, sign.id), { decision: "approved" }, config);
  const queued = db.prepare("SELECT * FROM tasks WHERE source = 'approval'").get() as TaskRow;
  assert.deepEqual([queued.subject_id, queued.status], [sign.id, "pending"]);
  const generalNote = task(db, null, "General note.", "manual");

  const seen: RunInput[] = [];
  const routine = startRun({ room: "demo", agent: "scout", task: "Daily watch." }, { config, engine: engine(seen), motive: "routine", send: quiet });
  assert.equal(routine.subject_id, null);
  assert.equal(taskRow(db, generalNote).run_id, routine.id, "the general task goes with the routine");
  assert.equal(taskRow(db, queued.id).status, "pending");
  await waitForRun(db, routine.id);
  assert.ok(!seen[0]!.prompt.includes("SECRET-S-TOPIC"), "no subject's discussion in a general run");

  // The routine was the agent's next run, of another subject: the queued approval wakes the agent for its own subject.
  const [execution] = runsAfter(db, routine.id);
  assert.equal(execution?.subject_id, sign.id);
  assert.equal(taskRow(db, queued.id).run_id, execution!.id);
  await waitForRun(db, execution!.id);
  assert.equal(subjectStatus(db, sign.id), "archived", "the subject could settle");
});

test("a queued task of a subject is taken once the agent ran for general work; failing runs do not wake each other in a loop", async () => {
  const config = office({ onApproval: "queue" });
  const db = getDbAt(config.dbPath);
  const sign = createSubject(db, "demo", "scout", "Sign");
  decideApproval(db, item(db, sign.id), { decision: "approved" }, config);
  const queued = db.prepare("SELECT * FROM tasks WHERE source = 'approval'").get() as TaskRow;

  // A general run that fails is no next run that came: nothing wakes.
  task(db, null, "chat 0", "chat");
  const [failing] = wakeAgents(config, db, { engine: engine([], "failed"), send: quiet });
  assert.equal(failing?.subject_id, null);
  await waitForRun(db, failing!.id);
  assert.deepEqual(runsAfter(db, failing!.id), []);
  assert.deepEqual(wakeAgents(config, db, { engine: engine(), send: quiet }), []);
  assert.equal(taskRow(db, queued.id).status, "pending");

  // A general run that ends done: its end wakes the agent for the sign.
  task(db, null, "chat 1", "chat");
  const [general] = wakeAgents(config, db, { engine: engine(), send: quiet });
  assert.equal(general?.subject_id, null);
  await waitForRun(db, general!.id);
  const [sign1] = runsAfter(db, general!.id);
  assert.equal(sign1?.subject_id, sign.id);
  assert.equal(taskRow(db, queued.id).run_id, sign1!.id);
  await waitForRun(db, sign1!.id);
  assert.equal(subjectStatus(db, sign.id), "archived");
});

test("a general task that waits by design is not left behind by runs of a subject; a task a failed subject run gave back neither", async () => {
  const config = office({ onMessage: "queue" });
  const db = getDbAt(config.dbPath);
  const sign = createSubject(db, "demo", "scout", "Sign");
  const message = task(db, null, "FYI from another agent.", "message");
  assert.deepEqual(wakeAgents(config, db, { engine: engine(), send: quiet }), [], "a queued message wakes nobody");

  // The sign's revision fails: given back, it waits; the next run of the agent is general and ends done.
  const revise = task(db, sign.id, "Revise the sign.", "revise");
  const [failed] = wakeAgents(config, db, { engine: engine([], "failed"), send: quiet });
  assert.equal(failed?.subject_id, sign.id);
  await waitForRun(db, failed!.id);
  assert.deepEqual(runsAfter(db, failed!.id), [], "a failed run is no next run that came: nothing wakes");
  const byHand = startRun({ room: "demo", agent: "scout", task: "Something general." }, { config, engine: engine(), send: quiet });
  assert.equal(byHand.subject_id, null);
  assert.equal(taskRow(db, message).run_id, byHand.id, "the general run takes the queued message, as before the subjects");
  await waitForRun(db, byHand.id);
  const [again] = runsAfter(db, byHand.id);
  assert.equal(again?.subject_id, sign.id, "the given-back revision is taken after the agent's next run");
  assert.equal(taskRow(db, revise).run_id, again!.id);
  await waitForRun(db, again!.id);

  // A queued general message whose next run went to the sign wakes the agent itself.
  const later = task(db, null, "Another FYI.", "message");
  const revise2 = task(db, sign.id, "Revise it again.", "revise");
  const [signRun] = wakeAgents(config, db, { engine: engine(), send: quiet });
  assert.equal(signRun?.subject_id, sign.id);
  assert.equal(taskRow(db, revise2).run_id, signRun!.id);
  await waitForRun(db, signRun!.id);
  const [overdue] = runsAfter(db, signRun!.id);
  assert.equal(overdue?.subject_id, null);
  assert.equal(overdue?.reason, "message");
  assert.equal(taskRow(db, later).run_id, overdue!.id);
  await waitForRun(db, overdue!.id);
  assert.deepEqual(wakeAgents(config, db, { engine: engine(), send: quiet }), [], "nothing left");
});

test("a home without subjects: a task that waits for the next run is woken by nothing, and the next run takes it", async () => {
  const config = office({ onMessage: "queue" });
  const db = getDbAt(config.dbPath);
  const message = task(db, null, "FYI.", "message");
  assert.deepEqual(wakeAgents(config, db, { engine: engine(), send: quiet }), []);
  const first = startRun({ room: "demo", agent: "scout", task: "Work." }, { config, engine: engine(), send: quiet });
  assert.equal(first.subject_id, null);
  assert.equal(taskRow(db, message).run_id, first.id, "the next run takes it");
  const queuedAfter = task(db, null, "FYI again.", "message");
  await waitForRun(db, first.id);
  assert.deepEqual(runsAfter(db, first.id), [], "the end of a run wakes nothing for it, as before the subjects");
  assert.deepEqual(wakeAgents(config, db, { engine: engine(), send: quiet }), []);
  const second = startRun({ room: "demo", agent: "scout", task: "More work." }, { config, engine: engine(), send: quiet });
  assert.equal(taskRow(db, queuedAfter).run_id, second.id);
  await waitForRun(db, second.id);
});

test("the Standard counts the runs of the task's own subject: a run of another subject neither takes it nor hides why it waits", async () => {
  const config = office({}, { maxRunsPerDay: 1 });
  const db = getDbAt(config.dbPath);
  const sign = createSubject(db, "demo", "scout", "Sign");
  const held = gate();
  const general = startRun({ room: "demo", agent: "scout", task: "General work." }, { config, engine: engine([], "done", held.promise), send: quiet });
  const revise = task(db, sign.id, "Revise the sign.", "revise");
  db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), revise);
  const later = new Date(Date.now() + 20 * 60_000);
  const home = loadHome(config.home);
  const entryOf = () => listBlocked(db, home, config, later).find((entry) => entry.entry === "pending" && entry.id === revise);
  assert.equal(entryOf(), undefined, "the end of the general run wakes the agent for it: not stuck");
  held.open();
  await waitForRun(db, general.id);
  // The cap of 1 held the wake-up back: that is the reason, not a run that took it.
  assert.equal(taskRow(db, revise).status, "pending");
  assert.equal(entryOf()?.cause, "cap");
});

test("a pending proposal keeps its subject open; a run or a revision confirmed in an archived subject opens it again", async () => {
  const config = office();
  const db = getDbAt(config.dbPath);
  const sign = createSubject(db, "demo", "scout", "Sign");
  const question = proposed(db, sign.id, "Draw a second sign.", null, "2026-11-10T09:00:00.000Z");
  decideApproval(db, item(db, sign.id), { decision: "approved" }, config);
  assert.equal(subjectStatus(db, sign.id), "open", "the proposal waits for the owner");
  assert.equal(settleSubject(db, sign.id), false);
  decideProposal({ room: "demo", agent: "scout", questionId: question, action: "dismiss" }, { config });
  assert.equal(subjectStatus(db, sign.id), "archived", "set aside, nothing is left");

  // Archived by the owner with a proposal pending: confirming it opens the subject, and its run lands there.
  const poster = createSubject(db, "demo", "scout", "Poster");
  const run = proposed(db, poster.id, "Draw the poster.");
  updateSubject(db, "demo", "scout", poster.id, { status: "archived" });
  const { run: started } = decideProposal({ room: "demo", agent: "scout", questionId: run, action: "launch" }, { config, engine: engine(), send: quiet });
  assert.equal(started?.subject_id, poster.id);
  assert.equal(subjectStatus(db, poster.id), "open");
  await waitForRun(db, started!.id);
});

test("confirming a revision the item already has from the desk sets the proposal aside, once, with its own error", () => {
  const config = office({ onRevise: "queue" });
  const db = getDbAt(config.dbPath);
  const piece = item(db, null);
  decideApproval(db, piece, { decision: "revise", note: "Thicker border." }, config);
  const question = proposed(db, null, "Thicker border.", piece);
  assert.throws(
    () => decideProposal({ room: "demo", agent: "scout", questionId: question, action: "launch" }, { config }),
    expectHqError("REVISION_ALREADY_ASKED"),
  );
  assert.equal(proposalOf(db, null, question)?.state, "dismissed");
  assert.throws(
    () => decideProposal({ room: "demo", agent: "scout", questionId: question, action: "launch" }, { config }),
    expectHqError("PROPOSAL_DECIDED"),
  );
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE source = 'revise'").get() as { n: number }).n, 1, "no second revision");
});

test("a queued run can be cancelled while its task waits, never once its run started", async () => {
  const config = office();
  const db = getDbAt(config.dbPath);
  const held = gate();
  const busy = startRun({ room: "demo", agent: "scout", task: "Long." }, { config, engine: engine([], "done", held.promise), send: quiet });
  const cancelled = proposed(db, null, "First task.");
  const kept = proposed(db, null, "Second task.");
  for (const id of [cancelled, kept]) {
    const { run } = decideProposal({ room: "demo", agent: "scout", questionId: id, action: "launch" }, { config, engine: engine(), send: quiet });
    assert.equal(run, null);
    assert.equal(proposalOf(db, null, id)?.state, "queued");
  }
  const { question } = decideProposal({ room: "demo", agent: "scout", questionId: cancelled, action: "dismiss" }, { config });
  assert.equal(toQuestion(question).proposal?.state, "dismissed");
  const closed = db.prepare("SELECT t.* FROM tasks t JOIN question_proposals p ON p.task_id = t.id WHERE p.question_id = ?").get(cancelled) as TaskRow;
  assert.equal(closed.status, "done");

  held.open();
  await waitForRun(db, busy.id);
  const [next] = runsAfter(db, busy.id);
  assert.ok(next, "the end of the run started the queued one left");
  assert.equal(proposalOf(db, null, kept)?.state, "launched");
  assert.equal(taskRow(db, closed.id).run_id, null, "the cancelled one was never taken");
  assert.throws(
    () => decideProposal({ room: "demo", agent: "scout", questionId: kept, action: "dismiss" }, { config }),
    expectHqError("PROPOSAL_DECIDED"),
  );
  await waitForRun(db, next!.id);
});
