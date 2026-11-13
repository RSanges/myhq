import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUTOPLAY_MAX,
  autoplayRuns,
  canCompare,
  elapsedText,
  liveFigures,
  mergeTimeline,
  shownIndex,
  wantsReload,
} from "../src/ui/live-room-model";
import type { LiveTile, PieceVersion } from "../src/ui/schemas";

const MINUTE = 60_000;
const NOW = Date.parse("2026-11-13T20:05:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const version = (path: string, at: number, kind: PieceVersion["kind"] = "video", caption: string | null = null): PieceVersion => ({
  path,
  kind,
  at: iso(at),
  size: 1,
  url: kind === "text" ? null : `/api/live/runs/1/file?path=${path}`,
  excerpt: null,
  caption,
});

function tile(overrides: Partial<LiveTile> = {}): LiveTile {
  return {
    runId: 1,
    room: "demo",
    roomColor: null,
    agentId: "a",
    agentName: "A",
    task: "Le film",
    taskSummary: null,
    state: "working",
    runStatus: "running",
    startedAt: iso(NOW - 38 * MINUTE),
    endedAt: null,
    costUsd: 1.5,
    status: null,
    previous: [],
    waitingSince: null,
    piece: null,
    ...overrides,
  };
}

test("elapsedText: the run's duration while it runs, how long ago it ended once done", () => {
  assert.equal(elapsedText(tile(), NOW), "38 min");
  assert.equal(elapsedText(tile({ startedAt: iso(NOW - 65 * MINUTE) }), NOW), "1 h 05");
  assert.equal(elapsedText(tile({ state: "done", endedAt: iso(NOW - 2 * MINUTE - 10_000) }), NOW), "terminé il y a 2 min");
  assert.equal(elapsedText(tile({ state: "done", endedAt: iso(NOW - 10_000) }), NOW), "terminé à l'instant");
});

test("liveFigures: agents at work and waiting, and the cost of the runs in progress only", () => {
  const figures = liveFigures([
    tile({ costUsd: 5.1 }),
    tile({ state: "waiting", costUsd: 3.2 }),
    tile({ state: "done", costUsd: 9 }),
    tile({ costUsd: null }),
  ]);
  assert.deepEqual({ ...figures, costUsd: Math.round(figures.costUsd * 100) / 100 }, { working: 2, waiting: 1, costUsd: 8.3 });
});

test("mergeTimeline: start, statuses and versions in time order, the last status of a live run marked now, then the end", () => {
  const piece = { source: "auto" as const, versions: [version("v1.mp4", NOW - 20 * MINUTE), version("v2.mp4", NOW - 10 * MINUTE)] };
  const statuses = [
    { text: "lit le brief", at: iso(NOW - 25 * MINUTE), waiting: false },
    { text: "rend le plan", at: iso(NOW - 15 * MINUTE), waiting: false },
    { text: "compare", at: iso(NOW - 5 * MINUTE), waiting: false },
  ];
  const live = mergeTimeline(tile({ piece }), statuses);
  assert.deepEqual(
    live.map((entry) => [entry.kind, entry.text ?? entry.version]),
    [
      ["start", "Le film"],
      ["status", "lit le brief"],
      ["version", 0],
      ["status", "rend le plan"],
      ["version", 1],
      ["now", "compare"],
    ],
  );
  assert.ok(live.every((entry, i) => i === 0 || Date.parse(entry.at) >= Date.parse(live[i - 1]!.at)));
  assert.equal(new Set(live.map((entry) => entry.key)).size, live.length, "unique keys");

  const waiting = mergeTimeline(tile({ state: "waiting" }), [{ text: "attend la carte", at: iso(NOW - MINUTE), waiting: true }]);
  assert.deepEqual(waiting.map((entry) => entry.kind), ["start", "wait"]);

  const pinned = { source: "pin" as const, versions: [version("sheet.png", NOW - 3 * MINUTE, "image", "Regarde")] };
  const done = mergeTimeline(tile({ state: "done", runStatus: "done", endedAt: iso(NOW - MINUTE), piece: pinned }), statuses);
  assert.deepEqual(done.map((entry) => entry.kind), ["start", "status", "status", "status", "pin", "end"]);
});

test("shownIndex: the version the owner chose while it exists, else the latest", () => {
  const piece = { source: "auto" as const, versions: [version("a.mp4", 1), version("b.mp4", 2), version("c.mp4", 3)] };
  assert.equal(shownIndex(piece, undefined), 2);
  assert.equal(shownIndex(piece, "a.mp4"), 0);
  assert.equal(shownIndex(piece, "gone.mp4"), 2);
});

test("autoplayRuns: at most four live tiles whose shown piece is a video, none with reduced motion", () => {
  const video = { source: "auto" as const, versions: [version("a.mp4", 1)] };
  const image = { source: "auto" as const, versions: [version("a.png", 1, "image")] };
  const tiles = [
    tile({ runId: 1, piece: video }),
    tile({ runId: 2, piece: image }),
    tile({ runId: 3, piece: video, state: "done" }),
    tile({ runId: 4, piece: video, state: "waiting" }),
    tile({ runId: 5, piece: video }),
    tile({ runId: 6, piece: video }),
    tile({ runId: 7, piece: video }),
  ];
  assert.equal(AUTOPLAY_MAX, 4);
  assert.deepEqual([...autoplayRuns(tiles, new Map(), false)], [1, 4, 5, 6]);
  const chosen = new Map([[1, "a.png"]]);
  assert.deepEqual([...autoplayRuns([tile({ runId: 1, piece: { source: "auto", versions: [version("a.png", 1, "image"), version("b.mp4", 2)] } })], chosen, false)], []);
  assert.deepEqual([...autoplayRuns(tiles, new Map(), true)], []);
});

test("canCompare: two versions or more, all videos or all images", () => {
  assert.equal(canCompare(null), false);
  assert.equal(canCompare({ source: "auto", versions: [version("a.mp4", 1)] }), false);
  assert.equal(canCompare({ source: "auto", versions: [version("a.mp4", 1), version("b.mp4", 2)] }), true);
  assert.equal(canCompare({ source: "auto", versions: [version("a.png", 1, "image"), version("b.png", 2, "image")] }), true);
  assert.equal(canCompare({ source: "auto", versions: [version("a.mp4", 1), version("b.png", 2, "image")] }), false);
  assert.equal(canCompare({ source: "auto", versions: [version("a.md", 1, "text"), version("b.md", 2, "text")] }), false);
});

test("wantsReload: a run, a status or a shown piece, and the result of those calls; other events do not", () => {
  const tracked = new Set<string>();
  assert.equal(wantsReload({ type: "tool_call", data: { id: "t1", name: "mcp__hq__hq_status", input: {} } }, tracked), true);
  assert.equal(wantsReload({ type: "tool_call", data: { id: "t2", name: "mcp__hq__hq_show", input: {} } }, tracked), true);
  assert.equal(wantsReload({ type: "tool_call", data: { id: "t3", name: "Write", input: {} } }, tracked), false);
  assert.equal(wantsReload({ type: "tool_result", data: { toolUseId: "t2", isError: false } }, tracked), true);
  assert.equal(wantsReload({ type: "tool_result", data: { toolUseId: "t3", isError: false } }, tracked), false);
  assert.equal(wantsReload({ type: "text", data: { text: "x" } }, tracked), false);
  assert.equal(wantsReload({ type: "start", data: {} }, tracked), true);
  assert.equal(wantsReload({ type: "end", data: {} }, tracked), true);
  assert.equal(tracked.has("t2"), false, "a result is followed once");
});
