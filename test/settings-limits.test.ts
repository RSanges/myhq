import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { getConfig, liveConfig } from "../src/server/config";
import { getDbAt, type RunRow } from "../src/server/db";
import { readPortierSetting, readRunSummariesSetting } from "../src/server/home-settings";
import { summarizeRun } from "../src/server/run-summary";
import { buildSettingsView, saveSettings } from "../src/server/settings";
import { makeHome } from "./helpers";

// « Limites et coûts »: the budgets and run durations of myhq.json over their
// environment variables, and the switches of the small model calls.

const homeFile = (home: string) => path.join(home, "myhq.json");
const readHome = (home: string) => JSON.parse(fs.readFileSync(homeFile(home), "utf8")) as Record<string, unknown>;
const limits = (extra: Record<string, unknown>) => ({ scheduler: null, maxRunsPerDay: null, ...extra });

test("the budgets and run durations of myhq.json win over the environment, which stays the fallback", () => {
  const { home } = makeHome();
  const env = {
    MYHQ_HOME: home,
    HQ_DEFAULT_MAX_BUDGET_USD: "1",
    HQ_WEEKLY_BUDGET_USD: "40",
    HQ_RUN_TIMEOUT_MINUTES: "30",
    HQ_RUN_HARD_LIMIT_MINUTES: "180",
  };
  const before = getConfig(env);
  assert.deepEqual([before.defaultMaxBudgetUsd, before.weeklyBudgetUsd, before.runTimeoutMs, before.runHardLimitMs], [1, 40, 30 * 60_000, 180 * 60_000]);
  fs.writeFileSync(homeFile(home), JSON.stringify({ defaultMaxBudgetUsd: 2.5, weeklyBudgetUsd: 25, runTimeoutMinutes: 45, runHardLimitMinutes: 90 }));
  const config = getConfig(env);
  assert.deepEqual([config.defaultMaxBudgetUsd, config.weeklyBudgetUsd, config.runTimeoutMs, config.runHardLimitMs], [2.5, 25, 45 * 60_000, 90 * 60_000]);
  // Read again without a restart, and back to the environment without the keys.
  fs.writeFileSync(homeFile(home), JSON.stringify({ runTimeoutMinutes: "soon" }));
  const live = liveConfig(config);
  assert.deepEqual([live.defaultMaxBudgetUsd, live.runTimeoutMs], [1, 30 * 60_000]);
});

test("saving the limits writes the budgets and durations, null going back to the environment", () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  saveSettings(config, db, "limits", limits({ defaultMaxBudgetUsd: 2, weeklyBudgetUsd: 30, runTimeoutMinutes: 20, runHardLimitMinutes: 60 }));
  assert.deepEqual(readHome(config.home), { defaultMaxBudgetUsd: 2, weeklyBudgetUsd: 30, runTimeoutMinutes: 20, runHardLimitMinutes: 60 });
  const view = buildSettingsView(config, db, {});
  assert.deepEqual(
    [view.budgets.defaultMaxBudgetUsd.effective, view.budgets.weeklyBudgetUsd.effective, view.budgets.runTimeoutMinutes.effective],
    [2, 30, 20],
  );
  assert.equal(view.budgets.runHardLimitMinutes.source, "file");
  assert.equal(view.defaultMaxBudgetUsd, 2);

  // Left out: unchanged. Null: removed.
  saveSettings(config, db, "limits", limits({ weeklyBudgetUsd: null }));
  assert.deepEqual(readHome(config.home), { defaultMaxBudgetUsd: 2, runTimeoutMinutes: 20, runHardLimitMinutes: 60 });
  assert.equal(buildSettingsView(config, db, {}).budgets.weeklyBudgetUsd.effective, null);
});

test("the run timeout must stay shorter than the hard limit, as they will be in force", () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  assert.throws(() => saveSettings(config, db, "limits", limits({ runTimeoutMinutes: 200 })), /shorter/);
  saveSettings(config, db, "limits", limits({ runHardLimitMinutes: 40 }));
  // The hard limit kept in the file counts too.
  assert.throws(() => saveSettings(config, db, "limits", limits({ runTimeoutMinutes: 40 })), /shorter/);
  assert.throws(() => saveSettings(config, db, "limits", limits({ defaultMaxBudgetUsd: 0 })));
  assert.deepEqual(readHome(config.home), { runHardLimitMinutes: 40 });
});

test("the portier and run summary switches are stored like the portier's setting", () => {
  const config = makeHome({ portier: { enabled: true, model: "haiku" } });
  const db = getDbAt(config.dbPath);
  fs.writeFileSync(homeFile(config.home), JSON.stringify({ portier: { enabled: true, model: "sonnet" } }));
  saveSettings(config, db, "limits", limits({ portier: false, runSummaries: false }));
  assert.deepEqual(readHome(config.home), { portier: { enabled: false, model: "sonnet" }, runSummaries: { enabled: false } });
  assert.equal(readPortierSetting(config.home).setting.enabled, false);
  assert.equal(readRunSummariesSetting(config.home).enabled, false);
  const view = buildSettingsView(config, db, {});
  assert.deepEqual([view.portier.enabled, view.summaries.enabled, view.summaries.source], [false, false, "file"]);

  // A switch left at its default writes nothing.
  const fresh = makeHome();
  saveSettings(fresh, getDbAt(fresh.dbPath), "limits", limits({ runSummaries: true }));
  assert.deepEqual(readHome(fresh.home), {});
});

test("with run summaries off, summarizeRun makes no call", async () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const run = db
    .prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at) VALUES ('demo', 'scout', 'claude', ?, 'running', ?) RETURNING *")
    .get("A long task\nover two lines", new Date().toISOString()) as RunRow;
  let calls = 0;
  const call = async () => {
    calls += 1;
    return { text: "Do the thing", costUsd: 0.0003, inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, durationMs: 1 };
  };
  fs.writeFileSync(homeFile(config.home), JSON.stringify({ runSummaries: { enabled: false } }));
  await summarizeRun({ config, db, run, mailbox: [], language: "en", env: {}, call });
  assert.equal(calls, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM run_summaries").get() as { n: number }).n, 0);

  fs.writeFileSync(homeFile(config.home), JSON.stringify({ runSummaries: { enabled: true } }));
  await summarizeRun({ config, db, run, mailbox: [], language: "en", env: {}, call });
  assert.equal(calls, 1);
  const view = buildSettingsView(config, db, {});
  assert.deepEqual(view.summaries.week, { calls: 1, costUsd: 0.0003 });
});
