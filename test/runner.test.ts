import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { getDbAt } from "../src/server/db";
import { LocalEngine, type Engine, type RunEvent, type RunInput } from "../src/server/engine";
import { HqError } from "../src/server/errors";
import { agentEnv, startRun } from "../src/server/runner";
import { makeHome, waitForRun } from "./helpers";

const usage = { inputTokens: 12, outputTokens: 34, cacheCreationInputTokens: 56, cacheReadInputTokens: 78 };

/** An engine that replays fixed events, optionally waiting for a release first. */
function fakeEngine(events: RunEvent[], gate?: Promise<void>, seen?: RunInput[]): Engine {
  return {
    name: "claude",
    async *run(input) {
      seen?.push(input);
      if (gate) await gate;
      for (const event of events) yield event;
    },
  };
}

const doneEvents: RunEvent[] = [
  { type: "start", sessionId: "s-1", model: "haiku", tools: ["mcp__hq__hq_submit"], mcpServers: [] },
  { type: "tool_call", id: "t1", name: "mcp__hq__hq_task_update", input: { status: "done" } },
  { type: "tool_result", toolUseId: "t1", isError: false, content: "{\"updated\":1}" },
  { type: "text", text: "OK" },
  { type: "end", status: "done", reason: "success", summary: "OK", usage, costUsd: 0.0123 },
];

function expectHqError(code: string, status: number) {
  return (error: unknown) => {
    assert.ok(error instanceof HqError, String(error));
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  };
}

test("a run records its events, tokens, cost and status", async () => {
  const config = makeHome();
  const seen: RunInput[] = [];
  const sent: string[] = [];
  const run = startRun(
    { room: "demo", agent: "scout", task: "Find threads." },
    { config, engine: fakeEngine(doneEvents, undefined, seen), send: async (t) => (sent.push(t), true) },
  );
  assert.equal(run.status, "running");
  const db = getDbAt(config.dbPath);
  const finished = await waitForRun(db, run.id);
  assert.equal(finished.status, "done");
  assert.equal(finished.input_tokens, 12);
  assert.equal(finished.output_tokens, 34);
  assert.equal(finished.cache_creation_input_tokens, 56);
  assert.equal(finished.cache_read_input_tokens, 78);
  assert.equal(finished.cost_usd, 0.0123);
  assert.equal(finished.summary, "OK");
  assert.equal(finished.session_id, "s-1");
  assert.ok(finished.ended_at);

  const types = (db.prepare("SELECT type FROM events WHERE run_id = ? ORDER BY id").all(run.id) as { type: string }[]).map(
    (e) => e.type,
  );
  assert.deepEqual(types, ["start", "tool_call", "tool_result", "text", "end"]);

  const input = seen[0]!;
  assert.equal(input.workDir, path.join(config.home, "data", "work", "demo", "scout"));
  assert.ok(fs.existsSync(input.workDir));
  assert.match(input.prompt, /Find threads\./);
  assert.equal(input.env.HQ_RUN_ID, String(run.id));
  const mcp = JSON.parse(fs.readFileSync(input.mcpConfigPath, "utf8")) as {
    mcpServers: { hq: { env: Record<string, string> } };
  };
  assert.equal(mcp.mcpServers.hq.env.HQ_DB_PATH, config.dbPath);
  assert.equal(sent.length, 0);
});

test("the agent lock refuses a second run while one is in progress", async () => {
  const config = makeHome();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const first = startRun({ room: "demo", agent: "scout" }, { config, engine: fakeEngine(doneEvents, gate) });
  assert.throws(
    () => startRun({ room: "demo", agent: "scout" }, { config, engine: fakeEngine(doneEvents) }),
    expectHqError("AGENT_BUSY", 409),
  );
  release();
  await waitForRun(getDbAt(config.dbPath), first.id);
  const second = startRun({ room: "demo", agent: "scout" }, { config, engine: fakeEngine(doneEvents) });
  await waitForRun(getDbAt(config.dbPath), second.id);
});

test("the daily cap refuses a run once reached", async () => {
  const config = makeHome({ maxRunsPerDay: 1 });
  const run = startRun({ room: "demo", agent: "scout" }, { config, engine: fakeEngine(doneEvents) });
  await waitForRun(getDbAt(config.dbPath), run.id);
  assert.throws(
    () => startRun({ room: "demo", agent: "scout" }, { config, engine: fakeEngine(doneEvents) }),
    expectHqError("DAILY_CAP_REACHED", 429),
  );
});

test("unknown rooms and agents are explicit errors", () => {
  const config = makeHome();
  assert.throws(() => startRun({ room: "nope", agent: "scout" }, { config }), expectHqError("ROOM_NOT_FOUND", 404));
  assert.throws(() => startRun({ room: "demo", agent: "nope" }, { config }), expectHqError("AGENT_NOT_FOUND", 404));
});

test("an invalid room cannot run", () => {
  const config = makeHome({}, { name: "demo", targetRepo: "x", agents: [] });
  assert.throws(() => startRun({ room: "demo", agent: "scout" }, { config }), expectHqError("ROOM_INVALID", 422));
});

test("a failed run is recorded and notified", async () => {
  const config = makeHome();
  const sent: string[] = [];
  const run = startRun(
    { room: "demo", agent: "scout" },
    {
      config,
      engine: fakeEngine([
        { type: "end", status: "failed", reason: "error_max_budget_usd", summary: "budget", usage, costUsd: 0.5 },
      ]),
      send: async (t) => (sent.push(t), true),
    },
  );
  const finished = await waitForRun(getDbAt(config.dbPath), run.id);
  assert.equal(finished.status, "failed");
  assert.equal(finished.cost_usd, 0.5);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, new RegExp(`#${run.id}`));
});

test("an engine that throws fails the run (LocalEngine is not implemented)", async () => {
  const config = makeHome();
  const run = startRun({ room: "demo", agent: "scout" }, { config, engine: new LocalEngine(), send: async () => true });
  const finished = await waitForRun(getDbAt(config.dbPath), run.id);
  assert.equal(finished.status, "failed");
  assert.match(finished.summary ?? "", /not implemented/);
});

test("pending approvals are notified once", async () => {
  const config = makeHome();
  const sent: string[] = [];
  const db = getDbAt(config.dbPath);
  const submitting: Engine = {
    name: "claude",
    async *run(input) {
      db.prepare(
        "INSERT INTO approvals (room, agent_id, run_id, type, title, body, status, created_at) VALUES ('demo', 'scout', ?, 'community_reply', 'A reply', 'body', 'pending', ?)",
      ).run(input.runId, new Date().toISOString());
      yield { type: "tool_result", toolUseId: "t1", isError: false, content: "{}" };
      yield { type: "end", status: "done", reason: "success", summary: "ok", usage, costUsd: 0 };
    },
  };
  const run = startRun({ room: "demo", agent: "scout" }, { config, engine: submitting, send: async (t) => (sent.push(t), true) });
  await waitForRun(db, run.id);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /A reply/);
});

test("the agent environment never carries the app variables", () => {
  const env = agentEnv(
    { PATH: "/bin", HQ_TELEGRAM_BOT_TOKEN: "secret", HQ_TELEGRAM_CHAT_ID: "1", MYHQ_HOME: "../home" },
    { HQ_RUN_ID: "3" },
  );
  assert.deepEqual(env, { PATH: "/bin", HQ_RUN_ID: "3" });
});

test("a nested Claude Code session does not leak into the agent", () => {
  const env = agentEnv(
    { PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "x", ANTHROPIC_BASE_URL: "http://proxy", CLAUDE_CODE_OAUTH_TOKEN: "user" },
    {},
  );
  assert.deepEqual(env, { PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "user" });
});

test("HQ_CLAUDE_OAUTH_TOKEN reaches the agent as CLAUDE_CODE_OAUTH_TOKEN, and nothing else does", () => {
  const env = agentEnv(
    { PATH: "/bin", HQ_CLAUDE_OAUTH_TOKEN: " long-lived ", CLAUDE_CODE_OAUTH_TOKEN: "other" },
    { HQ_RUN_ID: "3" },
  );
  assert.deepEqual(env, { PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "long-lived", HQ_RUN_ID: "3" });
});
