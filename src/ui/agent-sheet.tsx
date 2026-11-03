"use client";

import { useEffect, useMemo, useRef, type ReactNode } from "react";
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
 * The shell of a sheet: a side panel on a wide screen, the whole screen on a
 * phone (see .room-sheet), with a title and a close button. Focus goes in when
 * it opens and back to what opened it when it closes; Escape closes.
 */
export function SheetShell({
  label,
  title,
  onClose,
  children,
}: {
  label: string;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

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
    <aside className="room-sheet" role="dialog" aria-label={label}>
      <div className="room-sheet-head">
        <h2 className="wall-display text-lg font-semibold">{title}</h2>
        <button ref={closeRef} type="button" className={buttonClass()} onClick={onClose}>
          {t.close}
        </button>
      </div>
      <div className="room-sheet-body">{children}</div>
    </aside>
  );
}

/**
 * The sheet of an agent, opened from its character or from the list under the
 * room: the card of the team (role, model, tools, routines and their switch,
 * last run, the button that starts a run) and the journal of its recent runs,
 * rebuilt from the events the page holds.
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
  const runs = useMemo(() => recentRuns(events, agent.key, agent.lastRun), [events, agent.key, agent.lastRun]);

  return (
    <SheetShell label={t.label(agent.name)} title={agent.name} onClose={onClose}>
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
    </SheetShell>
  );
}
