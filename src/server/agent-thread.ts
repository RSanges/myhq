import { readDiscussion, toQuestion, type QuestionDto } from "./agent-questions";
import type { ApprovalStatus, Db, RunRow, RunStatus } from "./db";
import { QUESTION_TYPE } from "./questions";

// The thread of an agent's sheet (docs/architecture.md, "The sheet of an
// agent"): one chronological view of what the owner and the agent said and
// did, read from the tables that already hold it, never copied. The owner's
// questions and their answers (since the last « Nouvelle discussion »), the
// agent's latest runs and the latest items it submitted, its questions
// (`hq_ask`) among them.

/** The latest runs of the agent the thread shows. */
export const THREAD_RUNS = 15;
/** The latest items of the agent the thread shows. */
export const THREAD_ITEMS = 20;

/** A run, as the thread shows it: a line, its whole summary on demand. */
export type ThreadRun = {
  id: number;
  status: RunStatus;
  task: string;
  reason: string | null;
  costUsd: number;
  startedAt: string;
  endedAt: string | null;
  summary: string | null;
};

/** An item the agent submitted: its title and status, opened on the desk. `question`: an item of questions (`hq_ask`). */
export type ThreadItem = {
  id: number;
  type: string;
  title: string;
  status: ApprovalStatus;
  question: boolean;
  createdAt: string;
};

export type ThreadEntry =
  | { kind: "question"; at: string; question: QuestionDto }
  | { kind: "run"; at: string; run: ThreadRun }
  | { kind: "item"; at: string; item: ThreadItem };

export type ThreadDto = { entries: ThreadEntry[]; busy: boolean };

/** At the same time, a question comes before the run and the item it led to. */
const KIND_ORDER: Record<ThreadEntry["kind"], number> = { question: 0, run: 1, item: 2 };

const entryId = (entry: ThreadEntry): number =>
  entry.kind === "question" ? entry.question.id : entry.kind === "run" ? entry.run.id : entry.item.id;

/** The thread of an agent, oldest first. */
export function readThread(db: Db, room: string, agentId: string): ThreadDto {
  const questions = readDiscussion(db, room, agentId).map(toQuestion);
  const runs = db
    .prepare("SELECT * FROM runs WHERE room = ? AND agent_id = ? ORDER BY id DESC LIMIT ?")
    .all(room, agentId, THREAD_RUNS) as RunRow[];
  const items = db
    .prepare(
      "SELECT id, type, title, status, created_at FROM approvals WHERE room = ? AND agent_id = ? ORDER BY id DESC LIMIT ?",
    )
    .all(room, agentId, THREAD_ITEMS) as { id: number; type: string; title: string; status: ApprovalStatus; created_at: string }[];

  const entries: ThreadEntry[] = [
    ...questions.map((question): ThreadEntry => ({ kind: "question", at: question.askedAt, question })),
    ...runs.map(
      (run): ThreadEntry => ({
        kind: "run",
        at: run.started_at,
        run: {
          id: run.id,
          status: run.status,
          task: run.task,
          reason: run.reason,
          costUsd: run.cost_usd,
          startedAt: run.started_at,
          endedAt: run.ended_at,
          summary: run.summary,
        },
      }),
    ),
    ...items.map(
      (item): ThreadEntry => ({
        kind: "item",
        at: item.created_at,
        item: {
          id: item.id,
          type: item.type,
          title: item.title,
          status: item.status,
          question: item.type === QUESTION_TYPE,
          createdAt: item.created_at,
        },
      }),
    ),
  ];
  entries.sort(
    (a, b) => a.at.localeCompare(b.at) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || entryId(a) - entryId(b),
  );
  return { entries, busy: questions.some((question) => question.status === "running") };
}
