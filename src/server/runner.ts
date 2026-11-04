import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { strings } from "../ui/strings";
import { recordBotMessage } from "./chat-history";
import { ClaudeEngine, writeMcpConfig } from "./claude-engine";
import { getConfig, type Env, type HqConfig } from "./config";
import { getDbAt, now, type Db, type RunRow, type RunStatus, type TaskRow } from "./db";
import { ZERO_USAGE, type Engine, type RunEvent, type RunInput } from "./engine";
import { HqError } from "./errors";
import { notifyPendingApprovals, sendAlert, type Send } from "./notify";
import { wakeOnboarding } from "./onboarding";
import { appendLine, deskLinkLine, runLinkLine, withLine } from "./public-url";
import { toTelegramMessages } from "../assistant/text";
import { loadHome, syncHome, type Agent, type Room } from "./rooms";
import { ensureWorktree, worktreeBranch } from "./worktree";

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
};

type ActiveRun = { controller: AbortController; reason: "timeout" | null };

const globalForRunner = globalThis as unknown as {
  __myhqRunner?: { active: Map<number, ActiveRun>; dbPath: string | null; exitHook: boolean };
};

function runnerState() {
  globalForRunner.__myhqRunner ??= { active: new Map(), dbPath: null, exitHook: false };
  return globalForRunner.__myhqRunner;
}

/**
 * When the app stops (pm2 restart, Ctrl+C), the runs in progress are marked
 * `cancelled` and their processes killed. Synchronous on purpose: it runs in
 * the process `exit` event.
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
      cancel.run(now(), "MyHQ stopped during the run.", runId);
      run.controller.abort();
    }
  });
}

/** Runs left `running` by a crash of the app are closed as failed at startup. */
export function recoverInterruptedRuns(db: Db): number {
  return db
    .prepare(
      "UPDATE runs SET status = 'failed', ended_at = ?, summary = ? WHERE status = 'running'",
    )
    .run(now(), "Interrupted: MyHQ stopped during the run.").changes;
}

export function runsToday(db: Db): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM runs WHERE date(started_at, 'localtime') = date('now', 'localtime')")
    .get() as { n: number };
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

export function buildPrompt(params: { room: Room; agent: Agent; runId: number; task: string; mailbox: TaskRow[] }) {
  const lines = [
    `You are ${params.agent.name} (agent "${params.agent.id}") in room "${params.room.name}" of MyHQ, run #${params.runId}.`,
    "Report through the hq tools: hq_task_update for your task, hq_submit for anything to approve. Never publish anything yourself.",
    "",
    "Task:",
    params.task,
  ];
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
  syncHome(getDbAt(config.dbPath), loadHome(config.home));
  const task = request.task?.trim() || DEFAULT_TASK;
  return launchRun({
    config,
    deps,
    room,
    agent,
    task,
    reason: request.reason ?? null,
    prompt: (runId, mailbox) => buildPrompt({ room, agent, runId, task, mailbox }),
  });
}

type WakeCandidate = { room: string; agent_id: string; source: "approval" | "message" | "revise" | "chat" };

/** Whether a task of this source wakes the agent: every one does unless the agent opted out (`queue`). */
function wakesAgent(agent: Agent, source: WakeCandidate["source"]): boolean {
  switch (source) {
    case "approval":
      return agent.onApproval === "task";
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
 * older than that run, so a failing agent is not woken in a loop. Never
 * throws for a busy agent or the cap; returns the runs started.
 */
export function wakeAgents(config: HqConfig, db: Db, deps: RunnerDeps = {}): RunRow[] {
  // MyHQ's own onboarding agent is in no room of the home: its revisions are woken apart.
  const onboarding = wakeOnboarding(config, db, deps);
  const candidates = db
    .prepare(
      `SELECT t.room, t.agent_id, t.source FROM tasks t
       WHERE t.status = 'pending' AND t.source IN ('approval', 'message', 'revise', 'chat')
         AND t.created_at > COALESCE(
           (SELECT MAX(r.started_at) FROM runs r WHERE r.room = t.room AND r.agent_id = t.agent_id), '')
       ORDER BY t.id`,
    )
    .all() as WakeCandidate[];
  if (candidates.length === 0) return onboarding;
  const home = loadHome(config.home);
  const started: RunRow[] = [...onboarding];
  const done = new Set<string>();
  for (const candidate of candidates) {
    const key = `${candidate.room}/${candidate.agent_id}`;
    if (done.has(key)) continue;
    const agent = home.rooms.find((r) => r.name === candidate.room)?.agents.find((a) => a.id === candidate.agent_id);
    if (!agent) continue;
    if (!wakesAgent(agent, candidate.source)) continue;
    done.add(key);
    try {
      const request = { room: candidate.room, agent: agent.id, task: WAKE_TASK, reason: candidate.source };
      started.push(startRun(request, { ...deps, config }));
    } catch (error) {
      if (error instanceof HqError && (error.code === "AGENT_BUSY" || error.code === "DAILY_CAP_REACHED")) continue;
      console.error(`[runner] could not wake ${key}`, error);
    }
  }
  return started;
}

/**
 * Records and starts a run of any agent, room agent or MyHQ's own (onboarding),
 * after the agent lock and the daily cap. `prompt` receives the run id and
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
}): RunRow {
  const { config, deps, room, agent, task } = params;
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
      const today = runsToday(db);
      if (today >= config.maxRunsPerDay) {
        throw new HqError(
          "DAILY_CAP_REACHED",
          429,
          `Daily cap reached: ${today} of ${config.maxRunsPerDay} runs today (HQ_MAX_RUNS_PER_DAY).`,
        );
      }
      const at = now();
      const runId = Number(
        db
          .prepare(
            "INSERT INTO runs (room, agent_id, engine, task, status, started_at, reason) VALUES (?, ?, ?, ?, 'running', ?, ?)",
          )
          .run(room.name, agent.id, engine.name, task, at, params.reason ?? null).lastInsertRowid,
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

  const prompt = params.prompt(run.id, mailbox);
  void execute({ db, config, engine, room, agent, run, prompt, send: deps.send ?? sendAlert, deps }).catch((error) => {
    console.error(`[runner] run #${run.id} crashed`, error);
  });
  return run;
}

type ExecuteParams = {
  db: Db;
  config: HqConfig;
  engine: Engine;
  room: Room;
  agent: Agent;
  run: RunRow;
  prompt: string;
  send: Send;
  /** Passed on to the runs this one wakes (wakeAgents). */
  deps: RunnerDeps;
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

async function execute(p: ExecuteParams): Promise<void> {
  const { db, config, engine, room, agent, run } = p;
  const state = runnerState();
  const active: ActiveRun = { controller: new AbortController(), reason: null };
  state.active.set(run.id, active);
  const timer = setTimeout(() => {
    active.reason = "timeout";
    active.controller.abort();
  }, config.runTimeoutMs);

  const logFile = path.join(config.runsDir, `${run.id}.jsonl`);
  const mcpConfigPath = path.join(config.runsDir, `${run.id}.mcp.json`);
  const hqEnv = {
    HQ_DB_PATH: config.dbPath,
    HQ_RUN_ID: String(run.id),
    HQ_AGENT_ID: agent.id,
    HQ_ROOM: room.name,
  };

  let end: Extract<RunEvent, { type: "end" }> | null = null;
  try {
    if (agent.worktree) {
      ensureWorktree({ repo: room.targetRepo, dir: agent.worktree, branch: worktreeBranch(agent.id) });
    }
    fs.mkdirSync(agent.workDir, { recursive: true });
    fs.mkdirSync(config.runsDir, { recursive: true });
    writeMcpConfig({
      file: mcpConfigPath,
      repoRoot: config.repoRoot,
      hqEnv,
      extraServers: agent.mcpServers,
      env: process.env,
    });
    const input: RunInput = {
      runId: run.id,
      room: room.name,
      agentId: agent.id,
      prompt: p.prompt,
      model: agent.model,
      rolePath: agent.rolePath,
      allowedTools: agent.allowedTools,
      disallowedTools: agent.disallowedTools,
      addDirs: agent.addDirs,
      tools: agent.tools,
      mcpConfigPath,
      maxBudgetUsd: agent.maxBudgetUsd ?? config.defaultMaxBudgetUsd,
      workDir: agent.workDir,
      env: agentEnv(process.env, hqEnv),
      signal: active.controller.signal,
      onRawLine: (line) => fs.appendFileSync(logFile, `${line}\n`),
    };
    for await (const event of engine.run(input)) {
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
  }

  let status: RunStatus = end?.status ?? "failed";
  let summary = end?.summary ?? "The engine ended without a result.";
  if (active.reason === "timeout") {
    status = "failed";
    summary = `Timed out after ${Math.round(config.runTimeoutMs / 60_000)} minutes (HQ_RUN_TIMEOUT_MINUTES).`;
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
      db.prepare("UPDATE tasks SET status = 'done', updated_at = ? WHERE run_id = ? AND status = 'in_progress'").run(
        at,
        run.id,
      );
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
  if (status === "failed") {
    const text = withLine(
      strings.notify.runFailed({ room: room.name, agent: agent.name, runId: run.id, summary }),
      runLinkLine(run.id, p.deps.env),
    );
    if (await p.send(text)) recordBotMessage(db, text, "alert");
  }
  // A brief or a recap agent delivers its text this way: its summary is the message.
  if (status === "done" && agent.notifyRuns === "summary") {
    let sent = false;
    const link = deskLinkLine(p.deps.env);
    for (const part of appendLine(toTelegramMessages(summary), link)) sent = (await p.send(part)) || sent;
    if (sent) recordBotMessage(db, withLine(summary, link), "summary");
  }
}
