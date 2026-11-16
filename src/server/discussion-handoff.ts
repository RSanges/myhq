// The discussion follows the task. In question mode the owner and an agent talk
// things through (agent-questions.ts), but a run never sees that discussion:
// what was agreed there used to be lost the moment the work was handed to a run.
// Two kinds of run now get it, as a block of their prompt:
//
// - the run that revises an item the agent delivered (a task of source
//   `revise`, `ref_id` is the approval): the exchanges asked since the run that
//   produced the item started (the item's creation when it has no run), so
//   that what was agreed while the work was done, and after it, is included;
// - the run started from a proposal the agent made in the discussion
//   (decideProposal): the exchanges of the current discussion up to and
//   including the question whose answer proposed the run.
//
// Those are the rules of the general subject (subjects.ts), restricted to its
// own exchanges. A run of another subject gets the exchanges of that subject,
// all of them (up to the proposing question for a run it proposed): the
// subject is the topic, its whole discussion is the brief.
//
// A run proposed while the agent could not start it waits as a task of source
// `chat` whose ref_id is the proposing question (decideProposal): the run that
// claims it gets the discussion up to that question, as one started at once.
//
// Only this agent's own exchanges of the room (same room, same agent id), done,
// answered, not cleared. Built when the run starts, never when the revision is
// decided, so that what was said in between counts. Pure but for the reads.
//
// While the run works, the owner may still talk with the agent in question
// mode: every exchange of the run's subject answered after the block was built
// reaches the run at its next hq_status (`hearOwner`), once. The cursor is
// `runs.heard_up_to`, the highest exchange id the run has been given: set with
// the block (`heardFrom`), from the same reads, then advanced by each
// delivery. Within a subject one question runs at a time and ids grow, so a
// question still running when the block is built has an id above the cursor
// and is delivered once answered: no gap, no duplicate.

import type { Db, TaskRow } from "./db";

/** The longest answer kept whole; beyond it the answer is cut with a visible mark. */
export const HANDOFF_ANSWER_CHARS = 6_000;
/** The longest block: the oldest exchanges go first when it would be longer. */
export const HANDOFF_BLOCK_CHARS = 24_000;

const INTRO = [
  "## Your discussion with the owner",
  "",
  "These are your own exchanges with the owner in question mode (where you read and answer, and change nothing), oldest first. What was agreed there is part of this task. Where the note of the task and the discussion differ, the owner's most recent statement wins. If a doubt would change the deliverable, ask with hq_ask when you have it; otherwise state your reading at the top of your submission.",
].join("\n");

type Exchange = { id: number; question: string; answer: string; started_at: string };

/** The proposing question of the queued proposals a mailbox holds (tasks of source `chat` with a ref_id), the latest; undefined: none. */
export function queuedProposalUpTo(mailbox: readonly TaskRow[]): number | undefined {
  let upTo: number | undefined;
  for (const task of mailbox) {
    if (task.source === "chat" && task.ref_id !== null && (upTo === undefined || task.ref_id > upTo)) upTo = task.ref_id;
  }
  return upTo;
}

/** The earliest `since` of the revisions in a mailbox: when the run behind the item started, else the item's creation. */
function revisionSince(db: Db, mailbox: readonly TaskRow[]): string | null {
  const read = db.prepare(
    "SELECT COALESCE(r.started_at, a.created_at) AS since FROM approvals a LEFT JOIN runs r ON r.id = a.run_id WHERE a.id = ?",
  );
  let since: string | null = null;
  for (const task of mailbox) {
    if (task.source !== "revise" || task.ref_id === null) continue;
    const row = read.get(task.ref_id) as { since: string } | undefined;
    if (row && (since === null || row.since < since)) since = row.since;
  }
  return since;
}

/** One exchange as the block shows it: dated, the owner's message whole, the answer cut when too long. */
function renderExchange(each: Exchange): string {
  const cut = each.answer.length - HANDOFF_ANSWER_CHARS;
  const answer = cut > 0 ? `${each.answer.slice(0, HANDOFF_ANSWER_CHARS)}\n[answer cut: ${cut} more characters left out]` : each.answer;
  const when = `${each.started_at.slice(0, 16).replace("T", " ")} UTC`;
  return `### ${when}\nOwner: ${each.question}\n\nYou: ${answer}`;
}

/**
 * Where the run starts to hear the owner (`runs.heard_up_to`): the proposing
 * question for a run proposed in the discussion (what followed it reaches the
 * run at its first step), else the latest answered exchange of the subject
 * when the prompt is built (everything older is either in the block or left
 * out by the rules above); 0 when there is none.
 */
export function heardFrom(
  db: Db,
  params: { room: string; agentId: string; mailbox: readonly TaskRow[]; upToQuestionId?: number; subjectId?: number | null },
): number {
  const upTo = params.upToQuestionId ?? queuedProposalUpTo(params.mailbox);
  if (upTo !== undefined) return upTo;
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(id), 0) AS id FROM agent_questions
       WHERE room = ? AND agent_id = ? AND subject_id IS ? AND status = 'done' AND answer IS NOT NULL`,
    )
    .get(params.room, params.agentId, params.subjectId ?? null) as { id: number };
  return row.id;
}

const HEARD_INTRO =
  "New messages from the owner, exchanged with you in question mode while you work, oldest first. What was settled there is part of your task from now: apply it now if what it changes is not built yet, otherwise finish the step in progress, then apply it. Say what you do with it in your very next hq_status: the owner reads it in your thread.";

/**
 * The exchanges of the run's subject the run has not been given yet, as one
 * text for the result of its hq_status, and the cursor moved past them; null
 * when there is none, or the run hears nothing (no heard_up_to). Bounded as
 * the block: each answer cut at HANDOFF_ANSWER_CHARS, at most
 * HANDOFF_BLOCK_CHARS in all (always one exchange at least), the rest at the
 * next hq_status. Call it in the transaction that records the status.
 */
export function hearOwner(db: Db, runId: number): string | null {
  const run = db.prepare("SELECT room, agent_id, subject_id, heard_up_to FROM runs WHERE id = ?").get(runId) as
    | { room: string; agent_id: string; subject_id: number | null; heard_up_to: number | null }
    | undefined;
  if (!run || run.heard_up_to === null) return null;
  const rows = db
    .prepare(
      `SELECT id, question, answer, started_at FROM agent_questions
       WHERE room = ? AND agent_id = ? AND subject_id IS ? AND status = 'done' AND answer IS NOT NULL
         AND cleared_at IS NULL AND id > ? ORDER BY id LIMIT 20`,
    )
    .all(run.room, run.agent_id, run.subject_id, run.heard_up_to) as Exchange[];
  if (rows.length === 0) return null;
  const given: string[] = [];
  let length = HEARD_INTRO.length;
  let last = run.heard_up_to;
  for (const row of rows) {
    const text = renderExchange(row);
    if (given.length > 0 && length + text.length + 2 > HANDOFF_BLOCK_CHARS) break;
    given.push(text);
    length += text.length + 2;
    last = row.id;
  }
  db.prepare("UPDATE runs SET heard_up_to = ? WHERE id = ? AND heard_up_to < ?").run(last, runId, last);
  const more = given.length < rows.length ? ["(More of them come with your next hq_status.)"] : [];
  return [HEARD_INTRO, ...given, ...more].join("\n\n");
}

/**
 * The block of the discussion for the prompt of a run of this agent, or null
 * when no exchange applies (the prompt is then left as it always was).
 * `upToQuestionId` is the question whose answer proposed the run, if any;
 * `subjectId` the subject of the run, null or left out: the general one.
 */
export function discussionHandoff(
  db: Db,
  params: { room: string; agentId: string; mailbox: readonly TaskRow[]; upToQuestionId?: number; subjectId?: number | null },
): string | null {
  const subject = params.subjectId ?? null;
  const upTo = params.upToQuestionId ?? queuedProposalUpTo(params.mailbox);
  const wanted: string[] = [];
  const args: (string | number | null)[] = [params.room, params.agentId, subject];
  if (subject !== null) {
    wanted.push(upTo !== undefined ? "q.id <= ?" : "1 = 1");
    if (upTo !== undefined) args.push(upTo);
  } else {
    const since = revisionSince(db, params.mailbox);
    if (since !== null) {
      wanted.push("q.started_at >= ?");
      args.push(since);
    }
    if (upTo !== undefined) {
      wanted.push("q.id <= ?");
      args.push(upTo);
    }
  }
  if (wanted.length === 0) return null;
  const rows = db
    .prepare(
      `SELECT q.id, q.question, q.answer, q.started_at FROM agent_questions q
       WHERE q.room = ? AND q.agent_id = ? AND q.subject_id IS ? AND q.status = 'done' AND q.answer IS NOT NULL
         AND q.cleared_at IS NULL AND (${wanted.join(" OR ")}) ORDER BY q.id`,
    )
    .all(...args) as Exchange[];
  if (rows.length === 0) return null;
  const title =
    subject === null
      ? null
      : (db.prepare("SELECT title FROM subjects WHERE id = ?").get(subject) as { title: string | null } | undefined)?.title;
  const intro = title ? `${INTRO}\n\nThe subject of this run: "${title}".` : INTRO;
  const rendered = rows.map(renderExchange);
  // The oldest go first; the newest always stays, whatever its size.
  let first = 0;
  const length = () => intro.length + 120 + rendered.slice(first).reduce((sum, text) => sum + text.length + 2, 0);
  while (first < rendered.length - 1 && length() > HANDOFF_BLOCK_CHARS) first++;
  const left = first > 0 ? [`(${first} earlier exchange${first === 1 ? "" : "s"} left out to keep this short.)`] : [];
  return [intro, ...left, ...rendered.slice(first)].join("\n\n");
}
