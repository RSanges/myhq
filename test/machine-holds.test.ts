import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { HqConfig } from "../src/server/config";
import { getDbAt, type Db } from "../src/server/db";
import type { Engine, RunEvent } from "../src/server/engine";
import { closeStaleRunMachines, RESERVATION_WINDOW_MS, releaseHolds, reservations, takeHold, type MachineReading } from "../src/server/machine";
import { DEFAULT_MACHINE } from "../src/server/home-settings";
import { loadHome, syncHome } from "../src/server/rooms";
import { MachineBusy, startRun } from "../src/server/runner";
import { hqMachineHold, hqMachineRelease } from "../src/mcp/tools";
import { makeHome } from "./helpers";

// The holds (docs/architecture.md, "The queue and the machine"): memory for one heavy step of a run, reserved
// from when it is granted until it is released, expires or its run ends, counted with the young runs.

const usage = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const done: RunEvent = { type: "end", status: "done", reason: "success", summary: "ok", usage, costUsd: 0 };
const agent = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, role: "roles/scout.md", model: "haiku", allowedTools: ["mcp__hq__*"], ...extra });
const reading = (over: Partial<MachineReading> = {}): MachineReading => ({
  at: "2026-11-16T10:00:00.000Z",
  ramFreeGb: 12,
  ramTotalGb: 32,
  vramUsedGb: 2,
  vramTotalGb: 24,
  ...over,
});
const engine: Engine = {
  name: "claude",
  async *run() {
    yield done;
  },
};

function home(agents: Record<string, unknown>[]): { config: HqConfig; db: Db } {
  const config = makeHome({}, { name: "demo", targetRepo: "../demo", agents });
  const db = getDbAt(config.dbPath);
  syncHome(db, loadHome(config.home));
  return { config, db };
}

/** A run of `agentId` in progress, started `minutesAgo` minutes ago, with its machine record when it has a need. */
function running(db: Db, agentId: string, minutesAgo: number, ramNeed: number | null = null, ramFree = 12): number {
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const run = Number(db.prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at) VALUES ('demo', ?, 'claude', 't', 'running', ?)").run(agentId, at).lastInsertRowid);
  if (ramNeed !== null) {
    db.prepare("INSERT INTO run_machine (run_id, room, agent_id, ram_need_gb, ram_declared_gb, ram_free_start_gb, started_at) VALUES (?, 'demo', ?, ?, ?, ?, ?)").run(
      run,
      agentId,
      ramNeed,
      ramNeed,
      ramFree,
      at,
    );
  }
  return run;
}

test("a hold reserves its step for its whole length, and nothing once released: an old run renders while another agent waits, then starts", () => {
  const { config, db } = home([agent("motion", { needs: { ramGb: 2 } }), agent("cao", { needs: { ramGb: 4 } })]);
  const motion = running(db, "motion", 40, 2);
  // An old run reserves nothing; its hold of 7 GB for a render, granted with 12 GB free, does.
  const held = takeHold(db, { runId: motion, room: "demo", agentId: "motion", need: { ramGb: 7, vramGb: null }, minutes: 30, reading: reading(), setting: DEFAULT_MACHINE });
  assert.equal(held.kind, "held");
  // The render took 1 GB so far: 6 still reserved, 11 - 6 = 5 left, under the 4 + 2 the CAO needs.
  const busy = reading({ ramFreeGb: 11 });
  assert.deepEqual(reservations(db, busy), { ramGb: 6, vramGb: 0 });
  assert.throws(
    () => startRun({ room: "demo", agent: "cao" }, { config, engine, send: async () => true, machine: () => busy }),
    (error: unknown) => error instanceof MachineBusy,
  );
  assert.equal(releaseHolds(db, motion), 1);
  assert.deepEqual(reservations(db, busy), { ramGb: 0, vramGb: 0 });
  const run = startRun({ room: "demo", agent: "cao" }, { config, engine, send: async () => true, machine: () => busy });
  assert.equal(run.agent_id, "cao");
});

test("a hold is refused when the memory is not there, replaces the run's previous hold, expires, and ends with its run", () => {
  const { db } = home([agent("son"), agent("visuels")]);
  const son = running(db, "son", 30);
  const visuels = running(db, "visuels", 30);
  const take = (runId: number, ramGb: number, at?: Date, minutes = 30) =>
    takeHold(db, { runId, room: "demo", agentId: runId === son ? "son" : "visuels", need: { ramGb, vramGb: null }, minutes, reading: reading(), setting: DEFAULT_MACHINE, ...(at ? { at } : {}) });
  assert.equal(take(son, 8).kind, "held");
  const refused = take(visuels, 4);
  assert.equal(refused.kind, "busy");
  assert.match(refused.kind === "busy" ? refused.text : "", /4 GB are left/);
  // A new hold of the same run replaces the old one: it is not counted against itself.
  assert.equal(take(son, 9).kind, "held");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM machine_holds WHERE run_id = ? AND released_at IS NULL").get(son) as { n: number }).n, 1);
  assert.equal(take(son, 40).kind, "neverFits");
  // Expired: past its minutes a hold reserves nothing.
  assert.equal(take(son, 6, new Date(), 1).kind, "held");
  assert.deepEqual(reservations(db, reading(), new Date(Date.now() + 2 * 60_000)), { ramGb: 0, vramGb: 0 });
  // The end of the run releases it (closeStaleRunMachines for a run that ended any other way).
  assert.equal(take(son, 6).kind, "held");
  db.prepare("UPDATE runs SET status = 'done', ended_at = ? WHERE id = ?").run(new Date().toISOString(), son);
  closeStaleRunMachines(db);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM machine_holds WHERE released_at IS NULL").get() as { n: number }).n, 0);
});

test("a young run that holds reserves through its hold only, not twice", () => {
  const { db } = home([agent("motion", { needs: { ramGb: 6 } })]);
  const motion = running(db, "motion", 2, 6);
  assert.ok(2 * 60_000 < RESERVATION_WINDOW_MS);
  assert.deepEqual(reservations(db, reading()), { ramGb: 6, vramGb: 0 });
  takeHold(db, { runId: motion, room: "demo", agentId: "motion", need: { ramGb: 3, vramGb: null }, minutes: 30, reading: reading(), setting: DEFAULT_MACHINE });
  assert.deepEqual(reservations(db, reading()), { ramGb: 3, vramGb: 0 });
});

test("hq_machine_hold waits for the memory, then holds it; hq_machine_release gives it back", async () => {
  const { config, db } = home([agent("son"), agent("visuels")]);
  const son = running(db, "son", 30);
  const visuels = running(db, "visuels", 30);
  const ctx = (runId: number, agentId: string) => ({ dbPath: config.dbPath, runId, agentId, room: "demo", home: config.home, attachmentMaxBytes: 1, appEnv: {} });
  fs.writeFileSync(path.join(config.home, "myhq.json"), JSON.stringify({ machine: { keepFreeRamGb: 2 } }));
  const first = await hqMachineHold(db, ctx(son, "son") as never, { ramGb: 8 }, { read: async () => reading() });
  assert.equal(first.held, true);
  // Busy at first; the other run releases during the wait, and the hold is granted at the next poll.
  let polls = 0;
  const second = await hqMachineHold(db, ctx(visuels, "visuels") as never, { ramGb: 6, waitSeconds: 60 }, {
    read: async () => reading(),
    pollMs: 1,
    sleep: async () => {
      polls++;
      hqMachineRelease(db, ctx(son, "son") as never);
    },
  });
  assert.equal(second.held, true);
  assert.equal(polls, 1);
  const refused = await hqMachineHold(db, ctx(son, "son") as never, { ramGb: 8, waitSeconds: 0 }, { read: async () => reading() });
  assert.equal(refused.held, false);
  await assert.rejects(() => hqMachineHold(db, ctx(son, "son") as never, {}, { read: async () => reading() }), /ramGb, vramGb or both/);
});
