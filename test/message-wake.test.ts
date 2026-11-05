import assert from "node:assert/strict";
import { test } from "node:test";
import { hqMessage, type HqContext } from "../src/mcp/tools";
import type { HqConfig } from "../src/server/config";
import { getDbAt, type Db, type RunRow, type TaskRow } from "../src/server/db";
import type { Engine, RunEvent, RunInput } from "../src/server/engine";
import { resumeWaitingTasks, startRun, wakeAgents } from "../src/server/runner";
import { makeHome, waitForRun } from "./helpers";

const usage = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const done: RunEvent = { type: "end", status: "done", reason: "success", summary: "ok", usage, costUsd: 0 };

function office(overrides: Partial<HqConfig> = {}): HqConfig {
  const base = { role: "roles/scout.md", model: "haiku", allowedTools: ["mcp__hq__*"] };
  return makeHome(overrides, {
    name: "demo",
    targetRepo: "../demo-project",
    agents: [
      { id: "scout", name: "Scout", ...base },
      { id: "writer", name: "Writer", ...base },
      { id: "editor", name: "Editor", ...base },
    ],
  });
}

function engine(seen: RunInput[]): Engine {
  return {
    name: "claude",
    async *run(input) {
      seen.push(input);
      yield done;
    },
  };
}

const runsOf = (db: Db, agent: string) => db.prepare("SELECT * FROM runs WHERE agent_id = ? ORDER BY id").all(agent) as RunRow[];
const pendingOf = (db: Db, agent: string) =>
  db.prepare("SELECT * FROM tasks WHERE agent_id = ? AND status = 'pending' ORDER BY id").all(agent) as TaskRow[];

/** A finished run of `agent`, to send messages from. */
async function sender(config: HqConfig, db: Db, agent: string, seen: RunInput[]): Promise<HqContext> {
  const run = startRun({ room: "demo", agent }, { config, engine: engine(seen) });
  await waitForRun(db, run.id);
  return { dbPath: config.dbPath, runId: run.id, agentId: agent, room: "demo" };
}

test("a second message of the same sender within the window waits: two agents no longer wake each other at each message", async () => {
  const config = office();
  const db = getDbAt(config.dbPath);
  const seen: RunInput[] = [];
  const deps = { config, engine: engine(seen), send: async () => true };
  const scout = await sender(config, db, "scout", seen);

  hqMessage(db, scout, { to: "writer", text: "Order: a 20 s clip." });
  const [first] = wakeAgents(config, db, deps);
  assert.equal(first?.reason, "message");
  await waitForRun(db, first.id);

  hqMessage(db, scout, { to: "writer", text: "Did you get it?" });
  assert.deepEqual(wakeAgents(config, db, deps), [], "the pair woke the writer less than 10 minutes ago");
  assert.equal(pendingOf(db, "writer").length, 1, "the message waits in the mailbox");

  // Another sender is another pair: it wakes the writer, whose run takes both messages.
  const editor = await sender(config, db, "editor", seen);
  hqMessage(db, editor, { to: "writer", text: "The logo changed." });
  const [second] = wakeAgents(config, db, deps);
  assert.equal(second?.agent_id, "writer");
  await waitForRun(db, second.id);
  assert.match(seen.at(-1)!.prompt, /Did you get it\?[\s\S]*The logo changed\./);
  assert.equal(pendingOf(db, "writer").length, 0);
});

test("once the window is over, the scheduler's tick wakes the message that waited", async () => {
  const config = office();
  const db = getDbAt(config.dbPath);
  const seen: RunInput[] = [];
  const deps = { config, engine: engine(seen), send: async () => true };
  const scout = await sender(config, db, "scout", seen);
  hqMessage(db, scout, { to: "writer", text: "Order." });
  const [first] = wakeAgents(config, db, deps);
  await waitForRun(db, first!.id);
  hqMessage(db, scout, { to: "writer", text: "Status?" });
  assert.deepEqual(resumeWaitingTasks(config, db, deps), []);

  // Eleven minutes later.
  db.prepare("UPDATE runs SET started_at = ? WHERE id = ?").run(new Date(Date.now() - 11 * 60_000).toISOString(), first!.id);
  const [later] = resumeWaitingTasks(config, db, deps);
  assert.equal(later?.agent_id, "writer");
  await waitForRun(db, later.id);
  assert.equal(runsOf(db, "writer").length, 2);
});

test("HQ_MESSAGE_WAKE_MINUTES=0 wakes the recipient at each message, as before", async () => {
  const config = office({ messageWakeIntervalMs: 0 });
  const db = getDbAt(config.dbPath);
  const seen: RunInput[] = [];
  const deps = { config, engine: engine(seen), send: async () => true };
  const scout = await sender(config, db, "scout", seen);
  for (const text of ["One.", "Two."]) {
    hqMessage(db, scout, { to: "writer", text });
    const [run] = wakeAgents(config, db, deps);
    assert.equal(run?.agent_id, "writer");
    await waitForRun(db, run.id);
  }
});

test("the window is read from HQ_MESSAGE_WAKE_MINUTES (default 10), and the stop's grace from HQ_SHUTDOWN_GRACE_SECONDS (default 90)", async () => {
  const { getConfig } = await import("../src/server/config");
  const base = { MYHQ_HOME: office().home };
  assert.deepEqual(
    [getConfig(base).messageWakeIntervalMs, getConfig(base).shutdownGraceMs],
    [10 * 60_000, 90_000],
  );
  const set = getConfig({ ...base, HQ_MESSAGE_WAKE_MINUTES: "0", HQ_SHUTDOWN_GRACE_SECONDS: "120" });
  assert.deepEqual([set.messageWakeIntervalMs, set.shutdownGraceMs], [0, 120_000]);
  assert.throws(() => getConfig({ ...base, HQ_MESSAGE_WAKE_MINUTES: "-1" }), /HQ_MESSAGE_WAKE_MINUTES/);
});
