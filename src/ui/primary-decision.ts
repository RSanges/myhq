// The one main button of a pending item: « Approuver » while there is nothing
// to tell the agent, « Envoyer à retravailler » as soon as there is. Kept free
// of the DOM so that it can be tested on its own.

/** What the main button does: approve the item, or send it back to its agent. */
export type PrimaryDecision = "approved" | "revise";

/**
 * Approving and asking for a revision are one button: a general comment or at
 * least one remark on a passage means the user has something to say, and
 * approving would drop it, so the same button sends the item back instead.
 */
export function primaryDecision(comment: string, remarks: number): PrimaryDecision {
  return comment.trim() !== "" || remarks > 0 ? "revise" : "approved";
}
