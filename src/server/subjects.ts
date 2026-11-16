import { z } from "zod";
import { closeBench } from "./benches";
import { now, type ApprovalStatus, type Db } from "./db";
import { DOOR_TYPE } from "./door";
import { HqError } from "./errors";
import { QUESTION_TYPE } from "./questions";

// The subjects of an agent (docs/architecture.md, "The sheet of an agent"):
// the topics the owner has going with the same agent, one tab each on its
// sheet. A subject keeps the word-for-word of one topic: its exchanges
// (agent_questions), its runs, its tasks and its items carry its id
// (subject_id, migration 28). NULL is the general subject of the agent:
// everything from before the subjects, and everything that names none
// (routines, messages between agents, the chat, a run started by hand). A
// subject is never deleted nor reset: it is archived, by the owner or by
// itself once its work is validated (`settleSubject`), and reopened by the
// owner, or by a new message of the owner in it.

/** The longest title; a subject without one takes the owner's first message in it, cut to this. */
export const SUBJECT_TITLE_MAX_CHARS = 60;
/** How many archived subjects the list gives, the latest archived first. */
export const ARCHIVED_SUBJECTS_LIMIT = 30;
/** The latest items of a subject the question prompt gives the agent (subjectContext). */
export const SUBJECT_CONTEXT_ITEMS = 10;

export const SUBJECT_STATUSES = ["open", "archived"] as const;
export type SubjectStatus = (typeof SUBJECT_STATUSES)[number];

export type SubjectRow = {
  id: number;
  room: string;
  agent_id: string;
  title: string | null;
  status: SubjectStatus;
  created_at: string;
  archived_at: string | null;
};

/** A subject as the API gives it; `title` null: no title yet (no message in it either). */
export type SubjectDto = { id: number; title: string | null; status: SubjectStatus; createdAt: string; archivedAt: string | null };

export function toSubject(row: SubjectRow): SubjectDto {
  return { id: row.id, title: row.title, status: row.status, createdAt: row.created_at, archivedAt: row.archived_at };
}

const titleSchema = z.string().trim().min(1).max(SUBJECT_TITLE_MAX_CHARS);

/** The id of a subject in a path or a query (`?subject=12`). */
export const subjectIdSchema = z.coerce.number().int().positive();

export const createSubjectSchema = z.strictObject({ title: titleSchema.optional() });

/** Rename (`title`), archive or reopen (`status`): one or both. */
export const updateSubjectSchema = z
  .strictObject({ title: titleSchema.optional(), status: z.enum(SUBJECT_STATUSES).optional() })
  .refine((patch) => patch.title !== undefined || patch.status !== undefined, { message: "give a title or a status" });
export type SubjectPatch = z.infer<typeof updateSubjectSchema>;

/** The title a subject takes from the owner's first message: one line, cut to SUBJECT_TITLE_MAX_CHARS with a mark. */
export function subjectTitleFrom(message: string): string {
  const line = message.replace(/\s+/g, " ").trim();
  return line.length <= SUBJECT_TITLE_MAX_CHARS ? line : `${line.slice(0, SUBJECT_TITLE_MAX_CHARS - 1).trimEnd()}…`;
}

/** A subject of this agent, or SUBJECT_NOT_FOUND (404): never one of another agent. */
export function readSubject(db: Db, room: string, agentId: string, id: number): SubjectRow {
  const row = db.prepare("SELECT * FROM subjects WHERE id = ? AND room = ? AND agent_id = ?").get(id, room, agentId) as
    | SubjectRow
    | undefined;
  if (!row) throw new HqError("SUBJECT_NOT_FOUND", 404, `No subject #${id} of agent "${agentId}" in room "${room}".`);
  return row;
}

/** The open subjects of an agent, oldest first; with `archived`, its archived ones instead, the latest archived first. */
export function listSubjects(db: Db, room: string, agentId: string, archived = false): SubjectRow[] {
  if (archived) {
    return db
      .prepare("SELECT * FROM subjects WHERE room = ? AND agent_id = ? AND status = 'archived' ORDER BY archived_at DESC, id DESC LIMIT ?")
      .all(room, agentId, ARCHIVED_SUBJECTS_LIMIT) as SubjectRow[];
  }
  return db
    .prepare("SELECT * FROM subjects WHERE room = ? AND agent_id = ? AND status = 'open' ORDER BY id")
    .all(room, agentId) as SubjectRow[];
}

/** A new open subject; without a title it takes the owner's first message in it. */
export function createSubject(db: Db, room: string, agentId: string, title?: string): SubjectRow {
  const id = Number(
    db
      .prepare("INSERT INTO subjects (room, agent_id, title, status, created_at) VALUES (?, ?, ?, 'open', ?)")
      .run(room, agentId, title ?? null, now()).lastInsertRowid,
  );
  return readSubject(db, room, agentId, id);
}

/** Renames, archives or reopens a subject of this agent. */
export function updateSubject(db: Db, room: string, agentId: string, id: number, patch: SubjectPatch): SubjectRow {
  const row = db
    .transaction(() => {
      readSubject(db, room, agentId, id);
      if (patch.title !== undefined) db.prepare("UPDATE subjects SET title = ? WHERE id = ?").run(patch.title, id);
      if (patch.status === "archived") archive(db, id);
      if (patch.status === "open") reopenSubject(db, id);
      return readSubject(db, room, agentId, id);
    })
    .immediate();
  // Archived by the owner: its bench closes (benches.ts), out of the transaction since it runs Git; a held one is tried again at once.
  if (patch.status === "archived" && row.status === "archived") closeBench(db, id, undefined, { force: true });
  return row;
}

function archive(db: Db, id: number): boolean {
  return db.prepare("UPDATE subjects SET status = 'archived', archived_at = ? WHERE id = ? AND status = 'open'").run(now(), id).changes > 0;
}

/** An archived subject opens again (a new message of the owner in it, a revision of one of its items); null: nothing to do. */
export function reopenSubject(db: Db, id: number | null): void {
  if (id === null) return;
  db.prepare("UPDATE subjects SET status = 'open', archived_at = NULL WHERE id = ? AND status = 'archived'").run(id);
}

/**
 * A subject closes itself once its work is definitively validated: its latest
 * deliverable item (neither an item of questions, nor a question to the
 * assistant (door.ts), nor an informational one) is
 * approved, the task that approval gave the agent, if any, is done (and the
 * approval command, if any, has ended), nothing of the subject is pending or
 * running (a task, a run, an item, a question, a run or a revision one of its
 * answers proposes and the owner has not decided yet; a proposal queued
 * waits as a pending task; a question to the assistant the owner approved
 * and whose answer is not delivered yet), and the owner has written
 * nothing in it since that approval (a message after it reopened the work).
 * The general subject never closes. Called where those states change: a
 * decision (decideApproval), the end of a run, the end of an approval
 * command. The one place where a subject ends: what else goes with that end
 * belongs here, and its bench closes (benches.ts, closeBench: merged into
 * the agent's branch, or kept and told to the owner). Never throws; returns
 * whether it archived the subject.
 */
export function settleSubject(db: Db, subjectId: number | null): boolean {
  if (subjectId === null) return false;
  try {
    const open = db.prepare("SELECT 1 FROM subjects WHERE id = ? AND status = 'open'").get(subjectId);
    if (!open) return false;
    const item = db
      .prepare(
        `SELECT id, status, decided_at FROM approvals WHERE subject_id = ? AND type NOT IN (?, ?) AND status NOT IN ('unseen', 'seen')
         ORDER BY id DESC LIMIT 1`,
      )
      .get(subjectId, QUESTION_TYPE, DOOR_TYPE) as { id: number; status: ApprovalStatus; decided_at: string | null } | undefined;
    if (!item || item.status !== "approved") return false;
    const unsettled = db
      .prepare(
        `SELECT EXISTS (SELECT 1 FROM tasks WHERE subject_id = ? AND status IN ('pending', 'in_progress'))
           OR EXISTS (SELECT 1 FROM tasks WHERE source = 'approval' AND ref_id = ? AND status <> 'done')
           OR EXISTS (SELECT 1 FROM approval_commands WHERE approval_id = ? AND ended_at IS NULL)
           OR EXISTS (SELECT 1 FROM runs WHERE subject_id = ? AND status = 'running')
           OR EXISTS (SELECT 1 FROM approvals WHERE subject_id = ? AND status = 'pending')
           OR EXISTS (SELECT 1 FROM agent_questions WHERE subject_id = ? AND (status = 'running' OR started_at > ?))
           OR EXISTS (SELECT 1 FROM question_proposals p JOIN agent_questions q ON q.id = p.question_id
             WHERE q.subject_id = ? AND p.state = 'pending')
           OR EXISTS (SELECT 1 FROM door_requests d JOIN approvals a ON a.id = d.approval_id
             WHERE a.subject_id = ? AND d.status IN ('owner', 'answering')) AS n`,
      )
      .get(subjectId, item.id, item.id, subjectId, subjectId, subjectId, item.decided_at ?? "", subjectId, subjectId) as { n: number };
    if (unsettled.n !== 0 || !archive(db, subjectId)) return false;
    closeBench(db, subjectId);
    return true;
  } catch (error) {
    console.error(`[subjects] subject #${subjectId} could not be settled`, error);
    return false;
  }
}

/** A tab of the sheet: the general subject (id null) and each open subject, with what it shows. */
export type SubjectTabDto = {
  id: number | null;
  title: string | null;
  /** A run of the agent is going on this subject. */
  working: boolean;
  /** An item of this subject waits for the owner's decision. */
  waiting: boolean;
};

/** The tabs of an agent's sheet: « Général » first, then its open subjects, oldest first. */
export function subjectTabs(db: Db, room: string, agentId: string): SubjectTabDto[] {
  const working = db.prepare("SELECT 1 FROM runs WHERE room = ? AND agent_id = ? AND subject_id IS ? AND status = 'running' LIMIT 1");
  const waiting = db.prepare(
    "SELECT 1 FROM approvals WHERE room = ? AND agent_id = ? AND subject_id IS ? AND status = 'pending' LIMIT 1",
  );
  const tab = (id: number | null, title: string | null): SubjectTabDto => ({
    id,
    title,
    working: working.get(room, agentId, id) !== undefined,
    waiting: waiting.get(room, agentId, id) !== undefined,
  });
  return [tab(null, null), ...listSubjects(db, room, agentId).map((row) => tab(row.id, row.title))];
}

/** What the question prompt says of a subject: its title, a run on it, its latest item. */
export type SubjectContext = {
  id: number;
  title: string | null;
  working: boolean;
  lastItem: { id: number; title: string; status: ApprovalStatus } | null;
};

/** The open subjects of the agent other than `current`, for the prompt of a question asked in `current`. */
export function otherSubjects(db: Db, room: string, agentId: string, current: number | null): SubjectContext[] {
  const working = db.prepare("SELECT 1 FROM runs WHERE subject_id = ? AND status = 'running' LIMIT 1");
  const last = db.prepare("SELECT id, title, status FROM approvals WHERE subject_id = ? ORDER BY id DESC LIMIT 1");
  return listSubjects(db, room, agentId)
    .filter((row) => row.id !== current)
    .map((row) => ({
      id: row.id,
      title: row.title,
      working: working.get(row.id) !== undefined,
      lastItem: (last.get(row.id) as SubjectContext["lastItem"] | undefined) ?? null,
    }));
}

/** The latest deliverable items of a subject of the agent (no item of questions, no question to the assistant, no informational one), newest first: what a revision may name. */
export function subjectItems(
  db: Db,
  room: string,
  agentId: string,
  subject: number | null,
): { id: number; type: string; title: string; status: ApprovalStatus }[] {
  return db
    .prepare(
      `SELECT id, type, title, status FROM approvals WHERE room = ? AND agent_id = ? AND subject_id IS ? AND type NOT IN (?, ?)
         AND status NOT IN ('unseen', 'seen') ORDER BY id DESC LIMIT ?`,
    )
    .all(room, agentId, subject, QUESTION_TYPE, DOOR_TYPE, SUBJECT_CONTEXT_ITEMS) as { id: number; type: string; title: string; status: ApprovalStatus }[];
}
