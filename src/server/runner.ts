import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { strings } from "../ui/strings";
import { recordBotMessage } from "./chat-history";
import { ClaudeEngine, removeMcpConfig, writeMcpConfig } from "./claude-engine";
import { briefingText, giveBackDecisions, readMemories, takeDecisions } from "./briefing";
import { alertCapReached } from "./cap-alert";
import { getConfig, liveConfig, type Env, type HqConfig } from "./config";
import { getDbAt, now, type Db, type RunRow, type RunStatus, type TaskRow } from "./db";
import { ZERO_USAGE, type Engine, type RunEvent, type RunInput } from "./engine";
import { HqError } from "./errors";
import { exitProcess } from "./exit";
import { DEFAULT_LANGUAGE, readHomeLanguage } from "./export";
import { notifyPendingApprovals, sendAlert, type Send } from "./notify";
import {
  atDeadline,
  CHECK_WAIT_MS,
  readDeadlines,
  recordDeadlines,
  stoppedSummary,
  stopsFor,
  type DeadlineDecision,
} from "./long-runs";
import { languageName, wakeOnboarding } from "./onboarding";
import { messageGate, type PortierCall } from "./portier";
import { appendLine, deskLinkLine, runLinkLine, withLine } from "./public-url";
import { startRelaunchRequests } from "./relaunch-requests";
import { runPrepare, type PrepareInput, type PrepareOutcome } from "./prepare";
import { resourceHolder } from "./resources";
import { toTelegramMessages } from "../assistant/text";
import { loadHome, syncHome, type Agent, type Room } from "./rooms";
import { skillTools, syncSkills } from "./skills";
import { dayKey } from "./time";
import { ensureWorktree, worktreeBranch } from "./worktree";
import { installWriteGuard, writeGuardConfig, writeGuardEnv, writeGuardScript } from "./write-guard";

/** Why a run was started, stored on the run: lowercase letters and underscores, 40 at most. */
export const reasonSchema = z.string().regex(/^[a-z_]{1,40}$/, "lowercase letters and underscores, 40 at most");

export const startRunSchema = z.strictObject({
  room: z.string().min(1),
  agent: z.string().min(1),
  task: z.string().max(20_000).optional(),
  reason: reasonSchema.optional(),
});
export type StartRunRequest = z.infer<typeof startRunSchema>;

export const DEFAULT_TASK = "Do the routine work described in your role.";

/** The task of a run MyHQ starts to hand over an approved item or a message (wakeAgents). */
export const WAKE_TASK = "Handle the pending tasks of your mailbox, listed below.";

export type RunnerDeps = {
  config?: HqConfig;
  engine?: Engine;
  send?: Send;
  /** The environment read for HQ_PUBLIC_URL (the links of the alerts). Default: process.env. */
  env?: Env;
  /** Delay before the one retry of a run stopped for an MCP server not connected. Default: 5 s. */
  mcpRetryDelayMs?: number;
  /** How long a long run waits for the supervisor's decision (long-runs.ts). Default: 5 minutes. */
  runCheckWaitMs?: number;
  /**
   * The motive of a run started without a `reason` (`modelFor`, `prepare`): `routine` for a
   * routine (routines.ts), `manual` by default. Never passed on to the runs this one wakes.
   */
  motive?: string;
  /** The portier's model call (portier.ts). Default: the real `claude -p`. */
  portier?: PortierCall;
};

/** End reason of a run stopped at its start because an MCP server it declares is not connected. */
export const MCP_NOT_CONNECTED = "mcp_not_connected";
const MCP_RETRY_DELAY_MS = 5_000;

/** The MCP servers of a run's start event that are not connected, as `name (status)`. */
export function notConnectedServers(servers: readonly { name: string; status: string }[]): string[] {
  return servers.filter((server) => server.status !== "connected").map((server) => `${server.name} (${server.status})`);
}

/**
 * The date line every run's prompt ends with: today in the home's language and
 * time zone, the weekday spelled out, so that no agent works the weekday out
 * by itself (a model gets it wrong).
 */
export function todayLine(at: Date, timeZone: string, language: string): string {
  const day = new Intl.DateTimeFormat(language, {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(at);
  return `Today is ${day} (${dayKey(at, timeZone)}, time zone ${timeZone}). Use this date and this weekday as given, never compute them yourself.`;
}

/** The language of the home for the date line; the default one when myhq.json cannot be read. */
function promptLanguage(home: string): string {
  try {
    return readHomeLanguage(home);
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

/**
 * Why a run was stopped by the app: its timeout (no supervisor to check it),
 * its hard limit, a supervisor's hq_run_stop, or the app stopping (the run is
 * then `cancelled`, an interruption, see `releaseOrphanTasks`).
 */
type ActiveRun = {
  controller: AbortController;
  reason: "timeout" | "hard_limit" | "stopped" | "shutdown" | null;
  mcpConfigPath: string | null;
  /** The database of the run: a supervisor's stop is read there (`applyRunStops`). */
  db: Db;
};

type RunnerState = {
  active: Map<number, ActiveRun>;
  /** The executions in progress, until their end is recorded and their alerts are sent. */
  executing: Set<Promise<void>>;
  dbPath: string | null;
  exitHook: boolean;
  /** Set once the app is asked to stop: no run starts any more (`SHUTTING_DOWN`). */
  stopping: boolean;
  shutdownHook: boolean;
};

const globalForRunner = globalThis as unknown as { __myhqRunner?: RunnerState };

function runnerState(): RunnerState {
  globalForRunner.__myhqRunner ??= {
    active: new Map(),
    executing: new Set(),
    dbPath: null,
    exitHook: false,
    stopping: false,
    shutdownHook: false,
  };
  return globalForRunner.__myhqRunner;
}

/** How long the servers get to close at a stop, and how long a stuck stop may last after the grace. */
const CLEANUP_MS = 4_000;
const FORCE_EXIT_MS = 15_000;

/** The summary of a run interrupted because MyHQ stopped during it (status `cancelled`). */
export const INTERRUPTED_SUMMARY = "Interrupted: MyHQ stopped during the run.";

/**
 * When the process exits with runs still in progress (the grace of a stop is
 * over, or the process was told to exit without one), they are marked
 * `cancelled`, their tasks are given back (`releaseOrphanTasks`) and their
 * processes killed. Synchronous on purpose: it runs in the process `exit`
 * event. A process killed outright (no `exit` event) is caught up at the next
 * start by `recoverInterruptedRuns`.
 */
function installExitHook(dbPath: string): void {
  const state = runnerState();
  state.dbPath = dbPath;
  if (state.exitHook) return;
  state.exitHook = true;
  process.on("exit", () => {
    if (!state.dbPath || state.active.size === 0) return;
    const db = getDbAt(state.dbPath);
    const cancel = db.prepare(
      "UPDATE runs SET status = 'cancelled', ended_at = ?, summary = ? WHERE id = ? AND status = 'running'",
    );
    for (const [runId, run] of state.active) {
      cancel.run(now(), INTERRUPTED_SUMMARY, runId);
      run.controller.abort();
      if (run.mcpConfigPath) removeMcpConfig(run.mcpConfigPath);
    }
    releaseOrphanTasks(db);
  });
}

/**
 * Gives back the tasks left `in_progress` by a run that is no longer in
 * progress (interrupted, failed, or gone), as the end of a failed run does:
 * the run's own instruction (`manual`) is blocked with a note, the mailbox
 * tasks go back to `pending`, to be woken by the usual rules (`wakeAgents`).
 */
export function releaseOrphanTasks(db: Db): { requeued: number; blocked: number } {
  const orphan =
    "status = 'in_progress' AND (run_id IS NULL OR NOT EXISTS (SELECT 1 FROM runs r WHERE r.id = tasks.run_id AND r.status = 'running'))";
  const at = now();
  return db
    .transaction(() => ({
      blocked: db
        .prepare(`UPDATE tasks SET status = 'blocked', note = COALESCE(note, ?), updated_at = ? WHERE source = 'manual' AND ${orphan}`)
        .run(INTERRUPTED_SUMMARY, at).changes,
      requeued: db
        .prepare(`UPDATE tasks SET status = 'pending', run_id = NULL, updated_at = ? WHERE source <> 'manual' AND ${orphan}`)
        .run(at).changes,
    }))
    .immediate();
}

/**
 * At startup, in the one process that owns the home (see `app()`): the runs a
 * crash or a forced stop left `running` are closed as `cancelled`
 * (interrupted), and the tasks they held are given back. Returns the runs
 * closed and the tasks given back.
 */
export function recoverInterruptedRuns(db: Db): { runs: number; requeued: number; blocked: number } {
  const runs = db
    .prepare("UPDATE runs SET status = 'cancelled', ended_at = ?, summary = ? WHERE status = 'running'")
    .run(now(), INTERRUPTED_SUMMARY).changes;
  return { runs, ...releaseOrphanTasks(db) };
}

/** Whether the app was asked to stop: no run starts any more. */
export function isStopping(): boolean {
  return runnerState().stopping;
}

/**
 * Stops starting runs, waits up to `graceMs` for the runs in progress to end,
 * then interrupts the ones still going (`cancelled`, their tasks given back to
 * be woken again at the next start) and waits for their end to be recorded.
 * Returns how many runs ended on their own and how many were interrupted.
 */
export async function stopRuns(graceMs: number, pollMs = 250): Promise<{ ended: number; interrupted: number }> {
  const state = runnerState();
  state.stopping = true;
  const before = state.active.size;
  const deadline = Date.now() + graceMs;
  while (state.active.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
  }
  const interrupted = state.active.size;
  for (const run of state.active.values()) {
    run.reason = "shutdown";
    run.controller.abort();
  }
  // The end of an interrupted run is recorded as soon as its process is gone: a few seconds at most.
  await Promise.race([
    Promise.allSettled([...state.executing]),
    new Promise((resolve) => setTimeout(resolve, 5_000).unref()),
  ]);
  return { ended: before - interrupted, interrupted };
}

/**
 * Makes a stop of the app wait for the runs in progress: on SIGINT, SIGTERM
 * or the `shutdown` message of pm2 (`shutdown_with_message`, the only way to
 * stop a process gently on Windows), no run starts any more, the runs in
 * progress get `config.shutdownGraceMs` to end, then `cleanup` runs (the HTTP
 * servers are closed, at most `CLEANUP_MS`) and the process exits, whatever
 * happens: a stop that gets stuck is cut `FORCE_EXIT_MS` after the grace. A
 * second signal exits at once. Next.js stops the server on its own on these
 * signals unless NEXT_MANUAL_SIG_HANDLE is set (ecosystem.config.cjs sets it),
 * so closing the server and exiting is up to MyHQ. Installed once per
 * process, by the server only.
 */
export function installShutdown(
  config: HqConfig,
  exit: (code: number) => void = exitProcess,
  cleanup: () => Promise<unknown> = async () => undefined,
): void {
  const state = runnerState();
  if (state.shutdownHook) return;
  state.shutdownHook = true;
  const stop = (why: string) => {
    if (state.stopping) {
      console.warn(`[runner] ${why} again: exiting now`);
      exit(1);
      return;
    }
    const seconds = Math.round(config.shutdownGraceMs / 1000);
    console.log(`[runner] ${why}: no new run, waiting up to ${seconds} s for ${state.active.size} run(s) in progress`);
    // Last resort: whatever blocks the steps below, the process does not outlive this.
    setTimeout(() => {
      console.warn("[runner] the stop is stuck: exiting now");
      exit(1);
    }, config.shutdownGraceMs + FORCE_EXIT_MS).unref();
    void stopRuns(config.shutdownGraceMs)
      .then(({ ended, interrupted }) => console.log(`[runner] stopping: ${ended} run(s) ended, ${interrupted} interrupted`))
      .catch((error: unknown) => console.error("[runner] stopping the runs failed", error))
      .then(() =>
        Promise.race([
          cleanup().catch((error: unknown) => console.error("[runner] closing the servers failed", error)),
          new Promise((resolve) => setTimeout(resolve, CLEANUP_MS).unref()),
        ]),
      )
      .finally(() => exit(0));
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("message", (message) => {
    if (message === "shutdown") stop("shutdown message");
  });
}

/** The runs started today that count in the daily cap: a turn its prepare command skipped (no model call) does not. */
export function runsToday(db: Db): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM runs WHERE date(started_at, 'localtime') = date('now', 'localtime')
         AND NOT EXISTS (SELECT 1 FROM events e WHERE e.run_id = runs.id AND e.type = 'end'
           AND json_extract(e.data, '$.reason') = ?)`,
    )
    .get(PREPARE_SKIPPED) as { n: number };
  return row.n;
}

export function findAgent(config: HqConfig, roomName: string, agentId: string): { room: Room; agent: Agent } {
  const home = loadHome(config.home);
  const room = home.rooms.find((r) => r.name === roomName);
  if (!room) {
    const invalid = home.invalid.find((r) => path.basename(r.dir) === roomName);
    if (invalid) throw new HqError("ROOM_INVALID", 422, `Room "${roomName}" is invalid: ${invalid.error}`);
    throw new HqError("ROOM_NOT_FOUND", 404, `No room "${roomName}" in ${path.join(config.home, "rooms")}.`);
  }
  const agent = room.agents.find((a) => a.id === agentId);
  if (!agent) throw new HqError("AGENT_NOT_FOUND", 404, `No agent "${agentId}" in room "${roomName}".`);
  return { room, agent };
}

export function buildPrompt(params: {
  room: Room;
  agent: Agent;
  runId: number;
  task: string;
  mailbox: TaskRow[];
  /** The other shared rooms of the home, which this agent may order from. */
  sharedRooms?: readonly string[];
  /** The language of the home (`language` in myhq.json): the one of the final report. */
  language?: string;
}) {
  const language = languageName(params.language ?? DEFAULT_LANGUAGE);
  const lines = [
    `You are ${params.agent.name} (agent "${params.agent.id}") in room "${params.room.name}" of MyHQ, run #${params.runId}.`,
    "Report through the hq tools: hq_submit for anything to approve. Never publish anything yourself.",
    "When a decision of the owner is truly needed to go on, ask with hq_ask (if you have it): concrete options, all your questions at once, then finish your turn; the answers wake you with a new task. Do not guess, and do not submit a deliverable at random hoping it is the right one. Do not overuse it: ask only what blocks you.",
    "When a deliverable offers variants to choose from (voices, seeds, titles...), attach the choice as `questions` to the hq_submit of that deliverable instead of a separate hq_ask: the owner sees both together, and the answers come back with the decision.",
    "A revision (a task of source revise) is about the item it names: keep that piece's subject and brief, and apply the note to it. If the note seems to ask for a different subject or a new piece, do not start one: ask with hq_ask (or, without it, say so in your report) whether the owner wants to change the subject.",
    "MyHQ closes your task with your final message when your run ends: do not call hq_task_update for that. Call it only when you are blocked (status blocked, with a note saying why).",
    `Tell the owner what you are doing with hq_status (if you have it): once at the start, then at each notable step, a few words in ${language} (60 characters at most, for example "rend le clip B, 2 sur 3"), never a technical detail (no file path, command or tool name). It shows over your head on the floor and changes nothing else.`,
    "Your new decisions and your memory are given at the end of this message: do not call hq_read_decisions or hq_memory_read for them, whatever your role says. A decision comes to you once. Before you say that an item is not approved, or does not exist, check it with hq_items (by its number): never rely on memory. Read the content of an item (its body, its files) with hq_items and its id.",
    `Language of this home: ${language}. Write your final report, the last message of your run, in ${language}, whatever the language of the task, of your role or of the files you worked on. Tool names, ids and code stay as they are.`,
  ];
  if (params.room.shared) {
    lines.push(
      'Your room is shared: other rooms order from it. Deliver an order with hq_submit and forRoom set to the room that ordered, and ask or answer that room\'s agent with hq_message and its "room".',
    );
  }
  const shared = params.sharedRooms ?? [];
  if (shared.length > 0) {
    lines.push(`Shared rooms you may order from with hq_message and "room" (hq_rooms lists their agents): ${shared.join(", ")}.`);
  }
  lines.push(
    "",
    "Task:",
    params.task,
  );
  if (params.mailbox.length > 0) {
    lines.push("", "Pending tasks from your mailbox:");
    for (const task of params.mailbox) lines.push(`- [task ${task.id}, ${task.source}] ${task.text}`);
  }
  return lines.join("\n");
}

/** Variables a Claude Code session sets for its own child processes. */
const NESTED_SESSION_VAR =
  /^(CLAUDECODE|CLAUDE_CODE_.+|CLAUDE_AGENT_SDK_.+|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PREVIEW_.+|USE_LOCAL_OAUTH|USE_STAGING_OAUTH|ANTHROPIC_BASE_URL|MCP_CONNECTION_NONBLOCKING)$/;
/** User settings that stay valid for a nested run. */
const KEPT_CLAUDE_VARS = new Set(["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_GIT_BASH_PATH"]);

/**
 * Environment of a `claude -p` process (agent run or assistant chat). The
 * app's own variables (HQ_*, MYHQ_*, Telegram token included) never reach it.
 * When MyHQ itself was started from inside a Claude Code session, the
 * variables of that session are dropped too, so that the agent authenticates
 * with the user's own CLI login. HQ_CLAUDE_OAUTH_TOKEN, when set, becomes the
 * child's CLAUDE_CODE_OAUTH_TOKEN (a long-lived subscription token).
 */
export function agentEnv(base: Env, hqEnv: Record<string, string>): Env {
  const nested = Boolean(base.CLAUDECODE);
  const env: Env = {};
  for (const [key, value] of Object.entries(base)) {
    if (/^(HQ|MYHQ)_/i.test(key)) continue;
    if (nested && NESTED_SESSION_VAR.test(key) && !KEPT_CLAUDE_VARS.has(key)) continue;
    env[key] = value;
  }
  const token = base.HQ_CLAUDE_OAUTH_TOKEN?.trim();
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  return { ...env, ...hqEnv };
}

/**
 * Starts a run: checks the agent lock and the daily cap, records the run, then
 * executes it in the background. Returns the run as recorded (`running`).
 */
export function startRun(request: StartRunRequest, deps: RunnerDeps = {}): RunRow {
  const config = deps.config ?? getConfig();
  const { room, agent } = findAgent(config, request.room, request.agent);
  const home = loadHome(config.home);
  syncHome(getDbAt(config.dbPath), home);
  const sharedRooms = home.rooms.filter((each) => each.shared && each.name !== room.name).map((each) => each.name);
  const task = request.task?.trim() || DEFAULT_TASK;
  return launchRun({
    config,
    deps,
    room,
    agent,
    task,
    reason: request.reason ?? null,
    motive: request.reason ?? deps.motive ?? "manual",
    briefing: true,
    prompt: (runId, mailbox) => buildPrompt({ room, agent, runId, task, mailbox, sharedRooms, language: promptLanguage(config.home) }),
  });
}

export type WakeCandidate = {
  /** The task (given by wakeAgents' query, for the portier). */
  id?: number;
  room: string;
  agent_id: string;
  source: "approval" | "message" | "revise" | "chat";
  /** For a message: who sent it. */
  from_room: string | null;
  from_agent: string | null;
};

/** Whether a task of this source wakes the agent: every one does unless the agent opted out (`queue`). */
export function wakesAgent(agent: Agent, source: WakeCandidate["source"]): boolean {
  switch (source) {
    case "approval":
      // With "command", an approval task exists only when the command failed: the agent executes it.
      return agent.onApproval === "task" || agent.onApproval === "command";
    case "message":
      return agent.onMessage !== "queue";
    case "revise":
      return agent.onRevise !== "queue";
    case "chat":
      return true;
  }
}

/**
 * Starts a run, at once, for each agent that has a task to take: one from an
 * approved item (`onApproval: "task"`, reason `approval`), a message
 * (reason `message`), a revision (reason `revise`) or a request of the chat
 * (reason `chat`), created since the agent's last run started. A message or a
 * revision wakes the agent unless it opted out (`onMessage` or `onRevise` set
 * to `"queue"`), and the task then waits for its next run. A busy agent or the daily cap leaves the task pending: it
 * is taken by the agent's next run, and an agent still busy is woken again
 * when its run ends (the app calls this after each decision, on each tool
 * result and at the end of each run). Tasks given back by a failed run are
 * older than that run, so a failing agent is not woken in a loop. A run
 * interrupted because MyHQ stopped (`cancelled`) does not count, once: its
 * tasks, given back, wake the agent again after the restart, and a second
 * interruption of the same tasks leaves them for the agent's next run. A
 * message from an agent wakes its recipient at most once per
 * `config.messageWakeIntervalMs` per pair of agents (see `pairWokeRecently`):
 * the next ones wait, and the scheduler's tick wakes them once the window is
 * over. Never throws for a busy agent or the cap; returns the runs started.
 */
export function wakeAgents(config: HqConfig, db: Db, deps: RunnerDeps = {}): RunRow[] {
  // A supervisor's hq_run_stop is applied here: on the tool result of that very call.
  applyRunStops(db);
  // MyHQ's own onboarding agent is in no room of the home: its revisions are woken apart.
  const onboarding = wakeOnboarding(config, db, deps);
  // The relaunches a supervisor asked for (hq_relaunch), before the mailbox wake-ups: the run takes the whole mailbox.
  const relaunched = startRelaunchRequests(config, db, deps);
  const candidates = db
    .prepare(
      `SELECT t.id, t.room, t.agent_id, t.source, t.from_room, t.from_agent FROM tasks t
       WHERE t.status = 'pending' AND t.source IN ('approval', 'message', 'revise', 'chat')
         AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.room = t.room AND r.agent_id = t.agent_id
           AND r.started_at >= t.created_at AND r.status <> 'cancelled')
         AND (SELECT COUNT(*) FROM runs r WHERE r.room = t.room AND r.agent_id = t.agent_id
           AND r.started_at >= t.created_at AND r.status = 'cancelled') <= 1
       ORDER BY t.id`,
    )
    .all() as WakeCandidate[];
  if (candidates.length === 0) return [...onboarding, ...relaunched];
  const home = loadHome(config.home);
  const started: RunRow[] = [...onboarding, ...relaunched];
  const done = new Set<string>();
  const since = new Date(Date.now() - config.messageWakeIntervalMs).toISOString();
  for (const candidate of candidates) {
    const key = `${candidate.room}/${candidate.agent_id}`;
    if (done.has(key)) continue;
    const agent = home.rooms.find((r) => r.name === candidate.room)?.agents.find((a) => a.id === candidate.agent_id);
    if (!agent) continue;
    if (!wakesAgent(agent, candidate.source)) continue;
    // Another task of the agent may still wake it, and its run then takes this one too.
    if (candidate.source === "message" && config.messageWakeIntervalMs > 0 && pairWokeRecently(db, candidate, since)) continue;
    // The portier: a message that needs no wake waits for the agent's next run (portier.ts).
    if (
      candidate.source === "message" &&
      candidate.id !== undefined &&
      !messageGate({
        config,
        db,
        room: candidate.room,
        agent,
        taskId: candidate.id,
        env: agentEnv(process.env, {}),
        call: deps.portier,
        rewake: () => wakeAgents(config, db, deps),
      })
    ) {
      continue;
    }
    done.add(key);
    try {
      const request = { room: candidate.room, agent: agent.id, task: WAKE_TASK, reason: candidate.source };
      started.push(startRun(request, { ...deps, config }));
    } catch (error) {
      // A busy agent, a busy resource or the cap: the task waits, and the end of the run that holds them wakes it again.
      if (error instanceof HqError && WAITS.has(error.code)) continue;
      console.error(`[runner] could not wake ${key}`, error);
    }
  }
  return started;
}

/**
 * Whether a message of the same sender already woke this recipient since
 * `since`: a run started for a message (reason `message`) took one of that
 * sender's messages. Two agents answering each other ("received", "waiting")
 * then wake each other once per window, not at each message.
 */
export function pairWokeRecently(db: Db, candidate: WakeCandidate, since: string): boolean {
  if (!candidate.from_room || !candidate.from_agent) return false;
  return (
    db
      .prepare(
        `SELECT 1 FROM runs r JOIN tasks m ON m.run_id = r.id
         WHERE r.room = ? AND r.agent_id = ? AND r.reason = 'message' AND r.started_at > ?
           AND m.source = 'message' AND m.from_room = ? AND m.from_agent = ?
         LIMIT 1`,
      )
      .get(candidate.room, candidate.agent_id, since, candidate.from_room, candidate.from_agent) !== undefined
  );
}

/**
 * Interrupts the runs in progress of this process that a supervisor asked to
 * stop (hq_run_stop, written by the HQ MCP server): they end `failed`, as a
 * run that timed out. Never throws.
 */
export function applyRunStops(db: Db): void {
  try {
    const active = runnerState().active;
    const ids = [...active.entries()].filter(([, run]) => run.db === db && run.reason === null).map(([id]) => id);
    for (const row of stopsFor(db, ids)) {
      const run = active.get(row.run_id);
      if (!run || run.reason !== null) continue;
      run.reason = "stopped";
      run.controller.abort();
    }
  } catch (error) {
    console.error("[runner] applying the stops of the supervisor failed", error);
  }
}

/** Errors that leave a woken task pending, to be taken by a later run. */
export const WAITS = new Set(["AGENT_BUSY", "RESOURCE_BUSY", "DAILY_CAP_REACHED", "SHUTTING_DOWN"]);

/**
 * Wakes the agents whose tasks wait for the daily cap, once the counter allows
 * a run again: the day changed (the count is by calendar day), or the cap was
 * raised. Does nothing while the cap is reached. Same order and rules as
 * `wakeAgents` (it calls it), so a task is never woken twice and a failing
 * agent is not woken in a loop. Called at each tick of the scheduler's timer,
 * whether the scheduler is on or not: the check is one query when nothing waits.
 * Never throws; returns the runs started.
 */
export function resumeWaitingTasks(config: HqConfig, db: Db, deps: RunnerDeps = {}): RunRow[] {
  try {
    applyRunStops(db);
    if (runsToday(db) >= liveConfig(config).maxRunsPerDay) return [];
    return wakeAgents(config, db, deps);
  } catch (error) {
    console.error("[runner] resuming the tasks that waited for the cap failed", error);
    return [];
  }
}

/**
 * Records and starts a run of any agent, room agent or MyHQ's own (onboarding),
 * after the agent lock, its shared resources (`RESOURCE_BUSY` while another
 * run holds one of them) and the daily cap. `prompt` receives the run id and
 * the tasks claimed from the agent's mailbox.
 */
export function launchRun(params: {
  config: HqConfig;
  deps: RunnerDeps;
  room: Room;
  agent: Agent;
  task: string;
  /** Stored on the run (`runs.reason`); null for a run started by hand or a routine. */
  reason?: string | null;
  /** Only these pending tasks of the agent go into the run's mailbox. Default: all of them. */
  claimIds?: number[];
  prompt: (runId: number, mailbox: TaskRow[]) => string;
  /** 1 for the automatic retry of a run stopped for an MCP server not connected; there is no second one. */
  attempt?: number;
  /** The motive of the run for the agent's `modelFor` and `prepare`. Default: the reason, else `manual`. */
  motive?: string;
  /** The prompt gives the agent's new decisions and its memory (briefing.ts): the runs of room agents. */
  briefing?: boolean;
}): RunRow {
  const { config, room, agent, task } = params;
  // The motive is this run's own: the runs it wakes get theirs.
  const deps: RunnerDeps = { ...params.deps, motive: undefined };
  if (runnerState().stopping) {
    throw new HqError("SHUTTING_DOWN", 503, `MyHQ is stopping: the run of "${agent.id}" starts after the restart.`);
  }
  const db = getDbAt(config.dbPath);
  installExitHook(config.dbPath);
  const engine = deps.engine ?? new ClaudeEngine(config.claudeBin);

  const { run, mailbox } = db
    .transaction(() => {
      const busy = db
        .prepare("SELECT id FROM runs WHERE room = ? AND agent_id = ? AND status = 'running'")
        .get(room.name, agent.id) as { id: number } | undefined;
      if (busy) {
        throw new HqError(
          "AGENT_BUSY",
          409,
          `Agent "${agent.id}" of room "${room.name}" already has a run in progress (#${busy.id}).`,
        );
      }
      const holder = resourceHolder(db, agent.resources);
      if (holder) {
        throw new HqError(
          "RESOURCE_BUSY",
          409,
          `Resource "${holder.resource}" is held by run #${holder.runId} of ${holder.room}/${holder.agentId}: the run of "${agent.id}" starts when it ends.`,
        );
      }
      const today = runsToday(db);
      // The cap is read again here: a caller may hold a configuration older than myhq.json.
      const cap = liveConfig(config).maxRunsPerDay;
      if (today >= cap) {
        // The first refusal of the day tells the owner, once, how many tasks wait (after the transaction is over).
        queueMicrotask(() => void alertCapReached({ config, db, send: deps.send ?? sendAlert, env: deps.env }));
        throw new HqError(
          "DAILY_CAP_REACHED",
          429,
          `Daily cap reached: ${today} of ${cap} runs today (HQ_MAX_RUNS_PER_DAY, or maxRunsPerDay in myhq.json).`,
        );
      }
      const at = now();
      const runId = Number(
        db
          .prepare(
            "INSERT INTO runs (room, agent_id, engine, task, status, started_at, reason, resources) VALUES (?, ?, ?, ?, 'running', ?, ?, ?)",
          )
          .run(room.name, agent.id, engine.name, task, at, params.reason ?? null, JSON.stringify(agent.resources))
          .lastInsertRowid,
      );
      db.prepare(
        `INSERT INTO tasks (room, agent_id, source, text, status, run_id, created_at, updated_at)
         VALUES (?, ?, 'manual', ?, 'in_progress', ?, ?, ?)`,
      ).run(room.name, agent.id, task, runId, at, at);
      const only = params.claimIds;
      const claimed = db
        .prepare(
          `UPDATE tasks SET status = 'in_progress', run_id = ?, updated_at = ?
           WHERE room = ? AND agent_id = ? AND status = 'pending'${
             only ? ` AND id IN (${only.map(() => "?").join(", ")})` : ""
           } RETURNING *`,
        )
        .all(runId, at, room.name, agent.id, ...(only ?? [])) as TaskRow[];
      return {
        run: db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow,
        mailbox: claimed.sort((a, b) => a.id - b.id),
      };
    })
    .immediate();

  const today = todayLine(new Date(), liveConfig(config).timeZone, promptLanguage(config.home));
  const prompt = params.prompt(run.id, mailbox);
  // The same launch again: the tasks the stopped run claimed are back in the queue, so it claims them again.
  const retry = (params.attempt ?? 0) === 0 ? () => launchRun({ ...params, attempt: 1 }) : null;
  const execution = execute({
    db,
    config,
    engine,
    room,
    agent,
    run,
    prompt,
    today,
    mailbox,
    motive: params.motive ?? params.reason ?? "manual",
    briefing: params.briefing ?? false,
    send: deps.send ?? sendAlert,
    deps,
    retry,
  }).catch(
    (error) => {
      console.error(`[runner] run #${run.id} crashed`, error);
    },
  );
  // A stop of the app waits for it (stopRuns).
  const executing = runnerState().executing;
  executing.add(execution);
  void execution.finally(() => executing.delete(execution));
  return run;
}

type ExecuteParams = {
  db: Db;
  config: HqConfig;
  engine: Engine;
  room: Room;
  agent: Agent;
  run: RunRow;
  /** The prompt of the run, before the briefing, the prepared context and the date line (`today`). */
  prompt: string;
  today: string;
  /** The tasks of the mailbox the run claimed. */
  mailbox: TaskRow[];
  motive: string;
  briefing: boolean;
  send: Send;
  /** Passed on to the runs this one wakes (wakeAgents). */
  deps: RunnerDeps;
  /** Starts the one retry of this run when an MCP server is not connected at its start; null for a retry. */
  retry: (() => RunRow) | null;
};

function storeEvent(db: Db, run: RunRow, event: RunEvent): void {
  const { type, ...rest } = event;
  // The start event carries the run's reason, so that the feed can show it.
  const data = type === "start" && run.reason ? { ...rest, reason: run.reason } : rest;
  db.prepare("INSERT INTO events (run_id, room, agent_id, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    run.id,
    run.room,
    run.agent_id,
    type,
    JSON.stringify(data),
    now(),
  );
}

/** Wakes the agents that a message of this run, or the end of it, lets start. Never throws. */
function wake(p: ExecuteParams): void {
  try {
    wakeAgents(p.config, p.db, { ...p.deps, engine: p.engine, send: p.send });
  } catch (error) {
    console.error(`[runner] wake after run #${p.run.id} failed`, error);
  }
}

/** End reason of a run whose prepare command skipped the turn (`{ "run": false }`). */
export const PREPARE_SKIPPED = "prepare_skipped";
/** The summary of a skipped run starts with it, then the reason. */
export const SKIPPED_SUMMARY = "Skipped by its prepare command, no model turn:";
/** The heading of the context a prepare command adds to the prompt. */
export const PREPARED_HEADING = "## Préparé par MyHQ";

/** What a prepare command reads on stdin (prepare.ts). */
export function prepareInput(
  db: Db,
  params: { room: string; agentId: string; runId: number; motive: string; mailbox: readonly TaskRow[] },
): PrepareInput {
  const own = db
    .prepare("SELECT id, text FROM tasks WHERE run_id = ? AND source = 'manual' ORDER BY id LIMIT 1")
    .get(params.runId) as { id: number; text: string } | undefined;
  const last = db
    .prepare("SELECT MAX(started_at) AS at FROM runs WHERE room = ? AND agent_id = ? AND status = 'done' AND id <> ?")
    .get(params.room, params.agentId, params.runId) as { at: string | null };
  return {
    room: params.room,
    agent: params.agentId,
    motive: params.motive,
    // A wake-up's instruction only says to take the mailbox: the work is in `messages`.
    task:
      own && own.text !== WAKE_TASK
        ? { id: own.id, title: (own.text.split("\n")[0] ?? "").trim().slice(0, 200), body: own.text }
        : null,
    messages: params.mailbox.map((t) => {
      // `expects` is the column a message may carry (hq_message), when the database has it.
      const expects = (t as TaskRow & { expects?: unknown }).expects;
      return {
        from: t.from_room && t.from_agent ? `${t.from_room}/${t.from_agent}` : t.source,
        text: t.text,
        expects: typeof expects === "string" ? expects : null,
      };
    }),
    lastRunAt: last.at,
    now: new Date().toISOString(),
  };
}

/** Runs the agent's prepare command before its turn; a failure is logged and the turn runs (fail open). */
async function prepareRun(p: ExecuteParams, hqEnv: Record<string, string>, signal: AbortSignal): Promise<PrepareOutcome> {
  const { db, config, room, agent, run } = p;
  let outcome: PrepareOutcome;
  try {
    outcome = await runPrepare({
      command: agent.prepare!.command,
      cwd: config.home,
      env: { ...agentEnv(process.env, hqEnv), MYHQ_HOME: config.home },
      input: prepareInput(db, { room: room.name, agentId: agent.id, runId: run.id, motive: p.motive, mailbox: p.mailbox }),
      timeoutMs: agent.prepare!.timeoutMs,
      signal,
    });
  } catch (error) {
    outcome = { kind: "error", error: error instanceof Error ? error.message : String(error) };
  }
  if (outcome.kind === "error") {
    console.error(`[runner] the prepare command of ${room.name}/${agent.id} failed for run #${run.id}, the turn runs: ${outcome.error}`);
  }
  return outcome;
}

async function execute(p: ExecuteParams): Promise<void> {
  const { db, config, engine, room, agent, run } = p;
  const state = runnerState();
  const active: ActiveRun = { controller: new AbortController(), reason: null, mcpConfigPath: null, db };
  state.active.set(run.id, active);
  const interrupt = (why: NonNullable<ActiveRun["reason"]>) => {
    if (active.reason !== null) return;
    active.reason = why;
    active.controller.abort();
  };
  // The soft deadline (HQ_RUN_TIMEOUT_MINUTES) and the hard limit (HQ_RUN_HARD_LIMIT_MINUTES): see long-runs.ts.
  const startedAt = Date.parse(run.started_at);
  const hardAt = startedAt + config.runHardLimitMs;
  try {
    recordDeadlines(db, run.id, agent.maxBudgetUsd ?? config.defaultMaxBudgetUsd, startedAt + config.runTimeoutMs, hardAt);
  } catch (error) {
    // Without its row the run is interrupted at its soft deadline, as before long runs existed.
    console.error(`[runner] the deadlines of run #${run.id} could not be recorded`, error);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (until: number) => {
    timer = setTimeout(onDeadline, Math.max(0, Math.min(until, hardAt) - Date.now()));
  };
  const onDeadline = () => {
    const at = Date.now();
    if (at >= hardAt) return interrupt("hard_limit");
    let decision: DeadlineDecision;
    try {
      decision = atDeadline({
        config,
        db,
        home: loadHome(config.home),
        run,
        at,
        waitMs: p.deps.runCheckWaitMs ?? CHECK_WAIT_MS,
        start: (request) => startRun(request, { ...p.deps, config, engine: p.engine, send: p.send }),
      });
    } catch (error) {
      // Never interrupted for an error of MyHQ's: the run is looked at again in a minute, the hard limit holds.
      console.error(`[runner] the deadline of run #${run.id} could not be checked`, error);
      return arm(at + 60_000);
    }
    if (decision.kind === "wait") return arm(decision.until);
    interrupt(decision.kind === "stop" ? "stopped" : decision.why);
  };
  arm(startedAt + config.runTimeoutMs);

  const logFile = path.join(config.runsDir, `${run.id}.jsonl`);
  const mcpConfigPath = path.join(config.runsDir, `${run.id}.mcp.json`);
  active.mcpConfigPath = mcpConfigPath;
  const attachmentMaxMb = process.env.HQ_ATTACHMENT_MAX_MB?.trim();
  const hqEnv: Record<string, string> = {
    HQ_DB_PATH: config.dbPath,
    HQ_RUN_ID: String(run.id),
    HQ_AGENT_ID: agent.id,
    HQ_ROOM: room.name,
    // hq_submit reads the attachments relative to it, and refuses anything outside.
    HQ_WORK_DIR: agent.workDir,
    // hq_blocked and hq_relaunch tell the reasons of the Standard and its guards with the app's own values.
    HQ_MAX_RUNS_PER_DAY: String((config.fromEnv ?? config).maxRunsPerDay),
    HQ_MESSAGE_WAKE_MINUTES: String(config.messageWakeIntervalMs / 60_000),
    ...(attachmentMaxMb ? { HQ_ATTACHMENT_MAX_MB: attachmentMaxMb } : {}),
  };

  let end: Extract<RunEvent, { type: "end" }> | null = null;
  let mcpDown = false;
  /** The run reached the model: a start event that did not stop it. */
  let reachedModel = false;
  /** The reason of a turn its prepare command skipped. */
  let skipped: string | null = null;
  /** The decisions given in the prompt, given back when the run never reached the model. */
  let taken: { ids: number[]; seenAt: string } | null = null;
  try {
    const prepared = agent.prepare ? await prepareRun(p, hqEnv, active.controller.signal) : null;
    if (prepared?.kind === "skip") {
      // No model turn: the run is recorded done at no cost, with the reason (see the end of this function).
      skipped = prepared.reason;
      end = {
        type: "end",
        status: "done",
        reason: PREPARE_SKIPPED,
        summary: `${SKIPPED_SUMMARY} ${prepared.reason}`,
        usage: { ...ZERO_USAGE },
        costUsd: 0,
      };
      storeEvent(db, run, end);
    } else {
      if (active.controller.signal.aborted) throw new Error("Stopped before its start.");
      if (agent.worktree) {
        ensureWorktree({ repo: room.targetRepo, dir: agent.worktree, branch: worktreeBranch(agent.id) });
      }
      fs.mkdirSync(agent.workDir, { recursive: true });
      syncSkills(agent.workDir, agent.skills ?? [], { ignoreInGit: agent.worktree !== null });
      // Where the agent may write is enforced by MyHQ's hook, not by the CLI's path rules (write-guard.ts).
      const guard = writeGuardConfig({ workDir: agent.workDir, allowedTools: agent.allowedTools, disallowedTools: agent.disallowedTools });
      if (guard.allow.length > 0) {
        installWriteGuard(agent.workDir, { script: writeGuardScript(config.repoRoot), ignoreInGit: agent.worktree !== null });
      }
      fs.mkdirSync(config.runsDir, { recursive: true });
      writeMcpConfig({
        file: mcpConfigPath,
        repoRoot: config.repoRoot,
        hqEnv,
        extraServers: agent.mcpServers,
        env: process.env,
      });
      let briefing: string | null = null;
      if (p.briefing) {
        const { decisions, seenAt } = takeDecisions(db, room.name, agent.id);
        taken = { ids: decisions.map((d) => d.approvalId), seenAt };
        briefing = briefingText(decisions, readMemories(db, room.name, agent.id));
      }
      const ready = prepared?.kind === "run" ? prepared : null;
      const prompt = [p.prompt, briefing, ready?.context ? `${PREPARED_HEADING}\n\n${ready.context}` : null, p.today]
        .filter((part): part is string => part !== null)
        .join("\n\n");
      const effort = ready?.effort ?? agent.effort ?? null;
      const input: RunInput = {
        runId: run.id,
        room: room.name,
        agentId: agent.id,
        prompt,
        model: ready?.model ?? agent.modelFor?.[p.motive] ?? agent.model,
        ...(effort ? { effort } : {}),
        ...(agent.cacheTtl ? { cacheTtl: agent.cacheTtl } : {}),
        rolePath: agent.rolePath,
        allowedTools: agent.allowedTools,
        disallowedTools: agent.disallowedTools,
        addDirs: agent.addDirs,
        tools: skillTools(agent),
        mcpConfigPath,
        maxBudgetUsd: agent.maxBudgetUsd ?? config.defaultMaxBudgetUsd,
        workDir: agent.workDir,
        env: { ...agentEnv(process.env, hqEnv), ...writeGuardEnv(guard) },
        signal: active.controller.signal,
        onRawLine: (line) => fs.appendFileSync(logFile, `${line}\n`),
      };
      for await (const event of engine.run(input)) {
        if (event.type === "start") {
          // The init event comes after the CLI connected its servers, so it has read the file: its secrets leave the disk now.
          removeMcpConfig(mcpConfigPath);
          // A run without the tools of its servers must never deliver: it is stopped before its first turn.
          const down = notConnectedServers(event.mcpServers);
          if (down.length > 0) {
            mcpDown = true;
            storeEvent(db, run, event);
            end = {
              type: "end",
              status: "failed",
              reason: MCP_NOT_CONNECTED,
              summary: `Stopped at its start, before doing anything: MCP server not connected: ${down.join(", ")}.`,
              usage: { ...ZERO_USAGE },
              costUsd: 0,
            };
            storeEvent(db, run, end);
            active.controller.abort();
            break;
          }
          reachedModel = true;
        }
        if (event.type === "end") end = event;
        if (event.type === "start" && event.sessionId) {
          db.prepare("UPDATE runs SET session_id = ? WHERE id = ?").run(event.sessionId, run.id);
        }
        storeEvent(db, run, event);
        if (event.type === "tool_result") {
          void notifyPendingApprovals(db, p.send, p.deps.env);
          wake(p);
        }
      }
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
    storeEvent(db, run, end);
  } finally {
    clearTimeout(timer);
    state.active.delete(run.id);
    // Whatever the end (no init event, failure, abort, timeout), the config does not outlive the run.
    removeMcpConfig(mcpConfigPath);
  }
  if (taken && !reachedModel) {
    try {
      giveBackDecisions(db, taken.ids, taken.seenAt);
    } catch (error) {
      console.error(`[runner] the decisions taken by run #${run.id} could not be given back`, error);
    }
  }

  let status: RunStatus = end?.status ?? "failed";
  let summary = end?.summary ?? "The engine ended without a result.";
  const retryDelayMs = p.deps.mcpRetryDelayMs ?? MCP_RETRY_DELAY_MS;
  const retrying = mcpDown && p.retry !== null && active.reason !== "shutdown";
  if (mcpDown) {
    summary += retrying ? ` Retried once in ${Math.round(retryDelayMs / 1000)} s.` : " Second attempt: no retry.";
  }
  if (active.reason === "timeout") {
    status = "failed";
    summary = `Timed out after ${Math.round(config.runTimeoutMs / 60_000)} minutes (HQ_RUN_TIMEOUT_MINUTES).`;
  }
  if (active.reason === "hard_limit" || active.reason === "stopped") {
    // As a run that timed out: its instruction is blocked, its mailbox tasks go back to pending.
    status = "failed";
    const deadlines = readDeadlines(db, run.id);
    const minutes = Math.round((Date.now() - Date.parse(run.started_at)) / 60_000);
    if (active.reason === "hard_limit") {
      summary = `Interrupted at the hard limit of ${Math.round(config.runHardLimitMs / 60_000)} minutes (HQ_RUN_HARD_LIMIT_MINUTES), after ${deadlines?.extensions ?? 0} extension(s).`;
    } else if (deadlines) {
      const by = loadHome(config.home).rooms.find((each) => each.name === deadlines.stop_room)?.agents.find((each) => each.id === deadlines.stop_agent);
      summary = stoppedSummary(deadlines, by?.name ?? deadlines.stop_agent ?? "the supervisor", minutes);
    }
  }
  if (active.reason === "shutdown") {
    // Not a failure: the tasks go back to the queue and wake the agent again after the restart (wakeAgents).
    status = "cancelled";
    summary = INTERRUPTED_SUMMARY;
  }
  const usage = end?.usage ?? ZERO_USAGE;
  const at = now();
  db.transaction(() => {
    db.prepare(
      `UPDATE runs SET status = ?, ended_at = ?, summary = ?, input_tokens = ?, output_tokens = ?,
         cache_creation_input_tokens = ?, cache_read_input_tokens = ?, cost_usd = ?
       WHERE id = ? AND status = 'running'`,
    ).run(
      status,
      at,
      summary,
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheCreationInputTokens,
      usage.cacheReadInputTokens,
      end?.costUsd ?? 0,
      run.id,
    );
    if (status === "done") {
      // A skipped turn closes its tasks with the reason of its prepare command.
      db.prepare(
        "UPDATE tasks SET status = 'done', note = COALESCE(?, note), updated_at = ? WHERE run_id = ? AND status = 'in_progress'",
      ).run(skipped, at, run.id);
    } else {
      // The run's own instruction is closed; mailbox tasks go back to the queue.
      db.prepare(
        "UPDATE tasks SET status = 'blocked', note = ?, updated_at = ? WHERE run_id = ? AND source = 'manual' AND status = 'in_progress'",
      ).run(summary, at, run.id);
      db.prepare(
        "UPDATE tasks SET status = 'pending', run_id = NULL, updated_at = ? WHERE run_id = ? AND source <> 'manual' AND status = 'in_progress'",
      ).run(at, run.id);
    }
  })();

  wake(p);
  await notifyPendingApprovals(db, p.send, p.deps.env);
  // What the bot sends on its own goes into the conversation MyHQ keeps, so
  // that the user's answer to it is understood (chat-history.ts).
  if (retrying) {
    // No alert yet: the retry alerts if it fails too, or if it cannot start.
    setTimeout(() => void retryRun(p, summary), retryDelayMs);
  } else if (status === "failed") {
    const text = withLine(
      strings.notify.runFailed({ room: room.name, agent: agent.name, runId: run.id, summary }),
      runLinkLine(run.id, p.deps.env),
    );
    if (await p.send(text)) recordBotMessage(db, text, "alert");
  }
  // A brief or a recap agent delivers its text this way: its summary is the message.
  if (status === "done" && agent.notifyRuns === "summary" && skipped === null) {
    let sent = false;
    const link = deskLinkLine(p.deps.env);
    for (const part of appendLine(toTelegramMessages(summary), link)) sent = (await p.send(part)) || sent;
    if (sent) recordBotMessage(db, withLine(summary, link), "summary");
  }
}

/** Starts the retry of a run stopped for an MCP server; when it cannot start, the failure is alerted as any other. */
async function retryRun(p: ExecuteParams, summary: string): Promise<void> {
  try {
    p.retry?.();
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    const text = withLine(
      strings.notify.runFailed({
        room: p.room.name,
        agent: p.agent.name,
        runId: p.run.id,
        summary: `${summary} The retry could not start: ${why}`,
      }),
      runLinkLine(p.run.id, p.deps.env),
    );
    if (await p.send(text)) recordBotMessage(p.db, text, "alert");
  }
}
