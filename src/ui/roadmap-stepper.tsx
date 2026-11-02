import type { CSSProperties } from "react";
import type { RoadmapSlice } from "@/server/roadmap-schema";
import { formatDay } from "./format";
import { currentSlice, sliceKey } from "./roadmap-model";
import { flash, statusKey, StatusChip } from "./roadmap-parts";
import { strings } from "./strings";

const t = strings.roadmap;

/** Progress arc: the track, then the arc drawn over it (pathLength 100, so dasharray is the percentage). */
function Ring({ percent, status, changed }: { percent: number; status: RoadmapSlice["status"]; changed: boolean }) {
  return (
    <span className="wall-ring" data-status={statusKey[status]}>
      <svg viewBox="0 0 64 64" aria-hidden focusable="false">
        <circle className="wall-ring-track" cx="32" cy="32" r="27" pathLength={100} />
        {percent > 0 && (
          <circle
            className="wall-ring-arc"
            cx="32"
            cy="32"
            r="27"
            pathLength={100}
            strokeDasharray={`${percent} 100`}
            transform="rotate(-90 32 32)"
          />
        )}
      </svg>
      <span className={`wall-ring-value${changed ? " wall-flash" : ""}`}>{percent}</span>
    </span>
  );
}

/**
 * The slices as a stepper: a row on wide screens, a column on phones. Each step
 * is a toggle: click it to focus the list below on that slice, click again to
 * see them all.
 */
export function Stepper({
  slices,
  selected,
  onSelect,
  changed,
}: {
  slices: RoadmapSlice[];
  selected: number | "all";
  onSelect: (id: number | "all") => void;
  changed: ReadonlySet<string>;
}) {
  const current = currentSlice(slices);
  return (
    <ol className="wall-steps" aria-label={t.slicesTitle}>
      {slices.map((slice, index) => {
        const percent = Math.round(slice.progress);
        const isSelected = selected === slice.id;
        return (
          <li
            key={slice.id}
            className="wall-step"
            style={{ "--i": index } as CSSProperties}
            data-status={statusKey[slice.status]}
            data-current={current?.id === slice.id ? "" : undefined}
          >
            <button
              type="button"
              className={`wall-step-card${flash(changed, sliceKey(slice.id))}`}
              aria-pressed={isSelected}
              title={isSelected ? t.stepSelected : t.stepHint}
              onClick={() => onSelect(isSelected ? "all" : slice.id)}
            >
              {current?.id === slice.id && <span className="wall-step-flag">{t.currentStep}</span>}
              <span className="wall-step-head">
                <Ring percent={percent} status={slice.status} changed={changed.has(sliceKey(slice.id))} />
                <span className="wall-step-meta">
                  <span className="wall-step-index">{t.step(index + 1)}</span>
                  <StatusChip status={slice.status} />
                </span>
              </span>
              <span className="wall-step-name wall-display">{slice.name}</span>
              {slice.criterion !== "" && (
                <span className="wall-step-criterion">
                  <span className="wall-step-criterion-label">{t.criterion}</span>
                  {slice.criterion}
                </span>
              )}
              {slice.proved !== "" && <span className="wall-stamp">{t.provedOn(formatDay(slice.proved))}</span>}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
