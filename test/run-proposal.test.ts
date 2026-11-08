import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { POST as proposalRoute } from "../src/app/api/rooms/[room]/agents/[agent]/ask/[question]/proposal/route";
import {
  askAgent,
  buildQuestionPrompt,
  decideProposal,
  questionsIdle,
  questionSystemText,
  readDiscussion,
  toQuestion,
} from "../src/server/agent-questions";
import { readThread } from "../src/server/agent-thread";
import { getDbAt, type Db, type RunRow } from "../src/server/db";
import type { Engine, RunEvent, RunInput } from "../src/server/engine";
import { HqError } from "../src/server/errors";
import { parseRunProposal, RUN_PROPOSAL_MAX_CHARS } from "../src/server/run-proposal";
import { startRun } from "../src/server/runner";
import { makeHome, waitForRun } from "./helpers";

const usage = { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

/** Answers every question with `answer` (the CLI's result line), and records the prompts it was given. */
function answering(answer: string, prompts: string[] = []): Engine {
  return {
    name: "claude",
    async *run(input: RunInput): AsyncIterable<RunEvent> {
      prompts.push(input.prompt, fs.readFileSync(input.rolePath, "utf8"));
      input.onRawLine?.(JSON.stringify({ type: "result", subtype: "success", result: answer }));
      yield { type: "end", status: "done", reason: "success", summary: answer.slice(0, 50), usage, costUsd: 0.01 };
    },
  };
}

/** A run engine that records the runs it was asked for, and ends them at once. */
function runEngine(seen: RunInput[]): Engine {
  return {
    name: "claude",
    async *run(input: RunInput): AsyncIterable<RunEvent> {
      seen.push(input);
      yield { type: "end", status: "done", reason: "success", summary: "Done.", usage, costUsd: 0.05 };
    },
  };
}

const runs = (db: Db) => db.prepare("SELECT * FROM runs ORDER BY id").all() as RunRow[];

function expectHqError(code: string, status: number) {
  return (error: unknown) => {
    assert.ok(error instanceof HqError, String(error));
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  };
}

const WORK_ANSWER = [
  "D'accord, je lance un tour pour refaire le clip B.",
  "",
  "<run-proposal>",
  "Refais le clip B avec la nouvelle musique (piste 2), garde le montage actuel, puis dépose-le pour validation.",
  "</run-proposal>",
].join("\n");

/** Asks the question and waits for its answer. */
async function ask(config: ReturnType<typeof makeHome>, answer: string, question = "Refais le clip B") {
  const asked = askAgent({ room: "demo", agent: "scout", question }, { config, engine: answering(answer) });
  await questionsIdle();
  return asked.id;
}

// --- Parsing ---------------------------------------------------------------------

test("parsing: an answer without a block proposes nothing and stays as it is", () => {
  assert.deepEqual(parseRunProposal("Je fais mes vidéos avec **Remotion**."), {
    text: "Je fais mes vidéos avec **Remotion**.",
    task: null,
  });
  assert.deepEqual(parseRunProposal(""), { text: "", task: null });
});

test("parsing: the block becomes the task, the sentence stays", () => {
  const parsed = parseRunProposal(WORK_ANSWER);
  assert.equal(parsed.text, "D'accord, je lance un tour pour refaire le clip B.");
  assert.equal(parsed.task, "Refais le clip B avec la nouvelle musique (piste 2), garde le montage actuel, puis dépose-le pour validation.");
});

test("parsing: a block in a code fence, with spaces in its tags or in capitals, still counts", () => {
  const fenced = parseRunProposal("Je m'en occupe.\n\n```\n<run-proposal>\nÉcris l'article.\n</run-proposal>\n```\n");
  assert.deepEqual(fenced, { text: "Je m'en occupe.", task: "Écris l'article." });
  const inner = parseRunProposal("Ok.\n<run-proposal>\n```text\nÉcris l'article.\n```\n</run-proposal>");
  assert.deepEqual(inner, { text: "Ok.", task: "Écris l'article." });
  assert.equal(parseRunProposal("Ok. <RUN-PROPOSAL >Fais-le.</run-proposal >").task, "Fais-le.");
});

test("parsing: a missing closing tag, a stray one or an empty block propose nothing, and their text stays readable", () => {
  const open = parseRunProposal("Je lance un tour.\n<run-proposal>\nRefais le clip B.");
  assert.equal(open.task, null);
  assert.equal(open.text, "Je lance un tour.\n\nRefais le clip B.");
  const stray = parseRunProposal("Voilà.</run-proposal>");
  assert.deepEqual(stray, { text: "Voilà.", task: null });
  assert.deepEqual(parseRunProposal("Hum.\n<run-proposal>  \n </run-proposal>"), { text: "Hum.", task: null });
  const tooLong = parseRunProposal(`Ok.<run-proposal>${"x".repeat(RUN_PROPOSAL_MAX_CHARS + 1)}</run-proposal>`);
  assert.deepEqual(tooLong, { text: "Ok.", task: null });
});

test("parsing: of two blocks the last one is the proposal, and a block alone leaves an empty text", () => {
  const two = parseRunProposal("A.\n<run-proposal>First</run-proposal>\nB.\n<run-proposal>Second</run-proposal>");
  assert.equal(two.task, "Second");
  assert.equal(two.text, "A.\n\nB.");
  assert.deepEqual(parseRunProposal("<run-proposal>Only the task</run-proposal>"), { text: "", task: "Only the task" });
});

test("the question mode tells a discussion from a task and gives the block to end with", () => {
  const text = questionSystemText("French");
  assert.match(text, /<run-proposal>/);
  assert.match(text, /<\/run-proposal>/);
  assert.match(text, /do not do it/);
  assert.match(text, /confirms before anything starts/);
});

// --- Confirmation ------------------------------------------------------------------

test("an answer that proposes a run starts nothing: the proposal waits, the thread shows it", async () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const id = await ask(config, WORK_ANSWER);

  const [question] = readDiscussion(db, "demo", "scout").map(toQuestion);
  assert.equal(question?.id, id);
  assert.equal(question?.status, "done");
  assert.equal(question?.answer, "D'accord, je lance un tour pour refaire le clip B.", "the block leaves the answer");
  assert.deepEqual(question?.proposal, {
    task: "Refais le clip B avec la nouvelle musique (piste 2), garde le montage actuel, puis dépose-le pour validation.",
    state: "pending",
    runId: null,
    decidedAt: null,
  });
  assert.equal(runs(db).length, 0, "no run without the owner's click");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n, 0, "no task either");

  // Reading the thread, as the sheet does again and again, starts nothing either.
  for (let i = 0; i < 3; i++) {
    const [entry] = readThread(db, "demo", "scout").entries;
    assert.ok(entry?.kind === "question" && entry.question.proposal?.state === "pending");
  }
  assert.equal(runs(db).length, 0);
});

test("« On en parle d'abord » sets the proposal aside: no run, and it is decided once", async () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const id = await ask(config, WORK_ANSWER);
  const { question, run } = decideProposal({ room: "demo", agent: "scout", questionId: id, action: "dismiss" }, { config });
  assert.equal(run, null);
  assert.equal(toQuestion(question).proposal?.state, "dismissed");
  assert.ok(toQuestion(question).proposal?.decidedAt);
  assert.equal(runs(db).length, 0);
  assert.throws(
    () => decideProposal({ room: "demo", agent: "scout", questionId: id, action: "launch" }, { config }),
    expectHqError("PROPOSAL_DECIDED", 409),
  );
  assert.equal(runs(db).length, 0);
});

test("« Lancer le tour » starts the run with the agent's task, as the desk's button does, once", async () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const id = await ask(config, WORK_ANSWER);
  const seen: RunInput[] = [];
  const { question, run } = decideProposal(
    { room: "demo", agent: "scout", questionId: id, action: "launch" },
    { config, engine: runEngine(seen) },
  );
  assert.ok(run);
  assert.equal(run.task, "Refais le clip B avec la nouvelle musique (piste 2), garde le montage actuel, puis dépose-le pour validation.");
  assert.equal(run.reason, null, "started by hand, as « Lancer un tour »");
  assert.deepEqual(toQuestion(question).proposal?.state, "launched");
  assert.equal(toQuestion(question).proposal?.runId, run.id);
  await waitForRun(db, run.id);
  assert.match(seen[0]?.prompt ?? "", /Refais le clip B avec la nouvelle musique/);

  assert.throws(
    () => decideProposal({ room: "demo", agent: "scout", questionId: id, action: "launch" }, { config, engine: runEngine(seen) }),
    expectHqError("PROPOSAL_DECIDED", 409),
  );
  assert.equal(runs(db).length, 1, "one run, never two");
});

test("a launch the agent lock refuses leaves the proposal pending, to launch later", async () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const id = await ask(config, WORK_ANSWER);
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const busyEngine: Engine = {
    name: "claude",
    async *run() {
      await held;
      yield { type: "end", status: "done", reason: "success", summary: "ok", usage, costUsd: 0 };
    },
  };
  const first = startRun({ room: "demo", agent: "scout" }, { config, engine: busyEngine });
  assert.throws(
    () => decideProposal({ room: "demo", agent: "scout", questionId: id, action: "launch" }, { config, engine: busyEngine }),
    expectHqError("AGENT_BUSY", 409),
  );
  assert.equal(toQuestion(readDiscussion(db, "demo", "scout")[0]!).proposal?.state, "pending");
  release();
  await waitForRun(db, first.id);
  const { run } = decideProposal({ room: "demo", agent: "scout", questionId: id, action: "launch" }, { config, engine: runEngine([]) });
  assert.ok(run);
  await waitForRun(db, run.id);
});

test("a plain answer, an unknown question and another agent's question cannot be launched", async () => {
  const config = makeHome();
  const id = await ask(config, "Je fais mes vidéos avec Remotion.", "Comment fais-tu ?");
  assert.throws(
    () => decideProposal({ room: "demo", agent: "scout", questionId: id, action: "launch" }, { config }),
    expectHqError("PROPOSAL_NOT_FOUND", 404),
  );
  assert.throws(
    () => decideProposal({ room: "demo", agent: "scout", questionId: id + 100, action: "launch" }, { config }),
    expectHqError("QUESTION_NOT_FOUND", 404),
  );
  assert.throws(
    () => decideProposal({ room: "demo", agent: "nobody", questionId: id, action: "launch" }, { config }),
    expectHqError("AGENT_NOT_FOUND", 404),
  );
  assert.equal(runs(getDbAt(config.dbPath)).length, 0);
});

test("the next question gives the agent what became of its proposal", async () => {
  const config = makeHome();
  const id = await ask(config, WORK_ANSWER);
  decideProposal({ room: "demo", agent: "scout", questionId: id, action: "dismiss" }, { config });
  const prompts: string[] = [];
  askAgent({ room: "demo", agent: "scout", question: "Pourquoi la piste 2 ?" }, { config, engine: answering("Parce que.", prompts) });
  await questionsIdle();
  assert.match(prompts[0] ?? "", /You proposed a run: "Refais le clip B[^"]*"\. The owner set it aside, to talk about it first\./);

  const prompt = buildQuestionPrompt({
    room: { name: "demo" } as never,
    agent: { id: "scout", name: "Scout" } as never,
    question: "Et alors ?",
    previous: [{ question: "Fais-le", answer: "Ok.", proposal: { task: "Do it", state: "launched", runId: 9, decidedAt: null } }],
    memory: "",
    today: "",
  });
  assert.match(prompt, /You proposed a run: "Do it"\. The owner started it \(run #9\)\./);
});

test("the route: an action is required, launch answers 202 with the run, dismiss 200", async () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const first = await ask(config, WORK_ANSWER);
  const second = await ask(config, WORK_ANSWER, "Et le clip C");
  const saved = { home: process.env.MYHQ_HOME, bin: process.env.HQ_CLAUDE_BIN };
  process.env.MYHQ_HOME = config.home;
  // The launched run fails at once on a binary that does not exist: no real `claude` in the tests.
  process.env.HQ_CLAUDE_BIN = "myhq-no-such-binary";
  const call = (question: string, body: unknown) =>
    proposalRoute(
      new Request(`http://localhost/api/rooms/demo/agents/scout/ask/${question}/proposal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ room: "demo", agent: "scout", question }) },
    );
  try {
    assert.equal((await call(String(first), {})).status, 400);
    assert.equal((await call(String(first), { action: "run" })).status, 400);
    assert.equal((await call("abc", { action: "launch" })).status, 400);
    assert.equal(runs(db).length, 0);

    const dismissed = await call(String(second), { action: "dismiss" });
    assert.equal(dismissed.status, 200);
    assert.equal(((await dismissed.json()) as { run: unknown }).run, null);

    const launched = await call(String(first), { action: "launch" });
    assert.equal(launched.status, 202);
    const body = (await launched.json()) as { run: { id: number; task: string }; question: { proposal: { state: string; runId: number } } };
    assert.equal(body.question.proposal.state, "launched");
    assert.equal(body.question.proposal.runId, body.run.id);
    assert.match(body.run.task, /Refais le clip B/);
    await waitForRun(db, body.run.id);
    assert.equal((await call(String(first), { action: "launch" })).status, 409);
    assert.equal(runs(db).length, 1);
  } finally {
    for (const [key, value] of [
      ["MYHQ_HOME", saved.home],
      ["HQ_CLAUDE_BIN", saved.bin],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("migration 20 is additive and safe at a restart: an older database gets the table, its rows stay", async () => {
  const { openDb } = await import("../src/server/db");
  const config = makeHome();
  const db = openDb(config.dbPath);
  db.prepare(
    "INSERT INTO agent_questions (room, agent_id, question, answer, status, engine, started_at) VALUES ('demo', 'scout', 'q', 'a', 'done', 'claude', 'x')",
  ).run();
  // As a database of version 19: no table, no record of the migration.
  db.exec("DROP TABLE question_proposals; DELETE FROM schema_migrations WHERE version >= 20;");
  db.close();
  const again = openDb(config.dbPath);
  assert.equal((again.prepare("SELECT COUNT(*) AS n FROM agent_questions").get() as { n: number }).n, 1, "the questions stay");
  assert.equal((again.prepare("SELECT COUNT(*) AS n FROM question_proposals").get() as { n: number }).n, 0);
  again.close();
  // A restart on a migrated database changes nothing.
  openDb(config.dbPath).close();
});
