import assert from "node:assert/strict";
import { test } from "node:test";
import {
  askAgent,
  buildQuestionPrompt,
  decideProposal,
  questionsIdle,
  questionSystemText,
  readDiscussion,
  toQuestion,
  type ActiveRun,
} from "../src/server/agent-questions";
import { getDbAt, type Db, type RunRow, type TaskRow } from "../src/server/db";
import { HANDOFF_ANSWER_CHARS } from "../src/server/discussion-handoff";
import type { Engine, RunEvent, RunInput } from "../src/server/engine";
import { buildPrompt, startRun } from "../src/server/runner";
import { createSubject } from "../src/server/subjects";
import { hqStatus, type HqContext } from "../src/mcp/tools";
import { makeHome, waitForRun } from "./helpers";

// The agent hears the owner while it works (docs/architecture.md, "Questions
// to an agent"): the exchanges of the run's subject answered after its prompt
// was built come back with its next hq_status, once; and a run proposed while
// the agent is busy waits for its turn.

const usage = { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

/** A gate a fake run waits on. */
function gate() {
  let open = () => {};
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

/** Records every run it is given; each waits for `held` (when given) before it ends. */
function recording(seen: RunInput[], held?: Promise<void>): Engine {
  return {
    name: "claude",
    async *run(input: RunInput): AsyncIterable<RunEvent> {
      seen.push(input);
      if (held) await held;
      yield { type: "end", status: "done", reason: "success", summary: "Done.", usage, costUsd: 0.01 };
    },
  };
}

/** Answers every question with `answer`, and records the prompts. */
function answering(answer: string, prompts: string[] = []): Engine {
  return {
    name: "claude",
    async *run(input: RunInput): AsyncIterable<RunEvent> {
      prompts.push(input.prompt);
      input.onRawLine?.(JSON.stringify({ type: "result", subtype: "success", result: answer }));
      yield { type: "end", status: "done", reason: "success", summary: answer.slice(0, 50), usage, costUsd: 0.01 };
    },
  };
}

type Spec = { question: string; answer?: string | null; subject?: number | null; agent?: string; status?: string };

/** An exchange of the discussion, answered unless said otherwise. */
function exchange(db: Db, spec: Spec): number {
  return Number(
    db
      .prepare(
        `INSERT INTO agent_questions (room, agent_id, question, answer, status, engine, started_at, subject_id)
         VALUES ('demo', ?, ?, ?, ?, 'claude', ?, ?)`,
      )
      .run(
        spec.agent ?? "scout",
        spec.question,
        spec.answer === undefined ? `Answer to: ${spec.question}` : spec.answer,
        spec.status ?? "done",
        new Date().toISOString(),
        spec.subject ?? null,
      ).lastInsertRowid,
  );
}

const ctxOf = (config: ReturnType<typeof makeHome>, run: RunRow): HqContext => ({
  dbPath: config.dbPath,
  runId: run.id,
  agentId: run.agent_id,
  room: run.room,
});

/** What hq_status hands the run, or null for a result as it always was. */
function status(config: ReturnType<typeof makeHome>, run: RunRow, text = "avance"): string | null {
  const result = hqStatus(getDbAt(config.dbPath), ctxOf(config, run), { text });
  if (!("fromOwner" in result)) {
    assert.deepEqual(Object.keys(result).sort(), ["at", "saved", "text", "waiting"], "the result of always");
    return null;
  }
  return result.fromOwner;
}

/** Two agents in one room, to tell their discussions apart. */
function office() {
  const base = { role: "roles/scout.md", model: "haiku", allowedTools: ["mcp__hq__*"] };
  return makeHome(
    {},
    { name: "demo", targetRepo: "../demo-project", agents: [{ id: "scout", name: "Scout", ...base }, { id: "editor", name: "Editor", ...base }] },
  );
}

test("hq_status hands the run what was said after its prompt was built, once; the result is as before otherwise", async () => {
  const config = office();
  const db = getDbAt(config.dbPath);
  const subject = createSubject(db, "demo", "scout", "The sign");
  exchange(db, { question: "Before the run: a wax seal.", subject: subject.id });
  const pending = exchange(db, { question: "Asked as the run starts.", answer: null, status: "running", subject: subject.id });

  const held = gate();
  const seen: RunInput[] = [];
  const run = startRun({ room: "demo", agent: "scout", task: "Make the sign." }, { config, engine: recording(seen, held.promise), subject: subject.id });
  try {
    // The prompt has what came before; nothing of it comes again.
    assert.match(seen[0]!.prompt, /Before the run: a wax seal\./);
    // Answered between the prompt and the first status, and a question still running when the prompt was built.
    exchange(db, { question: "Make the border 2 mm.", subject: subject.id });
    db.prepare("UPDATE agent_questions SET status = 'done', answer = 'Seen, at the next step.' WHERE id = ?").run(pending);

    const first = status(config, run);
    assert.ok(first);
    assert.match(first, /New messages from the owner/);
    assert.match(first, /say what you do with it in your very next hq_status/i);
    assert.ok(first.includes("Owner: Make the border 2 mm."));
    assert.ok(first.includes("Owner: Asked as the run starts.") && first.includes("You: Seen, at the next step."));
    assert.ok(first.indexOf("Asked as the run starts.") < first.indexOf("Make the border 2 mm."), "oldest first");
    assert.ok(!first.includes("Before the run"), "no duplicate of the start block");

    assert.equal(status(config, run, "bordure à 2 mm, je l'applique"), null, "once: nothing again");
    exchange(db, { question: "And in red.", subject: subject.id });
    const second = status(config, run);
    assert.ok(second?.includes("Owner: And in red."));
    assert.ok(!second?.includes("Make the border"));
    // A failed question never comes.
    exchange(db, { question: "Failed one.", answer: null, status: "failed", subject: subject.id });
    assert.equal(status(config, run), null);
  } finally {
    held.open();
    await waitForRun(db, run.id);
  }
});

test("a general run without a block hears only what follows its start", async () => {
  const config = office();
  const db = getDbAt(config.dbPath);
  exchange(db, { question: "Old general talk." });
  const held = gate();
  const run = startRun({ room: "demo", agent: "scout" }, { config, engine: recording([], held.promise) });
  try {
    assert.equal(status(config, run), null);
    exchange(db, { question: "New general talk." });
    const heard = status(config, run);
    assert.ok(heard?.includes("New general talk.") && !heard.includes("Old general talk."));
  } finally {
    held.open();
    await waitForRun(db, run.id);
  }
});

test("a run hears its own subject only: not the general one, not another subject, not another agent", async () => {
  const config = office();
  const db = getDbAt(config.dbPath);
  const mine = createSubject(db, "demo", "scout", "Mine");
  const other = createSubject(db, "demo", "scout", "Other");
  const held = gate();
  const run = startRun({ room: "demo", agent: "scout" }, { config, engine: recording([], held.promise), subject: mine.id });
  try {
    exchange(db, { question: "General." });
    exchange(db, { question: "Other subject.", subject: other.id });
    exchange(db, { question: "Editor.", agent: "editor", subject: mine.id });
    assert.equal(status(config, run), null);
    exchange(db, { question: "Mine.", subject: mine.id });
    const heard = status(config, run)!;
    assert.ok(heard.includes("Owner: Mine."));
    for (const left of ["General.", "Other subject.", "Editor."]) assert.ok(!heard.includes(left), left);
  } finally {
    held.open();
    await waitForRun(db, run.id);
  }
});

test("bounds: the owner's message whole, the answer cut, a long delivery spread over the next statuses", async () => {
  const config = office();
  const db = getDbAt(config.dbPath);
  const held = gate();
  const run = startRun({ room: "demo", agent: "scout" }, { config, engine: recording([], held.promise) });
  try {
    const owner = `Long brief ${"o".repeat(3_900)}`;
    for (let n = 1; n <= 5; n++) exchange(db, { question: `#${n} ${owner}`, answer: `${"a".repeat(HANDOFF_ANSWER_CHARS)}${"z".repeat(500)}` });
    const first = status(config, run)!;
    assert.ok(first.includes(`#1 ${owner}`), "the owner's message whole");
    assert.match(first, /\[answer cut: 500 more characters left out\]/);
    assert.ok(!first.includes("z"), "the end of the answer is left out");
    assert.match(first, /More of them come with your next hq_status/);
    assert.ok(first.length <= 24_000 + 200);
    const rest: string[] = [];
    for (let i = 0; i < 5; i++) {
      const next = status(config, run);
      if (next === null) break;
      rest.push(next);
    }
    const all = [first, ...rest].join("\n");
    for (let n = 1; n <= 5; n++) assert.equal(all.split(`Owner: #${n} `).length - 1, 1, `exchange ${n} once`);
  } finally {
    held.open();
    await waitForRun(db, run.id);
  }
});

test("a run from before, without a cursor, hears nothing", async () => {
  const config = office();
  const db = getDbAt(config.dbPath);
  const held = gate();
  const run = startRun({ room: "demo", agent: "scout" }, { config, engine: recording([], held.promise) });
  try {
    db.prepare("UPDATE runs SET heard_up_to = NULL WHERE id = ?").run(run.id);
    exchange(db, { question: "Said now." });
    assert.equal(status(config, run), null);
  } finally {
    held.open();
    await waitForRun(db, run.id);
  }
});

test("the run instructions: hear the owner at hq_status, acknowledge in the next one, ask early", () => {
  const prompt = buildPrompt({
    room: { name: "demo", shared: false } as never,
    agent: { id: "scout", name: "Scout" } as never,
    runId: 1,
    task: "Task.",
    mailbox: [],
  });
  assert.match(prompt, /A result of hq_status may bring new messages from the owner/);
  assert.match(prompt, /If what it changes is not built yet, apply it now; otherwise finish the step in progress, then apply it/);
  assert.match(prompt, /say what you do with it in your very next hq_status/);
  assert.match(prompt, /A doubt that would change the deliverable is asked early in the run, before you build on it/);
  assert.equal(prompt.match(/at each notable step/g)?.length, 1, "the status at each step is asked once");
});

test("question mode talks like a colleague: short, one question at a time", () => {
  const text = questionSystemText("English");
  assert.match(text, /as a colleague would: a few sentences, no long structured report unless the owner asks for one/);
  assert.match(text, /ask one question, the one that matters most, and keep the others for after their answer/);
});

function questionPrompt(run: ActiveRun | null, subject: { id: number; title: string | null } | null) {
  return buildQuestionPrompt({
    room: { name: "demo" } as never,
    agent: { id: "scout", name: "Scout" } as never,
    question: "Make the border 2 mm.",
    previous: [],
    run,
    checkedAt: "2026-11-16T10:00:00.000Z",
    subject,
    memory: "",
    today: "",
  });
}

const activeRun = (subjectId: number | null, subjectTitle: string | null = null): ActiveRun => ({
  id: 7,
  task: "Make the sign.",
  reason: null,
  startedAt: "2026-11-16T09:50:00.000Z",
  subjectId,
  subjectTitle,
  statuses: [],
});

test("the question prompt in three situations: no run, a run on this subject, a run on another one", () => {
  const sign = { id: 3, title: "The sign" };
  const none = questionPrompt(null, sign);
  assert.match(none, /You have no run in progress\./);
  assert.doesNotMatch(none, /next step/);

  const here = questionPrompt(activeRun(3, "The sign"), sign);
  assert.match(here, /Run #7 works on this very subject: what the owner says here now, and your answer, reach that run at its next step/);
  assert.match(here, /in one or two sentences, what will happen/);
  assert.match(here, /settle with the owner what is unclear/);
  assert.match(here, /Do not propose a run nor a revision \(no run-proposal or revision-proposal block\) for something that amends the work in progress/);
  assert.doesNotMatch(here, /refuses a second run/);

  const general = questionPrompt(activeRun(null), null);
  assert.match(general, /works on this very subject/, "the general subject is a subject too");

  const elsewhere = questionPrompt(activeRun(5, "The logo"), sign);
  assert.match(elsewhere, /Run #7 works on another subject, your subject "The logo": what the owner says here does not reach it/);
  assert.match(elsewhere, /A run or a revision proposed here waits for its turn: it starts once run #7 ends/);
  assert.doesNotMatch(elsewhere, /refuses a second run/);
  assert.match(questionPrompt(activeRun(null), sign), /another subject, your general discussion/);
});

test("a run proposed while the agent is busy on another subject is kept, queued, and started by the wake-up with its subject and its discussion", async () => {
  const config = office();
  const db = getDbAt(config.dbPath);
  const busySubject = createSubject(db, "demo", "scout", "The sign");
  const subject = createSubject(db, "demo", "scout", "The logo");
  const held = gate();
  const seen: RunInput[] = [];
  const busy = startRun({ room: "demo", agent: "scout", task: "Make the sign." }, { config, engine: recording(seen, held.promise), subject: busySubject.id });

  exchange(db, { question: "The logo is round.", subject: subject.id });
  const prompts: string[] = [];
  const proposing = askAgent(
    { room: "demo", agent: "scout", question: "Draw the logo.", subject: subject.id },
    { config, engine: answering("I propose a run.\n<run-proposal>Draw the round logo.</run-proposal>", prompts) },
  );
  await questionsIdle();
  assert.match(prompts[0]!, new RegExp(`Run #${busy.id} works on another subject, your subject "The sign"`));
  assert.equal(toQuestion(readDiscussion(db, "demo", "scout", subject.id).at(-1)!).proposal?.state, "pending", "kept while busy");

  const { question, run } = decideProposal({ room: "demo", agent: "scout", questionId: proposing.id, action: "launch" }, { config, engine: recording([]) });
  assert.equal(run, null, "the agent is busy: nothing starts");
  assert.equal(toQuestion(question).proposal?.state, "queued");
  const task = db.prepare("SELECT * FROM tasks WHERE source = 'chat'").get() as TaskRow;
  assert.equal(task.status, "pending");
  assert.equal(task.ref_id, proposing.id, "the link to the proposing question survives the wait");
  assert.equal(task.subject_id, subject.id);
  assert.equal(task.text, "Draw the round logo.");

  // Set aside, a second proposal stays set aside: nothing queued, nothing started.
  const other = askAgent(
    { room: "demo", agent: "scout", question: "And a banner?", subject: subject.id },
    { config, engine: answering("I propose a run.\n<run-proposal>Draw a banner.</run-proposal>") },
  );
  await questionsIdle();
  decideProposal({ room: "demo", agent: "scout", questionId: other.id, action: "dismiss" }, { config });
  exchange(db, { question: "Said after the proposal.", subject: subject.id });

  held.open();
  await waitForRun(db, busy.id);
  const woken = db.prepare("SELECT * FROM runs WHERE id <> ? ORDER BY id").all(busy.id) as RunRow[];
  assert.equal(woken.length, 1, "one run: the queued one, never the dismissed one");
  const started = woken[0]!;
  assert.equal(started.subject_id, subject.id);
  assert.equal(started.reason, "chat");
  await waitForRun(db, started.id);
  const prompt = seen.find((input) => input.runId === started.id)!.prompt;
  assert.match(prompt, /Draw the round logo\./);
  assert.match(prompt, /## Your discussion with the owner/);
  for (const kept of ["The logo is round.", "Draw the logo."]) assert.ok(prompt.includes(kept), kept);
  for (const left of ["And a banner?", "Said after the proposal."]) assert.ok(!prompt.includes(left), left);
  // What followed the proposing question reaches the run at its first step.
  const heard = status(config, started);
  assert.ok(heard?.includes("Said after the proposal.") && !heard.includes("The logo is round."));

  const after = toQuestion(readDiscussion(db, "demo", "scout", subject.id).find((row) => row.id === proposing.id)!).proposal;
  assert.equal(after?.state, "launched");
  assert.equal(after?.runId, started.id);
  assert.equal(toQuestion(readDiscussion(db, "demo", "scout", subject.id).find((row) => row.id === other.id)!).proposal?.state, "dismissed");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE source = 'chat'").get() as { n: number }).n, 1);
});
