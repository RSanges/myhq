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
import { filterItems, newestFirst } from "../src/ui/roadmap-model";

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
