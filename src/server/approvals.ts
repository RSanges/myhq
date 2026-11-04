import { z } from "zod";
import { strings } from "../ui/strings";
import { annotationsSchema, decisionText, parseAnnotations, type Annotation } from "./annotations";
import { getConfig, type HqConfig } from "./config";
import { now, type ApprovalRow, type Db } from "./db";
import { HqError } from "./errors";
import { parseDecisionHistory, type DecisionRecord } from "./decision-history";
import { APPROVAL_SELECT, toApproval, type ApprovalDto, type ApprovalRowWithAction } from "./feed";
import { applyRoomProposal, ROOM_PROPOSAL } from "./proposal";
import { loadHome } from "./rooms";
import { wakeAgents, type RunnerDeps } from "./runner";

export const decisionSchema = z
  .strictObject({
    decision: z.enum(["approved", "rejected", "revise"]),
    note: z.string().trim().max(5_000).optional(),
    /** Remarks on passages of the body, for `revise` and `rejected` only. */
    annotations: annotationsSchema.optional(),
  })
  .superRefine((d, ctx) => {
    const annotated = (d.annotations?.length ?? 0) > 0;
    if (d.decision === "approved" && annotated) {
      ctx.addIssue({ code: "custom", message: "annotations only go with a rejection or a revision", path: ["annotations"] });
    }
    // A revision may rest on its annotations alone; a rejection always has a reason.
    const needsNote = d.decision === "rejected" || (d.decision === "revise" && !annotated);
    if (needsNote && !d.note) {
      ctx.addIssue({ code: "custom", message: "a note is required to reject or to ask for a revision", path: ["note"] });
    }
  });
export type Decision = z.infer<typeof decisionSchema>;

/**
 * The task sent back to the agent. Without annotations, the user's note alone;
 * with them, the numbered remarks then the general note (see decisionText).
 */
export function revisionTaskText(
  id: number,
  title: string,
  type: string,
  note: string | null,
  annotations: readonly Annotation[],
  /** The item was rejected, not sent back: the user's note still tells what to change. */
  rejected = false,
): string {
  const head = `Revise your submission #${id} "${title}" (${type})${rejected ? ", which the user rejected" : ""}.`;
  if (annotations.length === 0) return `${head} User's note: ${note}`;
  return `${head} User's remarks:
${decisionText(note, annotations)}`;
}

/**
 * What the agent of an item asks for when one of its items is approved: nothing
 * (null), a task it is woken for (`task`), or a task that waits for its next
 * run (`queue`).
 */
function approvalTaskFor(config: HqConfig, row: ApprovalRow): "task" | "queue" | null {
  const agent = loadHome(config.home)
    .rooms.find((room) => room.name === row.room)
    ?.agents.find((a) => a.id === row.agent_id);
  return agent?.onApproval ?? null;
}

/**
 * Decides a pending approval. `revise` sends the item back to its agent as a
 * new task carrying the user's note. It is also the one decision an item
 * that was already decided accepts: an approved or rejected item can still be
 * sent back (its previous decision goes to `decision_history`), and an item
 * already in `revise` only when the new note or remarks differ from the ones
 * it has. Any other decision on a decided item is `APPROVAL_ALREADY_DECIDED`.
 * A revision wakes the agent at once (`wakeAgents`, reason `revise`) unless it
 * has `onRevise: "queue"`; the wake-up needs `config`, the callers of the app
 * always give it. A `room_proposal` is the onboarding agent's, which is no room
 * agent: a revision, and a rejection too (its note says what to change),
 * gives it the same task and relaunches onboarding on the proposal's
 * repository (see `wakeOnboarding`).
 *
 * Approving a `room_proposal` writes the room in the home first (see
 * proposal.ts): when that fails, the item stays pending and the error is
 * thrown. Approving an item of an agent with `onApproval: "task"` gives that
 * agent a task to execute it, and wakes it (`wakeAgents`; with `"queue"` the
 * task waits for its next run): the agent acts, through its own tools, never
 * MyHQ. No other type is acted on: the item keeps its payload, and publishing
 * or pushing stays the user's.
 */
export function decideApproval(
  db: Db,
  id: number,
  decision: Decision,
  config?: HqConfig,
  deps: RunnerDeps = {},
): ApprovalDto {
  let taskFor: HqConfig | null = null;
  let queueTaskFor: HqConfig | null = null;
  let wakeFor: HqConfig | null = decision.decision === "revise" ? (config ?? null) : null;
  if (decision.decision === "approved") {
    const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | undefined;
    if (row?.status === "pending" && row.type === ROOM_PROPOSAL) {
      applyRoomProposal(config ?? getConfig(), db, JSON.parse(row.payload) as unknown);
    }
    if (row?.status === "pending") {
      const cfg = config ?? getConfig();
      const wanted = approvalTaskFor(cfg, row);
      if (wanted === "task") taskFor = wakeFor = cfg;
      else if (wanted === "queue") queueTaskFor = cfg;
    }
  }
  const approval = db
    .transaction(() => {
      const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | undefined;
      if (!row) throw new HqError("APPROVAL_NOT_FOUND", 404, `No approval #${id}.`);
      const at = now();
      const note = decision.note || null;
      const annotations = decision.annotations ?? [];
      let history = parseDecisionHistory(row.decision_history);
      if (row.status !== "pending") {
        if (decision.decision !== "revise") {
          throw new HqError("APPROVAL_ALREADY_DECIDED", 409, `Approval #${id} is already ${row.status}.`);
        }
        const current: DecisionRecord = {
          decision: row.status,
          note: row.decision_note,
          annotations: parseAnnotations(row.annotations),
          decidedAt: row.decided_at,
        };
        if (row.status === "revise" && current.note === note && JSON.stringify(current.annotations) === JSON.stringify(annotations)) {
          throw new HqError(
            "APPROVAL_ALREADY_DECIDED",
            409,
            `Approval #${id} is already sent back for a revision: add a new note or remark.`,
          );
        }
        history = [...history, current];
      }
      // The agent reads the new decision whether or not it read the previous one.
      db.prepare(
        `UPDATE approvals SET status = ?, decision_note = ?, annotations = ?, decided_at = ?,
           decision_history = ?, seen_by_agent_at = NULL WHERE id = ?`,
      ).run(decision.decision, note, JSON.stringify(annotations), at, JSON.stringify(history), id);
      if (decision.decision === "rejected" && row.type === ROOM_PROPOSAL) wakeFor = config ?? null;
      if (decision.decision === "revise" || (decision.decision === "rejected" && row.type === ROOM_PROPOSAL)) {
        db.prepare(
          `INSERT INTO tasks (room, agent_id, source, ref_id, text, status, created_at, updated_at)
           VALUES (?, ?, 'revise', ?, ?, 'pending', ?, ?)`,
        ).run(
          row.room,
          row.agent_id,
          id,
          revisionTaskText(id, row.title, row.type, note, annotations, decision.decision === "rejected"),
          at,
          at,
        );
      }
      if (decision.decision === "approved" && (taskFor || queueTaskFor)) {
        db.prepare(
          `INSERT INTO tasks (room, agent_id, source, ref_id, text, status, created_at, updated_at)
           VALUES (?, ?, 'approval', ?, ?, 'pending', ?, ?)`,
        ).run(row.room, row.agent_id, id, strings.tasks.executeApproved(id, row.title), at, at);
      }
      return toApproval(db.prepare(`${APPROVAL_SELECT} WHERE a.id = ?`).get(id) as ApprovalRowWithAction);
    })
    .immediate();
  if (wakeFor) {
    // The decision stands whatever happens next: a busy agent or the daily
    // cap leave the task waiting for the agent's next run.
    try {
      wakeAgents(wakeFor, db, deps);
    } catch (error) {
      console.error(`[approvals] wake after approval #${id} failed`, error);
    }
  }
  return approval;
}
