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
// Only this agent's own exchanges of the room (same room, same agent id), done,
// answered, not cleared. Built when the run starts, never when the revision is
// decided, so that what was said in between counts. Pure but for the reads.

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
  const upTo = params.upToQuestionId;
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
