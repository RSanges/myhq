import assert from "node:assert/strict";
import { test } from "node:test";
import { waitIdle } from "../scripts/wait-idle";
import { getDbAt } from "../src/server/db";
import { runsInProgress } from "../src/server/feed";
import { makeHome } from "./helpers";

/** A fake app that answers GET /api/runs/active with each body in turn (the last one repeats). */
function fakeApp(bodies: unknown[]): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch: (async (url: string) => {
      calls.push(url);
      return Response.json(bodies[Math.min(calls.length - 1, bodies.length - 1)]);
    }) as unknown as typeof fetch,
  };
}

const run = { id: 7, room: "creation", agentId: "motion" };

test("wait-idle returns once no run is in progress, and tells which ones it waits for", async () => {
  const app = fakeApp([
    { running: 1, stopping: false, runs: [run] },
    { running: 1, stopping: false, runs: [run] },
    { running: 0, stopping: false, runs: [] },
  ]);
  const lines: string[] = [];
  const idle = await waitIdle({ url: "http://127.0.0.1:4242", timeoutMs: 5_000, pollMs: 5, fetch: app.fetch, log: (l) => lines.push(l) });
  assert.equal(idle, true);
  assert.deepEqual(app.calls, Array(3).fill("http://127.0.0.1:4242/api/runs/active"));
  assert.deepEqual(lines, ["Tours en cours : #7 creation/motion. J'attends qu'ils finissent...", "Aucun tour en cours : tu peux déployer."]);
});

test("wait-idle gives up at its timeout while runs go on, and counts an app that does not answer as idle", async () => {
  const busy = fakeApp([{ running: 1, stopping: false, runs: [run] }]);
  assert.equal(await waitIdle({ url: "http://x", timeoutMs: 30, pollMs: 5, fetch: busy.fetch, log: () => {} }), false);
  const down = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  const lines: string[] = [];
  assert.equal(await waitIdle({ url: "http://x", timeoutMs: 30, pollMs: 5, fetch: down, log: (l) => lines.push(l) }), true);
  assert.match(lines[0]!, /ne répond pas sur http:\/\/x/);
});

test("the runs in progress are the ones GET /api/runs/active lists", () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const insert = db.prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at) VALUES ('demo', 'scout', 'claude', 'x', ?, ?)");
  insert.run("done", new Date().toISOString());
  const running = Number(insert.run("running", new Date().toISOString()).lastInsertRowid);
  assert.deepEqual(runsInProgress(db).map((r) => [r.id, r.status]), [[running, "running"]]);
});
