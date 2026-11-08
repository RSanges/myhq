import assert from "node:assert/strict";
import { test } from "node:test";
import { resetDiscussion } from "../src/server/agent-questions";
import { readThread } from "../src/server/agent-thread";
import { getDbAt, type Db } from "../src/server/db";
import { QUESTION_TYPE } from "../src/server/questions";
import { loadHome, syncHome } from "../src/server/rooms";
import { localDay, runDurationMs, sheetState, summaryTail, threadLines } from "../src/ui/agent-thread-model";
import type { ThreadEntry } from "../src/ui/schemas";
import { makeHome } from "./helpers";

function setup() {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  syncHome(db, loadHome(config.home));
  return { config, db };
}

function insertQuestion(db: Db, at: string, text: string, answer: string | null, status = "done", agent = "scout"): number {
  return Number(
    db
      .prepare(
        "INSERT INTO agent_questions (room, agent_id, question, answer, status, engine, model, cost_usd, started_at, ended_at) VALUES ('demo', ?, ?, ?, ?, 'claude', 'haiku', 0.01, ?, ?)",
      )
      .run(agent, text, answer, status, at, status === "running" ? null : at).lastInsertRowid,
  );
}

function insertRun(db: Db, at: string, status = "done", summary: string | null = "Done.", agent = "scout"): number {
  return Number(
    db
      .prepare(
        "INSERT INTO runs (room, agent_id, engine, task, status, started_at, ended_at, summary, cost_usd) VALUES ('demo', ?, 'claude', 'Do it', ?, ?, ?, ?, 0.2)",
      )
      .run(agent, status, at, status === "running" ? null : at, summary).lastInsertRowid,
  );
}

function insertItem(db: Db, at: string, type = "report", status = "pending", agent = "scout"): number {
  return Number(
    db
      .prepare(
        "INSERT INTO approvals (room, agent_id, type, title, body, status, created_at) VALUES ('demo', ?, ?, 'The report', 'Body', ?, ?)",
      )
      .run(agent, type, status, at).lastInsertRowid,
  );
}

test("the thread mixes the discussion, the runs and the items of the agent, oldest first", () => {
  const { db } = setup();
  const q1 = insertQuestion(db, "2026-11-08T09:00:00.000Z", "How are you?", "Fine.");
  const run = insertRun(db, "2026-11-08T09:05:00.000Z");
  const item = insertItem(db, "2026-11-08T09:10:00.000Z");
  const ask = insertItem(db, "2026-11-08T09:12:00.000Z", QUESTION_TYPE);
  const q2 = insertQuestion(db, "2026-11-08T09:20:00.000Z", "Next?", null, "running");
  // Another agent's entries never show.
  insertRun(db, "2026-11-08T09:06:00.000Z", "done", "x", "other");
  insertQuestion(db, "2026-11-08T09:07:00.000Z", "x", "y", "done", "other");

  const thread = readThread(db, "demo", "scout");
  assert.deepEqual(
    thread.entries.map((entry) => `${entry.kind}:${entry.kind === "question" ? entry.question.id : entry.kind === "run" ? entry.run.id : entry.item.id}`),
    [`question:${q1}`, `run:${run}`, `item:${item}`, `item:${ask}`, `question:${q2}`],
  );
  assert.equal(thread.busy, true);
  const askEntry = thread.entries[3];
  assert.ok(askEntry?.kind === "item" && askEntry.item.question);
  const runEntry = thread.entries[1];
  assert.ok(runEntry?.kind === "run" && runEntry.run.summary === "Done." && runEntry.run.costUsd === 0.2);
});

test("a new discussion hides the messages and the answers, the runs and the items stay", () => {
  const { db } = setup();
  insertQuestion(db, "2026-11-08T09:00:00.000Z", "How are you?", "Fine.");
  insertRun(db, "2026-11-08T09:05:00.000Z");
  insertItem(db, "2026-11-08T09:10:00.000Z");
  assert.equal(resetDiscussion(db, "demo", "scout"), 1);
  const thread = readThread(db, "demo", "scout");
  assert.deepEqual(
    thread.entries.map((entry) => entry.kind),
    ["run", "item"],
  );
  assert.equal(thread.busy, false);
});

const question = (id: number, at: string, status: "running" | "done" | "failed", answer: string | null = null) => ({
  id,
  question: `Question ${id}`,
  answer,
  status,
  error: status === "failed" ? ("timeout" as const) : null,
  model: "haiku",
  costUsd: 0.02,
  askedAt: at,
  answeredAt: status === "running" ? null : at,
});

test("the lines of the thread: a day line per day, the message then its answer, a run and an item", () => {
  const day1 = new Date(2026, 10, 7, 18, 0).toISOString();
  const day2 = new Date(2026, 10, 8, 9, 0).toISOString();
  const day2b = new Date(2026, 10, 8, 9, 30).toISOString();
  const entries: ThreadEntry[] = [
    { kind: "question", at: day1, question: question(1, day1, "done", "Hello **you**") },
    {
      kind: "run",
      at: day2,
      run: { id: 7, status: "running", task: "Go", reason: null, costUsd: 0, startedAt: day2, endedAt: null, summary: null },
    },
    {
      kind: "item",
      at: day2b,
      item: { id: 3, type: QUESTION_TYPE, title: "Which one?", status: "pending", question: true, createdAt: day2b },
    },
    { kind: "question", at: day2b, question: question(2, day2b, "running") },
    { kind: "question", at: day2b, question: question(3, day2b, "failed") },
  ];
  const now = new Date(2026, 10, 8, 9, 3).getTime();
  const lines = threadLines(entries, now);
  assert.deepEqual(
    lines.map((line) => line.kind),
    ["day", "mine", "reply", "day", "run", "item", "mine", "reply", "mine", "reply"],
  );
  assert.equal(lines[0]?.kind === "day" && lines[0].day, "2026-11-07");
  const reply = lines[2];
  assert.ok(reply?.kind === "reply" && reply.state === "answer" && reply.text === "Hello **you**");
  const run = lines[4];
  assert.ok(run?.kind === "run" && run.durationMs === 3 * 60_000 && run.tail === null);
  const item = lines[5];
  assert.ok(item?.kind === "item" && item.waiting);
  const thinking = lines[7];
  assert.ok(thinking?.kind === "reply" && thinking.state === "thinking" && thinking.text === null);
  const failed = lines[9];
  assert.ok(failed?.kind === "reply" && failed.state === "failed" && failed.error === "timeout");
});

test("an item of questions already answered does not wait any more", () => {
  const at = new Date(2026, 10, 8, 9, 0).toISOString();
  const lines = threadLines(
    [{ kind: "item", at, item: { id: 3, type: QUESTION_TYPE, title: "Q", status: "approved", question: true, createdAt: at } }],
    Date.now(),
  );
  assert.ok(lines[1]?.kind === "item" && !lines[1].waiting);
});

test("the end of a summary: its last line of text, in plain words, cut from the start when long", () => {
  assert.equal(summaryTail(null), null);
  assert.equal(summaryTail("   \n\n"), null);
  assert.equal(summaryTail("## Report\n\n- Clip A rendered\n- **Clip B** sent to [the desk](http://x)\n"), "Clip B sent to the desk");
  assert.equal(summaryTail("Done.\n\n---\n"), "Done.");
  const long = `Start ${"word ".repeat(60)}end of it.`;
  const tail = summaryTail(long, 40);
  assert.ok(tail !== null && tail.startsWith("…") && tail.endsWith("end of it.") && tail.length <= 40, tail ?? "");
});

test("the duration of a run, and the local day of an instant", () => {
  assert.equal(runDurationMs({ startedAt: "2026-11-08T09:00:00.000Z", endedAt: "2026-11-08T09:02:30.000Z" }, 0), 150_000);
  assert.equal(runDurationMs({ startedAt: "2026-11-08T09:00:00.000Z", endedAt: null }, Date.parse("2026-11-08T09:01:00.000Z")), 60_000);
  assert.equal(runDurationMs({ startedAt: "nope", endedAt: null }, 0), null);
  assert.equal(localDay(new Date(2026, 0, 5, 23, 59).toISOString()), "2026-01-05");
  assert.equal(localDay("nope"), null);
});

test("the state of the header: answering first, then at work with what it does, then failed, waiting, asleep", () => {
  const base = { answering: false, working: false, failed: false, asleep: false, activity: null, waitingFor: [] };
  assert.deepEqual(sheetState({ ...base, answering: true, working: true }), { kind: "answering" });
  assert.deepEqual(sheetState({ ...base, working: true, activity: "rend le clip B" }), { kind: "working", activity: "rend le clip B" });
  assert.deepEqual(sheetState({ ...base, failed: true, asleep: true }), { kind: "failed" });
  assert.deepEqual(sheetState({ ...base, waitingFor: ["gpu"], asleep: true }), { kind: "waiting", resources: ["gpu"] });
  assert.deepEqual(sheetState({ ...base, asleep: true }), { kind: "asleep" });
  assert.deepEqual(sheetState(base), { kind: "idle" });
});
