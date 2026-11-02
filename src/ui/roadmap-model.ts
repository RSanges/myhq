import type { Roadmap, RoadmapEvent, RoadmapItem, RoadmapStatus } from "@/server/roadmap-schema";

export type ItemFilter = { slice: number | "all"; status: RoadmapStatus | "all" };

export const initialItemFilter: ItemFilter = { slice: "all", status: "all" };

export function filterItems(items: RoadmapItem[], filter: ItemFilter): RoadmapItem[] {
  return items.filter(
    (item) =>
      (filter.slice === "all" || item.slice === filter.slice) &&
      (filter.status === "all" || item.status === filter.status),
  );
}

/** Journal entries, newest first. Entries with an unreadable time go last. */
export function newestFirst(events: RoadmapEvent[]): RoadmapEvent[] {
  const time = (event: RoadmapEvent) => {
    const value = new Date(event.at).getTime();
    return Number.isNaN(value) ? Number.NEGATIVE_INFINITY : value;
  };
  return events
    .map((event, index) => ({ event, index, time: time(event) }))
    .sort((a, b) => (a.time === b.time ? b.index - a.index : b.time - a.time))
    .map((entry) => entry.event);
}

export function sliceName(roadmap: Roadmap, id: number): string | null {
  return roadmap.slices.find((slice) => slice.id === id)?.name ?? null;
}
