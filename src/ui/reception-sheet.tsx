"use client";

import { AddRoomForm } from "./add-room";
import { SheetShell } from "./agent-sheet";
import { formatCost, formatDateTime } from "./format";
import type { Action } from "./model";
import { onboardingTarget } from "./reception";
import type { Run } from "./schemas";
import { strings } from "./strings";

const t = strings.room.reception;

/**
 * The sheet of the receptionist (the onboarding agent), opened from its
 * character or its chip: what it does, the « Ajouter une salle » form (the same
 * as the desk's) and its recent onboarding runs with their target repository
 * and their cost. The runs come from the API (the state, then the stream), not
 * from the events the page holds.
 */
export function ReceptionSheet({
  runs,
  dispatch,
  onClose,
}: {
  runs: Run[];
  dispatch: (action: Action) => void;
  onClose: () => void;
}) {
  return (
    <SheetShell label={strings.room.sheet.label(t.name)} title={t.name} onClose={onClose}>
      <p className="text-sm text-muted">{t.intro}</p>
      <section className="space-y-2" aria-labelledby="room-reception-add">
        <h3 id="room-reception-add" className="text-sm font-semibold">
          {strings.team.addRoom.title}
        </h3>
        <AddRoomForm dispatch={dispatch} />
      </section>
      <section className="space-y-2" aria-labelledby="room-reception-runs">
        <h3 id="room-reception-runs" className="text-sm font-semibold">
          {t.recentRuns}
        </h3>
        {runs.length === 0 ? (
          <p className="text-sm text-muted">{t.noRuns}</p>
        ) : (
          <ul className="space-y-2">
            {runs.map((run) => {
              const target = onboardingTarget(run.task);
              return (
                <li key={run.id} className="rounded-lg border border-line bg-card px-3 py-2 text-sm">
                  <p className="font-medium">
                    {t.run({ id: run.id, status: strings.team.runStatus[run.status], date: formatDateTime(run.startedAt) })}
                  </p>
                  <p className="break-all text-muted">{target === null ? t.noTarget : t.target(target)}</p>
                  {run.costUsd > 0 && <p className="text-muted">{strings.room.sheet.runCost(formatCost(run.costUsd))}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </SheetShell>
  );
}
