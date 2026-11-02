import assert from "node:assert/strict";
import { test } from "node:test";
import { getConfig } from "../src/server/config";
import { getDbAt, type FiringRow } from "../src/server/db";
import type { Engine, RunEvent } from "../src/server/engine";
import { HqError } from "../src/server/errors";
import { getState } from "../src/server/feed";
import { loadHome, syncHome } from "../src/server/rooms";
import { isArmed, Scheduler, setArmed, startScheduler } from "../src/server/routines";
import { getUsage } from "../src/server/usage";
import { makeHome, waitForRun } from "./helpers";

const usage = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const done: RunEvent[] = [{ type: "end", status: "done", reason: "success", summary: "ok", usage, costUsd: 0.01 }];

function engine(gate?: Promise<void>): Engine {
  return {
    name: "claude",
    async *run() {
      if (gate) await gate;
      yield* done;
    },
  };
}

const roleAgent = { name: "Agent", role: "roles/scout.md", model: "haiku", allowedTools: ["mcp__hq__*"] };

function roomWith(agents: Record<string, unknown>[]) {
  return { name: "demo", targetRepo: "../demo-project", agents: agents.map((a) => ({ ...roleAgent, ...a })) };
}

const silent = () => undefined;

test("HQ_SCHEDULER is off by default; when off nothing is scheduled", () => {
  assert.equal(getConfig({}).scheduler, false);
  assert.equal(getConfig({ HQ_SCHEDULER: "ON" }).scheduler, true);
  assert.throws(() => getConfig({ HQ_SCHEDULER: "maybe" }), /HQ_SCHEDULER/);
  assert.throws(() => getConfig({ HQ_TIMEZONE: "Mars/Olympus" }), /HQ_TIMEZONE/);
  assert.equal(getConfig({ HQ_TIMEZONE: "Europe/Paris" }).timeZone, "Europe/Paris");
  assert.equal(startScheduler(makeHome({ scheduler: false })), null);
});

test("the armed state starts from room.json, then the database wins", () => {
  const config = makeHome({}, roomWith([{ id: "scout", cron: "0 7 * * *", armed: true }, { id: "dev", cron: "0 5 * * *" }]));
  const db = getDbAt(config.dbPath);
  syncHome(db, loadHome(config.home));
  const [scout, dev] = loadHome(config.home).rooms[0]!.agents as [never, never];
  assert.equal(isArmed(db, "demo", scout), true);
  assert.equal(isArmed(db, "demo", dev), false);
  setArmed(config, db, "demo", "scout", false);
  setArmed(config, db, "demo", "dev", true);
  syncHome(db, loadHome(config.home));
  assert.equal(isArmed(db, "demo", scout), false);
  assert.equal(isArmed(db, "demo", dev), true);
  assert.throws(
    () => setArmed(config, db, "demo", "nobody", true),
    (e: unknown) => e instanceof HqError && e.code === "AGENT_NOT_FOUND",
  );
  const state = getState(db, loadHome(config.home), { enabled: false, running: false, timeZone: "UTC" }, new Date("2026-11-02T10:00:00Z"));
  const agents = state.rooms[0]!.agents;
  assert.deepEqual(
    agents.map((a) => [a.id, a.armed, a.routines[0]!.nextAt]),
    [
      ["scout", false, "2026-11-03T07:00:00.000Z"],
      ["dev", true, "2026-11-03T05:00:00.000Z"],
    ],
  );
});

test("a firing goes through the agent lock and the daily cap, and every outcome is journaled", async () => {
  const config = makeHome(
    { maxRunsPerDay: 1, timeZone: "UTC" },
    roomWith([
      { id: "scout", cron: [{ cron: "* * * * *", task: "Watch the forums." }], armed: true },
      { id: "dev", cron: "* * * * *" },
    ]),
  );
  const db = getDbAt(config.dbPath);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const scheduler = new Scheduler(config, db, { engine: engine(gate), send: async () => true }, silent);

  const t0 = Date.parse("2026-11-02T10:00:30Z");
  assert.deepEqual(scheduler.tick(new Date(t0)), [], "the first tick only plans");
  const first = scheduler.tick(new Date(t0 + 35_000));
  assert.deepEqual(
    first.map((f) => [f.agentId, f.outcome, f.scheduledAt]),
    [
      ["scout", "started", "2026-11-02T10:01:00.000Z"],
      ["dev", "skipped_unarmed", "2026-11-02T10:01:00.000Z"],
    ],
  );
  const runId = first[0]!.runId!;
  const run = db.prepare("SELECT task FROM runs WHERE id = ?").get(runId) as { task: string };
  assert.equal(run.task, "Watch the forums.");

  // The run is still going: the next minute is skipped by the lock.
  const busy = scheduler.tick(new Date(t0 + 95_000));
  assert.equal(busy[0]!.outcome, "skipped_busy");

  release();
  await waitForRun(db, runId);
  // One run today with a cap of one: the next minute is skipped by the cap.
  const capped = scheduler.tick(new Date(t0 + 155_000));
  assert.equal(capped[0]!.outcome, "skipped_cap");
  assert.match(capped[0]!.detail ?? "", /HQ_MAX_RUNS_PER_DAY/);

  // Far too late (the machine slept): dropped, not caught up, no journal row.
  assert.deepEqual(scheduler.tick(new Date(t0 + 3_600_000)), []);

  const rows = db.prepare("SELECT * FROM routine_firings WHERE agent_id = 'scout' ORDER BY id").all() as FiringRow[];
  assert.deepEqual(
    rows.map((r) => [r.outcome, r.cron, r.task, r.run_id]),
    [
      ["started", "* * * * *", "Watch the forums.", runId],
      ["skipped_busy", "* * * * *", "Watch the forums.", null],
      ["skipped_cap", "* * * * *", "Watch the forums.", null],
    ],
  );
  const state = getState(db, loadHome(config.home), { enabled: true, running: true, timeZone: "UTC" });
  assert.equal(state.firings.length, 6);
  assert.equal(state.firings[0]!.outcome, "skipped_unarmed");
});

test("the meter reports the share of the weekly budget", () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  db.prepare(
    "INSERT INTO runs (room, agent_id, engine, task, status, cost_usd, started_at) VALUES ('demo', 'scout', 'claude', 't', 'done', 2.5, ?)",
  ).run(new Date().toISOString());
  assert.equal(getUsage(db, 12).budget, null);
  assert.deepEqual(getUsage(db, 12, 10).budget, { weeklyUsd: 10, spentUsd: 2.5, share: 0.25 });
});
