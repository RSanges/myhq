import { agentKey, viewEvent } from "./model";
import type { HqEvent, Run, RunStatus } from "./schemas";

export type RunDigest = {
  runId: number;
  startedAt: string;
  /** `running` until the `end` event arrives, or the run itself says otherwise. */
  status: RunStatus;
  costUsd: number | null;
  /** The events of the run, oldest first. */
  events: HqEvent[];
};

/**
 * The most recent runs of an agent (`room/agent` key), newest first, rebuilt
 * from the events the page holds: the API has no list of old runs, and the
 * events of a run carry its start, its end, its status and its cost. `latest`
 * is the agent's last run as the API gives it, which is authoritative for that
 * run (a cancelled run has no `end` event).
 */
export function recentRuns(events: HqEvent[], key: string, latest: Run | null = null, limit = 5): RunDigest[] {
  const byRun = new Map<number, HqEvent[]>();
  for (const event of events) {
    if (agentKey(event.room, event.agentId) !== key) continue;
    const list = byRun.get(event.runId);
    if (list) list.push(event);
    else byRun.set(event.runId, [event]);
  }
  return [...byRun.entries()]
    .sort((a, b) => b[0] - a[0])
    .slice(0, limit)
    .map(([runId, list]) => {
      const sorted = list.slice().sort((a, b) => a.id - b.id);
      const end = sorted.map(viewEvent).find((view) => view.kind === "end");
      const fromEvents: RunStatus = end?.kind === "end" ? (end.status === "failed" ? "failed" : "done") : "running";
      const own = latest && latest.id === runId ? latest : null;
      return {
        runId,
        startedAt: own?.startedAt ?? sorted[0]!.createdAt,
        status: own?.status ?? fromEvents,
        costUsd: own ? (own.status === "running" ? null : own.costUsd) : end?.kind === "end" ? end.costUsd : null,
        events: sorted,
      };
    });
}
