import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { hqAsk, hqReadDecisions, inputs, type HqContext } from "../src/mcp/tools";
import { PATCH } from "../src/app/api/approvals/[id]/route";
import { decideApproval, decisionSchema } from "../src/server/approvals";
import { getDbAt, type ApprovalRow, type Db, type RunRow, type TaskRow } from "../src/server/db";
import type { Engine, RunEvent } from "../src/server/engine";
import { MAX_QUESTIONS, parseQuestionPayload, renderQuestionsBody, type Question } from "../src/server/questions";
import { makeHome, waitForRun } from "./helpers";

const usage = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const done: RunEvent = { type: "end", status: "done", reason: "success", summary: "ok", usage, costUsd: 0 };

const QUESTIONS: Question[] = [
  {
    question: "Which tone for the launch post?",
    header: "Tone",
    options: [{ label: "Playful", description: "Jokes allowed" }, { label: "Serious" }, { label: "Neutral" }],
  },
  {
    question: "Which channels?",
    multiSelect: true,
    options: [{ label: "Newsletter" }, { label: "Blog" }, { label: "Social" }],
  },
];

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
const count = (db: Db, sql: string) => (db.prepare(sql).get() as { n: number }).n;
const reviseTasks = (db: Db, id: number) =>
  db.prepare("SELECT * FROM tasks WHERE source = 'revise' AND ref_id = ? ORDER BY id").all(id) as TaskRow[];

// --- The input schema ------------------------------------------------------------------

const shape = z.object(inputs.hq_ask);
const option = (label: string) => ({ label });

test("hq_ask takes at least one question, 2 to 6 options each, and at most 20 questions", () => {
  const ok = (questions: unknown) => shape.safeParse({ title: "T", questions }).success;
  const question = (options: number) => ({ question: "Q?", options: Array.from({ length: options }, (_, i) => option(`o${i}`)) });
  assert.equal(ok([]), false, "at least one question");
  assert.equal(ok([question(1)]), false, "at least two options");
  assert.equal(ok([question(2)]), true);
  assert.equal(ok([question(6)]), true);
  assert.equal(ok([question(7)]), false, "at most six options");
  assert.equal(ok(Array.from({ length: MAX_QUESTIONS }, () => question(2))), true, "twenty questions are fine");
  assert.equal(ok(Array.from({ length: MAX_QUESTIONS + 1 }, () => question(2))), false, "the technical guard is 20");
  assert.equal(ok([{ question: "", options: [option("a"), option("b")] }]), false, "a question has a text");
  assert.equal(ok([{ question: "Q?", options: [option("a"), option("b")], header: "x".repeat(31) }]), false, "the header is very short");
  assert.equal(ok([{ question: "Q?", options: [option("a"), option("b")], multiSelect: true }]), true);
});

// --- Creating the item -------------------------------------------------------------------

test("hq_ask stores a pending item of type question: the questions in the payload, a readable text in the body", () => {
  const { db, ctx } = fresh();
  const result = hqAsk(db, ctx, { title: "Launch post", context: "I need **two** choices.", questions: QUESTIONS });
  assert.equal(result.status, "pending");
  assert.match(result.note, /finish your turn/);
  const stored = row(db, result.approvalId);
  assert.equal(stored.type, "question");
  assert.equal(stored.status, "pending");
  assert.equal(stored.agent_id, "scout");
  assert.equal(stored.title, "Launch post");
  const payload = JSON.parse(stored.payload) as unknown;
  assert.deepEqual(parseQuestionPayload(payload), { context: "I need **two** choices.", questions: QUESTIONS });
  assert.equal(stored.body, renderQuestionsBody("I need **two** choices.", QUESTIONS));
  assert.match(stored.body, /1\. \[Tone\] Which tone for the launch post\?/);
  assert.match(stored.body, /- Playful : Jokes allowed/);
  assert.match(stored.body, /\(plusieurs réponses possibles\)/);
  assert.match(stored.body, /- Autre \(texte libre\)/, "Other is always there, added by MyHQ");
});

test("the same questions twice while they wait are one item", () => {
  const { db, ctx } = fresh();
  const first = hqAsk(db, ctx, { title: "Launch post", questions: QUESTIONS });
  const again = hqAsk(db, ctx, { title: "Launch post", questions: QUESTIONS });
  assert.equal(again.approvalId, first.approvalId);
  assert.equal(again.duplicate, true);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM approvals WHERE type = 'question'"), 1);
});

test("the receptionist does not ask", () => {
  const { db, ctx } = fresh();
  assert.throws(() => hqAsk(db, { ...ctx, room: "_hq" }, { title: "T", questions: QUESTIONS }), /receptionist/);
});

// --- Answering ---------------------------------------------------------------------------

const ANSWERS = [{ options: [1] }, { options: [0, 2], other: "Podcast" }];

function ask() {
  const env = fresh();
  const { approvalId } = hqAsk(env.db, env.ctx, { title: "Launch post", questions: QUESTIONS });
  return { ...env, id: approvalId };
}

test("approving an item of questions needs its answers, checked against the questions", () => {
  const { db, id } = ask();
  assert.throws(() => decideApproval(db, id, { decision: "approved" }), { code: "ANSWERS_REQUIRED" });
  assert.throws(() => decideApproval(db, id, { decision: "approved", answers: [{ options: [1] }] }), { code: "INVALID_ANSWERS" });
  assert.throws(
    () => decideApproval(db, id, { decision: "approved", answers: [{ options: [5] }, { options: [0] }] }),
    { code: "INVALID_ANSWERS" },
    "an option that does not exist",
  );
  assert.throws(
    () => decideApproval(db, id, { decision: "approved", answers: [{ options: [0, 1] }, { options: [0] }] }),
    { code: "INVALID_ANSWERS" },
    "a single-select question takes one answer",
  );
  assert.throws(
    () => decideApproval(db, id, { decision: "approved", answers: [{ options: [] }, { options: [0] }] }),
    { code: "INVALID_ANSWERS" },
    "no answer",
  );
  assert.equal(row(db, id).status, "pending", "nothing was decided");
  assert.equal(reviseTasks(db, id).length, 0);
  // Answers come with an approval only, and only for an item of questions.
  assert.equal(decisionSchema.safeParse({ decision: "rejected", note: "No.", answers: ANSWERS }).success, false);
});

test("answering keeps the answers and sends the agent a task with its questions and each answer", () => {
  const { db, id } = ask();
  const answered = decideApproval(db, id, { decision: "approved", answers: ANSWERS });
  assert.equal(answered.status, "approved");
  assert.equal(
    answered.decisionNote,
    "Q : Which tone for the launch post? / R : Serious\nQ : Which channels? / R : Newsletter, Social, Autre : Podcast",
  );
  assert.deepEqual(parseQuestionPayload(answered.payload)?.answers, ANSWERS);
  const [task] = reviseTasks(db, id);
  assert.equal(task?.agent_id, "scout");
  assert.equal(task?.status, "pending");
  assert.equal(
    task?.text,
    [
      `The owner answered your questions #${id} "Launch post".`,
      "Q1: Which tone for the launch post?",
      "A1: Serious",
      "Q2: Which channels?",
      "A2: Newsletter, Social, Other: Podcast",
      "Go on with your work using these answers; do not ask the same questions again.",
    ].join("\n"),
  );
  // No approval task, whatever the agent's onApproval: the answers are the only task.
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM tasks WHERE source = 'approval'"), 0);
  // The agent also reads the decision, with the same Q and R lines.
  const [decision] = hqReadDecisions(db, { dbPath: "", runId: 1, agentId: "scout", room: "demo" }).decisions;
  assert.equal(decision?.decision, "approved");
  assert.equal(decision?.note, answered.decisionNote);
  // Answering twice is refused, like any decided item.
  assert.throws(() => decideApproval(db, id, { decision: "approved", answers: ANSWERS }), { code: "APPROVAL_ALREADY_DECIDED" });
});

test("an item of questions can be rejected with a reason, and is never sent back", () => {
  const { db, id } = ask();
  assert.throws(() => decideApproval(db, id, { decision: "revise", note: "Redo." }), { code: "QUESTION_NOT_REVISABLE" });
  const rejected = decideApproval(db, id, { decision: "rejected", note: "No need, go with the playful tone." });
  assert.equal(rejected.status, "rejected");
  assert.equal(reviseTasks(db, id).length, 0, "a rejection wakes nobody");
  assert.throws(() => decideApproval(db, id, { decision: "revise", note: "Redo." }), { code: "QUESTION_NOT_REVISABLE" });
});

test("answers are refused on an item that is not a question", () => {
  const { db } = fresh();
  const id = Number(
    db
      .prepare("INSERT INTO approvals (room, agent_id, type, title, body, status, created_at) VALUES ('demo', 'scout', 'article', 'A', 'B', 'pending', ?)")
      .run(new Date().toISOString()).lastInsertRowid,
  );
  assert.throws(() => decideApproval(db, id, { decision: "approved", answers: [{ options: [0] }] }), { code: "ANSWERS_NOT_EXPECTED" });
  assert.equal(row(db, id).status, "pending");
});

test("PATCH /api/approvals/[id] answers an item of questions, and refuses to approve it bare", async () => {
  const { db, config, id } = ask();
  const saved = { home: process.env.MYHQ_HOME, bin: process.env.HQ_CLAUDE_BIN };
  process.env.MYHQ_HOME = config.home;
  // The answers wake the agent: a binary that does not exist, so that no real run starts.
  process.env.HQ_CLAUDE_BIN = "claude-binary-not-installed-in-tests";
  try {
    const patch = (body: unknown) =>
      PATCH(
        new Request(`http://127.0.0.1/api/approvals/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id: String(id) }) } as never,
      );
    assert.equal((await patch({ decision: "approved" })).status, 422);
    assert.equal((await patch({ decision: "approved", answers: [{ options: [4] }, { options: [0] }] })).status, 422);
    assert.equal(row(db, id).status, "pending");
    const ok = await patch({ decision: "approved", answers: ANSWERS });
    assert.equal(ok.status, 200);
    assert.equal(row(db, id).status, "approved");
  } finally {
    if (saved.home === undefined) delete process.env.MYHQ_HOME;
    else process.env.MYHQ_HOME = saved.home;
    if (saved.bin === undefined) delete process.env.HQ_CLAUDE_BIN;
    else process.env.HQ_CLAUDE_BIN = saved.bin;
  }
});

test("answering wakes the agent with its questions and the answers, like a revision does", async () => {
  const wake = fresh({
    name: "demo",
    targetRepo: "../demo-project",
    agents: [{ id: "scout", name: "Scout", role: "roles/scout.md", model: "haiku", allowedTools: ["mcp__hq__*"] }],
  });
  const { db, config, ctx } = wake;
  const { approvalId: id } = hqAsk(db, ctx, { title: "Launch post", questions: QUESTIONS });
  // The run that asked has ended: the agent is free to be woken.
  db.prepare("UPDATE runs SET status = 'done', ended_at = ? WHERE id = ?").run(new Date().toISOString(), ctx.runId);
  const seen: string[] = [];
  const engine: Engine = {
    name: "claude",
    async *run(input) {
      seen.push(input.prompt);
      yield done;
    },
  };
  decideApproval(db, id, { decision: "approved", answers: ANSWERS }, config, { engine, send: async () => true });
  const run = db.prepare("SELECT * FROM runs WHERE reason = 'revise'").get() as RunRow | undefined;
  assert.ok(run, "the agent was woken at once");
  await waitForRun(db, run.id);
  assert.match(seen[0]!, /Q1: Which tone for the launch post\?\nA1: Serious\nQ2: Which channels\?\nA2: Newsletter, Social, Other: Podcast/);
  assert.equal(reviseTasks(db, id)[0]?.status, "done");
});

test("an agent that queues its revisions is not woken by answers, which wait for its next run", () => {
  const queued = fresh({
    name: "demo",
    targetRepo: "../demo-project",
    agents: [{ id: "scout", name: "Scout", role: "roles/scout.md", model: "haiku", allowedTools: ["mcp__hq__*"], onRevise: "queue" }],
  });
  const { db, config, ctx } = queued;
  const { approvalId: id } = hqAsk(db, ctx, { title: "Launch post", questions: QUESTIONS });
  db.prepare("UPDATE runs SET status = 'done', ended_at = ? WHERE id = ?").run(new Date().toISOString(), ctx.runId);
  decideApproval(db, id, { decision: "approved", answers: ANSWERS }, config, { send: async () => true });
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM runs WHERE reason = 'revise'"), 0);
  assert.equal(reviseTasks(db, id)[0]?.status, "pending");
});
