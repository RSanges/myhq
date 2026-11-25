import { z } from "zod";
import { strings } from "../ui/strings";
import { closeBlocked, listBlocked, STUCK_PENDING_MS, targetTasks, type BlockedTarget } from "./blocked";
import type { HqConfig } from "./config";
import { now, type Db, type TaskRow } from "./db";
import { HqError } from "./errors";
import type { Home } from "./rooms";
import { entryTarget, myhqActor, noteBlocked, type SupervisorActor } from "./supervisor";

// The supervisor closes what it settled (hq_blocked_close): the effect of the
// owner's « Clore », with its reason, and a row of `supervisor_closes`
// (migration 26) that keeps what undoes it. The Standard lists the closures
// of the last 7 days, and the owner reopens one: its tasks come back as they
// were, and the entry is handed to the owner, so that neither MyHQ's rules
// nor the supervisor act on it again. See docs/architecture.md, "The
// supervisor".

/** The closures the Standard shows: those of this window. Older rows are kept, not shown. */
export const CLOSURES_SHOWN_MS = 7 * 24 * 60 * 60_000;

/** The reason of a closure: one sentence for the owner, what was done or why the entry has no more reason to be. */
export const closeReasonSchema = z.string().trim().min(10).max(500);

/**
 * The sources of a task that carry a request of the owner: a task given from
 * the conversation (`chat`), and a send-back or the answers to questions
 * (`revise`). Only the owner cancels those: an entry holding one is never
 * closed by the supervisor.
 */
export const OWNER_SOURCES: readonly TaskRow["source"][] = ["chat", "revise"];

/** POST /api/blocked/reopen. */
export const reopenBodySchema = z.strictObject({ id: z.number().int().positive() });

/** A task as it was before the closure: what a reopening restores. */
type TaskBefore = Pick<TaskRow, "id" | "status" | "note" | "run_id" | "updated_at">;

type CloseRow = {
  id: number;
  target_kind: BlockedTarget["kind"];
  target_id: number;
  room: string;
  agent_id: string;
  entry_reason: string;
  entry_text: string;
  tasks: string;
  reason: string;
  by_room: string;
  by_agent: string;
  by_run: number | null;
  closed_at: string;
  reopened_at: string | null;
};

const nameOf = (home: Home, room: string, agentId: string): string =>
  home.rooms.find((each) => each.name === room)?.agents.find((each) => each.id === agentId)?.name ?? agentId;

const sameTarget = (a: BlockedTarget, b: BlockedTarget) => a.kind === b.kind && a.id === b.id;

/**
 * hq_blocked_close: closes an open entry of the Standard, as « Clore » does
 * (its tasks are done, nothing wakes), with the supervisor's reason as their
 * note, and records the closure. Refused on the supervisor's own entries, on
 * an entry handed to the owner (it is the owner's, whoever handed it), on an
 * entry holding a request of the owner (OWNER_SOURCES), and on a target that
 * is not, or no longer, an entry of the Standard.
 */
export function closeBySupervisor(
  db: Db,
  home: Home,
  config: HqConfig,
  by: SupervisorActor,
  target: BlockedTarget,
  reason: string,
  at: Date = new Date(),
): { closure: number; tasks: number[] } {
  return db
    .transaction(() => {
      const found = targetTasks(db, target);
      if (found.room === by.room && found.agentId === by.agentId) {
        throw new HqError("OWN_ENTRY", 409, "This entry is yours: a supervisor never closes its own entries, the owner does.");
      }
      const label = target.kind === "task" ? `Task #${target.id}` : `Run #${target.id}`;
      const entries = listBlocked(db, home, config, at);
      const entry = entries.find((each) => sameTarget(entryTarget(each), target));
      if (!entry) {
        const holder = entries.find((each) => found.ids.some((id) => each.taskIds.includes(id)));
        if (holder) {
          const { kind, id } = entryTarget(holder);
          throw new HqError(
            "NOT_ON_STANDARD",
            409,
            `${label} is not on the Standard as such: its tasks belong to the entry { kind: "${kind}", id: ${id} } (hq_blocked gives the targets).`,
          );
        }
        throw new HqError(
          "NOT_ON_STANDARD",
          409,
          `${label} is not on the Standard (a pending task younger than ${STUCK_PENDING_MS / 60_000} minutes, or one a wake-up will take, is not stuck): nothing to close.`,
        );
      }
      if (entry.handedOff) {
        throw new HqError("HANDED_OFF", 409, "This entry is handed to the owner: it is the owner's to close, whoever handed it. Leave it.");
      }
      const before = db
        .prepare("SELECT id, status, note, run_id, updated_at, source FROM tasks WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id")
        .all(JSON.stringify(entry.taskIds)) as (TaskBefore & Pick<TaskRow, "source">)[];
      const asked = before.find((task) => OWNER_SOURCES.includes(task.source));
      if (asked) {
        throw new HqError(
          "OWNER_REQUEST",
          409,
          `Task #${asked.id} was asked for by the owner (${asked.source === "chat" ? "from the conversation" : "a send-back or answers to questions"}): only the owner cancels it. Hand the entry to the owner with hq_blocked_note and handOff: true, saying what you found.`,
        );
      }
      const { tasks } = closeBlocked(db, target, strings.deskModules.standard.closedBySupervisor(nameOf(home, by.room, by.agentId), reason));
      const closedAt = (db.prepare("SELECT updated_at FROM tasks WHERE id = ?").get(tasks[0]) as { updated_at: string }).updated_at;
      const closure = Number(
        db
          .prepare(
            `INSERT INTO supervisor_closes (target_kind, target_id, room, agent_id, entry_reason, entry_text, tasks, reason, by_room, by_agent, by_run, closed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(target.kind, target.id, entry.room, entry.agentId, entry.reason, entry.text, JSON.stringify(before.map((task): TaskBefore => ({ id: task.id, status: task.status, note: task.note, run_id: task.run_id, updated_at: task.updated_at }))), reason, by.room, by.agentId, by.runId, closedAt)
          .lastInsertRowid,
      );
      return { closure, tasks };
    })
    .immediate();
}

/** A closure by the supervisor, as the Standard shows it (GET /api/desk, `closures`). */
export type ClosureDto = {
  id: number;
  room: string;
  agentId: string;
  /** The agent the entry was about. */
  agentName: string;
  /** The supervisor that closed it, by its name. */
  by: string;
  /** The supervisor's reason. */
  reason: string;
  /** Why the entry was stuck, as the Standard said it then. */
  entryReason: string;
  /** The text of the task, or the instruction of the run. */
  text: string;
  /** The room colour, null for a neutral room. */
  color: string | null;
  closedAt: string;
  /** When the owner reopened it, null while it stays closed. */
  reopenedAt: string | null;
};

/** The closures of the last 7 days, newest first. */
export function listClosures(db: Db, home: Home, at: Date = new Date()): ClosureDto[] {
  const rows = db
    .prepare("SELECT * FROM supervisor_closes WHERE closed_at >= ? ORDER BY closed_at DESC, id DESC")
    .all(new Date(at.getTime() - CLOSURES_SHOWN_MS).toISOString()) as CloseRow[];
  return rows.map((row) => ({
    id: row.id,
    room: row.room,
    agentId: row.agent_id,
    agentName: nameOf(home, row.room, row.agent_id),
    by: nameOf(home, row.by_room, row.by_agent),
    reason: row.reason,
    entryReason: row.entry_reason,
    text: row.entry_text,
    color: home.rooms.find((each) => each.name === row.room)?.color ?? null,
    closedAt: row.closed_at,
    reopenedAt: row.reopened_at,
  }));
}

/**
 * « Rouvrir »: the tasks of a closure come back exactly as they were (status,
 * note, run, time, so that a run's entry is recognized again), the entry is
 * handed to the owner with a note of MyHQ's, and the closure is marked
 * reopened. Refused when a task changed since the closure (taken again by a
 * run, relaunched, closed by the owner): nothing is restored.
 */
export function reopenClosure(db: Db, home: Home, id: number): { closure: number; tasks: number[] } {
  return db
    .transaction(() => {
      const row = db.prepare("SELECT * FROM supervisor_closes WHERE id = ?").get(id) as CloseRow | undefined;
      if (!row) throw new HqError("CLOSURE_NOT_FOUND", 404, `No closure #${id}.`);
      if (row.reopened_at) throw new HqError("ALREADY_REOPENED", 409, `Closure #${id} was already reopened, at ${row.reopened_at}.`);
      const before = JSON.parse(row.tasks) as TaskBefore[];
      const current = db.prepare("SELECT status, updated_at FROM tasks WHERE id = ?");
      for (const task of before) {
        const state = current.get(task.id) as Pick<TaskRow, "status" | "updated_at"> | undefined;
        if (!state || state.status !== "done" || state.updated_at !== row.closed_at) {
          throw new HqError(
            "STATE_CHANGED",
            409,
            `Task #${task.id} changed since the closure (${state ? `it is ${state.status} now` : "it no longer exists"}): the entry is not reopened.`,
          );
        }
      }
      const restore = db.prepare("UPDATE tasks SET status = ?, note = ?, run_id = ?, updated_at = ? WHERE id = ?");
      for (const task of before) restore.run(task.status, task.note, task.run_id, task.updated_at, task.id);
      const text = strings.deskModules.standard.reopenedNote(nameOf(home, row.by_room, row.by_agent), row.reason);
      // The owner reopened it: no item to tell them.
      for (const task of before) noteBlocked(db, myhqActor(), { kind: "task", id: task.id }, text, true, false);
      db.prepare("UPDATE supervisor_closes SET reopened_at = ? WHERE id = ?").run(now(), row.id);
      return { closure: row.id, tasks: before.map((task) => task.id) };
    })
    .immediate();
}
