import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { strings } from "../ui/strings";
import type { HqConfig } from "./config";
import { now, type Db, type EventRow, type RunRow } from "./db";
import { ZERO_USAGE, type Usage } from "./engine";
import { HqError } from "./errors";
import type { Agent, Home } from "./rooms";

// Long runs: what happens when a run reaches its soft deadline
// (HQ_RUN_TIMEOUT_MINUTES). Without a supervisor in the home, the run is
// interrupted, as it always was. With one, MyHQ wakes the supervisor with a
// task « long run to check » and pushes the deadline by a few minutes while it
// decides: hq_run_extend gives the run more time, hq_run_stop interrupts it.
// Without a decision in that wait, the run goes on by slices, and a note goes
// on the Standard: a run is never interrupted for want of an answer. The hard
// limit (HQ_RUN_HARD_LIMIT_MINUTES) always interrupts it. The runner owns the
// timer and asks `atDeadline` what to do each time it fires; the HQ MCP
// server, another process, writes the supervisor's decisions to
// `run_deadlines`, which the runner reads again. This module imports nothing
// that reads the runner at load time: the runner imports it. See
// docs/architecture.md, "Long runs".

/** Why MyHQ started a run of the supervisor to check a long run (`runs.reason`). */
export const LONG_RUN_REASON = "long_run";
/** How long MyHQ waits for the supervisor's decision before it gives the run a slice on its own. */
export const CHECK_WAIT_MS = 5 * 60_000;
/** hq_run_extend gives this many minutes at least, and at most. */
export const EXTEND_MIN_MINUTES = 10;
export const EXTEND_MAX_MINUTES = 60;
/** hq_run_status gives this many of the latest events. */
const STATUS_EVENTS = 20;
/** The repeated tool calls are looked for among this many of the latest tool calls. */
const REPEAT_WINDOW = 30;
/** The window of the activity counts of hq_run_status. */
const RECENT_MS = 10 * 60_000;
/** The most characters of an event's detail, and of a task text, in hq_run_status. */
const DETAIL_MAX = 300;
const TASK_MAX = 1_500;

export type DeadlineRow = {
  run_id: number;
  budget_usd: number;
  deadline_at: string;
  hard_deadline_at: string;
  extensions: number;
  checks: number;
  slices: number;
  check_asked_at: string | null;
  check_run_id: number | null;
  note_task_id: number | null;
  stop_reason: string | null;
  stop_room: string | null;
  stop_agent: string | null;
  stop_requested_at: string | null;
  updated_at: string;
};

const iso = (ms: number) => new Date(ms).toISOString();
const minutesOf = (ms: number) => Math.round(ms / 60_000);

/** Recorded by the runner when a run starts: its budget, its soft deadline and its hard limit. */
export function recordDeadlines(db: Db, runId: number, budgetUsd: number, softAt: number, hardAt: number): void {
  db.prepare(
    `INSERT OR REPLACE INTO run_deadlines (run_id, budget_usd, deadline_at, hard_deadline_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(runId, budgetUsd, iso(Math.min(softAt, hardAt)), iso(hardAt), now());
}

export function readDeadlines(db: Db, runId: number): DeadlineRow | undefined {
  return db.prepare("SELECT * FROM run_deadlines WHERE run_id = ?").get(runId) as DeadlineRow | undefined;
}

/** The supervisor MyHQ wakes: the first one of the home (room, then agent order), as for the Standard. */
export function firstSupervisor(home: Home): { room: string; agent: Agent } | null {
  for (const room of home.rooms) {
    const agent = room.agents.find((each) => each.supervisor);
    if (agent) return { room: room.name, agent };
  }
  return null;
}

const nameIn = (home: Home, room: string, agentId: string): string =>
  home.rooms.find((each) => each.name === room)?.agents.find((each) => each.id === agentId)?.name ?? agentId;

/** The task of the supervisor's check of a long run. */
export function checkTask(p: {
  run: RunRow;
  agentName: string;
  minutes: number;
  timeoutMinutes: number;
  waitMinutes: number;
  sliceMinutes: number;
  hardMinutes: number;
}): string {
  const text = p.run.task.replace(/\s+/g, " ").trim();
  const task = text.length > 500 ? `${text.slice(0, 500)}...` : text;
  return [
    `Long run to check: run #${p.run.id} of ${p.run.room}/${p.run.agent_id} (${p.agentName}) has been running for ${p.minutes} minutes, past the timeout of ${p.timeoutMinutes} minutes. Its task: ${task}`,
    `Read hq_run_status { runId: ${p.run.id} }, then decide as your role says: hq_run_extend { runId: ${p.run.id}, minutes } when it progresses, hq_run_stop { runId: ${p.run.id}, reason } when it is clearly stuck.`,
    `Without a decision within ${p.waitMinutes} minutes, MyHQ lets it go on by slices of ${p.sliceMinutes} minutes, up to the hard limit of ${p.hardMinutes} minutes after its start.`,
  ].join("\n");
}

/** What the runner does when the timer of a run fires. */
export type DeadlineDecision =
  | { kind: "interrupt"; why: "timeout" | "hard_limit" }
  | { kind: "stop" }
  | { kind: "wait"; until: number };

/**
 * The runner's timer fired for this run: interrupt it (no supervisor, or the
 * hard limit), stop it (hq_run_stop), or wait until the time this returns.
 * At the soft deadline, the first time or after a slice, the supervisor is
 * woken with a check (`start`), and the deadline moves `waitMs` later; when
 * that wait is over without a decision, or when the check could not start
 * (supervisor busy, daily cap, failure), the run gets a slice of
 * `config.runTimeoutMs` and the Standard gets a note. The supervisor's own run
 * has nobody to check it: it is interrupted as without a supervisor.
 */
export function atDeadline(p: {
  config: HqConfig;
  db: Db;
  home: Home;
  run: RunRow;
  at: number;
  waitMs: number;
  /** Starts the supervisor's check (startRun); throws when it cannot start. */
  start: (request: { room: string; agent: string; task: string; reason: string }) => RunRow;
}): DeadlineDecision {
  const { config, db, home, run, at } = p;
  const row = readDeadlines(db, run.id);
  if (!row) return { kind: "interrupt", why: "timeout" };
  if (row.stop_requested_at) return { kind: "stop" };
  const hard = Date.parse(row.hard_deadline_at);
  if (at >= hard) return { kind: "interrupt", why: "hard_limit" };
  const due = Date.parse(row.deadline_at);
  if (due > at) return { kind: "wait", until: due };
  const supervisor = firstSupervisor(home);
  if (!supervisor || (supervisor.room === run.room && supervisor.agent.id === run.agent_id)) {
    return { kind: "interrupt", why: "timeout" };
  }

  const started = Date.parse(run.started_at);
  if (row.check_asked_at === null) {
    const task = checkTask({
      run,
      agentName: nameIn(home, run.room, run.agent_id),
      minutes: minutesOf(at - started),
      timeoutMinutes: minutesOf(config.runTimeoutMs),
      waitMinutes: minutesOf(p.waitMs),
      sliceMinutes: minutesOf(config.runTimeoutMs),
      hardMinutes: minutesOf(hard - started),
    });
    let check: RunRow | null = null;
    try {
      check = p.start({ room: supervisor.room, agent: supervisor.agent.id, task, reason: LONG_RUN_REASON });
    } catch (error) {
      // A busy supervisor, the cap, a failure: no answer will come, the run gets its slice at once.
      if (!(error instanceof HqError)) console.error(`[long-runs] could not wake the supervisor for run #${run.id}`, error);
    }
    if (check) {
      const until = Math.min(hard, at + p.waitMs);
      db.prepare(
        "UPDATE run_deadlines SET check_asked_at = ?, check_run_id = ?, checks = checks + 1, deadline_at = ?, updated_at = ? WHERE run_id = ?",
      ).run(iso(at), check.id, iso(until), now(), run.id);
      return { kind: "wait", until };
    }
  }
  return { kind: "wait", until: giveSlice(p, row, supervisor, hard) };
}

/**
 * No decision of the supervisor: the run goes on for a slice (never past the
 * hard limit), the next deadline asks the supervisor again, and the Standard
 * shows one note per run (a blocked task of the supervisor, kept up to date).
 */
function giveSlice(
  p: { config: HqConfig; db: Db; home: Home; run: RunRow; at: number },
  row: DeadlineRow,
  supervisor: { room: string; agent: Agent },
  hard: number,
): number {
  const { config, db, home, run, at } = p;
  const until = Math.min(hard, at + config.runTimeoutMs);
  const started = Date.parse(run.started_at);
  const note = strings.deskModules.standard.longRunNoAnswer({
    supervisor: supervisor.agent.name,
    runId: run.id,
    agent: nameIn(home, run.room, run.agent_id),
    minutes: minutesOf(at - started),
    slice: minutesOf(config.runTimeoutMs),
    hard: minutesOf(hard - started),
  });
  const stamp = now();
  db.transaction(() => {
    const kept =
      row.note_task_id !== null &&
      db.prepare("UPDATE tasks SET note = ?, updated_at = ? WHERE id = ? AND status = 'blocked'").run(note, stamp, row.note_task_id).changes > 0;
    let noteTask = row.note_task_id;
    if (!kept) {
      noteTask = Number(
        db
          .prepare(
            `INSERT INTO tasks (room, agent_id, source, text, status, note, created_at, updated_at)
             VALUES (?, ?, 'manual', ?, 'blocked', ?, ?, ?)`,
          )
          .run(
            supervisor.room,
            supervisor.agent.id,
            `Long run to check: run #${run.id} of ${run.room}/${run.agent_id}. Read hq_run_status { runId: ${run.id} } and decide with hq_run_extend or hq_run_stop.`,
            note,
            stamp,
            stamp,
          ).lastInsertRowid,
      );
    }
    db.prepare(
      "UPDATE run_deadlines SET check_asked_at = NULL, slices = slices + 1, deadline_at = ?, note_task_id = ?, updated_at = ? WHERE run_id = ?",
    ).run(iso(until), noteTask, stamp, run.id);
  }).immediate();
  return until;
}

// --- The supervisor's tools (the HQ MCP server) ------------------------------------------

type Actor = { room: string; agentId: string };

/** The run a supervisor acts on: in progress, not its own, with its deadlines. */
function runningTarget(db: Db, by: Actor, runId: number): { run: RunRow; row: DeadlineRow } {
  const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow | undefined;
  if (!run) throw new HqError("RUN_NOT_FOUND", 404, `No run #${runId}.`);
  if (run.status !== "running") throw new HqError("NOT_RUNNING", 409, `Run #${runId} is no longer in progress (${run.status}): nothing to decide.`);
  if (run.room === by.room && run.agent_id === by.agentId) throw new HqError("OWN_RUN", 409, "This run is yours: a supervisor never decides on its own run.");
  const row = readDeadlines(db, runId);
  if (!row) throw new HqError("NO_DEADLINE", 409, `Run #${runId} was started by an earlier MyHQ: it has no deadline to move.`);
  return { run, row };
}

export type ExtendResult = {
  runId: number;
  deadlineAt: string;
  hardDeadlineAt: string;
  extensions: number;
  /** The hard limit came first: the run has less than the minutes asked. */
  cappedByHardLimit: boolean;
};

/**
 * hq_run_extend: the run goes on until `minutes` from now (never earlier than
 * its current deadline, never past its hard limit), and the extension is
 * counted. The check waiting for a decision is answered.
 */
export function extendRun(db: Db, by: Actor, runId: number, minutes: number, at: number = Date.now()): ExtendResult {
  return db
    .transaction((): ExtendResult => {
      const { row } = runningTarget(db, by, runId);
      const hard = Date.parse(row.hard_deadline_at);
      if (at >= hard) throw new HqError("HARD_LIMIT", 409, `Run #${runId} is at its hard limit (${row.hard_deadline_at}): it cannot be extended.`);
      const wanted = at + minutes * 60_000;
      const until = Math.min(hard, Math.max(Date.parse(row.deadline_at), wanted));
      db.prepare(
        "UPDATE run_deadlines SET deadline_at = ?, extensions = extensions + 1, check_asked_at = NULL, updated_at = ? WHERE run_id = ?",
      ).run(iso(until), now(), runId);
      return { runId, deadlineAt: iso(until), hardDeadlineAt: row.hard_deadline_at, extensions: row.extensions + 1, cappedByHardLimit: wanted > hard };
    })
    .immediate();
}

/**
 * hq_run_stop: the stop is recorded with its reason; the app interrupts the
 * run at once (`stopsFor`, from the wake-up that follows the tool result).
 */
export function requestStop(db: Db, by: Actor, runId: number, reason: string): { runId: number; stopping: true; already: boolean } {
  return db
    .transaction(() => {
      const { row } = runningTarget(db, by, runId);
      if (row.stop_requested_at) return { runId, stopping: true as const, already: true };
      const stamp = now();
      db.prepare(
        `UPDATE run_deadlines SET stop_reason = ?, stop_room = ?, stop_agent = ?, stop_requested_at = ?, check_asked_at = NULL, updated_at = ?
         WHERE run_id = ?`,
      ).run(reason, by.room, by.agentId, stamp, stamp, runId);
      return { runId, stopping: true as const, already: false };
    })
    .immediate();
}

/** Of these runs, the ones a supervisor asked to stop. */
export function stopsFor(db: Db, runIds: readonly number[]): DeadlineRow[] {
  if (runIds.length === 0) return [];
  return db
    .prepare("SELECT * FROM run_deadlines WHERE stop_requested_at IS NOT NULL AND run_id IN (SELECT value FROM json_each(?))")
    .all(JSON.stringify(runIds)) as DeadlineRow[];
}

/** The summary of a run a supervisor stopped. */
export function stoppedSummary(row: DeadlineRow, byName: string, minutes: number): string {
  return `Stopped by ${byName} (supervisor) after ${minutes} minutes: ${row.stop_reason ?? ""}`.trim();
}

// --- hq_run_status -----------------------------------------------------------------------

/** USD per million tokens, at the API prices of the current models: an estimate, the CLI applies the real budget. */
const PRICES = {
  opus: { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  sonnet: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  haiku: { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
} as const;

function family(model: string | null | undefined): keyof typeof PRICES | null {
  const name = (model ?? "").toLowerCase();
  return (Object.keys(PRICES) as (keyof typeof PRICES)[]).find((key) => name.includes(key)) ?? null;
}

const journalLine = z.looseObject({
  type: z.literal("assistant"),
  message: z.looseObject({
    id: z.string(),
    usage: z
      .looseObject({
        input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
        cache_creation_input_tokens: z.number().optional(),
        cache_read_input_tokens: z.number().optional(),
      })
      .optional(),
  }),
});

/**
 * The tokens of a run so far, from its journal (`<runs>/<id>.jsonl`, the
 * stream-json lines): the usage of each model call, once per message id (the
 * CLI repeats a message for each of its blocks). Zero when there is no journal.
 */
export function journalUsage(file: string): Usage {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { ...ZERO_USAGE };
  }
  const calls = new Map<string, Usage>();
  for (const line of text.split("\n")) {
    if (!line.includes('"assistant"')) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = journalLine.safeParse(raw);
    if (!parsed.success || !parsed.data.message.usage) continue;
    const u = parsed.data.message.usage;
    const before = calls.get(parsed.data.message.id) ?? ZERO_USAGE;
    calls.set(parsed.data.message.id, {
      inputTokens: Math.max(before.inputTokens, u.input_tokens ?? 0),
      outputTokens: Math.max(before.outputTokens, u.output_tokens ?? 0),
      cacheCreationInputTokens: Math.max(before.cacheCreationInputTokens, u.cache_creation_input_tokens ?? 0),
      cacheReadInputTokens: Math.max(before.cacheReadInputTokens, u.cache_read_input_tokens ?? 0),
    });
  }
  const total = { ...ZERO_USAGE };
  for (const u of calls.values()) {
    total.inputTokens += u.inputTokens;
    total.outputTokens += u.outputTokens;
    total.cacheCreationInputTokens += u.cacheCreationInputTokens;
    total.cacheReadInputTokens += u.cacheReadInputTokens;
  }
  return total;
}

/** The estimated cost of these tokens for a model, null when the model is not known. */
export function estimateCostUsd(usage: Usage, model: string | null | undefined): number | null {
  const key = family(model);
  if (!key) return null;
  const price = PRICES[key];
  const usd =
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheCreationInputTokens * price.cacheWrite +
      usage.cacheReadInputTokens * price.cacheRead) /
    1_000_000;
  return Math.round(usd * 10_000) / 10_000;
}

const cut = (text: string, max = DETAIL_MAX) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}...` : line;
};

function parseData(event: EventRow): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(event.data);
    return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const str = (value: unknown) => (typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value));

/** One event in a line, as hq_run_status gives it. */
function eventDetail(event: EventRow): string {
  const data = parseData(event);
  switch (event.type) {
    case "start":
      return cut(`model ${str(data.model) || "unknown"}`);
    case "text":
      return cut(str(data.text));
    case "tool_call":
      return cut(`${str(data.name)} ${str(data.input)}`);
    case "tool_result":
      return cut(`${data.isError === true ? "error: " : ""}${str(data.content)}`);
    case "end":
      return cut(`${str(data.status)}: ${str(data.summary)}`);
    default:
      return cut(event.data);
  }
}

export type LongRunStatus = {
  run: {
    id: number;
    room: string;
    agent: string;
    agentName: string;
    model: string | null;
    status: RunRow["status"];
    reason: string | null;
    task: string;
    taskTruncated: boolean;
    startedAt: string;
    endedAt: string | null;
    minutes: number;
  };
  deadlines: {
    deadlineAt: string;
    hardDeadlineAt: string;
    extensions: number;
    checks: number;
    slices: number;
    stopRequested: boolean;
  } | null;
  cost: {
    /** The cost so far: the real one once the run ended, an estimate from its tokens while it runs. */
    usd: number | null;
    estimated: boolean;
    budgetUsd: number | null;
    /** usd / budgetUsd, null when either is unknown. */
    shareOfBudget: number | null;
    tokens: Usage;
  };
  lastEventAt: string | null;
  events: { at: string; type: string; detail: string }[];
  hints: {
    /** Since the last event (or the start when there is none). */
    minutesSinceLastEvent: number;
    eventsLast10Minutes: number;
    toolCallsLast10Minutes: number;
    /** How many identical tool calls (same tool, same input) in a row end the run's activity. */
    trailingIdenticalCalls: number;
    /** The most repeated identical call among the latest tool calls, when one repeats. */
    mostRepeatedCall: { tool: string; input: string; count: number; outOf: number } | null;
  };
};

/**
 * hq_run_status: who runs, for how long, what it costs against its budget,
 * its latest events, and the hints MyHQ computes: the minutes without
 * activity, and the identical tool calls repeated. Read-only.
 */
export function runStatus(db: Db, home: Home, runsDir: string, runId: number, at: number = Date.now()): LongRunStatus {
  const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow | undefined;
  if (!run) throw new HqError("RUN_NOT_FOUND", 404, `No run #${runId}.`);
  const agent = home.rooms.find((each) => each.name === run.room)?.agents.find((each) => each.id === run.agent_id) ?? null;
  const row = readDeadlines(db, runId);
  const events = (db.prepare("SELECT * FROM events WHERE run_id = ? ORDER BY id DESC LIMIT ?").all(runId, STATUS_EVENTS) as EventRow[]).reverse();
  const start = db.prepare("SELECT * FROM events WHERE run_id = ? AND type = 'start' ORDER BY id LIMIT 1").get(runId) as EventRow | undefined;
  const model = (start ? str(parseData(start).model) : "") || agent?.model || null;

  const running = run.status === "running";
  const tokens: Usage = running
    ? journalUsage(path.join(runsDir, `${runId}.jsonl`))
    : {
        inputTokens: run.input_tokens,
        outputTokens: run.output_tokens,
        cacheCreationInputTokens: run.cache_creation_input_tokens,
        cacheReadInputTokens: run.cache_read_input_tokens,
      };
  const usd = running ? estimateCostUsd(tokens, model) : run.cost_usd;
  const budgetUsd = row?.budget_usd ?? agent?.maxBudgetUsd ?? null;

  const last = db.prepare("SELECT MAX(created_at) AS at FROM events WHERE run_id = ?").get(runId) as { at: string | null };
  const recentFrom = iso(at - RECENT_MS);
  const recent = db
    .prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN type = 'tool_call' THEN 1 ELSE 0 END) AS calls FROM events WHERE run_id = ? AND created_at >= ?")
    .get(runId, recentFrom) as { n: number; calls: number | null };
  const calls = (
    db.prepare("SELECT * FROM events WHERE run_id = ? AND type = 'tool_call' ORDER BY id DESC LIMIT ?").all(runId, REPEAT_WINDOW) as EventRow[]
  ).map((event) => {
    const data = parseData(event);
    return { tool: str(data.name), input: str(data.input) };
  });
  const key = (call: { tool: string; input: string }) => `${call.tool}\u0000${call.input}`;
  let trailing = 0;
  if (calls.length > 0) while (trailing < calls.length && key(calls[trailing]!) === key(calls[0]!)) trailing++;
  const counts = new Map<string, { tool: string; input: string; count: number }>();
  for (const call of calls) {
    const seen = counts.get(key(call));
    if (seen) seen.count++;
    else counts.set(key(call), { ...call, count: 1 });
  }
  const top = [...counts.values()].sort((a, b) => b.count - a.count)[0];

  const ended = run.ended_at ? Date.parse(run.ended_at) : at;
  const lastAt = last.at ? Date.parse(last.at) : Date.parse(run.started_at);
  const task = run.task.trim();
  return {
    run: {
      id: run.id,
      room: run.room,
      agent: run.agent_id,
      agentName: agent?.name ?? run.agent_id,
      model,
      status: run.status,
      reason: run.reason,
      task: task.slice(0, TASK_MAX),
      taskTruncated: task.length > TASK_MAX,
      startedAt: run.started_at,
      endedAt: run.ended_at,
      minutes: minutesOf(ended - Date.parse(run.started_at)),
    },
    deadlines: row
      ? {
          deadlineAt: row.deadline_at,
          hardDeadlineAt: row.hard_deadline_at,
          extensions: row.extensions,
          checks: row.checks,
          slices: row.slices,
          stopRequested: row.stop_requested_at !== null,
        }
      : null,
    cost: {
      usd,
      estimated: running,
      budgetUsd,
      shareOfBudget: usd !== null && budgetUsd ? Math.round((usd / budgetUsd) * 100) / 100 : null,
      tokens,
    },
    lastEventAt: last.at,
    events: events.map((event) => ({ at: event.created_at, type: event.type, detail: eventDetail(event) })),
    hints: {
      minutesSinceLastEvent: Math.max(0, Math.round(((running ? at : ended) - lastAt) / 6_000) / 10),
      eventsLast10Minutes: recent.n,
      toolCallsLast10Minutes: recent.calls ?? 0,
      trailingIdenticalCalls: trailing,
      mostRepeatedCall: top && top.count > 1 ? { tool: top.tool, input: cut(top.input), count: top.count, outOf: calls.length } : null,
    },
  };
}
