"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type {
  OpenPointStatus,
  Roadmap,
  RoadmapSlice,
  RoadmapStatus,
} from "@/server/roadmap-schema";
import { formatDateTime, formatDay } from "./format";
import { filterItems, initialItemFilter, newestFirst, sliceName, type ItemFilter } from "./roadmap-model";
import { strings } from "./strings";
import { Badge, buttonClass, ErrorNote, fieldClass, Section } from "./ui";
import { useRoadmap } from "./use-roadmap";

const t = strings.roadmap;

const statusTone: Record<RoadmapStatus, "ok" | "accent" | "danger" | "neutral"> = {
  fait: "ok",
  "en cours": "accent",
  bloqué: "danger",
  "à faire": "neutral",
};

const barTone: Record<RoadmapStatus, string> = {
  fait: "bg-ok",
  "en cours": "bg-accent",
  bloqué: "bg-danger",
  "à faire": "bg-muted",
};

const statusOrder: RoadmapStatus[] = ["fait", "en cours", "à faire", "bloqué"];

function StatusPill({ status }: { status: RoadmapStatus }) {
  return <Badge tone={statusTone[status]}>{t.status[status]}</Badge>;
}

function OpenPointPill({ status }: { status: OpenPointStatus }) {
  return <Badge tone={status === "ouvert" ? "warn" : "ok"}>{t.openPointStatus[status]}</Badge>;
}

export function RoadmapView() {
  const { state, retry } = useRoadmap();

  useEffect(() => {
    document.title = t.pageTitle;
  }, []);

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6">
      <header className="space-y-1">
        <Link
          href="/"
          className="inline-block text-sm text-muted underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {t.back}
        </Link>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h1 className="text-xl font-semibold">{t.title}</h1>
          {state.status === "ready" && (
            <p className="text-sm text-muted">{t.updatedAt(formatDateTime(state.roadmap.updatedAt))}</p>
          )}
        </div>
      </header>

      {state.status === "loading" && <p className="text-sm text-muted">{t.loading}</p>}
      {state.status === "missing" && <p className="text-sm text-muted">{t.missing}</p>}
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
      {state.status === "ready" && <RoadmapBody roadmap={state.roadmap} />}
    </div>
  );
}

function RoadmapBody({ roadmap }: { roadmap: Roadmap }) {
  const events = useMemo(() => newestFirst(roadmap.events), [roadmap.events]);
  return (
    <>
      <Section title={t.slicesTitle}>
        <ul className="grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-4">
          {roadmap.slices.map((slice) => (
            <li key={slice.id} className="min-w-0">
              <SliceCard slice={slice} />
            </li>
          ))}
        </ul>
      </Section>

      <ItemsTable roadmap={roadmap} />

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title={t.openPointsTitle}>
          {roadmap.openPoints.length === 0 ? (
            <p className="text-sm text-muted">{t.noOpenPoints}</p>
          ) : (
            <ul className="space-y-3">
              {roadmap.openPoints.map((point, index) => (
                <li key={index} className="space-y-1 rounded-lg border border-line bg-card p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0 break-words text-sm font-medium">{point.name}</span>
                    <OpenPointPill status={point.status} />
                  </div>
                  {point.note !== "" && <p className="break-words text-sm text-muted">{point.note}</p>}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title={t.eventsTitle}>
          {events.length === 0 ? (
            <p className="text-sm text-muted">{t.noEvents}</p>
          ) : (
            <ol className="space-y-3">
              {events.map((event, index) => (
                <li key={index} className="rounded-lg border border-line bg-card p-3">
                  <time className="block text-xs text-muted" dateTime={event.at}>
                    {formatDateTime(event.at)}
                  </time>
                  <p className="break-words text-sm">{event.text}</p>
                </li>
              ))}
            </ol>
          )}
        </Section>
      </div>
    </>
  );
}

function SliceCard({ slice }: { slice: RoadmapSlice }) {
  const percent = Math.round(slice.progress);
  return (
    <article className="h-full space-y-3 rounded-lg border border-line bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="min-w-0 break-words text-sm font-semibold">{slice.name}</h3>
        <StatusPill status={slice.status} />
      </div>
      <div className="flex items-center gap-2">
        <div
          role="progressbar"
          aria-label={t.progressLabel(slice.name)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-soft"
        >
          <div className={`h-full rounded-full ${barTone[slice.status]}`} style={{ width: `${percent}%` }} />
        </div>
        <span className="text-xs tabular-nums text-muted">{t.progress(percent)}</span>
      </div>
      {slice.criterion !== "" && (
        <p className="break-words text-sm text-muted">
          <span className="font-medium text-foreground">{t.criterion} : </span>
          {slice.criterion}
        </p>
      )}
      {slice.proved !== "" && <p className="text-xs text-ok">{t.provedOn(formatDay(slice.proved))}</p>}
    </article>
  );
}

function ItemsTable({ roadmap }: { roadmap: Roadmap }) {
  const [filter, setFilter] = useState<ItemFilter>(initialItemFilter);
  const shown = useMemo(() => filterItems(roadmap.items, filter), [roadmap.items, filter]);
  const th = "px-3 py-2 text-left text-xs font-medium text-muted";

  return (
    <Section
      title={t.itemsTitle}
      aside={
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted" aria-live="polite">
            {t.count(shown.length, roadmap.items.length)}
          </span>
          <select
            aria-label={t.filterSlice}
            className={`${fieldClass} sm:w-auto`}
            value={String(filter.slice)}
            onChange={(e) =>
              setFilter({ ...filter, slice: e.target.value === "all" ? "all" : Number(e.target.value) })
            }
          >
            <option value="all">{t.filterAllSlices}</option>
            {roadmap.slices.map((slice) => (
              <option key={slice.id} value={slice.id}>
                {slice.name}
              </option>
            ))}
          </select>
          <select
            aria-label={t.filterStatus}
            className={`${fieldClass} sm:w-auto`}
            value={filter.status}
            onChange={(e) => setFilter({ ...filter, status: e.target.value as RoadmapStatus | "all" })}
          >
            <option value="all">{t.filterAllStatuses}</option>
            {statusOrder.map((status) => (
              <option key={status} value={status}>
                {t.status[status]}
              </option>
            ))}
          </select>
        </div>
      }
    >
      {shown.length === 0 ? (
        <p className="text-sm text-muted">{t.noItems}</p>
      ) : (
        <div className="rounded-lg border border-line bg-card">
          <table className="w-full table-fixed border-collapse text-sm">
            <thead className="border-b border-line">
              <tr>
                <th scope="col" className={th}>
                  {t.columns.name}
                </th>
                <th scope="col" className={`${th} w-24 sm:w-28`}>
                  {t.columns.status}
                </th>
                <th scope="col" className={`${th} hidden w-32 sm:table-cell`}>
                  {t.columns.owner}
                </th>
                <th scope="col" className={`${th} hidden w-28 sm:table-cell`}>
                  {t.columns.date}
                </th>
                <th scope="col" className={`${th} w-2/5`}>
                  {t.columns.note}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {shown.map((item, index) => (
                <tr key={index} className="align-top">
                  <td className="break-words px-3 py-2">
                    <span className="block font-medium">{item.name}</span>
                    <span className="block text-xs text-muted">
                      {sliceName(roadmap, item.slice) ?? t.unknownSlice(item.slice)}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <StatusPill status={item.status} />
                  </td>
                  <td className="hidden break-words px-3 py-2 text-muted sm:table-cell">{item.owner}</td>
                  <td className="hidden px-3 py-2 text-muted sm:table-cell">
                    {item.date === "" ? "" : formatDay(item.date)}
                  </td>
                  <td className="break-words px-3 py-2 text-muted">{item.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
