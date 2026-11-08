import type { AgentStatus } from "./room-model";

// The strip of agents under the floor puts the active ones first: the agents at
// work, then the ones that wait or are stuck, then the ones asleep. Inside a
// group the order of the home (by room) is kept. Nothing here is worded: the
// interface names the groups (strings.room.groups).

export type AgentGroup = "working" | "waiting" | "resting";

/** The groups in the order of the strip. */
export const AGENT_GROUPS: readonly AgentGroup[] = ["working", "waiting", "resting"];

/**
 * The group of an agent from what it is doing. Working is everything that
 * belongs to a turn in progress (a bubble, a walk for a visit or a delivery,
 * or the agent still at its desk after the turn); waiting is a turn that ended
 * badly or a question that holds the agent; resting is the sleep (or the round
 * of an agent always on it, between its runs).
 */
export function groupOf(status: AgentStatus | null): AgentGroup {
  if (status === null) return "resting";
  switch (status.kind) {
    case "seated":
    case "typing":
    case "thinking":
    case "visiting":
    case "talking":
    case "carrying":
    case "dropping":
    case "returning":
    case "roaming":
    case "sweeping":
    case "stowing":
    case "closet":
      return "working";
    case "blocked":
    case "failed":
      return "waiting";
    case "asleep":
    // Always on its round (floor.always) between its runs: drawn walking, but no turn in progress.
    case "patrolling":
      return "resting";
  }
}

export type PlacedAgent<T> = {
  item: T;
  group: AgentGroup;
  /** The group to name above this agent: set on the first agent of each group, and only when the strip has several groups. */
  label: AgentGroup | null;
};

/**
 * The agents of the strip, active ones first, each group in the order it came
 * in (a stable sort). Before the first snapshot of the room no status is known:
 * the order is left as it is, with no label.
 */
export function placeAgents<T>(items: readonly T[], statusOf: (item: T) => AgentStatus | null): PlacedAgent<T>[] {
  if (items.every((item) => statusOf(item) === null)) {
    return items.map((item) => ({ item, group: "resting", label: null }));
  }
  const placed = AGENT_GROUPS.flatMap((group) =>
    items.filter((item) => groupOf(statusOf(item)) === group).map((item) => ({ item, group, label: null as AgentGroup | null })),
  );
  const present = new Set(placed.map((entry) => entry.group));
  if (present.size > 1) {
    for (const [index, entry] of placed.entries()) {
      if (index === 0 || placed[index - 1]!.group !== entry.group) entry.label = entry.group;
    }
  }
  return placed;
}
