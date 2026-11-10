import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { hqReadDecisions, hqSubmit, inputs, type HqContext } from "../src/mcp/tools";
import { decideApproval, decisionSchema } from "../src/server/approvals";
import { getDbAt, type ApprovalRow, type Db, type TaskRow } from "../src/server/db";
import { briefingText, takeDecisions } from "../src/server/briefing";
import { CHOICES_KEY, parseChoices, type Question } from "../src/server/questions";
import { buildPrompt } from "../src/server/runner";
import { loadHome } from "../src/server/rooms";
import { makeHome } from "./helpers";

// Questions attached to an ordinary deliverable (hq_submit `questions`): the
// owner decides the deliverable and the choices in one gesture.

const QUESTIONS: Question[] = [
  { question: "Which voice?", header: "Voice", options: [{ label: "A" }, { label: "B" }] },
  { question: "Which music?", multiSelect: true, options: [{ label: "7" }, { label: "11" }, { label: "23" }] },
];
const ANSWERS = [{ options: [0] }, { options: [1, 2] }];

const queueRoom = {
  name: "demo",
  targetRepo: "../demo-project",
  agents: [{ id: "scout", name: "Scout", role: "roles/scout.md", model: "haiku", allowedTools: ["mcp__hq__*"], onApproval: "queue" }],
};

function fresh(roomJson?: unknown) {
  const config = makeHome({}, roomJson);
  const db = getDbAt(config.dbPath);
  const at = new Date().toISOString();
  db.prepare("INSERT OR IGNORE INTO rooms (name, target_repo, synced_at) VALUES ('demo', '../demo', ?)").run(at);
  db.prepare("INSERT OR IGNORE INTO agents (room, id, name, model, role_path, synced_at) VALUES ('demo', 'scout', 'Scout', 'haiku', 'r.md', ?)").run(at);
  const runId = Number(
    db
      .prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at) VALUES ('demo', 'scout', 'claude', 't', 'running', ?)")
      .run(at).lastInsertRowid,
  );
  const ctx: HqContext = { dbPath: config.dbPath, runId, agentId: "scout", room: "demo" };
  return { config, db, ctx };
}

const row = (db: Db, id: number) => db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow;
const tasks = (db: Db, source: string, id: number) =>
  db.prepare("SELECT * FROM tasks WHERE source = ? AND ref_id = ? ORDER BY id").all(source, id) as TaskRow[];

function submit(env: ReturnType<typeof fresh>, extra: Record<string, unknown> = {}) {
  const { approvalId } = hqSubmit(env.db, env.ctx, {
    type: "voice_over",
    title: "Voice-over",
    body: "Two voices, three seeds.",
    payload: { takes: 5 },
    questions: QUESTIONS,
    ...extra,
  });
  return approvalId;
}

test("hq_submit stores the questions in the payload next to the agent's own keys", () => {
  const env = fresh();
  const id = submit(env);
  const stored = row(env.db, id);
  assert.equal(stored.status, "pending");
  const payload = JSON.parse(stored.payload) as Record<string, unknown>;
  assert.equal(payload.takes, 5, "the agent's own payload is kept");
  assert.deepEqual(parseChoices(payload), { questions: QUESTIONS });
  assert.ok(CHOICES_KEY in payload);
  assert.equal(parseChoices({ takes: 5 }), null);
});

test("hq_submit questions use the existing schema and are refused for a question item", () => {
  assert.equal(z.object(inputs.hq_submit).safeParse({ type: "x", title: "T", body: "b", questions: [] }).success, false);
  assert.equal(
    z.object(inputs.hq_submit).safeParse({ type: "x", title: "T", body: "b", questions: [{ question: "Q?", options: [{ label: "a" }] }] }).success,
    false,
  );
  const env = fresh();
  assert.throws(() => submit(env, { type: "question" }), /hq_ask/);
});

test("approving a deliverable with questions needs valid answers, which then reach the agent", () => {
  const env = fresh(queueRoom);
  const id = submit(env);
  assert.throws(() => decideApproval(env.db, id, { decision: "approved" }, env.config), { code: "ANSWERS_REQUIRED" });
  assert.throws(
    () => decideApproval(env.db, id, { decision: "approved", answers: [{ options: [0] }] }, env.config),
    { code: "INVALID_ANSWERS" },
  );
  assert.equal(row(env.db, id).status, "pending", "nothing was decided");
  const done = decideApproval(env.db, id, { decision: "approved", answers: ANSWERS, note: "Great." }, env.config);
  assert.equal(done.status, "approved");
  assert.match(done.decisionNote ?? "", /Q : Which voice\? \/ R : A/);
  assert.match(done.decisionNote ?? "", /R : 11, 23/);
  assert.match(done.decisionNote ?? "", /Great\./);
  assert.deepEqual(parseChoices(JSON.parse(row(env.db, id).payload))?.answers, ANSWERS);
  const [task] = tasks(env.db, "approval", id);
  assert.ok(task, "the approval task of the agent");
  assert.match(task.text, /Q1: Which voice\?/);
  assert.match(task.text, /A1: A/);
  assert.match(task.text, /A2: 11, 23/);
  // The agent reads them with its decision, in both ways it reads decisions.
  const read = hqReadDecisions(env.db, env.ctx).decisions[0]!;
  assert.match(read.note ?? "", /R : A/);
  assert.deepEqual(parseChoices(read.payload)?.answers, ANSWERS);
  const taken = takeDecisions(env.db, "demo", "scout");
  assert.equal(taken.decisions.length, 0, "read once");
});

test("the briefing of the next prompt carries the answers", () => {
  const env = fresh();
  const id = submit(env);
  decideApproval(env.db, id, { decision: "approved", answers: ANSWERS });
  const { decisions } = takeDecisions(env.db, "demo", "scout");
  const text = briefingText(decisions, []);
  assert.match(text, /R : A/);
  assert.match(text, /ownerChoices/);
});

test("without onApproval nothing else changes: no task is created by an approval with answers", () => {
  const env = fresh();
  const id = submit(env);
  decideApproval(env.db, id, { decision: "approved", answers: ANSWERS });
  assert.equal(tasks(env.db, "approval", id).length, 0);
  assert.equal(tasks(env.db, "revise", id).length, 0);
});

test("a revision may carry the answers: they are in the note and in the revision task", () => {
  const env = fresh();
  const id = submit(env);
  const revised = decideApproval(env.db, id, { decision: "revise", note: "Slower, please.", answers: ANSWERS });
  assert.equal(revised.status, "revise");
  assert.match(revised.decisionNote ?? "", /R : A/);
  const [task] = tasks(env.db, "revise", id);
  assert.match(task!.text, /User's note: Slower, please\./);
  assert.match(task!.text, /answers to the questions of this item/);
  assert.match(task!.text, /A2: 11, 23/);
  // Without answers a revision is what it always was.
  const other = submit(env, { title: "Second" });
  decideApproval(env.db, other, { decision: "revise", note: "Redo." });
  assert.equal(tasks(env.db, "revise", other)[0]!.text, `Revise your submission #${other} "Second" (voice_over). User's note: Redo.`);
  assert.equal(parseChoices(JSON.parse(row(env.db, other).payload))?.answers, undefined);
});

test("answers stay refused on a rejection and on an item without questions", () => {
  assert.equal(decisionSchema.safeParse({ decision: "rejected", note: "No.", answers: ANSWERS }).success, false);
  assert.equal(decisionSchema.safeParse({ decision: "revise", note: "Again.", answers: ANSWERS }).success, true);
  const env = fresh();
  const plain = hqSubmit(env.db, env.ctx, { type: "post", title: "Plain", body: "No question here." }).approvalId;
  assert.throws(() => decideApproval(env.db, plain, { decision: "approved", answers: ANSWERS }), { code: "ANSWERS_NOT_EXPECTED" });
  assert.throws(() => decideApproval(env.db, plain, { decision: "revise", note: "n", answers: ANSWERS }), { code: "ANSWERS_NOT_EXPECTED" });
  assert.equal(decideApproval(env.db, plain, { decision: "approved" }).status, "approved");
});

test("the base prompt tells agents to attach variants as questions to the deliverable", () => {
  const config = makeHome();
  const room = loadHome(config.home).rooms[0]!;
  const prompt = buildPrompt({ room, agent: room.agents[0]!, runId: 1, task: "T", mailbox: [] });
  assert.match(prompt, /attach the choice as `questions` to the hq_submit of that deliverable instead of a separate hq_ask/);
});
