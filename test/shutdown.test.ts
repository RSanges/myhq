import assert from "node:assert/strict";
import { test } from "node:test";
import { hqMessage } from "../src/mcp/tools";
import { getDbAt, type RunRow, type TaskRow } from "../src/server/db";
import type { Engine, RunEvent, RunInput } from "../src/server/engine";
import { HqError } from "../src/server/errors";
import { INTERRUPTED_SUMMARY, installShutdown, isStopping, startRun, stopRuns, wakeAgents } from "../src/server/runner";
import { makeHome, waitForRun } from "./helpers";

// One file on its own: a stop is for the whole process (the runner's state is global).

const usage = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const done: RunEvent = { type: "end", status: "done", reason: "success", summary: "ok", usage, costUsd: 0 };

function home() {
  const base = { role: "roles/scout.md", model: "haiku", allowedTools: ["mcp__hq__*"] };
  return makeHome({}, {
    name: "demo",
    targetRepo: "../demo-project",
    agents: [
      { id: "scout", name: "Scout", ...base },
      { id: "writer", name: "Writer", ...base },
    ],
  });
}

/** The scout ends after 100 ms; the writer works until it is aborted, as `claude -p` killed by the runner. */
function engine(seen: RunInput[]): Engine {
  return {
    name: "claude",
    async *run(input) {
      seen.push(input);
      if (input.agentId === "scout") {
        await new Promise((resolve) => setTimeout(resolve, 100));
        yield done;
        return;
      }
      await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
      yield { type: "end", status: "failed", reason: "aborted", summary: "aborted", usage, costUsd: 0 };
    },
  };
}

const sent: string[] = [];
const send = async (text: string) => {
  sent.push(text);
  return true;
};

test("a stop waits for the runs in progress, interrupts the ones still going after the grace, and starts none", async () => {
  const config = home();
  const db = getDbAt(config.dbPath);
  const seen: RunInput[] = [];
  const deps = { config, engine: engine(seen), send };
  const scoutRun = startRun({ room: "demo", agent: "scout" }, deps);
  hqMessage(db, { dbPath: config.dbPath, runId: scoutRun.id, agentId: "scout", room: "demo" }, { to: "writer", text: "Cut the video." });
  const [writerRun] = wakeAgents(config, db, deps);
  assert.ok(writerRun);

  const stopped = stopRuns(400, 20);
  assert.equal(isStopping(), true);
  // No run starts while the app stops: a manual start is refused, a wake-up leaves the task waiting.
  assert.throws(
    () => startRun({ room: "demo", agent: "scout", task: "Again." }, deps),
    (error: unknown) => error instanceof HqError && error.code === "SHUTTING_DOWN",
  );
  assert.deepEqual(await stopped, { ended: 1, interrupted: 1 });

  assert.equal((await waitForRun(db, scoutRun.id)).status, "done", "the short run ended on its own");
  const writer = db.prepare("SELECT * FROM runs WHERE id = ?").get(writerRun.id) as RunRow;
  assert.equal(writer.status, "cancelled");
  assert.equal(writer.summary, INTERRUPTED_SUMMARY);
  const tasks = db.prepare("SELECT * FROM tasks WHERE agent_id = 'writer' ORDER BY id").all() as TaskRow[];
  assert.deepEqual(
    tasks.map((t) => [t.source, t.status, t.run_id]),
    [
      ["message", "pending", null],
      ["manual", "blocked", writerRun.id],
    ],
  );
  assert.equal(sent.filter((text) => text.includes(`#${writerRun.id}`)).length, 0, "an interruption is no failure: no alert");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n, 2);

  // After the restart (a new process), the task given back wakes the writer once.
  (globalThis as unknown as { __myhqRunner: { stopping: boolean } }).__myhqRunner.stopping = false;
  const [resumed] = wakeAgents(config, db, { config, engine: { name: "claude", async *run() { yield done; } }, send });
  assert.equal(resumed?.agent_id, "writer");
  assert.equal((await waitForRun(db, resumed.id)).status, "done");
  assert.equal((db.prepare("SELECT status FROM tasks WHERE agent_id = 'writer' AND source = 'message'").get() as TaskRow).status, "done");
});

test("the shutdown message of pm2 stops the runs, then exits; a second one exits at once", async () => {
  (globalThis as unknown as { __myhqRunner: { stopping: boolean } }).__myhqRunner.stopping = false;
  const codes: (number | string)[] = [];
  let exited!: () => void;
  const first = new Promise<void>((resolve) => (exited = resolve));
  installShutdown(
    { ...home(), shutdownGraceMs: 50 },
    (code) => {
      codes.push(code);
      exited();
    },
    async () => {
      codes.push("servers closed");
    },
  );
  process.emit("message", "shutdown", undefined);
  assert.equal(isStopping(), true);
  process.emit("message", "shutdown", undefined);
  await first;
  await new Promise((resolve) => setTimeout(resolve, 100));
  // The servers are closed after the runs and before the exit.
  assert.deepEqual(codes, [1, "servers closed", 0]);
});
