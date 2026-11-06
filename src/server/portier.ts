import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { strings } from "../ui/strings";
import type { Env, HqConfig } from "./config";
import { now, type Db, type TaskRow } from "./db";
import { DEFAULT_LANGUAGE, DEFAULT_PORTIER, readHomeSettings, readPortierSetting, type PortierSetting } from "./home-settings";
import type { Agent } from "./rooms";

// The portier: before MyHQ wakes an agent for a message of another agent
// (reason `message`), a small model reads the message and says whether it is
// worth a wake, or can wait in the mailbox for the agent's next run. An
// acknowledgement ("received", "still waiting for the clips") no longer costs
// a turn of the recipient. One `claude -p` call, no tools, no MCP server,
// a minimal system prompt, low effort. The sender can decide instead of it
// (hq_message `expects`), a question mark wakes directly, and any failure of
// the call wakes the agent (fail open). Every call is stored with its cost
// (`portier_verdicts`, migration 18) and the latest ones are shown on
// /reglages. This module imports nothing that reads the runner: the runner
// calls it. See docs/architecture.md, "The portier".

/** What the sender of a message expects (hq_message `expects`). */
export const MESSAGE_EXPECTS = ["reply", "action", "none"] as const;
export type MessageExpects = (typeof MESSAGE_EXPECTS)[number];

export type Verdict = "wake" | "skip";

/** One portier call may not last longer than this: past it, the agent is woken (fail open). */
export const PORTIER_TIMEOUT_MS = 60_000;
/** The cap of one portier call (`--max-budget-usd`): far above what a verdict costs. */
export const PORTIER_MAX_BUDGET_USD = 0.05;
/** The most characters of one message, and of the role summary, given to the portier. */
const MESSAGE_MAX = 2_000;
const ROLE_MAX = 600;
/** The most messages given in one call; the others are judged by the next one. */
const BATCH_MAX = 10;

/** The input of one call of the portier model. */
export type PortierCallInput = {
  claudeBin: string;
  model: string;
  system: string;
  prompt: string;
  env: Env;
  timeoutMs: number;
};

/** What a call gives back: the model's text, and what it cost. */
export type PortierAnswer = {
  text: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  durationMs: number;
};

/** The model call itself, replaced in the tests. Rejects on any failure. */
export type PortierCall = (input: PortierCallInput) => Promise<PortierAnswer>;

/** The single result object of `claude -p --output-format json`. */
const resultSchema = z.looseObject({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  total_cost_usd: z.number().optional(),
  duration_ms: z.number().optional(),
  usage: z
    .looseObject({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
    })
    .optional(),
});

/** The arguments of the portier's `claude -p`: no tool, no MCP server, no user settings, low effort. */
export function portierArgs(input: Pick<PortierCallInput, "model" | "system" | "prompt">): string[] {
  return [
    "-p",
    input.prompt,
    "--output-format",
    "json",
    "--model",
    input.model,
    "--system-prompt",
    input.system,
    "--tools",
    "",
    "--strict-mcp-config",
    "--setting-sources",
    "project,local",
    "--effort",
    "low",
    "--max-budget-usd",
    String(PORTIER_MAX_BUDGET_USD),
  ];
}

/**
 * The real call: `claude -p` in a scratch folder of the system's temporary
 * directory (no CLAUDE.md of the home is read), its JSON result parsed.
 */
export const claudePortierCall: PortierCall = (input) =>
  new Promise((resolve, reject) => {
    const cwd = path.join(os.tmpdir(), "myhq-portier");
    try {
      fs.mkdirSync(cwd, { recursive: true });
    } catch (error) {
      reject(error as Error);
      return;
    }
    const started = Date.now();
    const child = spawn(input.claudeBin, portierArgs(input), {
      cwd,
      env: input.env as unknown as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-2_000)));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`no answer after ${Math.round(input.timeoutMs / 1000)} s`));
    }, input.timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`could not start "${input.claudeBin}": ${error.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      let raw: unknown;
      try {
        raw = JSON.parse(stdout.trim());
      } catch {
        reject(new Error(`claude exited with code ${code} without a JSON result${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
        return;
      }
      const parsed = resultSchema.safeParse(raw);
      if (!parsed.success || parsed.data.is_error || parsed.data.subtype !== "success") {
        reject(new Error(`claude gave no answer (${parsed.success ? parsed.data.subtype : "unreadable result"})`));
        return;
      }
      const usage = parsed.data.usage ?? {};
      resolve({
        text: parsed.data.result ?? "",
        costUsd: parsed.data.total_cost_usd ?? 0,
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
        cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
        durationMs: parsed.data.duration_ms ?? Date.now() - started,
      });
    });
  });

/** The portier in force: the `portier` block of myhq.json, else the configuration's (on, on Haiku). */
export function portierSetting(config: HqConfig): PortierSetting {
  return readPortierSetting(config.home, config.portier ?? DEFAULT_PORTIER).setting;
}

/**
 * What decides a message without the model: `expects: "none"` never wakes,
 * `"reply"` and `"action"` wake, and without `expects` a question mark wakes.
 * Null: the portier decides.
 */
export function ruleFor(expects: MessageExpects | null, text: string): Verdict | null {
  if (expects === "none") return "skip";
  if (expects === "reply" || expects === "action") return "wake";
  if (/[?？]/.test(text)) return "wake";
  return null;
}

/** Records what the sender of a message task expects (hq_message `expects`). To call within its transaction. */
export function recordExpects(db: Db, taskId: number, expects: MessageExpects): void {
  db.prepare(
    `INSERT INTO message_wake (task_id, expects) VALUES (?, ?)
     ON CONFLICT (task_id) DO UPDATE SET expects = excluded.expects`,
  ).run(taskId, expects);
}

type MessageTask = { id: number; text: string; from_room: string | null; from_agent: string | null; expects: string | null; verdict: string | null };

const MESSAGE_TASK = `SELECT t.id, COALESCE(m.text, t.text) AS text, t.from_room, t.from_agent, w.expects, v.verdict
  FROM tasks t
  LEFT JOIN messages m ON m.id = t.ref_id
  LEFT JOIN message_wake w ON w.task_id = t.id
  LEFT JOIN portier_verdicts v ON v.id = w.verdict_id`;

const expectsOf = (value: string | null): MessageExpects | null =>
  (MESSAGE_EXPECTS as readonly string[]).includes(value ?? "") ? (value as MessageExpects) : null;

/**
 * Whether a pending message task waits for the agent's next run by design: its
 * sender said `expects: "none"`, or the portier said skip. The Standard does
 * not list it as stuck.
 */
export function waitsForNextRun(db: Db, taskId: number): boolean {
  const row = db.prepare(`${MESSAGE_TASK} WHERE t.id = ? AND t.source = 'message'`).get(taskId) as MessageTask | undefined;
  if (!row) return false;
  const rule = ruleFor(expectsOf(row.expects), row.text);
  return rule !== null ? rule === "skip" : row.verdict === "skip";
}

/** The judgements in progress, per database file and task, shared by every copy of this module in the process. */
const globalForPortier = globalThis as unknown as { __myhqPortier?: { inFlight: Set<string>; pending: Set<Promise<void>> } };
function portierState() {
  globalForPortier.__myhqPortier ??= { inFlight: new Set(), pending: new Set() };
  return globalForPortier.__myhqPortier;
}

/** Resolves once every judgement in progress is stored (the tests wait for it). */
export async function portierIdle(): Promise<void> {
  const state = portierState();
  while (state.pending.size > 0) await Promise.allSettled([...state.pending]);
}

/** The first paragraph of the role prompt that is not a heading, on one line: what the portier knows of the agent. */
export function roleSummary(rolePath: string): string {
  let text: string;
  try {
    text = fs.readFileSync(rolePath, "utf8");
  } catch {
    return "";
  }
  const paragraph =
    text
      .replace(/\r\n/g, "\n")
      .split(/\n\s*\n/)
      .map((block) => block.trim())
      .find((block) => block !== "" && !/^#/.test(block) && !/^---/.test(block)) ?? "";
  const line = paragraph.replace(/\s+/g, " ").trim();
  return line.length > ROLE_MAX ? `${line.slice(0, ROLE_MAX)}...` : line;
}

export const PORTIER_SYSTEM =
  "You are the portier of an office where AI agents work and write to each other. Before the office wakes an agent for messages from other agents, you read them and decide: wake, the agent must act on them now; or skip, they can wait in its mailbox for its next run. Waking costs a full turn of a large model. Answer with one line of JSON and nothing else.";

/** The prompt of one call: the recipient, its role in one paragraph, the messages, the rules. */
export function portierPrompt(p: {
  agentName: string;
  room: string;
  agentId: string;
  role: string;
  messages: { from: string; text: string }[];
  language: string;
}): string {
  const cut = (text: string) => {
    const line = text.trim();
    return line.length > MESSAGE_MAX ? `${line.slice(0, MESSAGE_MAX)}...` : line;
  };
  return [
    `Recipient: ${p.agentName} (${p.room}/${p.agentId}).`,
    p.role ? `Its role: ${p.role}` : "Its role is not known.",
    "",
    "Messages waiting for it, oldest first:",
    ...p.messages.map((message, index) => `${index + 1}. From ${message.from}: ${cut(message.text)}`),
    "",
    'skip: an acknowledgement ("received", "thanks", "ok"), a status that asks nothing ("still waiting for the clips"), a courtesy, information the agent only needs at its next run.',
    "wake: a request, an order, a question, a deliverable or an answer the agent is waiting for to go on, a decision, an error to fix, anything urgent.",
    "When in doubt, wake.",
    `Write the reason in the language of the tag "${p.language}", in at most 15 words.`,
    'Answer exactly: {"verdict":"wake","reason":"..."} or {"verdict":"skip","reason":"..."}',
  ].join("\n");
}

const answerSchema = z.object({ verdict: z.enum(["wake", "skip"]), reason: z.string().trim().max(500).default("") });

/** The verdict in the model's text: the JSON line it was asked for, else a leading wake or skip. Null when unreadable. */
export function parseVerdict(text: string): { verdict: Verdict; reason: string } | null {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  if (json) {
    try {
      const parsed = answerSchema.safeParse(JSON.parse(json));
      if (parsed.success) return parsed.data;
    } catch {
      // Not JSON: the plain word below.
    }
  }
  const word = /^\W*(wake|skip)\b[\s:.,-]*([\s\S]*)$/i.exec(text.trim());
  return word ? { verdict: word[1]!.toLowerCase() as Verdict, reason: (word[2] ?? "").trim().slice(0, 500) } : null;
}

export type GateParams = {
  config: HqConfig;
  db: Db;
  room: string;
  agent: Agent;
  /** The pending message task a wake-up looks at. */
  taskId: number;
  /** The environment of the call (the agents' safe one). */
  env: Env;
  /** The model call; default: the real `claude -p`. */
  call?: PortierCall;
  /** Called once a verdict is stored that wakes the agent: the wake-up again. */
  rewake: () => void;
};

/**
 * Whether a wake-up may wake the agent now for this pending message task.
 * True: the sender expects a reply or an action, the text asks a question,
 * the portier is off (myhq.json, or `portier: false` on the agent), or its
 * verdict on the message is wake (a failed call is a wake). False: the
 * sender expects nothing (`expects: "none"`), the verdict is skip (the
 * message waits for the agent's next run), or the portier is still reading
 * it: the call is started here, for every pending message of the agent it
 * has not read, and `rewake` runs once a wake verdict is stored. Never throws.
 */
export function messageGate(p: GateParams): boolean {
  try {
    const row = p.db.prepare(`${MESSAGE_TASK} WHERE t.id = ?`).get(p.taskId) as MessageTask | undefined;
    if (!row) return true;
    const rule = ruleFor(expectsOf(row.expects), row.text);
    if (rule !== null) return rule === "wake";
    const setting = portierSetting(p.config);
    if (!setting.enabled || p.agent.portier === false) return true;
    if (row.verdict !== null) return row.verdict === "wake";
    const state = portierState();
    const key = (id: number) => `${p.config.dbPath}#${id}`;
    if (state.inFlight.has(key(row.id))) return false;
    // Every message of the agent the portier has not read yet, in one call.
    const batch = (
      p.db
        .prepare(`${MESSAGE_TASK} WHERE t.room = ? AND t.agent_id = ? AND t.source = 'message' AND t.status = 'pending' AND v.id IS NULL ORDER BY t.id`)
        .all(p.room, p.agent.id) as MessageTask[]
    ).filter((task) => ruleFor(expectsOf(task.expects), task.text) === null && !state.inFlight.has(key(task.id)));
    const tasks = (batch.some((task) => task.id === row.id) ? batch : [row, ...batch]).slice(0, BATCH_MAX);
    for (const task of tasks) state.inFlight.add(key(task.id));
    const judging = judge(p, setting, tasks).finally(() => {
      for (const task of tasks) state.inFlight.delete(key(task.id));
      state.pending.delete(judging);
    });
    state.pending.add(judging);
    return false;
  } catch (error) {
    console.error(`[portier] the message task #${p.taskId} could not be read: it wakes its agent`, error);
    return true;
  }
}

/** One call: the verdict is stored with its cost, a wake verdict wakes the agent again. Fails open. Never rejects. */
async function judge(p: GateParams, setting: PortierSetting, tasks: readonly MessageTask[]): Promise<void> {
  const started = Date.now();
  let language = DEFAULT_LANGUAGE;
  try {
    language = readHomeSettings(p.config.home)?.language ?? DEFAULT_LANGUAGE;
  } catch {
    // An invalid myhq.json: the default language.
  }
  const prompt = portierPrompt({
    agentName: p.agent.name,
    room: p.room,
    agentId: p.agent.id,
    role: roleSummary(p.agent.rolePath),
    messages: tasks.map((task) => ({
      from: task.from_agent ? `${task.from_agent}${task.from_room && task.from_room !== p.room ? ` (room ${task.from_room})` : ""}` : "an agent",
      text: task.text,
    })),
    language,
  });
  let verdict: Verdict = "wake";
  let reason = "";
  let error: string | null = null;
  let answer: PortierAnswer | null = null;
  try {
    answer = await (p.call ?? claudePortierCall)({
      claudeBin: p.config.claudeBin,
      model: setting.model,
      system: PORTIER_SYSTEM,
      prompt,
      env: p.env,
      timeoutMs: PORTIER_TIMEOUT_MS,
    });
    const parsed = parseVerdict(answer.text);
    if (parsed) ({ verdict, reason } = parsed);
    else error = `unreadable answer: ${answer.text.replace(/\s+/g, " ").trim().slice(0, 200)}`;
  } catch (failure) {
    error = (failure as Error).message ?? String(failure);
  }
  if (error !== null) {
    verdict = "wake";
    reason = strings.settings.portier.failedOpen;
    console.error(`[portier] ${p.room}/${p.agent.id}: ${error}: the agent is woken`);
  }
  try {
    p.db
      .transaction(() => {
        const id = Number(
          p.db
            .prepare(
              `INSERT INTO portier_verdicts (room, agent_id, task_ids, verdict, reason, model, cost_usd, input_tokens, output_tokens,
                 cache_creation_input_tokens, cache_read_input_tokens, duration_ms, error, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              p.room,
              p.agent.id,
              JSON.stringify(tasks.map((task) => task.id)),
              verdict,
              reason || (verdict === "wake" ? "wake" : "skip"),
              setting.model,
              answer?.costUsd ?? 0,
              answer?.inputTokens ?? 0,
              answer?.outputTokens ?? 0,
              answer?.cacheCreationInputTokens ?? 0,
              answer?.cacheReadInputTokens ?? 0,
              answer?.durationMs ?? Date.now() - started,
              error === null ? null : error.slice(0, 1_000),
              now(),
            ).lastInsertRowid,
        );
        const link = p.db.prepare(
          `INSERT INTO message_wake (task_id, verdict_id) VALUES (?, ?)
           ON CONFLICT (task_id) DO UPDATE SET verdict_id = excluded.verdict_id`,
        );
        for (const task of tasks) link.run(task.id, id);
      })
      .immediate();
  } catch (failure) {
    // Not stored: the next wake-up asks again, and nothing is lost.
    console.error(`[portier] the verdict for ${p.room}/${p.agent.id} could not be stored`, failure);
    return;
  }
  if (verdict === "wake") {
    try {
      p.rewake();
    } catch (failure) {
      console.error(`[portier] waking ${p.room}/${p.agent.id} after its verdict failed`, failure);
    }
  }
}

/** One verdict as /reglages shows it. */
export type PortierVerdictView = {
  id: number;
  room: string;
  agent: string;
  verdict: Verdict;
  reason: string;
  model: string;
  costUsd: number;
  messages: number;
  /** Who wrote the first message, and its first words. */
  from: string | null;
  excerpt: string;
  failed: boolean;
  at: string;
};

/** The latest verdicts, newest first, and what the portier cost and saved over the last 7 days. */
export function recentVerdicts(
  db: Db,
  limit = 20,
  at: Date = new Date(),
): { verdicts: PortierVerdictView[]; week: { calls: number; skips: number; costUsd: number } } {
  const rows = db
    .prepare("SELECT * FROM portier_verdicts ORDER BY id DESC LIMIT ?")
    .all(limit) as {
    id: number;
    room: string;
    agent_id: string;
    task_ids: string;
    verdict: Verdict;
    reason: string;
    model: string;
    cost_usd: number;
    error: string | null;
    created_at: string;
  }[];
  const first = db.prepare("SELECT t.from_agent, COALESCE(m.text, t.text) AS text FROM tasks t LEFT JOIN messages m ON m.id = t.ref_id WHERE t.id = ?");
  const verdicts = rows.map((row): PortierVerdictView => {
    let ids: number[] = [];
    try {
      ids = z.array(z.number()).parse(JSON.parse(row.task_ids));
    } catch {
      ids = [];
    }
    const task = ids[0] !== undefined ? (first.get(ids[0]) as Pick<TaskRow, "from_agent" | "text"> | undefined) : undefined;
    const text = (task?.text ?? "").replace(/\s+/g, " ").trim();
    return {
      id: row.id,
      room: row.room,
      agent: row.agent_id,
      verdict: row.verdict,
      reason: row.reason,
      model: row.model,
      costUsd: row.cost_usd,
      messages: ids.length,
      from: task?.from_agent ?? null,
      excerpt: text.length > 120 ? `${text.slice(0, 120)}...` : text,
      failed: row.error !== null,
      at: row.created_at,
    };
  });
  const week = db
    .prepare(
      "SELECT COUNT(*) AS calls, SUM(CASE WHEN verdict = 'skip' THEN 1 ELSE 0 END) AS skips, SUM(cost_usd) AS cost FROM portier_verdicts WHERE created_at >= ?",
    )
    .get(new Date(at.getTime() - 7 * 24 * 60 * 60_000).toISOString()) as { calls: number; skips: number | null; cost: number | null };
  return { verdicts, week: { calls: week.calls, skips: week.skips ?? 0, costUsd: Math.round((week.cost ?? 0) * 10_000) / 10_000 } };
}
