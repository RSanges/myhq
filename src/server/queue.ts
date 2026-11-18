import { z } from "zod";
import { strings } from "../ui/strings";
import { taskWait, type TaskWait } from "./blocked";
import type { HqConfig } from "./config";
import { queueOrder, type Db, type TaskRow } from "./db";
import { HqError } from "./errors";
import { declaresNeeds, readMachine, scarceOf, type MachineRead, type MachineReading } from "./machine";
import type { Home } from "./rooms";

// The queue: every pending task that waits for its turn, in the one order of
// the home (queueOrder: the owner's places first, then the oldest first), each
// with why it waits, in the words of the Standard (blocked.ts, taskWait). A
// task that waits by design for its agent's next run is not in it: nothing
// holds it back, and no place in the queue would start it. The wake-ups serve it
// in that order (wakeAgents), and a task that waits for a shared resource or
// for the machine keeps what its agent needs: a later task of another agent
// that needs the same thing waits behind it ("behind"), while a task that
// needs nothing scarce may still start. See docs/architecture.md, "The queue
// and the machine".

export type QueueEntry = {
  taskId: number;
  room: string;
  roomLabel: string | null;
  roomColor: string | null;
  agentId: string;
  agentName: string;
  /** The title of the task's subject (subjects.ts), null for the general one or a subject without title. */
  subject: string | null;
  source: string;
  /** The text of the task on one line, cut. */
  summary: string;
  /** Since when it waits: its creation. */
  since: string;
  /** The owner placed it (`queue_rank`); false: automatic order. */
  placed: boolean;
  /** Why it waits: a cause of the Standard (`busy`, `resource`, `machine`, `cap`...), or `afterRun`, `behind`. */
  cause: string;
  reason: string;
};

const SUMMARY_MAX = 160;
/** The causes of a task that waits for something another agent's run may take: it keeps its place for it. */
const SCARCE_CAUSES = new Set(["resource", "machine", "veto"]);

const oneLine = (text: string): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX).trimEnd()}...` : line;
};

/** Every pending task that waits for its turn, in the order of the queue, with why it waits. */
export function listQueue(db: Db, config: HqConfig, home: Home, read: MachineRead = readMachine): QueueEntry[] {
  const tasks = db.prepare(`SELECT * FROM tasks WHERE status = 'pending' ORDER BY ${queueOrder()}`).all() as TaskRow[];
  const title = db.prepare("SELECT title FROM subjects WHERE id = ?");
  // What an earlier task waits for, and which task: the later ones that need it wait behind it (as in wakeAgents).
  const held = new Map<string, number>();
  const entries = tasks.map((task) => {
    const room = home.rooms.find((each) => each.name === task.room) ?? null;
    const agent = room?.agents.find((each) => each.id === task.agent_id) ?? null;
    let wait: TaskWait = taskWait(db, config, home, task, agent, read);
    if (agent) {
      const scarce = scarceOf(agent);
      const ahead = scarce.map((each) => held.get(each)).find((id) => id !== undefined);
      if (wait.cause === "notWoken" && ahead !== undefined) {
        wait = { cause: "behind", reason: strings.deskModules.standard.reasons.behind(ahead), stuck: false };
      } else if (SCARCE_CAUSES.has(wait.cause)) {
        // A wait on memory keeps only what fell short (a RAM need does not wait behind a GPU need); a need that never fits keeps nothing.
        for (const each of wait.holds ?? scarce) if (!held.has(each)) held.set(each, task.id);
      }
    }
    const subject = task.subject_id === null ? undefined : (title.get(task.subject_id) as { title: string | null } | undefined);
    return {
      taskId: task.id,
      room: task.room,
      roomLabel: room?.label ?? null,
      roomColor: room?.color ?? null,
      agentId: task.agent_id,
      agentName: agent?.name ?? task.agent_id,
      subject: subject?.title ?? null,
      source: task.source,
      summary: oneLine(task.text),
      since: task.created_at,
      placed: task.queue_rank !== null && task.queue_rank !== undefined,
      cause: wait.cause,
      reason: wait.reason,
    };
  });
  return entries.filter((entry) => entry.cause !== "byDesign");
}

/** GET /api/queue: the queue, and the reading of the machine when an agent of the home declares needs. */
export function queueView(db: Db, config: HqConfig, home: Home, read: MachineRead = readMachine): { tasks: QueueEntry[]; machine: MachineReading | null } {
  const needs = home.rooms.some((room) => room.agents.some(declaresNeeds));
  return { tasks: listQueue(db, config, home, read), machine: needs ? read() : null };
}

export const QUEUE_MOVES = ["first", "up", "down", "auto"] as const;

/** POST /api/queue: put a pending task first, one place up or down, or back to automatic order. */
export const queueMoveSchema = z.strictObject({
  taskId: z.number().int().positive(),
  move: z.enum(QUEUE_MOVES),
});
export type QueueMove = z.infer<typeof queueMoveSchema>;

/**
 * Moves a pending task in the queue. `auto` gives it back to the automatic
 * order (oldest first, after the placed ones). `first`, `up` and `down` move
 * it in the order as it is, and the tasks from the head down to the moved
 * ones (and every task the owner had placed ahead) get their places, in that
 * order: the placed ones come before the others, so the rest keeps its order.
 * A `down` that makes it the last of the queue sends it to the end for good
 * (a rank below 0): after every task without a place, the ones that arrive
 * later included, so that a task the owner put out of the way no longer
 * holds the new ones back. The others keep their places.
 */
export function moveInQueue(db: Db, input: QueueMove): void {
  db.transaction(() => {
    const task = db.prepare("SELECT id, status FROM tasks WHERE id = ?").get(input.taskId) as { id: number; status: string } | undefined;
    if (!task) throw new HqError("TASK_NOT_FOUND", 404, `No task #${input.taskId}.`);
    if (task.status !== "pending") throw new HqError("NOT_IN_QUEUE", 409, `Task #${input.taskId} is ${task.status}: only a pending task is in the queue.`);
    // updated_at is left alone: it says which tasks a failed run gave back (blocked.ts, runTaskIds).
    if (input.move === "auto") {
      db.prepare("UPDATE tasks SET queue_rank = NULL WHERE id = ?").run(input.taskId);
      return;
    }
    const order = db.prepare(`SELECT id, queue_rank FROM tasks WHERE status = 'pending' ORDER BY ${queueOrder()}`).all() as {
      id: number;
      queue_rank: number | null;
    }[];
    const ids = order.map((row) => row.id);
    const from = ids.indexOf(input.taskId);
    const to = input.move === "first" ? 0 : input.move === "up" ? Math.max(0, from - 1) : Math.min(ids.length - 1, from + 1);
    ids.splice(from, 1);
    ids.splice(to, 0, input.taskId);
    const place = db.prepare("UPDATE tasks SET queue_rank = ? WHERE id = ?");
    const atEnd = new Set(order.filter((row) => row.queue_rank !== null && row.queue_rank < 0).map((row) => row.id));
    if (input.move === "down" && to === ids.length - 1) {
      // To the end for good: the tasks already sent there, then this one (-n to -1).
      const end = [...ids.filter((id) => atEnd.has(id) && id !== input.taskId), input.taskId];
      end.forEach((id, index) => place.run(index - end.length, id));
      return;
    }
    const placed = new Set(order.filter((row) => row.queue_rank !== null && row.queue_rank > 0).map((row) => row.id));
    const last = Math.max(from, to, ...ids.map((id, index) => (placed.has(id) ? index : -1)));
    // The tasks sent to the end keep their ranks; the moved one leaves the end if it was there.
    for (let index = 0; index <= last; index++) if (!atEnd.has(ids[index]!) || ids[index] === input.taskId) place.run(index + 1, ids[index]!);
  }).immediate();
}

/**
 * What the queue looks like, cheaply, for the counts of the desk (desk.ts):
 * the pending tasks in order, the runs in progress and the answers of the veto
 * command. When it changes, the open pages read the queue again.
 */
export function queueSignature(db: Db): string {
  const row = db
    .prepare(
      `SELECT
         (SELECT group_concat(id || ':' || COALESCE(queue_rank, ''), ',') FROM (SELECT id, queue_rank FROM tasks WHERE status = 'pending' ORDER BY ${queueOrder()})) AS tasks,
         (SELECT group_concat(id, ',') FROM runs WHERE status = 'running') AS runs,
         (SELECT group_concat(room || '/' || agent_id || ':' || verdict, ',') FROM machine_vetoes) AS vetoes`,
    )
    .get() as { tasks: string | null; runs: string | null; vetoes: string | null };
  return `${row.tasks ?? ""}|${row.runs ?? ""}|${row.vetoes ?? ""}`;
}
