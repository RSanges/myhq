import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  loadRoadmap,
  readRoadmap,
  roadmapPath,
  roadmapResponse,
  roadmapSchema,
  subscribeRoadmap,
  watchRoadmap,
} from "../src/server/roadmap";
import {
  currentSlice,
  diffRoadmap,
  eventKey,
  eventParts,
  filterItems,
  groupBySlice,
  groupEventsByDay,
  itemKeys,
  newestFirst,
  openPointKeys,
  overallKey,
  overallProgress,
  ownerInitial,
  ownerTint,
  sliceKey,
  statusCounts,
  updatedKey,
} from "../src/ui/roadmap-model";

const sample = () => ({
  updatedAt: "2026-01-02T10:00:00+01:00",
  slices: [
    { id: 1, name: "Alpha", status: "fait", progress: 100, criterion: "It works", proved: "2026-01-01", note: "" },
    { id: 2, name: "Beta", status: "en cours", progress: 40, criterion: "", proved: "", note: "", extra: "ignored" },
  ],
  items: [
    { slice: 1, name: "One", status: "fait", owner: "me", date: "2026-01-01", note: "n" },
    { slice: 2, name: "Two", status: "bloqué", owner: "", date: "", note: "" },
    { slice: 2, name: "Three", status: "à faire" },
  ],
  openPoints: [{ name: "Q", status: "ouvert", note: "" }],
  events: [
    { at: "2026-01-01T09:00", text: "first" },
    { at: "2026-01-02T09:30", text: "second" },
  ],
});

function tempHome(content?: unknown): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-roadmap-"));
  if (content !== undefined) {
    fs.mkdirSync(path.join(home, "docs"), { recursive: true });
    fs.writeFileSync(
      roadmapPath(home),
      typeof content === "string" ? content : JSON.stringify(content),
    );
  }
  return home;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await sleep(20);
  }
}

test("the schema accepts a valid document, tolerates extra fields and fills blanks", () => {
  const parsed = roadmapSchema.parse(sample());
  assert.equal(parsed.slices.length, 2);
  assert.equal("extra" in parsed.slices[1]!, false);
  assert.deepEqual(parsed.items[2], { slice: 2, name: "Three", status: "à faire", owner: "", date: "", note: "" });
});

test("the schema refuses an unknown status and a progress out of range", () => {
  const badItem = sample();
  badItem.items[0]!.status = "terminé";
  assert.equal(roadmapSchema.safeParse(badItem).success, false);
  const badPoint = sample();
  badPoint.openPoints[0]!.status = "fait";
  assert.equal(roadmapSchema.safeParse(badPoint).success, false);
  const badSlice = sample();
  badSlice.slices[0]!.progress = 140;
  assert.equal(roadmapSchema.safeParse(badSlice).success, false);
});

test("a missing file gives null and a logged reason", () => {
  const logs: string[] = [];
  assert.equal(readRoadmap(tempHome(), (m) => logs.push(m)), null);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /does not exist/);
});

test("an invalid status or broken JSON gives null and a logged reason", () => {
  const bad = sample();
  bad.items[1]!.status = "perdu";
  const logs: string[] = [];
  assert.equal(readRoadmap(tempHome(bad), (m) => logs.push(m)), null);
  assert.match(logs[0]!, /items\.1\.status/);
  const result = loadRoadmap(tempHome("{ not json"));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /not valid JSON/);
});

test("a valid file is read, with a UTF-8 byte order mark tolerated", () => {
  const home = tempHome("﻿" + JSON.stringify(sample()));
  assert.equal(readRoadmap(home)?.items.length, 3);
});

test("the route answers with the document, or 404 and an explicit error", async () => {
  const ok = roadmapResponse(tempHome(sample()));
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { updatedAt: string }).updatedAt, "2026-01-02T10:00:00+01:00");

  const missing = roadmapResponse(tempHome());
  assert.equal(missing.status, 404);
  const body = (await missing.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, "ROADMAP_NOT_FOUND");
  assert.match(body.error.message, /docs\/roadmap\.json/);

  const invalid = roadmapResponse(tempHome({ updatedAt: "x" }));
  assert.equal(invalid.status, 404);
});

test("the watcher reports an edit of the file, once for a burst of writes", async () => {
  const home = tempHome(sample());
  let calls = 0;
  const stop = watchRoadmap(home, () => calls++, 50);
  try {
    await sleep(100);
    const file = roadmapPath(home);
    fs.writeFileSync(file, JSON.stringify({ ...sample(), updatedAt: "2026-01-03T10:00:00+01:00" }));
    fs.appendFileSync(file, " ");
    await waitFor(() => calls >= 1);
    await sleep(200);
    assert.equal(calls, 1);

    // A replacement of the file (how editors save) is seen too.
    fs.writeFileSync(file + ".tmp", JSON.stringify(sample()));
    fs.renameSync(file + ".tmp", file);
    await waitFor(() => calls >= 2);

    // Another file of the directory is ignored.
    const before = calls;
    fs.writeFileSync(path.join(home, "docs", "other.json"), "{}");
    await sleep(250);
    assert.equal(calls, before);
  } finally {
    stop();
  }
});

test("subscribers share one watcher and are told about a change", async () => {
  const home = tempHome(sample());
  let a = 0;
  let b = 0;
  const offA = subscribeRoadmap(home, () => a++);
  const offB = subscribeRoadmap(home, () => b++);
  try {
    await sleep(100);
    fs.writeFileSync(roadmapPath(home), JSON.stringify(sample()));
    await waitFor(() => a >= 1 && b >= 1);
  } finally {
    offA();
    offB();
  }
  const seen = a;
  fs.writeFileSync(roadmapPath(home), JSON.stringify(sample()));
  await sleep(400);
  assert.equal(a, seen, "no call after unsubscribing");
});

test("items are filtered by slice and status, and the journal is newest first", () => {
  const doc = roadmapSchema.parse(sample());
  assert.equal(filterItems(doc.items, { slice: "all", status: "all" }).length, 3);
  assert.deepEqual(
    filterItems(doc.items, { slice: 2, status: "all" }).map((i) => i.name),
    ["Two", "Three"],
  );
  assert.deepEqual(
    filterItems(doc.items, { slice: 2, status: "bloqué" }).map((i) => i.name),
    ["Two"],
  );
  assert.deepEqual(
    newestFirst(doc.events).map((e) => e.text),
    ["second", "first"],
  );
});

test("search folds accents and case, and counts per status follow it", () => {
  const doc = roadmapSchema.parse({
    ...sample(),
    items: [
      { slice: 1, name: "Étape finale", status: "fait", owner: "Zoé", note: "" },
      { slice: 1, name: "Other", status: "à faire", owner: "", note: "about the ETAPE" },
    ],
  });
  assert.deepEqual(
    filterItems(doc.items, { slice: "all", status: "all", query: " etape " }).map((i) => i.name),
    ["Étape finale", "Other"],
  );
  assert.deepEqual(
    filterItems(doc.items, { slice: "all", status: "all", query: "zoe" }).map((i) => i.name),
    ["Étape finale"],
  );
  assert.deepEqual(statusCounts(doc.items), { all: 2, fait: 1, "en cours": 0, "à faire": 1, bloqué: 0 });
});

test("overall progress, current slice and grouping", () => {
  const doc = roadmapSchema.parse(sample());
  assert.equal(overallProgress(doc.slices), 70);
  assert.equal(overallProgress([]), 0);
  assert.equal(currentSlice(doc.slices)?.name, "Beta");
  assert.equal(currentSlice(doc.slices.slice(0, 1)), null);
  const groups = groupBySlice(doc.slices, [...doc.items, { slice: 9, name: "Lost", status: "fait", owner: "", date: "", note: "" }]);
  assert.deepEqual(
    groups.map((g) => [g.id, g.slice?.name ?? null, g.items.length]),
    [
      [1, "Alpha", 1],
      [2, "Beta", 2],
      [9, null, 1],
    ],
  );
});

test("journal times are read as written, and grouped by day", () => {
  assert.deepEqual(eventParts("2026-11-02T14:27"), { day: "2026-11-02", time: "14:27" });
  assert.deepEqual(eventParts("2026-11-02T14:27:10+01:00"), { day: "2026-11-02", time: "14:27" });
  assert.deepEqual(eventParts("2026-11-02"), { day: "2026-11-02", time: null });
  assert.deepEqual(eventParts("soon"), { day: null, time: null });
  const days = groupEventsByDay(
    newestFirst([
      { at: "2026-01-01T09:00", text: "a" },
      { at: "2026-01-02T09:30", text: "b" },
      { at: "2026-01-02T08:00", text: "c" },
    ]),
  );
  assert.deepEqual(
    days.map((d) => [d.day, d.events.map((e) => e.text)]),
    [
      ["2026-01-02", ["b", "c"]],
      ["2026-01-01", ["a"]],
    ],
  );
});

test("owner initials and tints are stable", () => {
  assert.equal(ownerInitial("  sonnet"), "S");
  assert.equal(ownerInitial(""), "");
  assert.equal(ownerTint("Opus", 5), ownerTint(" opus ", 5));
  assert.ok(ownerTint("Fable", 5) >= 0 && ownerTint("Fable", 5) < 5);
});

test("a live update flags only what changed", () => {
  const before = roadmapSchema.parse(sample());
  assert.equal(diffRoadmap(before, roadmapSchema.parse(sample())).size, 0);

  const next = roadmapSchema.parse(sample());
  next.updatedAt = "2026-01-02T11:00:00+01:00";
  next.slices[1]!.progress = 100;
  next.slices[1]!.status = "fait";
  next.items[1]!.status = "fait";
  next.openPoints.push({ name: "New question", status: "ouvert", note: "" });
  next.events.push({ at: "2026-01-02T10:30", text: "third" });

  const changed = diffRoadmap(before, next);
  const keys = itemKeys(next.items);
  assert.deepEqual(
    [...changed].sort(),
    [
      updatedKey,
      overallKey,
      sliceKey(2),
      keys.get(next.items[1]!)!,
      openPointKeys(next.openPoints).get(next.openPoints[1]!)!,
      eventKey(next.events[2]!),
    ].sort(),
  );
});
