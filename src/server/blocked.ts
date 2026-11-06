import { z } from "zod";
import { strings } from "../ui/strings";
import { RECEPTION_ROOM } from "../ui/reception";
import { liveConfig, type HqConfig } from "./config";
import { now, type Db, type RunRow, type TaskRow } from "./db";
import { HqError } from "./errors";
import { readDeadlines } from "./long-runs";
import { RELAUNCH_REASON } from "./relaunch-requests";
import { resourceHolder } from "./resources";
import type { Agent, Home } from "./rooms";
import {
  isStopping,
  pairWokeRecently,
  runsToday,
  startRun,
  WAITS,
  WAKE_TASK,
  wakesAgent,
  type RunnerDeps,
  type WakeCandidate,
} from "./runner";

// What is stuck at the agents (the `blocked` source of the desk, the
// Standard): the blocked tasks, the pending tasks that nothing will take on
// its own, and the failed or interrupted runs whose tasks were not taken
// again. Two actions act on an entry: relaunch it (its tasks go back to
// pending and the agent is woken at once) or close it (its tasks are done).
// A supervisor's note (supervisor.ts) is shown on its entry, and an entry
// handed to the owner comes first. See docs/architecture.md, "The Standard".

/** A pending task counts as stuck once it is this old. */
export const STUCK_PENDING_MS = 15 * 60_000;
/** The failed or interrupted runs looked at: the ones that ended in this window. */
export const FAILED_RUN_WINDOW_MS = 24 * 60 * 60_000;
/** Why a relaunch started a run (`runs.reason`). */
export { RELAUNCH_REASON };
/** A reason longer than this (an agent's note, a run summary) is cut. */
const REASON_MAX = 400;

export type BlockedEntry = {
  /** `task`: a blocked task; `pending`: a pending task nothing takes; `run`: a failed or interrupted run. */
  entry: "task" | "pending" | "run";
  /** The task id, or the run id for a run. */
  id: number;
  room: string;
  agentId: string;
  /** The agent's name in the home, its id when the home no longer has it. */
  agentName: string;
  state: "blocked" | "pending" | "failed" | "cancelled";
  /** Since when it is stuck: the block, the creation of the pending task, the end of the run. */
  since: string;
  /** Why, in one sentence (French, as the interface shows it). */
  reason: string;
  /** The text of the task, or the instruction of the run. */
  text: string;
  /** The tasks the actions act on. */
  taskIds: number[];
  /** The latest note of a supervisor on these tasks (hq_blocked_note), null when there is none. */
  note: BlockedNote | null;
  /** A supervisor handed it to the owner: the owner is the one to act, and it is listed first. */
  handedOff: boolean;
};

export type BlockedNote = {
  /** For the owner, in French: what the supervisor did, or what it expects from the owner. */
  text: string;
  /** The supervisor that wrote it. */
  room: string;
  agentId: string;
  agentName: string;
  at: string;
};

const oneLine = (text: string | null | undefined): string => {
  const line = (text ?? "").replace(/\s+/g, " ").trim();
  return line.length > REASON_MAX ? `${line.slice(0, REASON_MAX).trimEnd()}...` : line;
};

const placeholders = (ids: readonly number[]) => ids.map(() => "?").join(", ");

/** Sources whose pending tasks MyHQ wakes on its own (`wakeAgents`); a `manual` one waits for the agent's next run. */
const WAKE_SOURCES = new Set<string>(["approval", "message", "revise", "chat"]);

/**
 * The tasks of a failed or interrupted run that were not taken again: its
 * own instruction, still blocked, and the mailbox tasks it gave back, still
 * pending (they lost their run id, but were given back at the very instant
 * the run ended, see `execute` in runner.ts).
 */
function runTaskIds(db: Db, run: RunRow): number[] {
  return (
    db
      .prepare(
        `SELECT id FROM tasks
         WHERE (run_id = ? AND status = 'blocked')
            OR (room = ? AND agent_id = ? AND status = 'pending' AND run_id IS NULL AND updated_at = ?)
         ORDER BY id`,
      )
      .all(run.id, run.room, run.agent_id, run.ended_at ?? "") as { id: number }[]
  ).map((row) => row.id);
}

/** The instruction of a run, then the text of each mailbox task it gave back, as a Markdown list. */
function runText(db: Db, run: RunRow, taskIds: readonly number[]): string {
  const given = (
    db.prepare(`SELECT text FROM tasks WHERE id IN (${placeholders(taskIds)}) AND source <> 'manual' ORDER BY id`).all(...taskIds) as {
      text: string;
    }[]
  ).map((row) => `- ${row.text.replace(/\s+/g, " ").trim()}`);
  return given.length > 0 ? `${run.task}\n\n${given.join("\n")}` : run.task;
}

/** Why a pending task is stuck, or null when it is not (a wake-up will take it, or it waits by design). */
function pendingReason(db: Db, config: HqConfig, home: Home, task: TaskRow, agent: Agent | null): string | null {
  const r = strings.deskModules.standard.reasons;
  if (!agent && task.room !== RECEPTION_ROOM) return r.unknownAgent;
  const wakes = WAKE_SOURCES.has(task.source);
  // Waiting for the agent's next run is what `"queue"` asks for: not a block.
  if (wakes && agent && !wakesAgent(agent, task.source as WakeCandidate["source"])) return null;
  const running = db
    .prepare("SELECT id, started_at FROM runs WHERE room = ? AND agent_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1")
    .get(task.room, task.agent_id) as { id: number; started_at: string } | undefined;
  if (running) {
    // The end of the run wakes the agent again for a task newer than it.
    if (wakes && task.created_at > running.started_at) return null;
    return r.busy(running.id);
  }
  const later = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status <> 'cancelled' THEN 1 ELSE 0 END) AS taken,
         SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
       FROM runs WHERE room = ? AND agent_id = ? AND started_at >= ?`,
    )
    .get(task.room, task.agent_id, task.created_at) as { taken: number | null; cancelled: number | null };
  const taken = later.taken ?? 0;
  const cancelled = later.cancelled ?? 0;
  if (wakes && taken === 0 && cancelled <= 1) {
    // `wakeAgents` would take it: what holds it back is what holds back a run.
    if (isStopping()) return r.stopping;
    const today = runsToday(db);
    const cap = liveConfig(config).maxRunsPerDay;
    if (today >= cap) return r.cap(today, cap);
    const holder = resourceHolder(db, agent?.resources ?? []);
    if (holder) return r.resource(holder.resource, holder.runId, `${holder.room} / ${holder.agentId}`);
    if (task.source === "message" && config.messageWakeIntervalMs > 0) {
      const since = new Date(Date.now() - config.messageWakeIntervalMs).toISOString();
      const candidate: WakeCandidate = {
        room: task.room,
        agent_id: task.agent_id,
        source: "message",
        from_room: task.from_room,
        from_agent: task.from_agent,
      };
      if (pairWokeRecently(db, candidate, since)) {
        const sender = home.rooms.find((room) => room.name === task.from_room)?.agents.find((each) => each.id === task.from_agent);
        return r.pingPong(sender?.name ?? task.from_agent ?? "", Math.round(config.messageWakeIntervalMs / 60_000));
      }
    }
    return r.notWoken;
  }
  if (!wakes) return r.noWake;
  if (taken === 0 && cancelled > 1) return r.interruptedTwice;
  const last = db
    .prepare("SELECT id, status FROM runs WHERE room = ? AND agent_id = ? AND started_at >= ? ORDER BY id DESC LIMIT 1")
    .get(task.room, task.agent_id, task.created_at) as { id: number; status: string } | undefined;
  return last?.status === "failed" ? r.givenBack(last.id) : r.noWake;
}

/** Everything stuck at the agents, newest first. */
export function listBlocked(db: Db, home: Home, config: HqConfig, at: Date = new Date()): BlockedEntry[] {
  const r = strings.deskModules.standard.reasons;
  const agentOf = (room: string, id: string): Agent | null =>
    home.rooms.find((each) => each.name === room)?.agents.find((each) => each.id === id) ?? null;
  const nameOf = (room: string, id: string): string => agentOf(room, id)?.name ?? id;
  const entries: BlockedEntry[] = [];
  const listed = new Set<number>();

  // The failed or interrupted runs of the window, unless a later run of the agent did the same work.
  const runs = db
    .prepare(
      `SELECT * FROM runs r
       WHERE r.status IN ('failed', 'cancelled') AND r.ended_at >= ?
         AND NOT EXISTS (SELECT 1 FROM runs n WHERE n.room = r.room AND n.agent_id = r.agent_id AND n.id > r.id
           AND n.task = r.task AND n.status IN ('done', 'running'))
       ORDER BY r.id`,
    )
    .all(new Date(at.getTime() - FAILED_RUN_WINDOW_MS).toISOString()) as RunRow[];
  // A run a supervisor stopped, or that reached its hard limit, says so (long-runs.ts).
  const failedReason = (run: RunRow): string => {
    const deadlines = readDeadlines(db, run.id);
    if (deadlines?.stop_requested_at) {
      return r.runStopped(run.id, nameOf(deadlines.stop_room ?? "", deadlines.stop_agent ?? ""), oneLine(deadlines.stop_reason));
    }
    if (deadlines && run.ended_at && run.ended_at >= deadlines.hard_deadline_at) {
      return r.runHardLimit(run.id, Math.round((Date.parse(deadlines.hard_deadline_at) - Date.parse(run.started_at)) / 60_000));
    }
    return r.runFailed(run.id, oneLine(run.summary));
  };
  for (const run of runs) {
    const taskIds = runTaskIds(db, run);
    if (taskIds.length === 0) continue;
    for (const id of taskIds) listed.add(id);
    entries.push({
      entry: "run",
      id: run.id,
      room: run.room,
      agentId: run.agent_id,
      agentName: nameOf(run.room, run.agent_id),
      state: run.status === "cancelled" ? "cancelled" : "failed",
      since: run.ended_at ?? run.started_at,
      reason: run.status === "cancelled" ? r.runCancelled(run.id) : failedReason(run),
      text: runText(db, run, taskIds),
      taskIds,
      note: null,
      handedOff: false,
    });
  }

  // The blocked tasks; the instruction of a failed or interrupted run belongs to that run.
  const blocked = db
    .prepare(
      `SELECT t.* FROM tasks t WHERE t.status = 'blocked'
         AND NOT (t.source = 'manual' AND EXISTS (SELECT 1 FROM runs r WHERE r.id = t.run_id AND r.status IN ('failed', 'cancelled')))
       ORDER BY t.id`,
    )
    .all() as TaskRow[];
  for (const task of blocked) {
    if (listed.has(task.id)) continue;
    const note = oneLine(task.note);
    // MyHQ's own note on a long run the supervisor did not answer about (long-runs.ts): said as written.
    const myhqNote = db.prepare("SELECT 1 FROM run_deadlines WHERE note_task_id = ?").get(task.id) !== undefined;
    entries.push({
      entry: "task",
      id: task.id,
      room: task.room,
      agentId: task.agent_id,
      agentName: nameOf(task.room, task.agent_id),
      state: "blocked",
      since: task.updated_at,
      reason: myhqNote && note ? note : note ? r.blocked(note) : r.blockedNoNote,
      text: task.text,
      taskIds: [task.id],
      note: null,
      handedOff: false,
    });
  }

  // The pending tasks older than the threshold that nothing will take on its own.
  const pending = db
    .prepare("SELECT * FROM tasks WHERE status = 'pending' AND created_at <= ? ORDER BY id")
    .all(new Date(at.getTime() - STUCK_PENDING_MS).toISOString()) as TaskRow[];
  for (const task of pending) {
    if (listed.has(task.id)) continue;
    const reason = pendingReason(db, config, home, task, agentOf(task.room, task.agent_id));
    if (reason === null) continue;
    entries.push({
      entry: "pending",
      id: task.id,
      room: task.room,
      agentId: task.agent_id,
      agentName: nameOf(task.room, task.agent_id),
      state: "pending",
      since: task.created_at,
      reason,
      text: task.text,
      taskIds: [task.id],
      note: null,
      handedOff: false,
    });
  }

  // The latest supervisor note of each entry; what was handed to the owner comes first.
  const latest = db.prepare(
    `SELECT room, agent_id, text, handed_off, created_at FROM blocked_notes WHERE task_id IN (SELECT value FROM json_each(?))
     ORDER BY id DESC LIMIT 1`,
  );
  for (const entry of entries) {
    const row = latest.get(JSON.stringify(entry.taskIds)) as
      | { room: string; agent_id: string; text: string; handed_off: number; created_at: string }
      | undefined;
    if (!row) continue;
    entry.note = { text: row.text, room: row.room, agentId: row.agent_id, agentName: nameOf(row.room, row.agent_id), at: row.created_at };
    entry.handedOff = row.handed_off === 1;
  }
  return entries.sort(
    (a, b) => Number(b.handedOff) - Number(a.handedOff) || b.since.localeCompare(a.since) || b.id - a.id,
  );
}

/** The count of the Standard: the agents that have something stuck. */
export const stuckAgents = (entries: readonly BlockedEntry[]): number =>
  new Set(entries.map((entry) => `${entry.room}/${entry.agentId}`)).size;

// --- The actions -----------------------------------------------------------------------

/** What an action acts on: a task (blocked or pending), or a failed or interrupted run and its tasks. */
export const blockedTargetSchema = z.strictObject({
  kind: z.enum(["task", "run"]),
  id: z.number().int().positive(),
});
export type BlockedTarget = z.infer<typeof blockedTargetSchema>;

/** The open tasks of a target, with their agent. Throws when there is nothing to act on. */
export function targetTasks(db: Db, target: BlockedTarget): { room: string; agentId: string; ids: number[] } {
  if (target.kind === "task") {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(target.id) as TaskRow | undefined;
    if (!task) throw new HqError("TASK_NOT_FOUND", 404, `No task #${target.id}.`);
    if (task.status !== "blocked" && task.status !== "pending") {
      throw new HqError("NOT_BLOCKED", 409, `Task #${target.id} is ${task.status}, neither blocked nor pending.`);
    }
    return { room: task.room, agentId: task.agent_id, ids: [task.id] };
  }
  const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(target.id) as RunRow | undefined;
  if (!run) throw new HqError("RUN_NOT_FOUND", 404, `No run #${target.id}.`);
  const ids = run.status === "failed" || run.status === "cancelled" ? runTaskIds(db, run) : [];
  if (ids.length === 0) {
    throw new HqError("NOT_BLOCKED", 409, `Run #${target.id} (${run.status}) has no task left blocked or given back.`);
  }
  return { room: run.room, agentId: run.agent_id, ids };
}

export type RelaunchResult = {
  /** The tasks put back to pending. */
  tasks: number[];
  /** The run started for them, null when the agent could not be woken. */
  run: RunRow | null;
  /** Why the agent could not be woken (the tasks wait, pending), null when it was. */
  waiting: { code: string; message: string } | null;
};

/**
 * Errors of a relaunch that leave the tasks pending, said to the owner rather than thrown. Built when
 * asked: this module and the runner import each other (through supervisor.ts), so WAITS may not exist yet
 * while this module loads.
 */
const relaunchWaits = () => new Set([...WAITS, "ROOM_NOT_FOUND", "AGENT_NOT_FOUND", "ROOM_INVALID"]);

/**
 * « Relancer »: the tasks of the target go back to pending, then the agent is
 * woken at once by a run that takes its mailbox (reason `relaunch`), under the
 * usual rules: the agent lock, the shared resources, the daily cap. When the
 * run cannot start, the tasks stay pending and the result says why.
 */
export function relaunchBlocked(config: HqConfig, db: Db, target: BlockedTarget, deps: RunnerDeps = {}): RelaunchResult {
  const { room, agentId, ids } = db
    .transaction(() => {
      const found = targetTasks(db, target);
      db.prepare(
        `UPDATE tasks SET status = 'pending', run_id = NULL, updated_at = ? WHERE id IN (${placeholders(found.ids)}) AND status IN ('blocked', 'pending')`,
      ).run(now(), ...found.ids);
      return found;
    })
    .immediate();
  try {
    const run = startRun({ room, agent: agentId, task: WAKE_TASK, reason: RELAUNCH_REASON }, { ...deps, config });
    return { tasks: ids, run, waiting: null };
  } catch (error) {
    if (error instanceof HqError && relaunchWaits().has(error.code)) {
      return { tasks: ids, run: null, waiting: { code: error.code, message: error.message } };
    }
    throw error;
  }
}

/**
 * « Clore »: the tasks of the target are done, with the note « close par le
 * propriétaire ». Nothing wakes.
 */
export function closeBlocked(db: Db, target: BlockedTarget): { tasks: number[] } {
  return db
    .transaction(() => {
      const { ids } = targetTasks(db, target);
      db.prepare(
        `UPDATE tasks SET status = 'done', note = ?, updated_at = ? WHERE id IN (${placeholders(ids)}) AND status IN ('blocked', 'pending')`,
      ).run(strings.deskModules.standard.closedNote, now(), ...ids);
      return { tasks: ids };
    })
    .immediate();
}
