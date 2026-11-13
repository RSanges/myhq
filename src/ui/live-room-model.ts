import { HQ_STATUS_TOOL } from "./activity";
import { formatDuration } from "./format";
import type { LiveTile, LiveRun } from "./schemas";
import { strings } from "./strings";

// Pure helpers of the surveillance room (live-room.tsx): no DOM, no React.

export const HQ_SHOW_TOOL = "mcp__hq__hq_show";
/** The most tile videos that play at once; the others show their first image. */
export const AUTOPLAY_MAX = 4;

type Piece = NonNullable<LiveTile["piece"]>;

const minutesSince = (iso: string, now: number) => Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));

/** The time of a tile: how long the run has been going, or how long ago it ended. */
export function elapsedText(tile: LiveTile, now: number): string {
  if (tile.state === "done" && tile.endedAt) return strings.live.endedAgo(minutesSince(tile.endedAt, now));
  return formatDuration(Math.max(0, now - Date.parse(tile.startedAt)));
}

/** The minutes since an instant, for « En pause depuis 3 min ». */
export const pausedMinutes = minutesSince;

/** The figures of the hero: agents at work, agents waiting, and the cost of the runs in progress. */
export function liveFigures(tiles: readonly LiveTile[]): { working: number; waiting: number; costUsd: number } {
  let working = 0;
  let waiting = 0;
  let costUsd = 0;
  for (const tile of tiles) {
    if (tile.state === "done") continue;
    if (tile.state === "working") working += 1;
    else waiting += 1;
    costUsd += tile.costUsd ?? 0;
  }
  return { working, waiting, costUsd };
}

/** The version a tile shows: the one the owner chose while it is still there, else the latest. */
export function shownIndex(piece: Piece, chosenPath: string | undefined): number {
  const chosen = chosenPath === undefined ? -1 : piece.versions.findIndex((version) => version.path === chosenPath);
  return chosen >= 0 ? chosen : piece.versions.length - 1;
}

/**
 * The runs whose tile video plays: the live tiles (not done) whose shown
 * version is a video, AUTOPLAY_MAX at most, in the order of the grid. None
 * when the owner asks for reduced motion.
 */
export function autoplayRuns(tiles: readonly LiveTile[], chosen: ReadonlyMap<number, string>, reducedMotion: boolean): Set<number> {
  const runs = new Set<number>();
  if (reducedMotion) return runs;
  for (const tile of tiles) {
    if (runs.size >= AUTOPLAY_MAX) break;
    if (tile.state === "done" || !tile.piece) continue;
    if (tile.piece.versions[shownIndex(tile.piece, chosen.get(tile.runId))]?.kind === "video") runs.add(tile.runId);
  }
  return runs;
}

/** Two versions side by side make sense for two videos or two images. */
export function canCompare(piece: Piece | null): boolean {
  if (!piece || piece.versions.length < 2) return false;
  const kind = piece.versions[0]!.kind;
  return (kind === "video" || kind === "image") && piece.versions.every((version) => version.kind === kind);
}

export type TimelineEntry = {
  key: string;
  at: string;
  kind: "start" | "status" | "wait" | "now" | "version" | "pin" | "end";
  /** The status, the task (start). */
  text?: string;
  /** The index of the version in the tile's piece. */
  version?: number;
};

/**
 * The thread of a run in the detail panel: its start, its statuses and the
 * versions of its piece, in time order (a status before a version of the same
 * instant). The latest status of a live run is « now » unless it waits; a
 * finished run ends with its end.
 */
export function mergeTimeline(tile: LiveTile, statuses: LiveRun["timeline"]): TimelineEntry[] {
  const entries: TimelineEntry[] = statuses.map((status, i) => ({
    key: `s${i}`,
    at: status.at,
    kind: status.waiting ? "wait" : "status",
    text: status.text,
  }));
  const pinned = tile.piece?.source === "pin";
  (tile.piece?.versions ?? []).forEach((version, i) => {
    entries.push({ key: `v${i}`, at: version.at, kind: pinned ? "pin" : "version", version: i });
  });
  // Stable: statuses keep their order, and come before a version of the same instant.
  entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (tile.state === "working") {
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i]!.kind === "status") {
        entries[i] = { ...entries[i]!, kind: "now" };
        break;
      }
    }
  }
  const timeline: TimelineEntry[] = [{ key: "start", at: tile.startedAt, kind: "start", text: tile.task }, ...entries];
  if (tile.state === "done" && tile.endedAt) timeline.push({ key: "end", at: tile.endedAt, kind: "end" });
  return timeline;
}

/** An event of the stream, as /api/events gives it (type and data). */
export type StreamEvent = { type: string; data: Record<string, unknown> };

/**
 * Whether an event of a run asks the room to read its tiles again: a run that
 * starts or ends, a call to hq_status or hq_show (remembered in `tracked`),
 * and the result of such a call, which comes once the HQ server has stored it.
 */
export function wantsReload(event: StreamEvent, tracked: Set<string>): boolean {
  if (event.type === "start" || event.type === "end") return true;
  if (event.type === "tool_call") {
    const { id, name } = event.data;
    if (name !== HQ_STATUS_TOOL && name !== HQ_SHOW_TOOL) return false;
    if (typeof id === "string") tracked.add(id);
    return true;
  }
  if (event.type === "tool_result") {
    const id = event.data.toolUseId;
    return typeof id === "string" && tracked.delete(id);
  }
  return false;
}
