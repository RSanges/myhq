import assert from "node:assert/strict";
import { test } from "node:test";
import { getDbAt, type RunRow } from "../src/server/db";
import type { Engine, RunEvent } from "../src/server/engine";
import { readLiveRoom, readLiveRun } from "../src/server/live-room";
import { loadHome } from "../src/server/rooms";
import {
  needsSummary,
  runSummary,
  sanitizeSummary,
  summarizeRun,
  summaryPrompt,
  SUMMARY_MAX,
  SUMMARY_MAX_BUDGET_USD,
  SUMMARY_MODEL,
} from "../src/server/run-summary";
import { startRun, WAKE_TASK } from "../src/server/runner";
import type { SmallModelAnswer, SmallModelCall, SmallModelCallInput } from "../src/server/small-model";
import { mergeTimeline, taskHeadline } from "../src/ui/live-room-model";
import type { LiveTile } from "../src/ui/schemas";
import { makeHome, waitForRun } from "./helpers";

// The run summary: one line of a small model, asked at the run's start, for
// the surveillance room. The model call is a fake: no CLI runs in these tests.

const LONG_TASK = [
  "Relayed by the owner:",
  "",
  "Prepare the spring newsletter of the bakery: three short sections (new breads, the opening hours of the holidays, the tasting day),",
  "a subject line, and a version for the social networks. Keep the tone warm. Send the draft for approval.",
].join("\n");

function answer(text: string): SmallModelAnswer {
  return { text, costUsd: 0.0003, inputTokens: 400, outputTokens: 20, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, durationMs: 1200 };
}

function fakeCall(result: string | Error, calls: SmallModelCallInput[] = []): SmallModelCall {
  return async (input) => {
    calls.push(input);
    if (result instanceof Error) throw result;
    return answer(result);
  };
}

function setup() {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const insert = (task: string) =>
    db
      .prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at) VALUES ('demo', 'scout', 'claude', ?, 'running', ?) RETURNING *")
      .get(task, new Date().toISOString()) as RunRow;
  return { config, db, insert };
}

test("needsSummary: one line of at most 120 characters is its own summary; longer, several lines or a mailbox need one", () => {
  assert.equal(needsSummary("Find threads.", []), false);
  assert.equal(needsSummary(`  ${"x".repeat(120)}  `, []), false);
  assert.equal(needsSummary("x".repeat(121), []), true);
  assert.equal(needsSummary("Line one\nLine two", []), true);
  assert.equal(needsSummary(WAKE_TASK, [{ source: "message", text: "Render the trailer." }]), true);
});

test("sanitizeSummary: the first line, without label, quotes, markdown or final period, at most 90 characters", () => {
  assert.equal(sanitizeSummary("Préparer la newsletter de printemps."), "Préparer la newsletter de printemps");
  assert.equal(sanitizeSummary('\n\n  "Rédiger le brief du film"  \nSecond line'), "Rédiger le brief du film");
  assert.equal(sanitizeSummary("**Résumé : Monter la bande-annonce**"), "Monter la bande-annonce");
  assert.equal(sanitizeSummary("Summary: Fix the login form"), "Fix the login form");
  assert.equal(sanitizeSummary("# « Traduire le site »"), "Traduire le site");
  assert.equal(sanitizeSummary("Tab\there\u0007 now"), "Tab here now");
  const long = sanitizeSummary(`Écrire ${"un mot ".repeat(30)}`)!;
  assert.ok(long.length <= SUMMARY_MAX, long);
  assert.match(long, /\S\.\.\.$/);
  assert.equal(sanitizeSummary(""), null);
  assert.equal(sanitizeSummary('  \n  "" \n'), null);
});

test("summaryPrompt: the instruction, the mailbox tasks on one line each, the language of the home and the rules", () => {
  const prompt = summaryPrompt({
    task: WAKE_TASK,
    mailbox: [
      { source: "message", text: "Render the trailer\nwith the new logo." },
      { source: "approval", text: "Post the approved thread." },
    ],
    language: "fr",
  });
  assert.match(prompt, /Handle the pending tasks of your mailbox/);
  assert.match(prompt, /1\. \[message\] Render the trailer with the new logo\./);
  assert.match(prompt, /2\. \[approval\] Post the approved thread\./);
  assert.match(prompt, /language of the tag "fr"/);
  assert.match(prompt, /never "handle the mailbox"/);
});

test("summarizeRun: one call on Haiku with a cap, the text stored with its cost, and the run marked changed for the room", async () => {
  const { config, db, insert } = setup();
  const run = insert(LONG_TASK);
  const calls: SmallModelCallInput[] = [];
  const before = (db.prepare("SELECT MAX(seq) AS seq FROM changes").get() as { seq: number }).seq;
  await summarizeRun({ config, db, run, mailbox: [], language: "fr", env: {}, call: fakeCall("Préparer la newsletter de printemps.", calls) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.model, SUMMARY_MODEL);
  assert.equal(calls[0]!.maxBudgetUsd, SUMMARY_MAX_BUDGET_USD);
  assert.match(calls[0]!.prompt, /spring newsletter of the bakery/);
  assert.equal(runSummary(db, run.id), "Préparer la newsletter de printemps");
  const row = db.prepare("SELECT * FROM run_summaries WHERE run_id = ?").get(run.id) as Record<string, unknown>;
  assert.equal(row.model, "haiku");
  assert.equal(row.cost_usd, 0.0003);
  assert.equal(row.input_tokens, 400);
  assert.equal(row.output_tokens, 20);
  assert.equal(row.duration_ms, 1200);
  const change = db.prepare("SELECT entity, entity_id FROM changes WHERE seq > ?").all(before);
  assert.deepEqual(change, [{ entity: "run", entity_id: run.id }]);

  // Once only: a second ask keeps the first summary.
  await summarizeRun({ config, db, run, mailbox: [], language: "fr", env: {}, call: fakeCall("Autre chose") });
  assert.equal(runSummary(db, run.id), "Préparer la newsletter de printemps");
});

test("summarizeRun: no call for a short task; a failed call leaves nothing; an unusable answer is metered but no summary", async () => {
  const { config, db, insert } = setup();
  const calls: SmallModelCallInput[] = [];
  const short = insert("Find threads.");
  await summarizeRun({ config, db, run: short, mailbox: [], language: "fr", env: {}, call: fakeCall("never", calls) });
  assert.equal(calls.length, 0);
  assert.equal(runSummary(db, short.id), null);

  const failed = insert(LONG_TASK);
  await summarizeRun({ config, db, run: failed, mailbox: [], language: "fr", env: {}, call: fakeCall(new Error("no answer after 60 s")) });
  assert.equal(runSummary(db, failed.id), null);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM run_summaries WHERE run_id = ?").get(failed.id) as { n: number }).n, 0);

  const empty = insert(LONG_TASK);
  const before = (db.prepare("SELECT MAX(seq) AS seq FROM changes").get() as { seq: number }).seq;
  await summarizeRun({ config, db, run: empty, mailbox: [], language: "fr", env: {}, call: fakeCall('  ""  ') });
  assert.equal(runSummary(db, empty.id), null);
  assert.equal((db.prepare("SELECT cost_usd FROM run_summaries WHERE run_id = ?").get(empty.id) as { cost_usd: number }).cost_usd, 0.0003);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM changes WHERE seq > ?").get(before) as { n: number }).n, 0, "no change without a summary");

  // The real CLI missing (the tests' binary): silent, nothing stored.
  const missing = insert(LONG_TASK);
  await summarizeRun({ config, db, run: missing, mailbox: [], language: "fr", env: { PATH: process.env.PATH ?? "" } });
  assert.equal(runSummary(db, missing.id), null);
});

test("a run starts at once and its summary arrives when the call answers, with the mailbox tasks it took", async () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const usage = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
  const done: RunEvent = { type: "end", status: "done", reason: "success", summary: "ok", usage, costUsd: 0 };
  const engine: Engine = { name: "claude", async *run() { yield done; } };
  db.prepare(
    "INSERT INTO tasks (room, agent_id, source, text, status, created_at, updated_at) VALUES ('demo', 'scout', 'message', 'Render the trailer with the new logo.', 'pending', ?, ?)",
  ).run(new Date().toISOString(), new Date().toISOString());
  let release!: (value: SmallModelAnswer) => void;
  const calls: SmallModelCallInput[] = [];
  const summarize: SmallModelCall = (input) => {
    calls.push(input);
    return new Promise((resolve) => (release = resolve));
  };
  const run = startRun({ room: "demo", agent: "scout", task: WAKE_TASK, reason: "message" }, { config, engine, summarize });
  assert.equal(run.status, "running");
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.prompt, /\[message\] Render the trailer with the new logo\./);
  assert.equal((await waitForRun(db, run.id)).status, "done", "the run does not wait for its summary");
  assert.equal(runSummary(db, run.id), null);
  release(answer("Monter la bande-annonce avec le nouveau logo"));
  for (let i = 0; i < 50 && runSummary(db, run.id) === null; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(runSummary(db, run.id), "Monter la bande-annonce avec le nouveau logo");
});

test("the room gives the summary next to the task, null without one, in the tiles and in one run", async () => {
  const { config, db, insert } = setup();
  const home = loadHome(config.home);
  const run = insert(LONG_TASK);
  assert.equal(readLiveRoom(db, home, config.runsDir)[0]!.taskSummary, null);
  await summarizeRun({ config, db, run, mailbox: [], language: "fr", env: {}, call: fakeCall("Préparer la newsletter de printemps") });
  const tile = readLiveRoom(db, home, config.runsDir)[0]!;
  assert.equal(tile.task, LONG_TASK);
  assert.equal(tile.taskSummary, "Préparer la newsletter de printemps");
  assert.equal(readLiveRun(db, home, config.runsDir, run.id).tile.taskSummary, "Préparer la newsletter de printemps");
});

test("taskHeadline: the summary when there is one, else the task; the timeline starts with it", () => {
  const tile = { task: LONG_TASK, taskSummary: "Préparer la newsletter", startedAt: new Date(0).toISOString(), state: "working", piece: null, endedAt: null } as unknown as LiveTile;
  assert.equal(taskHeadline(tile), "Préparer la newsletter");
  assert.equal(taskHeadline({ task: "Find threads.", taskSummary: null }), "Find threads.");
  assert.equal(mergeTimeline(tile, [])[0]!.text, "Préparer la newsletter");
});
