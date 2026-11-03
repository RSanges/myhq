// The guard on « Approuver »: approving an item that has draft remarks drops
// them, so the desk asks first. A tiny state machine, kept free of the DOM so
// that it can be tested on its own.

export type GuardState = "idle" | "confirming";

export type GuardAction =
  /** Click on « Approuver ». */
  | "approve"
  /** « Passer en À retravailler ». */
  | "revise"
  /** « Approuver quand même ». */
  | "approveAnyway"
  /** Escape. */
  | "escape"
  /** The drafts changed (the confirmation is moot once none is left). */
  | "drafts";

/** What the desk does as a result: nothing, or send one of the decisions. */
export type GuardEffect = "none" | "approve" | "revise";

/**
 * One step of the guard. `drafts` is the number of draft remarks the item has
 * when the action happens. Approving with none goes straight through; with at
 * least one, the guard waits for a choice and only Escape (or the last draft
 * going away) takes it back to idle without sending anything.
 */
export function stepGuard(
  state: GuardState,
  action: GuardAction,
  drafts: number,
): { state: GuardState; effect: GuardEffect } {
  if (state === "idle") {
    if (action !== "approve") return { state, effect: "none" };
    return drafts > 0 ? { state: "confirming", effect: "none" } : { state: "idle", effect: "approve" };
  }
  switch (action) {
    case "revise":
      return { state: "idle", effect: "revise" };
    case "approveAnyway":
      return { state: "idle", effect: "approve" };
    case "escape":
      return { state: "idle", effect: "none" };
    case "drafts":
      return { state: drafts > 0 ? "confirming" : "idle", effect: "none" };
    case "approve":
      return { state, effect: "none" };
  }
}
