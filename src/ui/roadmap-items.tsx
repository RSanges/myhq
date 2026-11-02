import { useMemo, useState } from "react";
import type { Roadmap, RoadmapItem, RoadmapStatus } from "@/server/roadmap-schema";
import { formatShortDay } from "./format";
import {
  filterItems,
  groupBySlice,
  itemKeys,
  sliceKey,
  statusCounts,
  type ItemGroup,
} from "./roadmap-model";
import { flash, OwnerDot, StatusChip } from "./roadmap-parts";
import { strings } from "./strings";

const t = strings.roadmap;

const statusOrder: RoadmapStatus[] = ["fait", "en cours", "à faire", "bloqué"];

function Row({ item, itemKey, changed }: { item: RoadmapItem; itemKey: string; changed: ReadonlySet<string> }) {
  return (
    <li className={`wall-row${flash(changed, itemKey)}`}>
      <span className="wall-row-status">
        <StatusChip status={item.status} />
      </span>
      <span className="wall-row-main">
        <span className="wall-row-name">{item.name}</span>
        {item.note !== "" && <span className="wall-row-note">{item.note}</span>}
      </span>
      <span className="wall-row-side">
        <OwnerDot owner={item.owner} />
        <span className="wall-row-date">{item.date === "" ? "" : formatShortDay(item.date)}</span>
      </span>
    </li>
  );
}

function Group({
  group,
  keys,
  changed,
  total,
  done,
  open,
  onToggle,
}: {
  group: ItemGroup;
  keys: Map<RoadmapItem, string>;
  changed: ReadonlySet<string>;
  total: number;
  done: number;
  open: boolean;
  onToggle: () => void;
}) {
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <section className="wall-group" aria-labelledby={`wall-group-${group.id}`}>
      <h3 id={`wall-group-${group.id}`} className="wall-group-heading">
        <button
          type="button"
          className={`wall-group-head${group.slice ? flash(changed, sliceKey(group.id)) : ""}`}
          aria-expanded={open}
          onClick={onToggle}
        >
          <svg className="wall-group-chevron" viewBox="0 0 20 20" aria-hidden focusable="false">
            <path d="m7 4 6 6-6 6" />
          </svg>
          <span className="wall-group-title wall-display">{group.slice?.name ?? t.unknownSlice(group.id)}</span>
          <span className="wall-group-count">{t.groupDone(done, total)}</span>
          <span className="wall-group-bar" aria-hidden>
            <span style={{ transform: `scaleX(${percent / 100})` }} />
          </span>
        </button>
      </h3>
      {open && (
        <ul className="wall-rows">
          {group.items.map((item) => (
            <Row key={keys.get(item)} item={item} itemKey={keys.get(item)!} changed={changed} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** The items under their slice: filter by status, search, and the slice picked in the stepper. */
export function Items({
  roadmap,
  slice,
  onShowAll,
  changed,
}: {
  roadmap: Roadmap;
  slice: number | "all";
  onShowAll: () => void;
  changed: ReadonlySet<string>;
}) {
  const [status, setStatus] = useState<RoadmapStatus | "all">("all");
  const [query, setQuery] = useState("");

  const keys = useMemo(() => itemKeys(roadmap.items), [roadmap.items]);
  const inSlice = useMemo(() => filterItems(roadmap.items, { slice, status: "all" }), [roadmap.items, slice]);
  const counts = useMemo(
    () => statusCounts(filterItems(inSlice, { slice: "all", status: "all", query })),
    [inSlice, query],
  );
  const shown = useMemo(() => filterItems(inSlice, { slice: "all", status, query }), [inSlice, status, query]);
  const groups = useMemo(() => groupBySlice(roadmap.slices, shown), [roadmap.slices, shown]);
  // The progress of a group counts all its items, whatever the filter says.
  const totals = useMemo(() => {
    const map = new Map<number, { total: number; done: number }>();
    for (const item of roadmap.items) {
      const entry = map.get(item.slice) ?? { total: 0, done: 0 };
      entry.total += 1;
      if (item.status === "fait") entry.done += 1;
      map.set(item.slice, entry);
    }
    return map;
  }, [roadmap.items]);

  // A slice that is entirely done starts folded, so that the wall shows what is left to do.
  // Searching, filtering or picking a slice unfolds everything; a click on a title overrides.
  const [toggled, setToggled] = useState<ReadonlyMap<number, boolean>>(new Map());
  const filtered = status !== "all" || query.trim() !== "" || slice !== "all";

  return (
    <section className="wall-panel" aria-labelledby="wall-items-title">
      <div className="wall-panel-head">
        <h2 id="wall-items-title" className="wall-panel-title wall-display">
          {t.itemsTitle}
          <span className="wall-panel-count" aria-live="polite">
            {t.count(shown.length, roadmap.items.length)}
          </span>
        </h2>
        <div className="wall-tools">
          <label className="wall-search">
            <svg viewBox="0 0 20 20" aria-hidden focusable="false">
              <circle cx="8.5" cy="8.5" r="5.5" />
              <path d="M12.5 12.5 17 17" />
            </svg>
            <input
              type="search"
              value={query}
              placeholder={t.searchPlaceholder}
              aria-label={t.searchLabel}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="wall-filters" role="group" aria-label={t.statusGroupLabel}>
            {(["all", ...statusOrder] as const).map((value) => (
              <button
                key={value}
                type="button"
                className="wall-filter"
                aria-pressed={status === value}
                onClick={() => setStatus(value)}
              >
                {value === "all" ? t.filterAllStatuses : t.status[value]}
                <span className="wall-filter-count">{counts[value]}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {groups.length === 0 ? (
        <div className="wall-empty">
          <p>{t.noItems}</p>
          {filtered && (
            <button
              type="button"
              className="wall-link"
              onClick={() => {
                setStatus("all");
                setQuery("");
                onShowAll();
              }}
            >
              {t.showAll}
            </button>
          )}
        </div>
      ) : (
        <div className="wall-groups">
          {groups.map((group) => {
            const sums = totals.get(group.id) ?? { total: group.items.length, done: 0 };
            const open = toggled.get(group.id) ?? (filtered || sums.done < sums.total);
            return (
              <Group
                key={group.id}
                group={group}
                keys={keys}
                changed={changed}
                total={sums.total}
                done={sums.done}
                open={open}
                onToggle={() => setToggled(new Map(toggled).set(group.id, !open))}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
