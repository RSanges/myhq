import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Db } from "./db";
import type { QueueEntry } from "./queue";

// What a run is doing right now, read from its journal (the `events` table),
// for the surveillance room (docs/architecture.md, "The surveillance room"):
// the tool it is in (a call with no result yet), when its journal last moved,
// and the end of the output of its latest command moved to the background.
// Also the journal of the queue's waits (`task_waits`, migration 36): what
// held each pending task back, from when to when, so the time lost waiting
// can be counted.

/** How many of the latest tool events of a run are read to find the one in progress. */
const RECENT_TOOL_EVENTS = 200;
/** The end of a background command's output that the room shows. */
export const OUTPUT_TAIL_BYTES = 2048;
export const OUTPUT_TAIL_LINES = 12;
/** A detail of a tool (a command's description, a file name) is cut to this length. */
const DETAIL_MAX = 120;

/** The tool a run is in: its name, a short detail from its input, since when. */
export type LiveToolDto = { tool: string; detail: string | null; at: string };

export type LiveActivityDto = {
  /** The latest tool call of the run that has no result yet; null: none (the agent thinks or writes). */
  current: LiveToolDto | null;
  /** When the run's journal last moved (any event), null: nothing yet. */
  lastEventAt: string | null;
  /** The latest command the CLI moved to the background, with the end of its output; null: none. */
  background: (LiveToolDto & { output: string | null; outputAt: string | null }) | null;
};

const cut = (text: string): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > DETAIL_MAX ? `${line.slice(0, DETAIL_MAX - 3).trimEnd()}...` : line;
};

const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);

/**
 * A short detail of a tool call, from its input: what a command says it does
 * (its description, else its start), the name of the file read or written,
 * the pattern searched, what a subagent was asked. Null when nothing fits.
 */
export function toolDetail(name: string, input: unknown): string | null {
  const fields = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const file = str(fields.file_path) ?? str(fields.notebook_path) ?? str(fields.path);
  let detail: string | null;
  if (name === "Bash" || name === "PowerShell") detail = str(fields.description) ?? str(fields.command);
  else if (name === "Agent" || name === "Task") detail = str(fields.description) ?? str(fields.prompt);
  else if (name === "Grep" || name === "Glob") detail = str(fields.pattern);
  else if (name === "WebSearch") detail = str(fields.query);
  else if (name === "WebFetch") detail = str(fields.url);
  else if (file) detail = path.basename(file.replace(/\\/g, "/"));
  else detail = str(fields.text) ?? str(fields.description);
  return detail === null ? null : cut(detail);
}

/** The path of the output file a Bash result names when the CLI runs the command in the background, null otherwise. */
export function backgroundOutputPath(content: string): string | null {
  const match = /Output is being written to:\s*(\S[^\r\n]*?\.output)\b/.exec(content);
  return match ? match[1]!.trim() : null;
}

/**
 * The end of a background command's output: its last OUTPUT_TAIL_LINES lines
 * within OUTPUT_TAIL_BYTES, without terminal colours. Read only from a regular
 * `.output` file under the system's temporary folder (where the CLI writes
 * them), once links are followed: any other path, a missing file or one that
 * cannot be read gives null.
 */
export function readOutputTail(file: string, tmpDir: string = os.tmpdir()): { text: string; mtimeMs: number } | null {
  try {
    if (!path.isAbsolute(file) || path.extname(file) !== ".output") return null;
    const real = fs.realpathSync(file);
    const root = fs.realpathSync(tmpDir);
    const relative = path.relative(root, real);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    const handle = fs.openSync(real, "r");
    try {
      const stat = fs.fstatSync(handle);
      if (!stat.isFile()) return null;
      const length = Math.min(stat.size, OUTPUT_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      fs.readSync(handle, buffer, 0, length, stat.size - length);
      const text = buffer.toString("utf8").replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r(?!\n)/g, "\n");
      const lines = text.split(/\r?\n/);
      while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
      return { text: lines.slice(-OUTPUT_TAIL_LINES).join("\n"), mtimeMs: stat.mtimeMs };
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return null;
  }
}

type ToolEvent = { type: "tool_call" | "tool_result"; data: string; created_at: string };

/** What a run is doing, from its journal. `running`: a run that ended has no tool in progress and no background command to follow. */
export function readActivity(db: Db, runId: number, running: boolean, tmpDir?: string): LiveActivityDto {
  const last = db.prepare("SELECT MAX(created_at) AS at FROM events WHERE run_id = ?").get(runId) as { at: string | null };
  if (!running) return { current: null, lastEventAt: last.at, background: null };
  const rows = (
    db
      .prepare("SELECT type, data, created_at FROM events WHERE run_id = ? AND type IN ('tool_call', 'tool_result') ORDER BY id DESC LIMIT ?")
      .all(runId, RECENT_TOOL_EVENTS) as ToolEvent[]
  ).reverse();
  const calls = new Map<string, LiveToolDto>();
  const open: string[] = [];
  let background: { call: LiveToolDto; file: string } | null = null;
  for (const row of rows) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(row.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (row.type === "tool_call") {
      const id = str(data.id);
      const name = str(data.name);
      if (!id || !name) continue;
      calls.set(id, { tool: name, detail: toolDetail(name, data.input), at: row.created_at });
      open.push(id);
    } else {
      const id = str(data.toolUseId);
      if (!id) continue;
      const index = open.indexOf(id);
      if (index !== -1) open.splice(index, 1);
      const file = typeof data.content === "string" ? backgroundOutputPath(data.content) : null;
      const call = calls.get(id);
      if (file && call) background = { call: { ...call, at: row.created_at }, file };
    }
  }
  const currentId = open[open.length - 1];
  const current = currentId !== undefined ? calls.get(currentId)! : null;
  let shown: LiveActivityDto["background"] = null;
  if (background) {
    const tail = readOutputTail(background.file, tmpDir);
    shown = { ...background.call, output: tail?.text ?? null, outputAt: tail ? new Date(tail.mtimeMs).toISOString() : null };
  }
  return { current, lastEventAt: last.at, background: shown };
}

// --- The journal of the queue's waits ----------------------------------------------

/**
 * Writes what the queue says now into `task_waits`: a task that waits for a
 * new cause opens a row (and closes its previous one), a task that no longer
 * waits (started, closed, or waiting by design) closes its open row. Called
 * at each tick of the scheduler with the queue as `listQueue` gives it, so a
 * wait is known to within a tick. Idempotent for an unchanged queue.
 */
export function journalWaits(db: Db, entries: readonly QueueEntry[], at: string = new Date().toISOString()): void {
  db.transaction(() => {
    const open = db.prepare("SELECT id, task_id, cause FROM task_waits WHERE ended_at IS NULL").all() as { id: number; task_id: number; cause: string }[];
    const byTask = new Map(open.map((row) => [row.task_id, row]));
    const close = db.prepare("UPDATE task_waits SET ended_at = ? WHERE id = ?");
    const insert = db.prepare(
      "INSERT INTO task_waits (task_id, room, agent_id, cause, reason, started_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const updateReason = db.prepare("UPDATE task_waits SET reason = ? WHERE id = ?");
    const seen = new Set<number>();
    for (const entry of entries) {
      seen.add(entry.taskId);
      const row = byTask.get(entry.taskId);
      if (row && row.cause === entry.cause) {
        // The same wait: its latest words (the figures of a shortfall move).
        updateReason.run(entry.reason, row.id);
        continue;
      }
      if (row) close.run(at, row.id);
      insert.run(entry.taskId, entry.room, entry.agentId, entry.cause, entry.reason, at);
    }
    for (const row of open) if (!seen.has(row.task_id)) close.run(at, row.id);
  }).immediate();
}

export type WaitTotalDto = {
  room: string;
  agentId: string;
  /** The cause that held the agent's tasks the longest in the window. */
  cause: string;
  /** Minutes during which at least one task of the agent waited, in the window (overlapping waits counted once). */
  minutes: number;
};

/**
 * For each agent, how long at least one of its tasks waited in the queue since
 * `sinceMs`, the open waits counted up to `nowMs`, the longest first; a wait
 * for the end of the agent's own run in progress (`afterRun`) is left out,
 * since the agent is working then.
 */
export function waitTotals(db: Db, sinceMs: number, nowMs: number = Date.now()): WaitTotalDto[] {
  const rows = db
    .prepare(
      `SELECT room, agent_id, cause, started_at, ended_at FROM task_waits
       WHERE cause <> 'afterRun' AND (ended_at IS NULL OR ended_at >= ?) ORDER BY started_at`,
    )
    .all(new Date(sinceMs).toISOString()) as { room: string; agent_id: string; cause: string; started_at: string; ended_at: string | null }[];
  type Spans = { room: string; agentId: string; spans: [number, number][]; causes: Map<string, number> };
  const agents = new Map<string, Spans>();
  for (const row of rows) {
    const start = Math.max(sinceMs, Date.parse(row.started_at));
    const end = Math.min(nowMs, row.ended_at ? Date.parse(row.ended_at) : nowMs);
    if (!(end > start)) continue;
    const key = `${row.room}\u0000${row.agent_id}`;
    const agent: Spans = agents.get(key) ?? { room: row.room, agentId: row.agent_id, spans: [], causes: new Map<string, number>() };
    agent.spans.push([start, end]);
    agent.causes.set(row.cause, (agent.causes.get(row.cause) ?? 0) + (end - start));
    agents.set(key, agent);
  }
  const totals: WaitTotalDto[] = [];
  for (const agent of agents.values()) {
    agent.spans.sort((a, b) => a[0] - b[0]);
    let total = 0;
    let from = agent.spans[0]![0];
    let to = agent.spans[0]![1];
    for (const [start, end] of agent.spans.slice(1)) {
      if (start > to) {
        total += to - from;
        from = start;
        to = end;
      } else to = Math.max(to, end);
    }
    total += to - from;
    const cause = [...agent.causes.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    totals.push({ room: agent.room, agentId: agent.agentId, cause, minutes: Math.round(total / 60_000) });
  }
  return totals.filter((each) => each.minutes > 0).sort((a, b) => b.minutes - a.minutes);
}
