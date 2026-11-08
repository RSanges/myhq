import { formatCost, formatDateTime } from "./format";
import { agentKey, type TeamAgent } from "./model";
import type { Firing, Usage } from "./schemas";
import { strings } from "./strings";

const t = strings.room.board;

/** One line of the whiteboard: what it counts, and its figure. */
export type BoardRow = { key: string; label: string; value: string };

/**
 * The whiteboard of a room (of every room, with `room` null: the single
 * floor of the home): the day's runs against the cap, the cost (the runs
 * and the questions to the agents), the share of the weekly budget, and the state of the routines (armed or not,
 * next fire, last firing). Pure: the strings and the formats are the only
 * things it needs.
 */
export function buildBoard(params: {
  room: string | null;
  agents: TeamAgent[];
  usage: Usage | null;
  firings: Firing[];
  schedulerEnabled: boolean;
}): BoardRow[] {
  const { room, agents, usage, firings, schedulerEnabled } = params;
  const mine = room === null ? agents : agents.filter((agent) => agent.room === room);
  const names = new Map(mine.map((agent) => [agentKey(agent.room, agent.id), agent.name]));
  const rows: BoardRow[] = [];

  rows.push({
    key: "runs",
    label: t.runs,
    value: usage ? t.runsValue(usage.cap.runsToday, usage.cap.maxRunsPerDay) : t.unknown,
  });
  rows.push({
    key: "cost",
    label: t.cost,
    value: usage ? formatCost(usage.today.costUsd + (usage.questions?.today.costUsd ?? 0)) : t.unknown,
  });
  rows.push(
    usage?.budget
      ? { key: "budget", label: t.budget, value: strings.meter.budgetShare(Math.round(usage.budget.share * 100)) }
      : {
          key: "week",
          label: t.week,
          value: usage ? formatCost(usage.week.costUsd + (usage.questions?.week.costUsd ?? 0)) : t.unknown,
        },
  );

  const withRoutines = mine.filter((agent) => agent.routines.length > 0);
  rows.push({
    key: "routines",
    label: t.routines,
    value: t.routinesValue(withRoutines.filter((agent) => agent.armed).length, withRoutines.length),
  });

  let next: { agent: string; at: string } | null = null;
  for (const agent of withRoutines) {
    if (!agent.armed) continue;
    for (const routine of agent.routines) {
      if (routine.nextAt && (next === null || routine.nextAt < next.at)) next = { agent: agent.name, at: routine.nextAt };
    }
  }
  rows.push({
    key: "next",
    label: t.next,
    value: !schedulerEnabled ? t.nextOff : next ? t.nextValue(next.agent, formatDateTime(next.at)) : t.nextNone,
  });

  const last = firings.find((firing) => names.has(agentKey(firing.room, firing.agentId)));
  rows.push({
    key: "last",
    label: t.last,
    value: last
      ? t.lastValue(
          names.get(agentKey(last.room, last.agentId)) ?? last.agentId,
          formatDateTime(last.createdAt),
          strings.routines.outcome[last.outcome] ?? last.outcome,
        )
      : t.lastNone,
  });
  return rows;
}
