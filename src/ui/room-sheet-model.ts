import { viewEvent } from "./model";
import type { Approval, HqEvent, Routine, Run, Usage } from "./schemas";

// What the sheet of a room says, without any wording (room-sheet.tsx words it):
// what waits for the user's decision, the cost of the day, and for each agent
// its state, what it does or last did, and its routines. Pure, so the tests
// build it from plain entities.

/** An agent as the sheet of a room reads it (a TeamAgent fits, the receptionist is built to fit). */
export type SheetAgentInput = {
  key: string;
  id: string;
  name: string;
  lastRun: Run | null;
  /** Its resources held by another run while its work waits (« en attente du GPU »). */
  waitingFor?: string[];
  armed: boolean;
  routines: Routine[];
};

export type SheetAgentState =
  | { kind: "working" }
  | { kind: "resource"; resources: string[] }
  | { kind: "deciding"; count: number }
  | { kind: "stuck" }
  | { kind: "failed" }
  | { kind: "asleep" };

/** One line on what the agent does now, or did last. */
export type SheetAgentLine =
  | { kind: "thought"; text: string }
  | { kind: "running"; since: string }
  | { kind: "summary"; text: string }
  | { kind: "noSummary" }
  | { kind: "noRun" };

export type SheetAgent = {
  key: string;
  name: string;
  state: SheetAgentState;
  line: SheetAgentLine;
  /** When its last run started, or null without one. */
  lastAt: string | null;
  armed: boolean;
  routines: Routine[];
};

export type RoomDigest = {
  /** Items of the room waiting for the user's decision (the count of the room's desk on the floor). */
  pending: number;
  /** Runs and cost of the room today, or null when the usage does not say (not loaded yet, an older server). */
  today: { runs: number; costUsd: number } | null;
  agents: SheetAgent[];
};

/** The first line of a text with something on it, spaces folded. */
function firstLine(text: string): string {
  return (text.split("\n").find((line) => line.trim() !== "") ?? "").replace(/\s+/g, " ").trim();
}

/** What a running run last said (its latest `text` event), or null before it says anything. */
function lastThought(events: readonly HqEvent[], runId: number): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.runId !== runId || event.type !== "text") continue;
    const view = viewEvent(event);
    const line = view.kind === "text" ? firstLine(view.text) : "";
    if (line !== "") return line;
  }
  return null;
}

function stateOf(agent: SheetAgentInput, deciding: number, blocked: boolean): SheetAgentState {
  if (agent.lastRun?.status === "running") return { kind: "working" };
  if ((agent.waitingFor?.length ?? 0) > 0) return { kind: "resource", resources: agent.waitingFor ?? [] };
  if (deciding > 0) return { kind: "deciding", count: deciding };
  if (blocked) return { kind: "stuck" };
  if (agent.lastRun?.status === "failed") return { kind: "failed" };
  return { kind: "asleep" };
}

function lineOf(agent: SheetAgentInput, events: readonly HqEvent[]): SheetAgentLine {
  const run = agent.lastRun;
  if (!run) return { kind: "noRun" };
  if (run.status === "running") {
    const thought = lastThought(events, run.id);
    return thought ? { kind: "thought", text: thought } : { kind: "running", since: run.startedAt };
  }
  const summary = run.summary ? firstLine(run.summary) : "";
  return summary ? { kind: "summary", text: summary } : { kind: "noSummary" };
}

/**
 * The sheet of one room. `pending` is the count the floor shows on the room's
 * desk (a delivery of a shared room counts for the room that ordered it);
 * `approvals` the items waiting for a decision, to count those of each agent;
 * `blocked` the agents the floor shows with a question mark.
 */
export function roomDigest(input: {
  room: string;
  agents: readonly SheetAgentInput[];
  pending: number;
  approvals: readonly Approval[];
  events: readonly HqEvent[];
  usage: Usage | null;
  blocked: ReadonlySet<string>;
}): RoomDigest {
  const { room } = input;
  const deciding = new Map<string, number>();
  for (const approval of input.approvals) {
    if (approval.status !== "pending" || approval.room !== room) continue;
    deciding.set(approval.agentId, (deciding.get(approval.agentId) ?? 0) + 1);
  }
  const totals = input.usage?.agents?.today ?? null;
  const today =
    totals === null
      ? null
      : totals
          .filter((entry) => entry.room === room)
          .reduce((sum, entry) => ({ runs: sum.runs + entry.runs, costUsd: sum.costUsd + entry.costUsd }), { runs: 0, costUsd: 0 });
  return {
    pending: input.pending,
    today,
    agents: input.agents.map((agent) => ({
      key: agent.key,
      name: agent.name,
      state: stateOf(agent, deciding.get(agent.id) ?? 0, input.blocked.has(agent.key)),
      line: lineOf(agent, input.events),
      lastAt: agent.lastRun?.startedAt ?? null,
      armed: agent.armed,
      routines: agent.routines,
    })),
  };
}
