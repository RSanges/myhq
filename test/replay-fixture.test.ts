import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openDb } from "../src/server/db";
import { loadHome } from "../src/server/rooms";

const root = path.join(import.meta.dirname, "..");
const fixtures = path.join(import.meta.dirname, "fixtures");

function replay(fixture: string, home: string, extra: string[] = []) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      path.join(root, "scripts", "replay-fixture.ts"),
      path.join(fixtures, fixture),
      "--home",
      home,
      "--delay",
      "0",
      "--interval",
      "0",
      ...extra,
    ],
    { cwd: root, encoding: "utf8" },
  );
}

const tempHome = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "myhq-replay-")), "home");

test("replays a fixture into a throwaway demo home: a run, its events, the approval and the message", () => {
  const home = tempHome();
  const onboarding = replay("stream-json-onboarding.jsonl", home);
  assert.equal(onboarding.status, 0, onboarding.stderr);
  assert.equal(loadHome(home).rooms[0]!.agents.length, 3);

  const message = replay("stream-json-message.synthetic.jsonl", home, ["--agent", "scout"]);
  assert.equal(message.status, 0, message.stderr);

  const db = openDb(path.join(home, "data", "hq.db"));
  const runs = db.prepare("SELECT * FROM runs ORDER BY id").all() as { status: string; agent_id: string; cost_usd: number }[];
  assert.deepEqual(runs.map((r) => r.status), ["done", "done"]);
  assert.ok(runs[1]!.cost_usd > 0);
  const events = db.prepare("SELECT type FROM events WHERE run_id = 1 ORDER BY id").all() as { type: string }[];
  assert.equal(events.length, 24);
  assert.equal(events[events.length - 1]!.type, "end");
  const approvals = db.prepare("SELECT type, status, agent_id FROM approvals").all() as { type: string; status: string }[];
  assert.deepEqual(approvals.map((a) => [a.type, a.status]), [["room_proposal", "pending"]]);
  const messages = db.prepare("SELECT from_agent, to_agent FROM messages").all();
  assert.deepEqual(messages, [{ from_agent: "scout", to_agent: "writer" }]);
  // Every change reached the stream the interface follows.
  const changes = db.prepare("SELECT COUNT(*) AS n FROM changes").get() as { n: number };
  assert.ok(changes.n > 24);
  db.close();
});

test("a failed fixture closes the run as failed", () => {
  const home = tempHome();
  const result = replay("stream-json-auth-error.jsonl", home);
  assert.equal(result.status, 0, result.stderr);
  const db = openDb(path.join(home, "data", "hq.db"));
  assert.equal((db.prepare("SELECT status FROM runs").get() as { status: string }).status, "failed");
  db.close();
});

test("refuses a folder that is not a demo home, and an unknown agent", () => {
  const notMine = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-real-"));
  fs.writeFileSync(path.join(notMine, "something.txt"), "a real home");
  const refused = replay("stream-json-tool-run.jsonl", notMine);
  assert.notEqual(refused.status, 0);
  assert.deepEqual(fs.readdirSync(notMine), ["something.txt"], "nothing was written there");

  const unknown = replay("stream-json-tool-run.jsonl", tempHome(), ["--agent", "ghost"]);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /ghost/);
});
