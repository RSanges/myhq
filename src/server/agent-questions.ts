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
import type { Agent, Room } from "./rooms";
import { parseRunProposal, RUN_PROPOSAL_TAG } from "./run-proposal";
import { agentEnv, findAgent, isStopping, startRun, todayLine, type RunnerDeps } from "./runner";

// Questions of the owner to an agent (docs/architecture.md, "Questions to an
// agent"). The agent answers with its own role, memory, model and effort, in
// its own working directory, through the same `claude -p` as a run, but with
// read tools only: Read, Glob, Grep and the HQ server in read-only mode
// (hq_memory_read, hq_items). It is not a run: nothing in `runs`, no agent
// lock, no daily cap, no wake-up. Each question is metered in
// `agent_questions` (migration 19), and its cost counts in the day and the
// week of the whiteboard (usage.ts). A message that asks for work gets an
// answer that proposes a run (run-proposal.ts, `question_proposals`, migration
// 20): that run starts only when the owner confirms it (`decideProposal`).

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
 * Denied on top of the global deny list, whatever the project settings of the
 * working directory allow: every built-in tool that writes, runs or fetches,
 * and every HQ tool that writes (the server does not even give them).
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
  "mcp__hq__hq_task_update",
  "mcp__hq__hq_read_decisions",
  "mcp__hq__hq_memory_write",
  "mcp__hq__hq_suggest_agent",
  "mcp__hq__hq_relaunch",
  "mcp__hq__hq_blocked_note",
  "mcp__hq__hq_run_extend",
  "mcp__hq__hq_run_stop",
] as const;

/** How much of a proposed task the agent reads again in the context of the next questions. */
export const QUESTION_CONTEXT_PROPOSAL_CHARS = 500;

export const askSchema = z.strictObject({
  question: z.string().trim().min(1).max(QUESTION_MAX_CHARS),
});

export const QUESTION_STATUSES = ["running", "done", "failed"] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

/** Why a question has no answer: its delay, its budget, the engine, or the app stopped during it. */
export type QuestionError = "timeout" | "budget" | "error" | "interrupted";

/** A run proposed by an answer: waiting for the owner, started by « Lancer le tour », or set aside by « On en parle d'abord ». */
export const PROPOSAL_STATES = ["pending", "launched", "dismissed"] as const;
export type ProposalState = (typeof PROPOSAL_STATES)[number];

export const proposalActionSchema = z.strictObject({ action: z.enum(["launch", "dismiss"]) });
export type ProposalAction = z.infer<typeof proposalActionSchema>["action"];

/** The run an answer proposes (`question_proposals`, migration 20). */
export type ProposalDto = { task: string; state: ProposalState; runId: number | null; decidedAt: string | null };

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
  /** The run its answer proposes, joined from `question_proposals` (QUESTION_SELECT); absent or null: none. */
  proposal_task?: string | null;
  proposal_state?: ProposalState | null;
  proposal_run_id?: number | null;
  proposal_decided_at?: string | null;
};

/** Selects questions as `q` with the run their answer proposes; append a WHERE clause. */
const QUESTION_SELECT = `SELECT q.*, p.task AS proposal_task, p.state AS proposal_state, p.run_id AS proposal_run_id,
  p.decided_at AS proposal_decided_at FROM agent_questions q LEFT JOIN question_proposals p ON p.question_id = q.id`;

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
            state: row.proposal_state,
            runId: row.proposal_run_id ?? null,
            decidedAt: row.proposal_decided_at ?? null,
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

/** The question of this agent in progress, if any. */
function runningQuestion(db: Db, room: string, agentId: string): QuestionRow | undefined {
  return db
    .prepare("SELECT * FROM agent_questions WHERE room = ? AND agent_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1")
    .get(room, agentId) as QuestionRow | undefined;
}

/** The current discussion with an agent (since its last reset), oldest first, the latest DISCUSSION_LIMIT. */
export function readDiscussion(db: Db, room: string, agentId: string): QuestionRow[] {
  const rows = db
    .prepare(`${QUESTION_SELECT} WHERE q.room = ? AND q.agent_id = ? AND q.cleared_at IS NULL ORDER BY q.id DESC LIMIT ?`)
    .all(room, agentId, DISCUSSION_LIMIT) as QuestionRow[];
  return rows.reverse();
}

/**
 * A new discussion: the questions of the current one leave the sheet (and
 * the context given to the agent), their rows stay for the meter. Refused
 * while a question is in progress. Returns how many questions were cleared.
 */
export function resetDiscussion(db: Db, room: string, agentId: string): number {
  return db
    .transaction(() => {
      const busy = runningQuestion(db, room, agentId);
      if (busy) throw busyError(agentId, busy.id);
      return db
        .prepare("UPDATE agent_questions SET cleared_at = ? WHERE room = ? AND agent_id = ? AND cleared_at IS NULL")
        .run(now(), room, agentId).changes;
    })
    .immediate();
}

function busyError(agentId: string, questionId: number): HqError {
  return new HqError(
    "QUESTION_BUSY",
    409,
    `Agent "${agentId}" is already answering a question (#${questionId}): one question at a time per agent.`,
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
export function questionSystemText(language: string): string {
  return [
    "## Question mode",
    "",
    "The owner of MyHQ is asking you a question. This is not a task and not a run: answer it, and nothing else.",
    `Answer in ${language}, short and concrete, from what you know (your role, your memory, the discussion below) and from what you can read in your working directory and its folders (Read, Glob, Grep; hq_memory_read and hq_items for your memory and the items).`,
    "You do nothing, deliver nothing, change nothing: you write no file, submit nothing, send no message. The instructions of your role about reporting, submitting or writing do not apply here.",
    "If you do not know, say so: never invent.",
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
  ].join("\n");
}

/** What became of the run an earlier answer proposed, for the context of the next question. */
function proposalNote(proposal: ProposalDto): string {
  const task =
    proposal.task.length > QUESTION_CONTEXT_PROPOSAL_CHARS
      ? `${proposal.task.slice(0, QUESTION_CONTEXT_PROPOSAL_CHARS)}... [cut]`
      : proposal.task;
  const fate =
    proposal.state === "launched"
      ? `The owner started it (run #${proposal.runId ?? "?"}).`
      : proposal.state === "dismissed"
        ? "The owner set it aside, to talk about it first."
        : "The owner has not decided yet.";
  return `[You proposed a run: "${task}". ${fate}]`;
}

/** The user message of a question: who the agent is, the discussion so far, the question, its memory and the date. */
export function buildQuestionPrompt(params: {
  room: Room;
  agent: Agent;
  question: string;
  /** The earlier answered exchanges of the discussion, oldest first, with the run an answer proposed. */
  previous: readonly { question: string; answer: string; proposal?: ProposalDto | null }[];
  memory: string;
  today: string;
}): string {
  const lines = [
    `You are ${params.agent.name} (agent "${params.agent.id}") in room "${params.room.name}" of MyHQ. The owner asks you a question: this is not a run.`,
  ];
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
  lines.push("", "The owner's question:", params.question, "", params.memory, "", params.today);
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
 * Asks an agent a question: records it (`running`) and lets the agent answer
 * in the background. Refused while the app stops, and while the agent answers
 * another one (QUESTION_BUSY): one at a time per agent. A run of the agent in
 * progress does not matter. Returns the question as recorded.
 */
export function askAgent(request: { room: string; agent: string; question: string }, deps: QuestionDeps = {}): QuestionRow {
  const config = deps.config ?? getConfig();
  const { room, agent } = findAgent(config, request.room, request.agent);
  const question = askSchema.parse({ question: request.question }).question;
  if (isStopping()) {
    throw new HqError("SHUTTING_DOWN", 503, `MyHQ is stopping: ask "${agent.id}" again after the restart.`);
  }
  const db = getDbAt(config.dbPath);
  const engine = deps.engine ?? new ClaudeEngine(config.claudeBin);
  const { row, previous } = db
    .transaction(() => {
      const busy = runningQuestion(db, room.name, agent.id);
      if (busy) throw busyError(agent.id, busy.id);
      const answered = (
        db
          .prepare(
            `${QUESTION_SELECT}
             WHERE q.room = ? AND q.agent_id = ? AND q.cleared_at IS NULL AND q.status = 'done' AND q.answer IS NOT NULL
             ORDER BY q.id DESC LIMIT ?`,
          )
          .all(room.name, agent.id, QUESTION_CONTEXT_EXCHANGES) as QuestionRow[]
      ).map((each) => ({ question: each.question, answer: each.answer ?? "", proposal: toQuestion(each).proposal }));
      const id = Number(
        db
          .prepare(
            "INSERT INTO agent_questions (room, agent_id, question, status, engine, model, started_at) VALUES (?, ?, ?, 'running', ?, ?, ?)",
          )
          .run(room.name, agent.id, question, engine.name, agent.model, now()).lastInsertRowid,
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
    fs.writeFileSync(systemFile, `${fs.readFileSync(agent.rolePath, "utf8").trimEnd()}\n\n${questionSystemText(language)}\n`);
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
    const prompt = buildQuestionPrompt({
      room,
      agent,
      question: row.question,
      previous: p.previous,
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
      allowedTools: [...QUESTION_TOOLS, ...QUESTION_HQ_TOOLS],
      disallowedTools: [...QUESTION_DENIED_TOOLS],
      tools: [...QUESTION_TOOLS],
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
  if (closed > 0 && parsed?.task) {
    db.prepare("INSERT OR IGNORE INTO question_proposals (question_id, task, state, created_at) VALUES (?, ?, 'pending', ?)").run(
      row.id,
      parsed.task,
      now(),
    );
  }
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
 * does (the agent lock, the shared resources and the daily cap refuse it the
 * same way, and the proposal then stays pending), with the agent's task;
 * « On en parle d'abord » (`dismiss`) sets it aside. This is the only way a
 * proposed run starts: an answer never starts one by itself. A proposal is
 * decided once (PROPOSAL_DECIDED).
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
  if (request.action === "launch") {
    run = startRun({ room: room.name, agent: agent.id, task: proposal.task }, { ...deps, config });
    db.prepare("UPDATE question_proposals SET state = 'launched', run_id = ?, decided_at = ? WHERE question_id = ? AND state = 'pending'").run(
      run.id,
      now(),
      question.id,
    );
  } else {
    db.prepare("UPDATE question_proposals SET state = 'dismissed', decided_at = ? WHERE question_id = ? AND state = 'pending'").run(
      now(),
      question.id,
    );
  }
  return { question: readQuestion(db, room.name, agent.id, question.id)!, run };
}
