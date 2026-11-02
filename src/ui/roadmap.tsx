"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { Roadmap } from "@/server/roadmap-schema";
import { formatDateTime } from "./format";
import { Journal, OpenNotes } from "./roadmap-board";
import { Items } from "./roadmap-items";
import { newestFirst, overallKey, overallProgress, updatedKey } from "./roadmap-model";
import { flash, statusKey } from "./roadmap-parts";
import { Stepper } from "./roadmap-stepper";
import { strings } from "./strings";
import { buttonClass, ErrorNote } from "./ui";
import { useRoadmap } from "./use-roadmap";

const t = strings.roadmap;

export function RoadmapView() {
  const { state, retry, pulse, connected } = useRoadmap();

  useEffect(() => {
    document.title = t.pageTitle;
  }, []);

  const ready = state.status === "ready" ? state : null;

  return (
    <div className="wall-page">
      <header className="wall-hero">
        <div className="wall-wrap">
          <div className="wall-hero-top">
            <Link href="/" className="wall-back">
              <svg viewBox="0 0 20 20" aria-hidden focusable="false">
                <path d="M12 4 6 10l6 6" />
              </svg>
              {t.back}
            </Link>
            <p className="wall-live" role="status" data-connected={connected ? "" : undefined}>
              <span className="wall-live-dot" aria-hidden>
                {pulse > 0 && <span key={pulse} className="wall-live-ping" />}
              </span>
              {connected ? t.live : t.reconnecting}
              {ready && (
                <span className={`wall-updated${flash(ready.changed, updatedKey)}`}>
                  <span aria-hidden> · </span>
                  {t.updatedAt(formatDateTime(ready.roadmap.updatedAt))}
                </span>
              )}
            </p>
          </div>
          <h1 className="wall-title wall-display">{t.title}</h1>
          {ready && <Overall roadmap={ready.roadmap} changed={ready.changed} />}
        </div>
      </header>

      <div className="wall-wrap wall-body">
        {state.status === "loading" && <p className="wall-empty-text">{t.loading}</p>}
        {state.status === "missing" && <p className="wall-empty-text">{t.missing}</p>}
        {state.status === "error" && (
          <div className="space-y-3">
            <ErrorNote>
              {t.loadFailed} {state.message}
            </ErrorNote>
            <button type="button" className={buttonClass()} onClick={retry}>
              {t.retry}
            </button>
          </div>
        )}
        {ready && <RoadmapBody roadmap={ready.roadmap} changed={ready.changed} />}
      </div>
    </div>
  );
}

/** One big number and a thin bar cut in one segment per slice. */
function Overall({ roadmap, changed }: { roadmap: Roadmap; changed: ReadonlySet<string> }) {
  const percent = overallProgress(roadmap.slices);
  const proved = roadmap.slices.filter((slice) => slice.proved !== "").length;
  const done = roadmap.items.filter((item) => item.status === "fait").length;
  return (
    <div className="wall-overall">
      <div className="wall-overall-figure">
        <p className="wall-big wall-display" aria-label={`${t.overallLabel} : ${t.progress(percent)}`}>
          <span className={`wall-big-value${flash(changed, overallKey)}`}>{percent}</span>
          <span className="wall-big-unit" aria-hidden>
            %
          </span>
        </p>
        <div className="wall-overall-text">
          <p className="wall-overall-caption">{t.overallCaption}</p>
          <p className="wall-overall-stats">
            <span>{t.provedCount(proved, roadmap.slices.length)}</span>
            <span>{t.doneCount(done, roadmap.items.length)}</span>
          </p>
        </div>
      </div>
      <div
        className="wall-segments"
        role="progressbar"
        aria-label={t.segmentsLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        {roadmap.slices.map((slice, index) => (
          <div key={slice.id} className="wall-segment" data-status={statusKey[slice.status]} title={slice.name}>
            <span className="wall-segment-track">
              <span
                className="wall-segment-fill"
                style={{ transform: `scaleX(${Math.round(slice.progress) / 100})` }}
              />
            </span>
            <span className="wall-segment-label" aria-hidden>
              <b>{index + 1}</b>
              <span>{slice.name}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function RoadmapBody({ roadmap, changed }: { roadmap: Roadmap; changed: ReadonlySet<string> }) {
  const events = useMemo(() => newestFirst(roadmap.events), [roadmap.events]);
  const [selected, setSelected] = useState<number | "all">("all");
  // A slice that disappeared from the file can no longer be the focus.
  const focus = selected !== "all" && roadmap.slices.some((slice) => slice.id === selected) ? selected : "all";

  return (
    <>
      <Stepper slices={roadmap.slices} selected={focus} onSelect={setSelected} changed={changed} />
      <Items roadmap={roadmap} slice={focus} onShowAll={() => setSelected("all")} changed={changed} />
      <div className="wall-board">
        <OpenNotes points={roadmap.openPoints} changed={changed} />
        <Journal events={events} changed={changed} />
      </div>
    </>
  );
}
