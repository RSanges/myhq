"use client";

import { useEffect, useMemo, useRef } from "react";
import { recentRuns } from "./agent-runs";
import { FeedRow } from "./feed";
import { formatCost, formatDateTime } from "./format";
import type { Action, FeedEntry, TeamAgent } from "./model";
import type { HqEvent } from "./schemas";
import { strings } from "./strings";
import { AgentCard } from "./team";
import { buttonClass } from "./ui";

const t = strings.room.sheet;

/**
 * The sheet of an agent, opened from its character or from the list under the
 * room: the card of the team (role, model, tools, routines and their switch,
 * last run, the button that starts a run) and the journal of its recent runs,
 * rebuilt from the events the page holds. A side panel on a wide screen, the
 * whole screen on a phone (see .room-sheet).
 */
export function AgentSheet({
  agent,
  events,
  dispatch,
  onClose,
}: {
  agent: TeamAgent;
  events: HqEvent[];
  dispatch: (action: Action) => void;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  const runs = useMemo(() => recentRuns(events, agent.key, agent.lastRun), [events, agent.key, agent.lastRun]);

  // Focus goes in when the sheet opens and back to what opened it when it closes; Escape closes.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener?.focus();
    };
  }, []);

  return (
    <aside className="room-sheet" role="dialog" aria-label={t.label(agent.name)}>
      <div className="room-sheet-head">
        <h2 className="wall-display text-lg font-semibold">{agent.name}</h2>
        <button ref={closeRef} type="button" className={buttonClass()} onClick={onClose}>
          {t.close}
        </button>
      </div>
      <div className="room-sheet-body">
        <ul>
          <AgentCard agent={agent} dispatch={dispatch} showTools />
        </ul>
        <section className="space-y-2" aria-labelledby="room-sheet-runs">
          <h3 id="room-sheet-runs" className="text-sm font-semibold">
            {t.recentRuns}
          </h3>
          {runs.length === 0 ? (
            <p className="text-sm text-muted">{t.noRuns}</p>
          ) : (
            <ul className="space-y-2">
              {runs.map((run) => (
                <li key={run.runId}>
                  <details className="rounded-lg border border-line bg-card px-3 py-2">
                    <summary className="cursor-pointer text-sm">
                      <span className="font-medium">
                        {t.run({
                          id: run.runId,
                          status: strings.team.runStatus[run.status],
                          date: formatDateTime(run.startedAt),
                        })}
                      </span>
                      <span className="text-muted">
                        {run.costUsd !== null && run.costUsd > 0 ? `, ${t.runCost(formatCost(run.costUsd))}` : ""}
                        {`, ${t.events(run.events.length)}`}
                      </span>
                    </summary>
                    <ul className="mt-2 max-h-80 space-y-2 overflow-y-auto pr-1">
                      {run.events.map((event) => {
                        const entry: FeedEntry = {
                          key: `event:${event.id}`,
                          at: event.createdAt,
                          room: event.room,
                          kind: "event",
                          event,
                        };
                        return <FeedRow key={entry.key} entry={entry} />;
                      })}
                    </ul>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </aside>
  );
}
