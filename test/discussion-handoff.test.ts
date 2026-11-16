import assert from "node:assert/strict";
import { test } from "node:test";
import { decideProposal, questionSystemText } from "../src/server/agent-questions";
import { getDbAt, type Db, type RunRow, type TaskRow } from "../src/server/db";
import { decideApproval } from "../src/server/approvals";
import { discussionHandoff, HANDOFF_ANSWER_CHARS, HANDOFF_BLOCK_CHARS } from "../src/server/discussion-handoff";
import type { Engine, RunInput } from "../src/server/engine";
import { buildPrompt, startRun } from "../src/server/runner";
import { loadHome } from "../src/server/rooms";
import { makeHome, waitForRun } from "./helpers";

const usage = { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

/** Records the prompt of every run it is given and ends it at once. */
function recording(seen: RunInput[]): Engine {
  return {
    name: "claude",
    async *run(input) {
      seen.push(input);
      yield { type: "end", status: "done", reason: "success", summary: "Done.", usage, costUsd: 0.01 };
    },
  };
}

/** Two agents in one room, to tell their discussions apart. */
function office() {
  const base = { role: "roles/scout.md", model: "haiku", allowedTools: ["mcp__hq__*"] };
  return makeHome(
    {},
    {
      name: "demo",
      targetRepo: "../demo-project",
      agents: [
        { id: "scout", name: "Scout", ...base },
        { id: "editor", name: "Editor", ...base },
      ],
    },
  );
}

type Spec = { question: string; answer?: string | null; at: string; agent?: string; status?: string; cleared?: string | null };

/** A question of the discussion, with the date given (the times of the incident are what matter). */
function addQuestion(db: Db, spec: Spec): number {
  return Number(
    db
      .prepare(
        `INSERT INTO agent_questions (room, agent_id, question, answer, status, engine, started_at, cleared_at)
         VALUES ('demo', ?, ?, ?, ?, 'claude', ?, ?)`,
      )
      .run(spec.agent ?? "scout", spec.question, spec.answer === undefined ? "Noted." : spec.answer, spec.status ?? "done", spec.at, spec.cleared ?? null)
      .lastInsertRowid,
  );
}

/** A run of the agent that delivered an item, started at `at`; the item it submitted. */
async function deliveredItem(config: ReturnType<typeof office>, db: Db, at: string): Promise<{ run: RunRow; approvalId: number }> {
  const run = startRun({ room: "demo", agent: "scout" }, { config, engine: recording([]) });
  await waitForRun(db, run.id);
  db.prepare("UPDATE runs SET started_at = ? WHERE id = ?").run(at, run.id);
  const approvalId = Number(
    db
      .prepare(
        "INSERT INTO approvals (room, agent_id, run_id, type, title, body, payload, status, created_at) VALUES ('demo', 'scout', ?, 'article', 'The piece', 'B', '{}', 'pending', ?)",
      )
      .run(run.id, at).lastInsertRowid,
  );
  return { run, approvalId };
}

const answerOf = (n: number) => `Agreed point ${n}.`;

test("the incident: a revision with a short note gets the discussion held since the run that made the item started", async () => {
  const config = office();
  const db = getDbAt(config.dbPath);
  const { approvalId } = await deliveredItem(config, db, "2026-11-10T10:00:00.000Z");
  // Before the run started: not part of this item's discussion.
  addQuestion(db, { question: "Old chat about lunch.", answer: "Before the run.", at: "2026-11-10T09:00:00.000Z" });
  // During the run, and after it.
  addQuestion(db, { question: "Make the border 2 mm.", answer: answerOf(1), at: "2026-11-10T10:05:00.000Z" });
  addQuestion(db, { question: "And the seal is a wax seal.", answer: answerOf(2), at: "2026-11-10T11:00:00.000Z" });
  // Cleared, another agent's, unanswered, failed: none of them.
  addQuestion(db, { question: "Cleared remark.", answer: "Cleared answer.", at: "2026-11-10T10:10:00.000Z", cleared: "2026-11-10T10:11:00.000Z" });
  addQuestion(db, { question: "Question to the editor.", answer: "Editor answer.", at: "2026-11-10T10:20:00.000Z", agent: "editor" });
  addQuestion(db, { question: "Still waiting.", answer: null, at: "2026-11-10T10:30:00.000Z", status: "running" });
  addQuestion(db, { question: "Broken one.", answer: "Half an", at: "2026-11-10T10:40:00.000Z", status: "failed" });

  const seen: RunInput[] = [];
  decideApproval(db, approvalId, { decision: "revise", note: "As agreed in the discussion." }, config, { engine: recording(seen) });
  const revision = db.prepare("SELECT * FROM runs WHERE reason = 'revise'").get() as RunRow;
  await waitForRun(db, revision.id);

  const prompt = seen[0]!.prompt;
  assert.match(prompt, /As agreed in the discussion\./, "the note is still there");
  assert.match(prompt, /## Your discussion with the owner/);
  assert.match(prompt, /where the note of the task and the discussion differ, the owner's most recent statement wins/i);
  assert.match(prompt, /hq_ask/);
  for (const kept of ["Make the border 2 mm.", answerOf(1), "And the seal is a wax seal.", answerOf(2)]) {
    assert.ok(prompt.includes(kept), `${kept} is in the prompt`);
  }
  for (const left of ["Old chat about lunch.", "Cleared remark.", "Editor answer.", "Question to the editor.", "Still waiting.", "Broken one."]) {
    assert.ok(!prompt.includes(left), `${left} is not in the prompt`);
  }
  assert.ok(prompt.indexOf("Make the border 2 mm.") < prompt.indexOf("And the seal is a wax seal."), "oldest first");
  assert.match(prompt, /### 2026-11-10 10:05 UTC/, "each exchange is dated");
});

test("the block is read when the revision run starts: what was said after the revision was decided counts", async () => {
  const config = office();
  const db = getDbAt(config.dbPath);
  const { approvalId } = await deliveredItem(config, db, "2026-11-10T10:00:00.000Z");
  // Decided with no config: the task waits, nothing wakes the agent.
  decideApproval(db, approvalId, { decision: "revise", note: "As agreed." });
  addQuestion(db, { question: "One more thing, said after the decision.", answer: "Understood.", at: "2026-11-10T12:00:00.000Z" });

  const seen: RunInput[] = [];
  const run = startRun({ room: "demo", agent: "scout", reason: "revise" }, { config, engine: recording(seen) });
  await waitForRun(db, run.id);
  assert.match(seen[0]!.prompt, /One more thing, said after the decision\./);
});

test("an item with no run is covered since its creation", () => {
  const config = office();
  const db = getDbAt(config.dbPath);
  const id = Number(
    db
      .prepare(
        "INSERT INTO approvals (room, agent_id, type, title, body, payload, status, created_at) VALUES ('demo', 'scout', 'article', 'T', 'B', '{}', 'pending', '2026-11-10T10:00:00.000Z')",
      )
      .run().lastInsertRowid,
  );
  addQuestion(db, { question: "Earlier.", at: "2026-11-10T09:59:00.000Z" });
  addQuestion(db, { question: "Later.", at: "2026-11-10T10:01:00.000Z" });
  const task = { source: "revise", ref_id: id } as TaskRow;
  const block = discussionHandoff(db, { room: "demo", agentId: "scout", mailbox: [task] })!;
  assert.ok(block.includes("Later.") && !block.includes("Earlier."));
});

test("a run started from a proposal gets the discussion up to the question that proposed it, not what came after", async () => {
  const config = office();
  const db = getDbAt(config.dbPath);
  addQuestion(db, { question: "Cleared start.", answer: "Gone.", at: "2026-11-10T09:00:00.000Z", cleared: "2026-11-10T09:30:00.000Z" });
  addQuestion(db, { question: "First point: a wax seal.", answer: answerOf(1), at: "2026-11-10T10:00:00.000Z" });
  const proposing = addQuestion(db, { question: "Then do it.", answer: "I propose a run.", at: "2026-11-10T10:05:00.000Z" });
  addQuestion(db, { question: "Said after the proposal.", answer: "Later answer.", at: "2026-11-10T10:10:00.000Z" });
  addQuestion(db, { question: "Question to the editor.", answer: "Editor answer.", at: "2026-11-10T10:02:00.000Z", agent: "editor" });
  db.prepare("INSERT INTO question_proposals (question_id, task, state, created_at) VALUES (?, 'Make the seal.', 'pending', '2026-11-10T10:05:00.000Z')").run(proposing);

  const seen: RunInput[] = [];
  const { run } = decideProposal({ room: "demo", agent: "scout", questionId: proposing, action: "launch" }, { config, engine: recording(seen) });
  await waitForRun(db, run!.id);
  const prompt = seen[0]!.prompt;
  assert.match(prompt, /Make the seal\./, "the task of the proposal");
  assert.match(prompt, /## Your discussion with the owner/);
  for (const kept of ["First point: a wax seal.", answerOf(1), "Then do it.", "I propose a run."]) assert.ok(prompt.includes(kept), kept);
  for (const left of ["Cleared start.", "Said after the proposal.", "Editor answer."]) assert.ok(!prompt.includes(left), left);

  // The link is the run's own: a run started by hand afterwards has no block.
  const plain: RunInput[] = [];
  const next = startRun({ room: "demo", agent: "scout", task: "Something else." }, { config, engine: recording(plain) });
  await waitForRun(db, next.id);
  assert.doesNotMatch(plain[0]!.prompt, /Your discussion with the owner/);
});

test("bounds: a long answer is cut with a mark, the owner's message stays whole", () => {
  const config = office();
  const db = getDbAt(config.dbPath);
  const message = "m".repeat(3_900);
  const id = addQuestion(db, { question: message, answer: "a".repeat(HANDOFF_ANSWER_CHARS + 1_000), at: "2026-11-10T10:00:00.000Z" });
  const block = discussionHandoff(db, { room: "demo", agentId: "scout", mailbox: [], upToQuestionId: id })!;
  assert.ok(block.includes(message));
  assert.ok(block.includes("a".repeat(HANDOFF_ANSWER_CHARS)));
  assert.ok(!block.includes("a".repeat(HANDOFF_ANSWER_CHARS + 1)));
  assert.match(block, /\[answer cut: 1000 more characters left out\]/);
});

test("bounds: over 24000 characters the oldest exchanges go first and their count is stated", () => {
  const config = office();
  const db = getDbAt(config.dbPath);
  let last = 0;
  for (let i = 1; i <= 6; i++) {
    last = addQuestion(db, { question: `Question number ${i}.`, answer: `${"x".repeat(5_900)} end ${i}`, at: `2026-11-10T10:0${i}:00.000Z` });
  }
  const block = discussionHandoff(db, { room: "demo", agentId: "scout", mailbox: [], upToQuestionId: last })!;
  assert.ok(block.length <= HANDOFF_BLOCK_CHARS, `${block.length} characters`);
  const left = Number(/\((\d+) earlier exchanges? left out/.exec(block)?.[1]);
  assert.ok(left >= 1 && left < 6, `${left} left out`);
  assert.equal((block.match(/^Owner: /gm) ?? []).length, 6 - left);
  assert.ok(block.includes("Question number 6."), "the newest stays");
  assert.ok(!block.includes("Question number 1."), "the oldest went first");
  // The exchanges that stay are the newest, in order.
  assert.ok(block.indexOf(`Question number ${left + 1}.`) < block.indexOf("Question number 6."));
});

test("no block, and the prompt as before, when no exchange applies", async () => {
  const config = office();
  const db = getDbAt(config.dbPath);
  const { approvalId } = await deliveredItem(config, db, "2026-11-10T10:00:00.000Z");
  const revise = { source: "revise", ref_id: approvalId } as TaskRow;
  // Nothing asked since the run; a question of before the run; no link at all.
  addQuestion(db, { question: "Long ago.", at: "2026-11-09T10:00:00.000Z" });
  assert.equal(discussionHandoff(db, { room: "demo", agentId: "scout", mailbox: [revise] }), null);
  assert.equal(discussionHandoff(db, { room: "demo", agentId: "scout", mailbox: [] }), null);
  // An approval task is no revision: it carries no discussion.
  addQuestion(db, { question: "Recent.", at: "2026-11-10T11:00:00.000Z" });
  assert.equal(discussionHandoff(db, { room: "demo", agentId: "scout", mailbox: [{ source: "approval", ref_id: approvalId } as TaskRow] }), null);

  const room = loadHome(config.home).rooms[0]!;
  const params = { room, agent: room.agents[0]!, runId: 1, task: "T", mailbox: [] };
  assert.equal(buildPrompt(params), buildPrompt({ ...params, discussion: null }));
  assert.doesNotMatch(buildPrompt(params), /Your discussion with the owner/);
});

test("every run is told to open its submission with what it decided alone", () => {
  const room = loadHome(office().home).rooms[0]!;
  const prompt = buildPrompt({ room, agent: room.agents[0]!, runId: 1, task: "T", mailbox: [] });
  assert.match(prompt, /body of a submission starts with the readings and choices you made alone/);
});

test("question mode says the discussion follows the task, and a proposed task stays a recap", () => {
  const text = questionSystemText("English");
  assert.match(text, /handed to the run that revises an item you delivered, to a run you propose here, and, while a run of yours works on this subject, to that run at its next step/);
  assert.match(text, /never ask the owner to copy or repeat what was agreed/);
  assert.match(text, /self-contained recap of what was agreed/);
});
