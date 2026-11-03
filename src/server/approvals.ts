import { z } from "zod";
import { strings } from "../ui/strings";
import { annotationsSchema, decisionText, type Annotation } from "./annotations";
import { getConfig, type HqConfig } from "./config";
import { now, type ApprovalRow, type Db } from "./db";
import { HqError } from "./errors";
import { toApproval, type ApprovalDto } from "./feed";
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
): string {
  const head = `Revise your submission #${id} "${title}" (${type}).`;
  if (annotations.length === 0) return `${head} User's note: ${note}`;
  return `${head} User's remarks:
${decisionText(note, annotations)}`;
}

/** Whether the agent of an item asks for a task when one of its items is approved. */
function wantsApprovalTask(config: HqConfig, row: ApprovalRow): boolean {
  const agent = loadHome(config.home)
    .rooms.find((room) => room.name === row.room)
    ?.agents.find((a) => a.id === row.agent_id);
  return agent?.onApproval === "task";
}

/**
 * Decides a pending approval. `revise` sends the item back to its agent as a
 * new task carrying the user's note. Approving a `room_proposal` writes the
 * room in the home first (see proposal.ts): when that fails, the item stays
 * pending and the error is thrown. Approving an item of an agent with
 * `onApproval: "task"` gives that agent a task to execute it, and wakes it
 * (`wakeAgents`): the agent acts, through its own tools, never MyHQ. No other
 * type is acted on: the item keeps its payload, and publishing or pushing
 * stays the user's.
 */
export function decideApproval(
  db: Db,
  id: number,
  decision: Decision,
  config?: HqConfig,
  deps: RunnerDeps = {},
): ApprovalDto {
  let taskFor: HqConfig | null = null;
  if (decision.decision === "approved") {
    const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | undefined;
    if (row?.status === "pending" && row.type === ROOM_PROPOSAL) {
      applyRoomProposal(config ?? getConfig(), db, JSON.parse(row.payload) as unknown);
    }
    if (row?.status === "pending") {
      const cfg = config ?? getConfig();
      if (wantsApprovalTask(cfg, row)) taskFor = cfg;
    }
  }
  const approval = db
    .transaction(() => {
      const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | undefined;
      if (!row) throw new HqError("APPROVAL_NOT_FOUND", 404, `No approval #${id}.`);
      if (row.status !== "pending") {
        throw new HqError("APPROVAL_ALREADY_DECIDED", 409, `Approval #${id} is already ${row.status}.`);
      }
      const at = now();
      const note = decision.note || null;
      const annotations = decision.annotations ?? [];
      db.prepare(
        "UPDATE approvals SET status = ?, decision_note = ?, annotations = ?, decided_at = ? WHERE id = ?",
      ).run(decision.decision, note, JSON.stringify(annotations), at, id);
      if (decision.decision === "revise") {
        db.prepare(
          `INSERT INTO tasks (room, agent_id, source, ref_id, text, status, created_at, updated_at)
           VALUES (?, ?, 'revise', ?, ?, 'pending', ?, ?)`,
        ).run(
          row.room,
          row.agent_id,
          id,
          revisionTaskText(id, row.title, row.type, note, annotations),
          at,
          at,
        );
      }
      if (decision.decision === "approved" && taskFor) {
        db.prepare(
          `INSERT INTO tasks (room, agent_id, source, ref_id, text, status, created_at, updated_at)
           VALUES (?, ?, 'approval', ?, ?, 'pending', ?, ?)`,
        ).run(row.room, row.agent_id, id, strings.tasks.executeApproved(id, row.title), at, at);
      }
      return toApproval(db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow);
    })
    .immediate();
  if (taskFor) {
    // The decision stands whatever happens next: a busy agent or the daily
    // cap leave the task waiting for the agent's next run.
    try {
      wakeAgents(taskFor, db, deps);
    } catch (error) {
      console.error(`[approvals] wake after approval #${id} failed`, error);
    }
  }
  return approval;
}
