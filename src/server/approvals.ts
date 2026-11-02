import { z } from "zod";
import { strings } from "../ui/strings";
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
  })
  .refine((d) => d.decision === "approved" || Boolean(d.note), {
    message: "a note is required to reject or to ask for a revision",
    path: ["note"],
  });
export type Decision = z.infer<typeof decisionSchema>;

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
      db.prepare("UPDATE approvals SET status = ?, decision_note = ?, decided_at = ? WHERE id = ?").run(
        decision.decision,
        note,
        at,
        id,
      );
      if (decision.decision === "revise") {
        db.prepare(
          `INSERT INTO tasks (room, agent_id, source, ref_id, text, status, created_at, updated_at)
           VALUES (?, ?, 'revise', ?, ?, 'pending', ?, ?)`,
        ).run(
          row.room,
          row.agent_id,
          id,
          `Revise your submission #${id} "${row.title}" (${row.type}). User's note: ${note}`,
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
