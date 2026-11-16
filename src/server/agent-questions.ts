import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { memoryText, readMemories } from "./briefing";
import { ClaudeEngine, removeMcpConfig, writeMcpConfig } from "./claude-engine";
import { getConfig, liveConfig, type HqConfig } from "./config";
import { getDbAt, now, type Db, type RunRow } from "./db";
import { ZERO_USAGE, type Engine, type RunEvent, type RunInput, type Usage } from "./engine";
import { HqError } from "./errors";
import { DEFAULT_LANGUAGE, readHomeLanguage } from "./export";
import { languageName } from "./onboarding";
import { QUESTION_TYPE } from "./questions";
import type { Agent, Room } from "./rooms";
import { decideApproval, decisionSchema } from "./approvals";
import { parseRunProposal, REVISION_PROPOSAL_TAG, RUN_PROPOSAL_TAG } from "./run-proposal";
import { agentEnv, findAgent, isStopping, startRun, todayLine, WAITS, type RunnerDeps } from "./runner";
import {
  otherSubjects,
  readSubject,
  reopenSubject,
  subjectItems,
  subjectTitleFrom,
  type SubjectContext,
} from "./subjects";

// Questions of the owner to an agent (docs/architecture.md, "Questions to an
// agent"). The agent answers with its own role, memory, model and effort, in
// its own working directory, through the same `claude -p` as a run, but with
// read tools only: Read, Glob, Grep, the web tools when its own whitelist has
// them (WebSearch, WebFetch), and the HQ server in read-only mode
// (hq_memory_read, hq_items). It is not a run: nothing in `runs`, no agent
// lock, no daily cap, no wake-up. Each question is metered in
// `agent_questions` (migration 19), and its cost counts in the day and the
// week of the whiteboard (usage.ts). A message that asks for work gets an
// answer that proposes a run (run-proposal.ts, `question_proposals`, migration
// 20): that run starts only when the owner confirms it (`decideProposal`),
// at once, or once the agent is free (a queued proposal, migration 30). While
// a run of the agent works on the subject of the question, the exchange
// reaches that run at its next step (hearOwner, discussion-handoff.ts).

/** The longest question the owner may ask. */
export const QUESTION_MAX_CHARS = 4_000;
/** A question that has no answer after this is stopped (`timeout`). */
export const QUESTION_TIMEOUT_MS = 5 * 60_000;
/** The cap of one question (`--max-budget-usd`), below the agent's own when that is lower. */
export const QUESTION_MAX_BUDGET_USD = 1;
/** The earlier exchanges of the discussion given back to the agent, and how much of each answer. */
export const QUESTION_CONTEXT_EXCHANGES = 10;
export const QUESTION_CONTEXT_ANSWER_CHARS = 2_000;
/** The longest answer stored. */
export const ANSWER_MAX_CHARS = 20_000;
/** How many questions of the discussion the API gives back, the latest ones. */
export const DISCUSSION_LIMIT = 50;

/** The only built-in tools that exist for a question: they read, never write. */
export const QUESTION_TOOLS = ["Read", "Glob", "Grep"] as const;
/** The HQ tools of a question: the ones the server gives in read-only mode. */
export const QUESTION_HQ_TOOLS = ["mcp__hq__hq_memory_read", "mcp__hq__hq_items"] as const;
/**
 * The web tools a question keeps when the agent's own whitelist has them: they
 * read, and an agent whose job is to stay current (a documentalist, a watch)
 * must check before it answers about anything recent, not answer from memory.
 */
export const QUESTION_WEB_TOOLS = ["WebSearch", "WebFetch"] as const;

/** The web tools of the agent's whitelist (`WebFetch` or `WebFetch(domain:...)` both count). */
export function questionWebTools(allowedTools: string[]): string[] {
  return QUESTION_WEB_TOOLS.filter((tool) =>
    allowedTools.some((rule) => rule.replace(/\(.*$/, "").trim() === tool),
  );
}
/**
 * Denied on top of the global deny list, whatever the project settings of the
 * working directory allow: every built-in tool that writes, runs or fetches,
 * and every HQ tool that writes (the server does not even give them). The web
 * tools leave this list for an agent that has them (QUESTION_WEB_TOOLS).
 */
export const QUESTION_DENIED_TOOLS = [
  "Bash",
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Task",
  "mcp__hq__hq_submit",
  "mcp__hq__hq_message",
  "mcp__hq__hq_ask",
  "mcp__hq__hq_status",
  "mcp__hq__hq_show",
  "mcp__hq__hq_task_update",
  "mcp__hq__hq_read_decisions",
  "mcp__hq__hq_memory_write",
  "mcp__hq__hq_order_open",
  "mcp__hq__hq_suggest_agent",
  "mcp__hq__hq_relaunch",
  "mcp__hq__hq_blocked_note",
  "mcp__hq__hq_run_extend",
  "mcp__hq__hq_run_stop",
] as const;

/** How much of a proposed task the agent reads again in the context of the next questions. */
export const QUESTION_CONTEXT_PROPOSAL_CHARS = 500;
/** How much of the task of the agent's run in progress, and how many of its latest steps (hq_status), a question gives. */
export const QUESTION_CONTEXT_RUN_TASK_CHARS = 1_000;
export const QUESTION_CONTEXT_RUN_STATUSES = 3;

/** The agent's run in progress, as a question reads it from `runs` (the agent lock of `startRun`). */
export type ActiveRun = {
  id: number;
  task: string;
  reason: string | null;
  startedAt: string;
  /** The subject it works on (subjects.ts), null: the general one, and that subject's title. */
  subjectId: number | null;
  subjectTitle: string | null;
  /** What the agent said last in this run (hq_status), oldest first. */
  statuses: { text: string; at: string }[];
};

/** The run of this agent in progress, if any: the one that makes `startRun` refuse another (AGENT_BUSY). */
export function activeRunOf(db: Db, room: string, agentId: string): ActiveRun | null {
  const run = db
    .prepare("SELECT * FROM runs WHERE room = ? AND agent_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1")
    .get(room, agentId) as RunRow | undefined;
  if (!run) return null;
  const statuses = (
    db
      .prepare("SELECT text, created_at FROM run_statuses WHERE run_id = ? ORDER BY id DESC LIMIT ?")
      .all(run.id, QUESTION_CONTEXT_RUN_STATUSES) as { text: string; created_at: string }[]
  )
    .reverse()
    .map((row) => ({ text: row.text, at: row.created_at }));
  const subjectTitle =
    run.subject_id === null
      ? null
      : ((db.prepare("SELECT title FROM subjects WHERE id = ?").get(run.subject_id) as { title: string | null } | undefined)?.title ?? null);
  return {
    id: run.id,
    task: run.task,
    reason: run.reason,
    startedAt: run.started_at,
    subjectId: run.subject_id,
    subjectTitle,
    statuses,
  };
}

export const askSchema = z.strictObject({
  question: z.string().trim().min(1).max(QUESTION_MAX_CHARS),
  /** The subject the question is asked in (subjects.ts); null or left out: the general one. */
  subject: z.number().int().positive().nullable().optional(),
});

export const QUESTION_STATUSES = ["running", "done", "failed"] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

/** Why a question has no answer: its delay, its budget, the engine, or the app stopped during it. */
export type QuestionError = "timeout" | "budget" | "error" | "interrupted";

/** A run proposed by an answer: waiting for the owner, started by « Lancer le tour », or set aside by « On en parle d'abord ». */
export const PROPOSAL_STATES = ["pending", "launched", "dismissed"] as const;
export type ProposalState = (typeof PROPOSAL_STATES)[number];
/**
 * A proposal as the owner reads it: `queued` is a confirmed run that waits
 * for the agent to be free (stored `launched`, its task still pending).
 */
export type ProposalView = ProposalState | "queued";

export const proposalActionSchema = z.strictObject({ action: z.enum(["launch", "dismiss"]) });
export type ProposalAction = z.infer<typeof proposalActionSchema>["action"];

/**
 * The run an answer proposes (`question_proposals`, migration 20), or the
 * revision of an item (`reviseId`, migration 28): `task` is then the note of
 * that revision, and `runId` the revision run once one started.
 */
export type ProposalDto = { task: string; state: ProposalView; runId: number | null; decidedAt: string | null; reviseId: number | null };

export type QuestionRow = {
  id: number;
  room: string;
  agent_id: string;
  question: string;
  answer: string | null;
  status: QuestionStatus;
  error: QuestionError | null;
  detail: string | null;
  engine: string;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cost_usd: number;
  tool_calls: number;
  tools: string;
  started_at: string;
  ended_at: string | null;
  cleared_at: string | null;
  /** The subject it was asked in (subjects.ts), null: the general one. */
  subject_id: number | null;
  /** The run its answer proposes, joined from `question_proposals` (QUESTION_SELECT); absent or null: none. */
  proposal_task?: string | null;
  proposal_state?: ProposalState | null;
  proposal_run_id?: number | null;
  proposal_decided_at?: string | null;
  proposal_revise_id?: number | null;
  /** 1: the task of a queued proposal is still pending. */
  proposal_queued?: number | null;
};

/**
 * Selects questions as `q` with the run their answer proposes; append a WHERE
 * clause. The run of a queued proposal is the one that took its task.
 */
const QUESTION_SELECT = `SELECT q.*, p.task AS proposal_task, p.state AS proposal_state,
  COALESCE(p.run_id, pt.run_id) AS proposal_run_id, p.decided_at AS proposal_decided_at, p.revise_id AS proposal_revise_id,
  pt.status = 'pending' AS proposal_queued
  FROM agent_questions q LEFT JOIN question_proposals p ON p.question_id = q.id LEFT JOIN tasks pt ON pt.id = p.task_id`;

/** A question as the API gives it. */
export type QuestionDto = {
  id: number;
  question: string;
  answer: string | null;
  status: QuestionStatus;
  error: QuestionError | null;
  model: string | null;
  costUsd: number;
  askedAt: string;
  answeredAt: string | null;
  /** The run the answer proposes, for the owner to start or set aside; null: the answer proposes none. */
  proposal: ProposalDto | null;
};

export function toQuestion(row: QuestionRow): QuestionDto {
  return {
    id: row.id,
    question: row.question,
    answer: row.answer,
    status: row.status,
    error: row.error,
    model: row.model,
    costUsd: row.cost_usd,
    askedAt: row.started_at,
    answeredAt: row.ended_at,
    proposal:
      row.proposal_task && row.proposal_state
        ? {
            task: row.proposal_task,
            state: row.proposal_queued ? "queued" : row.proposal_state,
            runId: row.proposal_run_id ?? null,
            decidedAt: row.proposal_decided_at ?? null,
            reviseId: row.proposal_revise_id ?? null,
          }
        : null,
  };
}

export type QuestionDeps = {
  config?: HqConfig;
  /** Default: the real `claude -p` (ClaudeEngine). */
  engine?: Engine;
  /** Default: QUESTION_TIMEOUT_MS. */
  timeoutMs?: number;
};

type QuestionsState = {
  /** The questions in progress in this process, to stop them when it exits. */
  active: Map<number, AbortController>;
  /** Their executions, until their end is recorded. */
  executing: Set<Promise<void>>;
  exitHook: boolean;
};

const globalForQuestions = globalThis as unknown as { __myhqQuestions?: QuestionsState };

function questionsState(): QuestionsState {
  globalForQuestions.__myhqQuestions ??= { active: new Map(), executing: new Set(), exitHook: false };
  return globalForQuestions.__myhqQuestions;
}

/** Resolves when no question of this process is in progress (tests, scripts). */
export async function questionsIdle(): Promise<void> {
  const state = questionsState();
  while (state.executing.size > 0) await Promise.allSettled([...state.executing]);
}

/** The question of this agent in progress in this subject (null: the general one), if any. */
function runningQuestion(db: Db, room: string, agentId: string, subject: number | null): QuestionRow | undefined {
  return db
    .prepare(
      "SELECT * FROM agent_questions WHERE room = ? AND agent_id = ? AND subject_id IS ? AND status = 'running' ORDER BY id DESC LIMIT 1",
    )
    .get(room, agentId, subject) as QuestionRow | undefined;
}

/**
 * The current discussion with an agent in a subject (null: the general one,
 * since its last reset), oldest first, the latest DISCUSSION_LIMIT.
 */
export function readDiscussion(db: Db, room: string, agentId: string, subject: number | null = null): QuestionRow[] {
  const rows = db
    .prepare(
      `${QUESTION_SELECT} WHERE q.room = ? AND q.agent_id = ? AND q.subject_id IS ? AND q.cleared_at IS NULL ORDER BY q.id DESC LIMIT ?`,
    )
    .all(room, agentId, subject, DISCUSSION_LIMIT) as QuestionRow[];
  return rows.reverse();
}

/**
 * A new discussion, in the general subject only (a subject is archived, never
 * reset): its questions leave the sheet (and the context given to the agent),
 * their rows stay for the meter. Refused while a question of the general
 * subject is in progress. Returns how many questions were cleared.
 */
export function resetDiscussion(db: Db, room: string, agentId: string): number {
  return db
    .transaction(() => {
      const busy = runningQuestion(db, room, agentId, null);
      if (busy) throw busyError(agentId, busy.id);
      return db
        .prepare(
          "UPDATE agent_questions SET cleared_at = ? WHERE room = ? AND agent_id = ? AND subject_id IS NULL AND cleared_at IS NULL",
        )
        .run(now(), room, agentId).changes;
    })
    .immediate();
}

function busyError(agentId: string, questionId: number): HqError {
  return new HqError(
    "QUESTION_BUSY",
    409,
    `Agent "${agentId}" is already answering a question (#${questionId}) in this subject: one question at a time per subject.`,
  );
}

/**
 * At startup, in the process that owns the home: the questions a crash or a
 * stop left `running` end `failed` (`interrupted`). Returns how many.
 */
export function recoverInterruptedQuestions(db: Db): number {
  return db
    .prepare(
      "UPDATE agent_questions SET status = 'failed', error = 'interrupted', detail = ?, ended_at = ? WHERE status = 'running'",
    )
    .run("Interrupted: MyHQ stopped during the question.", now()).changes;
}

/** The question-mode rules, after the agent's role in its system prompt. */
export function questionSystemText(language: string, web = false): string {
  return [
    "## Question mode",
    "",
    "The owner of MyHQ is asking you a question. This is not a task and not a run: answer it, and nothing else.",
    `Answer in ${language}, short and concrete, as a colleague would: a few sentences, no long structured report unless the owner asks for one. Answer from what you know (your role, your memory, the discussion below) and from what you can read in your working directory and its folders (Read, Glob, Grep; hq_memory_read and hq_items for your memory and the items).`,
    "You do nothing, deliver nothing, change nothing: you write no file, submit nothing, send no message. The instructions of your role about reporting, submitting or writing do not apply here.",
    ...(web
      ? [
          "You have WebSearch and WebFetch here, to read only. Anything that may have changed (a release, a model, a version, a price, a rule, an announcement, the state of the art): search the web before you answer, never answer it from memory, and give each fact with its source and its date. Search results are leads: for the facts that matter, open the official source (the publisher's own page, release notes, documentation) with WebFetch before you state them. Your notes and knowledge files are a starting point, not the latest word.",
          "Never put anything personal or private in a search query or a fetched URL.",
        ]
      : []),
    "If you do not know, say so: never invent. When you need something from the owner, ask one question, the one that matters most, and keep the others for after their answer.",
    "",
    "### A discussion or a task",
    "",
    "Tell the two apart from what the owner wants:",
    "- The owner wants to talk (a question, an opinion, where you stand, how you work, what you would do, an idea to weigh): answer normally.",
    `- The owner asks you to do work (make, redo, produce, write, render, send, fix, check and report, publish...): do not do it, and never say or suggest it is done. Say in one short sentence that you propose a run for it, which starts only once the owner confirms it, then end your answer with a block holding the task of that run, alone on its last lines, outside any code block:`,
    "",
    `<${RUN_PROPOSAL_TAG}>`,
    "The task of the run, in the language of your answer: complete and self-contained, as if it were given to you without this discussion (what to do, on what, with the details and decisions of the discussion that matter, what to deliver and how).",
    `</${RUN_PROPOSAL_TAG}>`,
    "",
    "The owner reads your sentence and the task, and confirms before anything starts: nothing runs without them. One block at most, only for work, never for a plain question. When you cannot tell, answer and ask whether they want you to start a run.",
    "",
    "### A change to an item you delivered",
    "",
    `When the owner asks to change something in an item you delivered in this discussion (one of the items of this subject listed below, pending or already decided), do not propose a new run: propose to revise that item. Say in one short sentence that you propose this revision, which starts only once the owner confirms it, then end your answer with this block instead, with the number of the item, alone on its last lines, outside any code block:`,
    "",
    `<${REVISION_PROPOSAL_TAG} item="12">`,
    "The note of the revision, in the language of your answer: your own recap of what the owner asks to change in that item, complete and self-contained, with the details of the discussion that matter.",
    `</${REVISION_PROPOSAL_TAG}>`,
    "",
    "Once the owner confirms, MyHQ sends the item back to you for a revision with that note, and the run that revises it gets this discussion. Only an item of the list below; for a new piece, or when the owner asks for a different subject, propose a run.",
    "",
    "### What follows this discussion",
    "",
    "This discussion is handed to the run that revises an item you delivered, to a run you propose here, and, while a run of yours works on this subject, to that run at its next step: what was agreed here is not lost. So never ask the owner to copy or repeat what was agreed into a task or a note. The task of a proposed run is still a self-contained recap of what was agreed.",
  ].join("\n");
}

/** What became of the run an earlier answer proposed, for the context of the next question. */
function proposalNote(proposal: ProposalDto): string {
  const task =
    proposal.task.length > QUESTION_CONTEXT_PROPOSAL_CHARS
      ? `${proposal.task.slice(0, QUESTION_CONTEXT_PROPOSAL_CHARS)}... [cut]`
      : proposal.task;
  if (proposal.reviseId !== null) {
    const fate =
      proposal.state === "launched"
        ? `The owner confirmed it: item #${proposal.reviseId} went back to you for a revision.`
        : proposal.state === "dismissed"
          ? "The owner set it aside, to talk about it first."
          : "The owner has not decided yet.";
    return `[You proposed to revise item #${proposal.reviseId}: "${task}". ${fate}]`;
  }
  const fate =
    proposal.state === "queued"
      ? "The owner confirmed it: it starts once you are free."
      : proposal.state === "launched"
      ? `The owner started it (run #${proposal.runId ?? "?"}).`
      : proposal.state === "dismissed"
        ? "The owner set it aside, to talk about it first."
        : "The owner has not decided yet.";
  return `[You proposed a run: "${task}". ${fate}]`;
}

/**
 * The agent's run state, read from the database when the question is asked:
 * above its memory, which may say a run ended when the lock says it runs.
 * `subject` is the subject of the question (null: the general one): a run on
 * it hears this exchange at its next step, a run on another one does not.
 */
function runStateText(run: ActiveRun | null, checkedAt: string, subject: number | null): string {
  const heading = `Your run state, read from the MyHQ database at ${checkedAt}: this is the source of truth, above your memory, your notes and the discussion so far.`;
  if (!run) return `${heading}\nYou have no run in progress.`;
  const task =
    run.task.length > QUESTION_CONTEXT_RUN_TASK_CHARS ? `${run.task.slice(0, QUESTION_CONTEXT_RUN_TASK_CHARS)}... [cut]` : run.task;
  const lines = [
    heading,
    `You have run #${run.id} in progress, started at ${run.startedAt} (${run.reason ? `reason: ${run.reason}` : "started by hand or by a routine"}).`,
    `Its task: "${task}"`,
  ];
  if (run.statuses.length > 0) {
    lines.push("What you said last in this run (hq_status), oldest first:");
    for (const status of run.statuses) lines.push(`- ${status.at}: ${status.text}`);
  } else {
    lines.push("You have said nothing yet in this run (no hq_status).");
  }
  lines.push(
    `This run is still going: never say you have no run in progress or that run #${run.id} ended. When the owner asks where you stand, say it runs and what it is doing or waiting for, as far as the lines above show, without inventing more.`,
  );
  if (run.subjectId === subject) {
    lines.push(
      `Run #${run.id} works on this very subject: what the owner says here now, and your answer, reach that run at its next step. So answer as the same agent at work, in one or two sentences, what will happen (for example "seen, it reaches my bench at the next step", or "good catch, I change it now"), and settle with the owner what is unclear. Do not propose a run nor a revision (no ${RUN_PROPOSAL_TAG} or ${REVISION_PROPOSAL_TAG} block) for something that amends the work in progress: the run hears it. A separate piece of work may still be proposed: it waits for the end of run #${run.id}.`,
    );
  } else {
    const where =
      run.subjectId === null
        ? "your general discussion"
        : run.subjectTitle
          ? `your subject "${run.subjectTitle}"`
          : `your subject #${run.subjectId}`;
    lines.push(
      `Run #${run.id} works on another subject, ${where}: what the owner says here does not reach it. You are busy on that subject, say so plainly. A run or a revision proposed here waits for its turn: it starts once run #${run.id} ends.`,
    );
  }
  return lines.join("\n");
}

/** The user message of a question: who the agent is, the discussion so far, the question, its run state, its memory and the date. */
export function buildQuestionPrompt(params: {
  room: Room;
  agent: Agent;
  question: string;
  /** The earlier answered exchanges of the discussion, oldest first, with the run an answer proposed. */
  previous: readonly { question: string; answer: string; proposal?: ProposalDto | null }[];
  /** The agent's run in progress (null: none); undefined: not given. */
  run?: ActiveRun | null;
  /** When the run state was read. */
  checkedAt?: string;
  /** The subject the question is asked in (subjects.ts); null or left out: the general one. */
  subject?: { id: number; title: string | null } | null;
  /** The agent's other open subjects; left out: none. */
  subjects?: readonly SubjectContext[];
  /** The deliverable items of this subject, newest first: what a revision may name; left out: not given. */
  items?: readonly { id: number; type: string; title: string; status: string }[];
  memory: string;
  today: string;
}): string {
  const lines = [
    `You are ${params.agent.name} (agent "${params.agent.id}") in room "${params.room.name}" of MyHQ. The owner asks you a question: this is not a run.`,
  ];
  const others = params.subjects ?? [];
  if (params.subject) {
    lines.push(
      `This discussion is your subject ${params.subject.title ? `"${params.subject.title}"` : "(no title yet)"} with the owner: one of the topics you have going with them, each in its own tab, with its own exchanges, runs and items.`,
    );
  } else if (others.length > 0) {
    lines.push("This discussion is your general one with the owner; your other subjects with them are listed below.");
  }
  if (params.previous.length > 0) {
    lines.push("", "The discussion so far:");
    for (const exchange of params.previous) {
      const answer =
        exchange.answer.length > QUESTION_CONTEXT_ANSWER_CHARS
          ? `${exchange.answer.slice(0, QUESTION_CONTEXT_ANSWER_CHARS)}... [cut]`
          : exchange.answer;
      lines.push("", `Owner: ${exchange.question}`, `You: ${answer}`);
      if (exchange.proposal) lines.push(proposalNote(exchange.proposal));
    }
  }
  lines.push("", "The owner's question:", params.question);
  if (params.run !== undefined) lines.push("", runStateText(params.run, params.checkedAt ?? now(), params.subject?.id ?? null));
  if (params.items) {
    if (params.items.length === 0) {
      lines.push("", "You have delivered no item in this subject yet: there is nothing to revise here.");
    } else {
      lines.push("", "The items you delivered in this subject, newest first (a revision names one of them):");
      for (const item of params.items) lines.push(`- #${item.id} "${item.title}" (${item.type}, ${item.status})`);
    }
  }
  if (others.length > 0) {
    lines.push("", "Your other open subjects with the owner, each a discussion of its own:");
    for (const other of others) {
      const title = other.title ? `"${other.title}"` : "(no title yet)";
      const work = other.working ? "a run of yours is going on it" : "no run on it";
      const item = other.lastItem ? `its latest item: #${other.lastItem.id} "${other.lastItem.title}" (${other.lastItem.status})` : "no item yet";
      lines.push(`- ${title} (subject #${other.id}): ${work}; ${item}.`);
    }
    lines.push(
      "When the owner's message clearly belongs to one of these other subjects, say so in one sentence (name that subject, so the owner can write there), then answer anyway.",
    );
  }
  lines.push("", params.memory, "", params.today);
  return lines.join("\n");
}

function homeLanguage(home: string): string {
  try {
    return readHomeLanguage(home);
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

/**
 * Asks an agent a question in one of its subjects (`subject`, null or left
 * out: the general one): records it (`running`) and lets the agent answer in
 * the background. Refused while the app stops, and while the agent answers
 * another one in the same subject (QUESTION_BUSY): one at a time per subject.
 * A message in an archived subject opens it again, and the first message in a
 * subject without a title gives it one. A run of the agent in progress does
 * not refuse it: the agent is told about that run, which hears the exchange
 * at its next step when it works on the same subject; a run the answer
 * proposes meanwhile waits for the agent to be free once confirmed
 * (decideProposal). Returns the question as recorded.
 */
export function askAgent(
  request: { room: string; agent: string; question: string; subject?: number | null },
  deps: QuestionDeps = {},
): QuestionRow {
  const config = deps.config ?? getConfig();
  const { room, agent } = findAgent(config, request.room, request.agent);
  const parsed = askSchema.parse({ question: request.question, subject: request.subject });
  const question = parsed.question;
  const subject = parsed.subject ?? null;
  if (isStopping()) {
    throw new HqError("SHUTTING_DOWN", 503, `MyHQ is stopping: ask "${agent.id}" again after the restart.`);
  }
  const db = getDbAt(config.dbPath);
  const engine = deps.engine ?? new ClaudeEngine(config.claudeBin);
  const { row, previous } = db
    .transaction(() => {
      if (subject !== null) {
        const found = readSubject(db, room.name, agent.id, subject);
        reopenSubject(db, found.id);
        if (found.title === null) db.prepare("UPDATE subjects SET title = ? WHERE id = ?").run(subjectTitleFrom(question), found.id);
      }
      const busy = runningQuestion(db, room.name, agent.id, subject);
      if (busy) throw busyError(agent.id, busy.id);
      const answered = (
        db
          .prepare(
            `${QUESTION_SELECT}
             WHERE q.room = ? AND q.agent_id = ? AND q.subject_id IS ? AND q.cleared_at IS NULL AND q.status = 'done'
               AND q.answer IS NOT NULL
             ORDER BY q.id DESC LIMIT ?`,
          )
          .all(room.name, agent.id, subject, QUESTION_CONTEXT_EXCHANGES) as QuestionRow[]
      ).map((each) => ({ question: each.question, answer: each.answer ?? "", proposal: toQuestion(each).proposal }));
      const id = Number(
        db
          .prepare(
            `INSERT INTO agent_questions (room, agent_id, question, status, engine, model, started_at, subject_id)
             VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`,
          )
          .run(room.name, agent.id, question, engine.name, agent.model, now(), subject).lastInsertRowid,
      );
      return {
        row: db.prepare("SELECT * FROM agent_questions WHERE id = ?").get(id) as QuestionRow,
        previous: answered.reverse(),
      };
    })
    .immediate();

  const state = questionsState();
  installExitHook(state);
  const timeoutMs = deps.timeoutMs ?? QUESTION_TIMEOUT_MS;
  const execution = answerQuestion({ config, db, engine, room, agent, row, previous, timeoutMs }).catch((error: unknown) =>
    console.error(`[questions] question #${row.id} crashed`, error),
  );
  state.executing.add(execution);
  void execution.finally(() => state.executing.delete(execution));
  return row;
}

/** A process that exits kills the `claude -p` of its questions; their rows are closed at the next start. */
function installExitHook(state: QuestionsState): void {
  if (state.exitHook) return;
  state.exitHook = true;
  process.on("exit", () => {
    for (const controller of state.active.values()) controller.abort();
  });
}

/** The full text of the CLI's result line (the engine's summary is cut), when the line is one. */
function resultText(line: string): string | null {
  try {
    const message = JSON.parse(line) as { type?: unknown; result?: unknown };
    return message.type === "result" && typeof message.result === "string" ? message.result : null;
  } catch {
    return null;
  }
}

async function answerQuestion(p: {
  config: HqConfig;
  db: Db;
  engine: Engine;
  room: Room;
  agent: Agent;
  row: QuestionRow;
  previous: { question: string; answer: string; proposal: ProposalDto | null }[];
  timeoutMs: number;
}): Promise<void> {
  const { config, db, engine, room, agent, row } = p;
  const state = questionsState();
  const controller = new AbortController();
  state.active.set(row.id, controller);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, p.timeoutMs);

  const dir = path.join(config.runsDir, "questions");
  const systemFile = path.join(dir, `${row.id}.system.md`);
  const mcpConfigPath = path.join(dir, `${row.id}.mcp.json`);
  let end: Extract<RunEvent, { type: "end" }> | null = null;
  /** The untruncated answer, read from the raw lines; the model the CLI reports. */
  const seen: { answer: string | null; model: string | null } = { answer: null, model: null };
  const tools: string[] = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
    const language = languageName(homeLanguage(config.home));
    const web = questionWebTools(agent.allowedTools);
    fs.writeFileSync(
      systemFile,
      `${fs.readFileSync(agent.rolePath, "utf8").trimEnd()}\n\n${questionSystemText(language, web.length > 0)}\n`,
    );
    // The HQ server alone, in read-only mode: never the agent's own servers.
    writeMcpConfig({
      file: mcpConfigPath,
      repoRoot: config.repoRoot,
      hqEnv: { HQ_DB_PATH: config.dbPath, HQ_AGENT_ID: agent.id, HQ_ROOM: room.name, HQ_READ_ONLY: "1" },
      extraServers: {},
    });
    const memory = memoryText(readMemories(db, room.name, agent.id), {
      empty: "Your memory: empty.",
      heading: "Your memory, kept between runs (read only here):",
    });
    const subject = row.subject_id;
    const prompt = buildQuestionPrompt({
      room,
      agent,
      question: row.question,
      previous: p.previous,
      run: activeRunOf(db, room.name, agent.id),
      checkedAt: now(),
      subject: subject === null ? null : readSubject(db, room.name, agent.id, subject),
      subjects: otherSubjects(db, room.name, agent.id, subject),
      items: subjectItems(db, room.name, agent.id, subject),
      memory,
      today: todayLine(new Date(), liveConfig(config).timeZone, homeLanguage(config.home)),
    });
    // The working directory is read, never created here: an agent that never ran answers from a scratch folder.
    const workDir = fs.existsSync(agent.workDir) ? agent.workDir : path.join(dir, "scratch");
    fs.mkdirSync(workDir, { recursive: true });
    const input: RunInput = {
      runId: row.id,
      room: room.name,
      agentId: agent.id,
      prompt,
      model: agent.model,
      ...(agent.effort ? { effort: agent.effort } : {}),
      ...(agent.cacheTtl ? { cacheTtl: agent.cacheTtl } : {}),
      rolePath: systemFile,
      allowedTools: [...QUESTION_TOOLS, ...web, ...QUESTION_HQ_TOOLS],
      disallowedTools: QUESTION_DENIED_TOOLS.filter((tool) => !web.includes(tool)),
      tools: [...QUESTION_TOOLS, ...web],
      addDirs: agent.addDirs,
      mcpConfigPath,
      maxBudgetUsd: Math.min(QUESTION_MAX_BUDGET_USD, agent.maxBudgetUsd ?? config.defaultMaxBudgetUsd),
      workDir,
      env: agentEnv(process.env, {}),
      signal: controller.signal,
      onRawLine: (line) => {
        fs.appendFileSync(path.join(dir, `${row.id}.jsonl`), `${line}\n`);
        seen.answer = resultText(line) ?? seen.answer;
      },
    };
    for await (const event of engine.run(input)) {
      // The CLI has read the file once it says it started: it leaves the disk.
      if (event.type === "start") {
        removeMcpConfig(mcpConfigPath);
        seen.model = event.model;
      }
      if (event.type === "tool_call") tools.push(event.name);
      if (event.type === "end") end = event;
    }
  } catch (error) {
    end = {
      type: "end",
      status: "failed",
      reason: "engine_error",
      summary: error instanceof Error ? error.message : String(error),
      usage: { ...ZERO_USAGE },
      costUsd: 0,
    };
  } finally {
    clearTimeout(timer);
    state.active.delete(row.id);
    removeMcpConfig(mcpConfigPath);
    fs.rmSync(systemFile, { force: true });
  }

  const usage: Usage = end?.usage ?? ZERO_USAGE;
  const done = !timedOut && end?.status === "done";
  const error: QuestionError | null = done
    ? null
    : timedOut
      ? "timeout"
      : end?.reason === "error_max_budget_usd"
        ? "budget"
        : "error";
  const detail = done
    ? null
    : timedOut
      ? `No answer after ${Math.round(p.timeoutMs / 1000)} s: the question was stopped.`
      : (end?.summary ?? "The engine ended without a result.");
  // A request for work comes back as a proposal: its task is kept apart, the owner starts it or not.
  const parsed = done ? parseRunProposal(seen.answer ?? end?.summary ?? "") : null;
  const answer = parsed ? parsed.text.slice(0, ANSWER_MAX_CHARS) : null;
  const closed = db.prepare(
    `UPDATE agent_questions SET status = ?, answer = ?, model = COALESCE(?, model), error = ?, detail = ?, input_tokens = ?, output_tokens = ?,
       cache_creation_input_tokens = ?, cache_read_input_tokens = ?, cost_usd = ?, tool_calls = ?, tools = ?, ended_at = ?
     WHERE id = ? AND status = 'running'`,
  ).run(
    done ? "done" : "failed",
    answer,
    seen.model,
    error,
    detail,
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheCreationInputTokens,
    usage.cacheReadInputTokens,
    end?.costUsd ?? 0,
    tools.length,
    JSON.stringify(tools),
    now(),
    row.id,
  ).changes;
  // Recorded once the answer is: a question closed meanwhile (the app stopped) proposes nothing.
  // One answered while the agent has a run in progress is kept: confirmed, it waits for the agent to be free.
  // A revision is kept when it names an item it may revise.
  const revise = parsed?.revise;
  const proposes = revise !== undefined ? revisable(db, row, revise) : true;
  if (closed > 0 && parsed?.task && proposes) {
    db.prepare(
      "INSERT OR IGNORE INTO question_proposals (question_id, task, state, created_at, revise_id) VALUES (?, ?, 'pending', ?, ?)",
    ).run(row.id, parsed.task, now(), revise ?? null);
  }
}

/**
 * Whether a revision proposed in answer to `question` may name this item: a
 * deliverable of the same agent and the same subject (subjectItems: no item
 * of questions, no informational one), pending or already decided. Any other
 * number proposes nothing: the answer stays a plain answer.
 */
function revisable(db: Db, question: QuestionRow, itemId: number): boolean {
  const item = db
    .prepare("SELECT room, agent_id, subject_id, type, status FROM approvals WHERE id = ?")
    .get(itemId) as { room: string; agent_id: string; subject_id: number | null; type: string; status: string } | undefined;
  return (
    item !== undefined &&
    item.room === question.room &&
    item.agent_id === question.agent_id &&
    item.subject_id === question.subject_id &&
    item.type !== QUESTION_TYPE &&
    item.status !== "unseen" &&
    item.status !== "seen"
  );
}

/** Keeps a confirmed run the agent cannot start now as a pending task of its subject, for the wake-ups (decideProposal). */
function queueProposal(db: Db, p: { room: string; agentId: string; question: QuestionRow; task: string }): void {
  db.transaction(() => {
    const at = now();
    const taskId = Number(
      db
        .prepare(
          `INSERT INTO tasks (room, agent_id, source, ref_id, text, status, subject_id, created_at, updated_at)
           VALUES (?, ?, 'chat', ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(p.room, p.agentId, p.question.id, p.task, p.question.subject_id, at, at).lastInsertRowid,
    );
    db.prepare(
      "UPDATE question_proposals SET state = 'launched', task_id = ?, decided_at = ? WHERE question_id = ? AND state = 'pending'",
    ).run(taskId, at, p.question.id);
  }).immediate();
}

/** A question of this agent with the run its answer proposes, or undefined. */
function readQuestion(db: Db, room: string, agentId: string, id: number): QuestionRow | undefined {
  return db.prepare(`${QUESTION_SELECT} WHERE q.id = ? AND q.room = ? AND q.agent_id = ?`).get(id, room, agentId) as
    | QuestionRow
    | undefined;
}

/**
 * What the owner does with the run an answer proposes: « Lancer le tour »
 * (`launch`) starts it through `startRun`, as the desk's « Lancer un tour »
 * does, with the agent's task. When the agent cannot start now (its lock, a
 * shared resource, the daily cap: WAITS), the run is kept as a pending task
 * of source `chat` of the question's subject, whose ref_id is the question
 * (the run that takes it gets the discussion up to it, discussion-handoff.ts),
 * and the wake-ups start it once the agent is free (wakeAgents): the proposal
 * shows `queued` until then;
 * « On en parle d'abord » (`dismiss`) sets it aside. This is the only way a
 * proposed run starts: an answer never starts one by itself. A proposal is
 * decided once (PROPOSAL_DECIDED). The run carries the subject the question
 * was asked in (subjects.ts).
 *
 * A proposed revision (`reviseId`) is confirmed the same way, and is then the
 * « revise » decision on that item with the agent's note (decideApproval, its
 * checks and its wake-up, as the desk's button), instead of a run started by
 * hand: the revision run, when the agent is woken at once, is the one returned.
 */
export function decideProposal(
  request: { room: string; agent: string; questionId: number; action: ProposalAction },
  deps: RunnerDeps = {},
): { question: QuestionRow; run: RunRow | null } {
  const config = deps.config ?? getConfig();
  const { room, agent } = findAgent(config, request.room, request.agent);
  const db = getDbAt(config.dbPath);
  const question = readQuestion(db, room.name, agent.id, request.questionId);
  if (!question) {
    throw new HqError("QUESTION_NOT_FOUND", 404, `No question #${request.questionId} to agent "${agent.id}" of room "${room.name}".`);
  }
  const proposal = toQuestion(question).proposal;
  if (!proposal) throw new HqError("PROPOSAL_NOT_FOUND", 404, `The answer to question #${question.id} proposes no run.`);
  if (proposal.state !== "pending") {
    throw new HqError("PROPOSAL_DECIDED", 409, `The run proposed by question #${question.id} was already ${proposal.state}.`);
  }
  // Everything below is synchronous: no other request of this process decides it in between.
  let run: RunRow | null = null;
  if (request.action === "launch" && proposal.reviseId !== null) {
    decideApproval(db, proposal.reviseId, decisionSchema.parse({ decision: "revise", note: proposal.task }), config, deps);
    run =
      (db
        .prepare(
          `SELECT r.* FROM tasks t JOIN runs r ON r.id = t.run_id
           WHERE t.source = 'revise' AND t.ref_id = ? AND t.status = 'in_progress' ORDER BY t.id DESC LIMIT 1`,
        )
        .get(proposal.reviseId) as RunRow | undefined) ?? null;
    db.prepare("UPDATE question_proposals SET state = 'launched', run_id = ?, decided_at = ? WHERE question_id = ? AND state = 'pending'").run(
      run?.id ?? null,
      now(),
      question.id,
    );
  } else if (request.action === "launch") {
    try {
      run = startRun(
        { room: room.name, agent: agent.id, task: proposal.task },
        { ...deps, config, discussionUpTo: question.id, subject: question.subject_id },
      );
    } catch (error) {
      if (!(error instanceof HqError && WAITS.has(error.code))) throw error;
    }
    if (run) {
      db.prepare("UPDATE question_proposals SET state = 'launched', run_id = ?, decided_at = ? WHERE question_id = ? AND state = 'pending'").run(
        run.id,
        now(),
        question.id,
      );
    } else {
      queueProposal(db, { room: room.name, agentId: agent.id, question, task: proposal.task });
    }
  } else {
    db.prepare("UPDATE question_proposals SET state = 'dismissed', decided_at = ? WHERE question_id = ? AND state = 'pending'").run(
      now(),
      question.id,
    );
  }
  return { question: readQuestion(db, room.name, agent.id, question.id)!, run };
}
