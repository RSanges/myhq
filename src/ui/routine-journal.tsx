import { formatDateTime } from "./format";
import type { TeamAgent } from "./model";
import type { Firing } from "./schemas";
import { strings } from "./strings";
import { Badge, Section } from "./ui";

const SHOWN = 20;

const tone: Record<Firing["outcome"], "ok" | "warn" | "danger" | "neutral"> = {
  started: "ok",
  skipped_busy: "warn",
  skipped_cap: "warn",
  skipped_unarmed: "neutral",
  error: "danger",
};

/** The journal of routine firings (newest first): what the scheduler did with each routine that came due. */
export function RoutineJournal({ firings, agents }: { firings: Firing[]; agents: TeamAgent[] }) {
  const nameOf = (room: string, agentId: string) =>
    agents.find((agent) => agent.room === room && agent.id === agentId)?.name ?? agentId;
  return (
    <Section title={strings.routines.title}>
      {firings.length === 0 ? (
        <p className="text-sm text-muted">{strings.routines.empty}</p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-card text-sm">
          {firings.slice(0, SHOWN).map((firing) => (
            <li key={firing.id} className="space-y-1 px-4 py-2">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-medium">{nameOf(firing.room, firing.agentId)}</span>
                <span className="text-xs text-muted">{firing.room}</span>
                <Badge tone={tone[firing.outcome]}>{strings.routines.outcome[firing.outcome]}</Badge>
                {firing.runId !== null && <span className="text-xs text-muted">{strings.routines.run(firing.runId)}</span>}
              </p>
              <p className="text-xs text-muted">
                {strings.routines.scheduledAt(formatDateTime(firing.scheduledAt))}{" "}
                <code className="font-mono">{firing.cron}</code>
              </p>
              {firing.outcome === "error" && firing.detail && (
                <p className="break-words text-xs text-danger">{firing.detail}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
