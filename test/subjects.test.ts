import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PATCH as subjectRoute } from "../src/app/api/rooms/[room]/agents/[agent]/subjects/[subject]/route";
import { POST as subjectsPost } from "../src/app/api/rooms/[room]/agents/[agent]/subjects/route";
import {
  askAgent,
  decideProposal,
  questionsIdle,
  questionSystemText,
  readDiscussion,
  resetDiscussion,
  toQuestion,
} from "../src/server/agent-questions";
import { readThread } from "../src/server/agent-thread";
import { decideApproval } from "../src/server/approvals";
import { getDbAt, openDb, type ApprovalRow, type Db, type RunRow, type TaskRow } from "../src/server/db";
import { discussionHandoff } from "../src/server/discussion-handoff";
import type { Engine, RunEvent, RunInput } from "../src/server/engine";
import { HqError } from "../src/server/errors";
import { parseRunProposal, REVISION_PROPOSAL_MAX_CHARS } from "../src/server/run-proposal";
import { startRun, wakeAgents } from "../src/server/runner";
import {
  createSubject,
  createSubjectSchema,
  listSubjects,
  readSubject,
  settleSubject,
  SUBJECT_TITLE_MAX_CHARS,
  subjectTitleFrom,
  updateSubject,
  updateSubjectSchema,
} from "../src/server/subjects";
import { hqAsk, hqSubmit } from "../src/mcp/tools";
import { makeHome, waitForRun } from "./helpers";

const usage = { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

function expectHqError(code: string, status: number) {
  return (error: unknown) => {
    assert.ok(error instanceof HqError, String(error));
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  };
}

/** Answers every question with `answer`, records the prompts, and waits for `gate` when one is given. */
function answering(answer: string, prompts: string[] = [], gate?: Promise<void>): Engine {
  return {
    name: "claude",
    async *run(input: RunInput): AsyncIterable<RunEvent> {
      prompts.push(input.prompt, fs.readFileSync(input.rolePath, "utf8"));
      if (gate) await gate;
      input.onRawLine?.(JSON.stringify({ type: "result", subtype: "success", result: answer }));
      yield { type: "end", status: "done", reason: "success", summary: answer.slice(0, 50), usage, costUsd: 0.01 };
    },
  };
}

/** A run engine: records each run, lets `during` act in it (submit an item, for one), then ends it done. */
function runEngine(seen: RunInput[], during?: (input: RunInput) => void, gate?: Promise<void>): Engine {
  return {
    name: "claude",
    async *run(input: RunInput): AsyncIterable<RunEvent> {
      seen.push(input);
      during?.(input);
      if (gate) await gate;
      yield { type: "end", status: "done", reason: "success", summary: "Done.", usage, costUsd: 0.02 };
    },
  };
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

/** A room whose agent executes what the owner approves (`onApproval: "task"`) when `executes`. */
function office(executes = false) {
  return makeHome(
    {},
    {
      name: "demo",
      targetRepo: "../demo-project",
      agents: [
        {
          id: "scout",
          name: "Scout",
          role: "roles/scout.md",
          model: "haiku",
          allowedTools: ["mcp__hq__*"],
          ...(executes ? { onApproval: "task" } : {}),
        },
      ],
    },
  );
}

/** A question already answered in a subject, with its date. */
function exchange(db: Db, subject: number | null, question: string, answer: string, at: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO agent_questions (room, agent_id, question, answer, status, engine, started_at, ended_at, subject_id)
         VALUES ('demo', 'scout', ?, ?, 'done', 'claude', ?, ?, ?)`,
      )
      .run(question, answer, at, at, subject).lastInsertRowid,
  );
}

/** An item of the agent in a subject, with no run. */
function item(db: Db, subject: number | null, title: string, status = "pending", type = "article"): number {
  return Number(
    db
      .prepare(
        `INSERT INTO approvals (room, agent_id, type, title, body, payload, status, created_at, subject_id)
         VALUES ('demo', 'scout', ?, ?, 'B', '{}', ?, ?, ?)`,
      )
      .run(type, title, status, new Date().toISOString(), subject).lastInsertRowid,
  );
}

/** A pending task of the agent's mailbox in a subject. */
function pendingTask(db: Db, subject: number | null, text: string, source = "message"): number {
  const at = new Date().toISOString();
  return Number(
    db
      .prepare(
        `INSERT INTO tasks (room, agent_id, source, text, status, subject_id, created_at, updated_at)
         VALUES ('demo', 'scout', ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(source, text, subject, at, at).lastInsertRowid,
  );
}

const status = (db: Db, id: number) => (db.prepare("SELECT status FROM subjects WHERE id = ?").get(id) as { status: string }).status;
const tasksOf = (db: Db, runId: number) => db.prepare("SELECT * FROM tasks WHERE run_id = ? ORDER BY id").all(runId) as TaskRow[];
/** The mailbox tasks a run claimed (not its own instruction). */
const mailboxOf = (db: Db, runId: number) =>
  tasksOf(db, runId)
    .filter((task) => task.source !== "manual")
    .map((task) => task.id);

// --- The schema -------------------------------------------------------------------

test("migration 28: a fresh database has the subjects, and one at version 27 gets them with its rows in the general subject", () => {
  const columns = (db: Db, table: string) =>
    (db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as { name: string }[]).map((c) => c.name);
  const tables = ["agent_questions", "tasks", "runs", "approvals"];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-subjects-"));
  const fresh = openDb(path.join(dir, "fresh.db"));
  for (const table of tables) assert.ok(columns(fresh, table).includes("subject_id"), table);
  assert.ok(columns(fresh, "question_proposals").includes("revise_id"));
  assert.ok(columns(fresh, "subjects").includes("archived_at"));
  fresh.close();

  const file = path.join(dir, "old.db");
  const old = openDb(file);
  old.exec(`
    ${tables.map((table) => `ALTER TABLE ${table} DROP COLUMN subject_id;`).join("\n")}
    ALTER TABLE question_proposals DROP COLUMN revise_id; DROP TABLE subjects;
    DELETE FROM schema_migrations WHERE version = 28;
  `);
  old.prepare(
    "INSERT INTO tasks (room, agent_id, source, text, status, created_at, updated_at) VALUES ('demo', 'scout', 'message', 'Hi', 'pending', 'x', 'x')",
  ).run();
  old.close();
  const upgraded = openDb(file);
  assert.deepEqual(upgraded.prepare("SELECT text, subject_id FROM tasks").all(), [{ text: "Hi", subject_id: null }]);
  assert.ok(upgraded.prepare("SELECT 1 FROM schema_migrations WHERE version = 28").get());
  upgraded.close();
  // Opened again: nothing runs twice.
  openDb(file).close();
});

// --- The subjects themselves ---------------------------------------------------------

test("a subject is created, renamed, archived and reopened; never one of another agent", () => {
  const config = office();
  const db = getDbAt(config.dbPath);
  const untitled = createSubject(db, "demo", "scout");
  assert.equal(untitled.title, null);
  const named = createSubject(db, "demo", "scout", "Shop sign");
  assert.deepEqual(listSubjects(db, "demo", "scout").map((row) => row.id), [untitled.id, named.id]);

  assert.equal(updateSubject(db, "demo", "scout", named.id, { title: "Shop sign, front" }).title, "Shop sign, front");
  const archived = updateSubject(db, "demo", "scout", named.id, { status: "archived" });
  assert.equal(archived.status, "archived");
  assert.ok(archived.archived_at);
  assert.deepEqual(listSubjects(db, "demo", "scout").map((row) => row.id), [untitled.id]);
  assert.deepEqual(listSubjects(db, "demo", "scout", true).map((row) => row.id), [named.id]);
  const reopened = updateSubject(db, "demo", "scout", named.id, { status: "open" });
  assert.equal(reopened.status, "open");
  assert.equal(reopened.archived_at, null);

  assert.throws(() => readSubject(db, "demo", "editor", named.id), expectHqError("SUBJECT_NOT_FOUND", 404));
  assert.throws(() => updateSubject(db, "demo", "scout", 999, { title: "X" }), expectHqError("SUBJECT_NOT_FOUND", 404));

  assert.equal(createSubjectSchema.safeParse({ title: "   " }).success, false);
  assert.equal(createSubjectSchema.safeParse({ title: "x".repeat(SUBJECT_TITLE_MAX_CHARS + 1) }).success, false);
  assert.equal(createSubjectSchema.safeParse({ other: 1 }).success, false);
  assert.equal(updateSubjectSchema.safeParse({}).success, false);
  assert.equal(updateSubjectSchema.safeParse({ status: "deleted" }).success, false);
});

test("a subject without a title takes the owner's first message, on one line, cut to 60 characters", async () => {
  assert.equal(subjectTitleFrom("  The   shop\nsign  "), "The shop sign");
  const long = subjectTitleFrom("word ".repeat(30));
  assert.equal(long.length, SUBJECT_TITLE_MAX_CHARS);
  assert.ok(long.endsWith("…"));

  const config = office();
  const db = getDbAt(config.dbPath);
  const subject = createSubject(db, "demo", "scout");
  askAgent({ room: "demo", agent: "scout", question: "The sign of the shop front", subject: subject.id }, { config, engine: answering("Ok.") });
  await questionsIdle();
  askAgent({ room: "demo", agent: "scout", question: "And another thing", subject: subject.id }, { config, engine: answering("Ok.") });
  await questionsIdle();
  assert.equal(readSubject(db, "demo", "scout", subject.id).title, "The sign of the shop front", "the first message only");
});

test("the routes: create answers 201, the list gives the open or the archived ones, a patch renames and archives", async () => {
  const config = office();
  const saved = process.env.MYHQ_HOME;
  process.env.MYHQ_HOME = config.home;
  const json = (method: string, body: unknown) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const base = "http://localhost/api/rooms/demo/agents/scout/subjects";
  const params = { params: Promise.resolve({ room: "demo", agent: "scout" }) };
  try {
    const created = await subjectsPost(new Request(base, json("POST", { title: "Poster" })), params);
    assert.equal(created.status, 201);
    const { subject } = (await created.json()) as { subject: { id: number; title: string; status: string } };
    assert.equal(subject.title, "Poster");
    assert.equal((await subjectsPost(new Request(base, json("POST", { title: 3 })), params)).status, 400);

    const patch = (id: string, body: unknown) =>
      subjectRoute(new Request(`${base}/${id}`, json("PATCH", body)), {
        params: Promise.resolve({ room: "demo", agent: "scout", subject: id }),
      });
    assert.equal((await patch(String(subject.id), {})).status, 400);
    assert.equal((await patch("abc", { title: "X" })).status, 400);
    assert.equal((await patch("999", { title: "X" })).status, 404);
    const renamed = (await (await patch(String(subject.id), { title: "Big poster", status: "archived" })).json()) as {
      subject: { title: string; status: string };
    };
    assert.deepEqual([renamed.subject.title, renamed.subject.status], ["Big poster", "archived"]);
    const nobody = { params: Promise.resolve({ room: "demo", agent: "nobody" }) };
    assert.equal((await subjectsPost(new Request(base, json("POST", {})), nobody)).status, 404);
  } finally {
    if (saved === undefined) delete process.env.MYHQ_HOME;
    else process.env.MYHQ_HOME = saved;
  }
});

// --- Questions per subject -------------------------------------------------------------

test("a question gets back the exchanges of its own subject only, and is told about the agent's other subjects", async () => {
  const config = office();
  const db = getDbAt(config.dbPath);
  const sign = createSubject(db, "demo", "scout", "Shop sign");
  const poster = createSubject(db, "demo", "scout", "Poster");
  exchange(db, null, "General chat.", "General answer.", "2026-11-10T09:00:00.000Z");
  exchange(db, sign.id, "The sign is 2 m wide.", "Noted for the sign.", "2026-11-10T09:01:00.000Z");
  exchange(db, poster.id, "The poster is A2.", "Noted for the poster.", "2026-11-10T09:02:00.000Z");
  const posterItem = item(db, poster.id, "Poster draft", "approved");
  // A run of the agent going on the poster.
  const held = gate();
  const run = startRun({ room: "demo", agent: "scout", task: "Draw the poster." }, { config, engine: runEngine([], undefined, held.promise), subject: poster.id });

  const prompts: string[] = [];
  askAgent({ room: "demo", agent: "scout", question: "How wide is it again?", subject: sign.id }, { config, engine: answering("2 m.", prompts) });
  await questionsIdle();
  const prompt = prompts[0]!;
  assert.match(prompt, /The sign is 2 m wide\./);
  assert.match(prompt, /This discussion is your subject "Shop sign"/);
  for (const left of ["General chat.", "The poster is A2."]) assert.ok(!prompt.includes(left), left);
  assert.match(prompt, new RegExp(`- "Poster" \\(subject #${poster.id}\\): a run of yours is going on it; its latest item: #${posterItem} "Poster draft" \\(approved\\)\\.`));
  assert.match(prompt, /clearly belongs to one of these other subjects, say so in one sentence .*then answer anyway/);
  assert.ok(!prompt.includes(`"Shop sign" (subject #${sign.id})`), "the current subject is not among the others");

  // The general discussion does not see the subjects' exchanges either.
  const general: string[] = [];
  askAgent({ room: "demo", agent: "scout", question: "Anything else?" }, { config, engine: answering("No.", general) });
  await questionsIdle();
  assert.match(general[0]!, /General chat\./);
  assert.ok(!general[0]!.includes("The sign is 2 m wide."));
  assert.match(general[0]!, /This discussion is your general one with the owner/);
  held.open();
  await waitForRun(db, run.id);
});

test("one question at a time per subject: another subject is answered meanwhile; a reset clears the general subject only", async () => {
  const config = office();
  const db = getDbAt(config.dbPath);
  const sign = createSubject(db, "demo", "scout", "Shop sign");
  const held = gate();
  askAgent({ room: "demo", agent: "scout", question: "First, general." }, { config, engine: answering("Ok.", [], held.promise) });
  assert.throws(
    () => askAgent({ room: "demo", agent: "scout", question: "Second, general." }, { config, engine: answering("Ok.") }),
    expectHqError("QUESTION_BUSY", 409),
  );
  assert.throws(() => resetDiscussion(db, "demo", "scout"), expectHqError("QUESTION_BUSY", 409));
  const inSubject = askAgent({ room: "demo", agent: "scout", question: "In the sign.", subject: sign.id }, { config, engine: answering("Ok.") });
  assert.equal(inSubject.subject_id, sign.id);
  assert.throws(
    () => askAgent({ room: "demo", agent: "scout", question: "Again in the sign.", subject: sign.id }, { config, engine: answering("Ok.") }),
    expectHqError("QUESTION_BUSY", 409),
  );
  assert.throws(
    () => askAgent({ room: "demo", agent: "scout", question: "Nowhere.", subject: 999 }, { config, engine: answering("Ok.") }),
    expectHqError("SUBJECT_NOT_FOUND", 404),
  );
  held.open();
  await questionsIdle();

  assert.equal(resetDiscussion(db, "demo", "scout"), 1);
  assert.equal(readDiscussion(db, "demo", "scout").length, 0);
  assert.equal(readDiscussion(db, "demo", "scout", sign.id).length, 1, "a subject is never reset");
});

test("a message in an archived subject opens it again", async () => {
  const config = office();
  const db = getDbAt(config.dbPath);
  const sign = createSubject(db, "demo", "scout", "Shop sign");
  updateSubject(db, "demo", "scout", sign.id, { status: "archived" });
  askAgent({ room: "demo", agent: "scout", question: "One more change.", subject: sign.id }, { config, engine: answering("Ok.") });
  await questionsIdle();
  assert.equal(status(db, sign.id), "open");
});

// --- Work inherits the subject --------------------------------------------------------------

const PROPOSAL = "Je lance un tour.\n<run-proposal>\nDessine l'enseigne.\n</run-proposal>";

test("a run proposed in a subject carries it, and what it submits or asks belongs to it; the tasks of its items too", async () => {
  const config = office(true);
  const db = getDbAt(config.dbPath);
  const sign = createSubject(db, "demo", "scout", "Shop sign");
  const asked = askAgent({ room: "demo", agent: "scout", question: "Draw the sign.", subject: sign.id }, { config, engine: answering(PROPOSAL) });
  await questionsIdle();
  const ids: { submitted?: number; asked?: number } = {};
  const seen: RunInput[] = [];
  const { run } = decideProposal(
    { room: "demo", agent: "scout", questionId: asked.id, action: "launch" },
    {
      config,
      engine: runEngine(seen, (input) => {
        const ctx = { dbPath: config.dbPath, runId: input.runId, agentId: "scout", room: "demo" };
        ids.submitted = hqSubmit(db, ctx, { type: "article", title: "The sign", body: "Drawn." }).approvalId;
        ids.asked = hqAsk(db, ctx, {
          title: "Colour",
          questions: [{ question: "Which colour?", options: [{ label: "Red" }, { label: "Blue" }] }],
        }).approvalId;
      }),
    },
  );
  assert.ok(run);
  assert.equal(run.subject_id, sign.id);
  assert.deepEqual(tasksOf(db, run.id).map((task) => [task.source, task.subject_id]), [["manual", sign.id]]);
  await waitForRun(db, run.id);
  const subjectOf = (id: number) => (db.prepare("SELECT subject_id FROM approvals WHERE id = ?").get(id) as ApprovalRow).subject_id;
  assert.equal(subjectOf(ids.submitted!), sign.id);
  assert.equal(subjectOf(ids.asked!), sign.id);

  // A revision, an approval and the answers to its questions give tasks of the same subject.
  decideApproval(db, ids.asked!, { decision: "approved", answers: [{ options: [0] }] });
  decideApproval(db, ids.submitted!, { decision: "revise", note: "Bigger." });
  const tasks = db.prepare("SELECT source, subject_id FROM tasks WHERE source <> 'manual' ORDER BY id").all();
  assert.deepEqual(tasks, [
    { source: "revise", subject_id: sign.id },
    { source: "revise", subject_id: sign.id },
  ]);
  // A run started by hand names no subject: it takes the one of the oldest pending task it claims.
  const plain = startRun({ room: "demo", agent: "scout", task: "Routine." }, { config, engine: runEngine([]) });
  assert.equal(plain.subject_id, sign.id);
  await waitForRun(db, plain.id);
});

test("a run takes the tasks of one subject: the oldest pending task's, NULL with NULL; the others wake the agent once it ends", async () => {
  const config = office();
  const db = getDbAt(config.dbPath);
  const sign = createSubject(db, "demo", "scout", "Shop sign");
  const general = pendingTask(db, null, "A message for the general subject.");
  const first = pendingTask(db, sign.id, "First of the sign.");
  const second = pendingTask(db, sign.id, "Second of the sign.");
  // claimIds: the subject of the oldest of them, and only the ones of that subject.
  const held = gate();
  const seen: RunInput[] = [];
  const run = startRun({ room: "demo", agent: "scout", task: "Go." }, { config, engine: runEngine(seen, undefined, held.promise) });
  assert.equal(run.subject_id, null, "the oldest pending task is the general one");
  assert.deepEqual(mailboxOf(db, run.id), [general]);
  assert.match(seen[0]?.prompt ?? "", /A message for the general subject\./);
  assert.ok(!(seen[0]?.prompt ?? "").includes("First of the sign."));
  held.open();
  await waitForRun(db, run.id);

  // The run that ended woke the agent for the sign's tasks, left pending.
  const woken = db.prepare("SELECT * FROM runs WHERE id > ? ORDER BY id").all(run.id) as RunRow[];
  assert.equal(woken.length, 1, "the end of the run woke the agent for the other subject");
  assert.equal(woken[0]!.subject_id, sign.id);
  assert.deepEqual(
    tasksOf(db, woken[0]!.id)
      .filter((task) => task.source !== "manual")
      .map((task) => task.id),
    [first, second],
  );
  await waitForRun(db, woken[0]!.id);
  assert.deepEqual(wakeAgents(config, db, { engine: runEngine([]) }), [], "nothing left to wake");
});

test("claimIds: only those tasks, and among them the ones of the oldest one's subject", async () => {
  const { launchRun } = await import("../src/server/runner");
  const { loadHome } = await import("../src/server/rooms");
  const config = office();
  const db = getDbAt(config.dbPath);
  const sign = createSubject(db, "demo", "scout", "Shop sign");
  const a = pendingTask(db, null, "General one.");
  const b = pendingTask(db, sign.id, "Sign one.");
  const c = pendingTask(db, sign.id, "Sign two.");
  const room = loadHome(config.home).rooms[0]!;
  const run = launchRun({ config, deps: { engine: runEngine([]) }, room, agent: room.agents[0]!, task: "T", claimIds: [b, c], prompt: () => "P" });
  assert.equal(run.subject_id, sign.id);
  assert.deepEqual(mailboxOf(db, run.id), [b, c]);
  assert.equal((db.prepare("SELECT status FROM tasks WHERE id = ?").get(a) as TaskRow).status, "pending");
  await waitForRun(db, run.id);
});

// --- A proposal can be a revision -------------------------------------------------------------

test("parsing a revision block: the item and the note; a block without an item or too long proposes nothing", () => {
  assert.deepEqual(parseRunProposal('Je reprends l\'item.\n<revision-proposal item="12">\nBordure de 2 mm.\n</revision-proposal>'), {
    text: "Je reprends l'item.",
    task: "Bordure de 2 mm.",
    revise: 12,
  });
  assert.equal(parseRunProposal("<REVISION-PROPOSAL item=#7>Plus grand.</revision-proposal>").revise, 7);
  assert.deepEqual(parseRunProposal("Ok.<revision-proposal>Plus grand.</revision-proposal>"), { text: "Ok.", task: null });
  const tooLong = parseRunProposal(`Ok.<revision-proposal item="3">${"x".repeat(REVISION_PROPOSAL_MAX_CHARS + 1)}</revision-proposal>`);
  assert.deepEqual(tooLong, { text: "Ok.", task: null });
  // The last block wins, whichever its kind.
  const both = parseRunProposal('<revision-proposal item="3">Note.</revision-proposal> Puis <run-proposal>Task.</run-proposal>');
  assert.deepEqual(both, { text: "Puis", task: "Task." });
  assert.match(questionSystemText("English"), /<revision-proposal item="12">/);
  assert.match(questionSystemText("English"), /asks to change something in an item you delivered/);
});

test("a revision proposed in a subject: confirmed, it is the revise decision on the item, and its run gets the subject's discussion", async () => {
  const config = office();
  const db = getDbAt(config.dbPath);
  const sign = createSubject(db, "demo", "scout", "Shop sign");
  const delivered = item(db, sign.id, "The sign", "approved");
  const other = createSubject(db, "demo", "scout", "Poster");
  const elsewhere = item(db, other.id, "The poster");
  exchange(db, sign.id, "The sign is 2 m wide.", "Noted.", "2026-11-10T09:00:00.000Z");
  exchange(db, null, "General chat.", "General answer.", "2026-11-10T09:01:00.000Z");

  // An item of another subject is not revisable from here: the answer stays plain.
  const wrong = askAgent(
    { room: "demo", agent: "scout", question: "Change the poster.", subject: sign.id },
    { config, engine: answering(`Ok.\n<revision-proposal item="${elsewhere}">Bigger.</revision-proposal>`) },
  );
  await questionsIdle();
  assert.equal(toQuestion(readDiscussion(db, "demo", "scout", sign.id).find((row) => row.id === wrong.id)!).proposal, null);

  const prompts: string[] = [];
  const asked = askAgent(
    { room: "demo", agent: "scout", question: "Make the border thicker.", subject: sign.id },
    { config, engine: answering(`Je propose de reprendre l'enseigne.\n<revision-proposal item="${delivered}">Bordure de 2 mm, le reste inchangé.</revision-proposal>`, prompts) },
  );
  await questionsIdle();
  assert.match(prompts[0]!, new RegExp(`- #${delivered} "The sign" \\(article, approved\\)`), "the items of the subject are listed");
  const proposal = toQuestion(readDiscussion(db, "demo", "scout", sign.id).find((row) => row.id === asked.id)!).proposal;
  assert.deepEqual(proposal, { task: "Bordure de 2 mm, le reste inchangé.", state: "pending", runId: null, decidedAt: null, reviseId: delivered });

  const seen: RunInput[] = [];
  const { run, question } = decideProposal({ room: "demo", agent: "scout", questionId: asked.id, action: "launch" }, { config, engine: runEngine(seen) });
  assert.ok(run, "the revision woke the agent");
  assert.equal(run.reason, "revise");
  assert.equal(run.subject_id, sign.id);
  assert.equal(toQuestion(question).proposal?.state, "launched");
  assert.equal(toQuestion(question).proposal?.runId, run.id);
  const decided = db.prepare("SELECT status, decision_note FROM approvals WHERE id = ?").get(delivered) as ApprovalRow;
  assert.deepEqual([decided.status, decided.decision_note], ["revise", "Bordure de 2 mm, le reste inchangé."]);
  await waitForRun(db, run.id);
  const prompt = seen[0]!.prompt;
  assert.match(prompt, /Bordure de 2 mm, le reste inchangé\./);
  assert.match(prompt, /## Your discussion with the owner/);
  assert.match(prompt, /The subject of this run: "Shop sign"\./);
  assert.match(prompt, /The sign is 2 m wide\./);
  assert.ok(!prompt.includes("General chat."));
  assert.throws(
    () => decideProposal({ room: "demo", agent: "scout", questionId: asked.id, action: "launch" }, { config }),
    expectHqError("PROPOSAL_DECIDED", 409),
  );
});

test("a revision may be proposed while a run goes on: confirmed, it waits for that run", async () => {
  const config = office();
  const db = getDbAt(config.dbPath);
  const delivered = item(db, null, "The sign");
  const held = gate();
  const busy = startRun({ room: "demo", agent: "scout", task: "Something long." }, { config, engine: runEngine([], undefined, held.promise) });
  const prompts: string[] = [];
  const asked = askAgent(
    { room: "demo", agent: "scout", question: "Thicker border." },
    { config, engine: answering(`Ok.\n<revision-proposal item="${delivered}">Thicker border.</revision-proposal>`, prompts) },
  );
  await questionsIdle();
  assert.match(prompts[0]!, /A separate piece of work may still be proposed: it waits for the end of run/);
  const { run } = decideProposal({ room: "demo", agent: "scout", questionId: asked.id, action: "launch" }, { config, engine: runEngine([]) });
  assert.equal(run, null, "the agent is busy: the revision task waits");
  assert.equal((db.prepare("SELECT status FROM tasks WHERE source = 'revise'").get() as TaskRow).status, "pending");
  held.open();
  await waitForRun(db, busy.id);
  const revision = db.prepare("SELECT * FROM runs WHERE reason = 'revise'").get() as RunRow;
  assert.ok(revision, "the end of the run woke the agent for the revision");
  await waitForRun(db, revision.id);
});

// --- A subject closes itself ---------------------------------------------------------------------

test("a subject closes itself once its latest deliverable is approved and nothing of it is left; never the general one", () => {
  const config = office();
  const db = getDbAt(config.dbPath);
  const sign = createSubject(db, "demo", "scout", "Shop sign");
  const question = item(db, sign.id, "Which colour?", "pending", "question");
  const draft = item(db, sign.id, "The sign");
  // A pending item of questions keeps it open, the deliverable approved or not.
  decideApproval(db, draft, { decision: "approved" }, config);
  assert.equal(status(db, sign.id), "open");
  decideApproval(db, question, { decision: "rejected", note: "No need." }, config);
  assert.equal(status(db, sign.id), "open", "rejecting a question changes nothing by itself");
  assert.equal(settleSubject(db, sign.id), true, "nothing is left: it closes");
  assert.equal(status(db, sign.id), "archived");

  // An approval with nothing left closes it at once; an informational item does not count as the latest deliverable.
  const poster = createSubject(db, "demo", "scout", "Poster");
  const piece = item(db, poster.id, "The poster");
  item(db, poster.id, "A note", "unseen", "note");
  decideApproval(db, piece, { decision: "approved" }, config);
  assert.equal(status(db, poster.id), "archived");

  // A rejected latest deliverable, or a message after the approval, keeps it open.
  const flyer = createSubject(db, "demo", "scout", "Flyer");
  const done = item(db, flyer.id, "Flyer v1", "approved");
  db.prepare("UPDATE approvals SET decided_at = '2026-11-10T10:00:00.000Z' WHERE id = ?").run(done);
  exchange(db, flyer.id, "One more idea.", "Ok.", "2026-11-10T11:00:00.000Z");
  assert.equal(settleSubject(db, flyer.id), false);
  item(db, flyer.id, "Flyer v2", "rejected");
  assert.equal(settleSubject(db, flyer.id), false);

  item(db, null, "General piece", "approved");
  assert.equal(settleSubject(db, null), false);
});

test("an approval the agent executes closes the subject only once that run is done; a revision reopens it", async () => {
  const config = office(true);
  const db = getDbAt(config.dbPath);
  const sign = createSubject(db, "demo", "scout", "Shop sign");
  const piece = item(db, sign.id, "The sign");
  const seen: RunInput[] = [];
  decideApproval(db, piece, { decision: "approved" }, config, { engine: runEngine(seen) });
  const execution = db.prepare("SELECT * FROM runs WHERE reason = 'approval'").get() as RunRow;
  assert.ok(execution, "the approval woke the agent");
  assert.equal(execution.subject_id, sign.id);
  assert.equal(status(db, sign.id), "open", "its task is not done yet");
  await waitForRun(db, execution.id);
  assert.equal(status(db, sign.id), "archived", "the end of the run closed it");

  // Sent back from the desk, the item opens its subject again.
  decideApproval(db, piece, { decision: "revise", note: "One more change." });
  assert.equal(status(db, sign.id), "open");
});

// --- The discussion handed to a run, by subject -----------------------------------------------------

test("the discussion follows the subject: a run of a subject gets all of it, a general run only the general rules", () => {
  const config = office();
  const db = getDbAt(config.dbPath);
  const sign = createSubject(db, "demo", "scout", "Shop sign");
  exchange(db, sign.id, "Long ago in the sign.", "Ok.", "2026-11-01T09:00:00.000Z");
  const recent = exchange(db, sign.id, "Recent in the sign.", "Ok.", "2026-11-10T09:00:00.000Z");
  exchange(db, sign.id, "After the proposal.", "Ok.", "2026-11-10T10:00:00.000Z");
  exchange(db, null, "General words.", "Ok.", "2026-11-10T09:30:00.000Z");

  const all = discussionHandoff(db, { room: "demo", agentId: "scout", mailbox: [], subjectId: sign.id })!;
  for (const kept of ["Long ago in the sign.", "Recent in the sign.", "After the proposal."]) assert.ok(all.includes(kept), kept);
  assert.ok(!all.includes("General words."));
  assert.match(all, /The subject of this run: "Shop sign"\./);
  const upTo = discussionHandoff(db, { room: "demo", agentId: "scout", mailbox: [], subjectId: sign.id, upToQuestionId: recent })!;
  assert.ok(upTo.includes("Long ago in the sign.") && upTo.includes("Recent in the sign.") && !upTo.includes("After the proposal."));

  // The general subject: nothing without a revision or a proposal, and never a subject's exchanges.
  assert.equal(discussionHandoff(db, { room: "demo", agentId: "scout", mailbox: [] }), null);
  const general = discussionHandoff(db, { room: "demo", agentId: "scout", mailbox: [], upToQuestionId: recent + 10 })!;
  assert.ok(general.includes("General words."));
  assert.ok(!general.includes("Recent in the sign."));
});

// --- The thread and its tabs --------------------------------------------------------------------------

test("the thread of a subject has its exchanges, runs and items only, with the tabs and what they show", async () => {
  const config = office();
  const db = getDbAt(config.dbPath);
  const sign = createSubject(db, "demo", "scout", "Shop sign");
  const archived = createSubject(db, "demo", "scout", "Old");
  updateSubject(db, "demo", "scout", archived.id, { status: "archived" });
  exchange(db, sign.id, "In the sign.", "Ok.", "2026-11-10T09:00:00.000Z");
  exchange(db, null, "In general.", "Ok.", "2026-11-10T09:01:00.000Z");
  const signItem = item(db, sign.id, "The sign");
  item(db, null, "General piece", "approved");
  const held = gate();
  const run = startRun({ room: "demo", agent: "scout", task: "Draw." }, { config, engine: runEngine([], undefined, held.promise), subject: sign.id });

  const thread = readThread(db, "demo", "scout", sign.id);
  assert.deepEqual(
    thread.entries.map((entry) => entry.kind),
    ["question", "item", "run"],
  );
  assert.ok(thread.entries.some((entry) => entry.kind === "item" && entry.item.id === signItem));
  assert.equal(thread.subject?.title, "Shop sign");
  assert.deepEqual(thread.subjects, [
    { id: null, title: null, working: false, waiting: false },
    { id: sign.id, title: "Shop sign", working: true, waiting: true },
  ]);
  const general = readThread(db, "demo", "scout");
  assert.equal(general.subject, null);
  assert.ok(general.entries.every((entry) => entry.kind !== "run"));
  assert.ok(general.entries.some((entry) => entry.kind === "question" && entry.question.question === "In general."));
  assert.ok(!general.entries.some((entry) => entry.kind === "question" && entry.question.question === "In the sign."));
  // An archived subject is still read; another agent's never.
  assert.equal(readThread(db, "demo", "scout", archived.id).subject?.status, "archived");
  assert.throws(() => readThread(db, "demo", "editor", sign.id), expectHqError("SUBJECT_NOT_FOUND", 404));
  held.open();
  await waitForRun(db, run.id);
});
