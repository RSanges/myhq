import type {
  Roadmap,
  RoadmapEvent,
  RoadmapItem,
  RoadmapOpenPoint,
  RoadmapSlice,
  RoadmapStatus,
} from "@/server/roadmap-schema";

export type ItemFilter = { slice: number | "all"; status: RoadmapStatus | "all"; query?: string };

export const initialItemFilter: ItemFilter = { slice: "all", status: "all", query: "" };

/** Lower case, accents removed: a search for "etape" finds "Étape". */
function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function filterItems(items: RoadmapItem[], filter: ItemFilter): RoadmapItem[] {
  const query = fold((filter.query ?? "").trim());
  return items.filter(
    (item) =>
      (filter.slice === "all" || item.slice === filter.slice) &&
      (filter.status === "all" || item.status === filter.status) &&
      (query === "" || fold(`${item.name} ${item.note} ${item.owner}`).includes(query)),
  );
}

/** Number of items per status (and the total under `all`). */
export function statusCounts(items: RoadmapItem[]): Record<RoadmapStatus | "all", number> {
  const counts = { all: items.length, fait: 0, "en cours": 0, "à faire": 0, bloqué: 0 };
  for (const item of items) counts[item.status] += 1;
  return counts;
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

/** Mean progress of the slices, rounded, 0 to 100 (0 when there is no slice). */
export function overallProgress(slices: RoadmapSlice[]): number {
  if (slices.length === 0) return 0;
  return Math.round(slices.reduce((sum, slice) => sum + slice.progress, 0) / slices.length);
}

/** The slice being worked on: the first one in progress, else the first not done. */
export function currentSlice(slices: RoadmapSlice[]): RoadmapSlice | null {
  return (
    slices.find((slice) => slice.status === "en cours") ??
    slices.find((slice) => slice.status !== "fait") ??
    null
  );
}

export type ItemGroup = { id: number; slice: RoadmapSlice | null; items: RoadmapItem[] };

/**
 * Items grouped by slice, in slice order. Groups without item are left out;
 * items whose slice does not exist come last, one group per unknown id.
 */
export function groupBySlice(slices: RoadmapSlice[], items: RoadmapItem[]): ItemGroup[] {
  const groups: ItemGroup[] = slices.map((slice) => ({ id: slice.id, slice, items: [] }));
  for (const item of items) {
    let group = groups.find((entry) => entry.id === item.slice);
    if (!group) {
      group = { id: item.slice, slice: null, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups.filter((group) => group.items.length > 0);
}

/** First letter of an owner, upper case (empty for no owner). */
export function ownerInitial(owner: string): string {
  const first = Array.from(owner.trim())[0];
  return first ? first.toLocaleUpperCase() : "";
}

/** Stable small number for an owner name, to pick one of a few tints. */
export function ownerTint(owner: string, tints: number): number {
  let hash = 0;
  for (const char of owner.trim().toLowerCase()) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return hash % tints;
}

/** The `YYYY-MM-DD` and `HH:MM` parts of a journal time, as written (null when absent). */
export function eventParts(at: string): { day: string | null; time: string | null } {
  const match = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(at.trim());
  return { day: match?.[1] ?? null, time: match?.[2] ?? null };
}

export type EventDay = { day: string | null; events: RoadmapEvent[] };

/** Newest-first journal split into consecutive runs of the same day. */
export function groupEventsByDay(events: RoadmapEvent[]): EventDay[] {
  const days: EventDay[] = [];
  for (const event of events) {
    const { day } = eventParts(event.at);
    const last = days[days.length - 1];
    if (last && last.day === day) last.events.push(event);
    else days.push({ day, events: [event] });
  }
  return days;
}

// ---- Change detection (what to highlight after a live update) ----

export const overallKey = "overall";
export const updatedKey = "updated";
export const sliceKey = (id: number): string => `slice:${id}`;

/** Keys that stay the same as long as the entry does, even if others move around it. */
function occurrenceKeys<T>(entries: T[], base: (entry: T) => string): string[] {
  const seen = new Map<string, number>();
  return entries.map((entry) => {
    const key = base(entry);
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    return `${key}#${count}`;
  });
}

export function itemKeys(items: RoadmapItem[]): Map<RoadmapItem, string> {
  const keys = occurrenceKeys(items, (item) => `item:${item.slice}:${item.name}`);
  return new Map(items.map((item, index) => [item, keys[index]!]));
}

export function openPointKeys(points: RoadmapOpenPoint[]): Map<RoadmapOpenPoint, string> {
  const keys = occurrenceKeys(points, (point) => `point:${point.name}`);
  return new Map(points.map((point, index) => [point, keys[index]!]));
}

export const eventKey = (event: RoadmapEvent): string => `event:${event.at}|${event.text}`;

const itemSignature = (item: RoadmapItem) => [item.status, item.owner, item.date, item.note].join("\u0000");
const pointSignature = (point: RoadmapOpenPoint) => [point.status, point.note].join("\u0000");
const sliceSignature = (slice: RoadmapSlice) =>
  [slice.name, slice.status, slice.progress, slice.criterion, slice.proved, slice.note].join("\u0000");

/** Keys of everything that is new or different in `next` compared to `previous`. */
export function diffRoadmap(previous: Roadmap, next: Roadmap): Set<string> {
  const changed = new Set<string>();

  if (previous.updatedAt !== next.updatedAt) changed.add(updatedKey);
  if (overallProgress(previous.slices) !== overallProgress(next.slices)) changed.add(overallKey);

  const oldSlices = new Map(previous.slices.map((slice) => [slice.id, sliceSignature(slice)]));
  for (const slice of next.slices) {
    if (oldSlices.get(slice.id) !== sliceSignature(slice)) changed.add(sliceKey(slice.id));
  }

  const oldItems = new Map<string, string>();
  for (const [item, key] of itemKeys(previous.items)) oldItems.set(key, itemSignature(item));
  for (const [item, key] of itemKeys(next.items)) {
    if (oldItems.get(key) !== itemSignature(item)) changed.add(key);
  }

  const oldPoints = new Map<string, string>();
  for (const [point, key] of openPointKeys(previous.openPoints)) oldPoints.set(key, pointSignature(point));
  for (const [point, key] of openPointKeys(next.openPoints)) {
    if (oldPoints.get(key) !== pointSignature(point)) changed.add(key);
  }

  const oldEvents = new Set(previous.events.map(eventKey));
  for (const event of next.events) {
    if (!oldEvents.has(eventKey(event))) changed.add(eventKey(event));
  }

  return changed;
}
