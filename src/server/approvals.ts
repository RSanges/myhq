import { z } from "zod";
import { now, type ApprovalRow, type Db } from "./db";
import { HqError } from "./errors";
import { toApproval, type ApprovalDto } from "./feed";

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

/**
 * Decides a pending approval. `revise` sends the item back to its agent as a
 * new task carrying the user's note. Handlers that act on an approved item
 * (publish, merge...) are not part of this slice: the item keeps its payload.
 */
export function decideApproval(db: Db, id: number, decision: Decision): ApprovalDto {
  return db
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
      return toApproval(db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow);
    })
    .immediate();
}
