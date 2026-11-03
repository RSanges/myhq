import { z } from "zod";
import { annotationsSchema } from "./annotations";

/** A decision an item had before it was sent back for a revision. */
export const decisionRecordSchema = z.strictObject({
  decision: z.enum(["approved", "rejected", "revise"]),
  note: z.string().nullable(),
  annotations: annotationsSchema,
  decidedAt: z.string().nullable(),
});
export type DecisionRecord = z.infer<typeof decisionRecordSchema>;

const historySchema = z.array(decisionRecordSchema);

/** Reads the `decision_history` column; an unreadable value counts as empty. */
export function parseDecisionHistory(raw: string | null | undefined): DecisionRecord[] {
  if (!raw) return [];
  try {
    const parsed = historySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}
