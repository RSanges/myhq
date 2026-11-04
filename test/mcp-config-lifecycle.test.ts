import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { purgeLeftoverMcpConfigs, removeMcpConfig, writeMcpConfig } from "../src/server/claude-engine";
import { getDbAt, type RunRow } from "../src/server/db";
import type { Engine, RunEvent, RunInput } from "../src/server/engine";
import { startRun } from "../src/server/runner";
import { makeHome, waitForRun } from "./helpers";

const usage = { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const SECRET = "s3cr3t-value-for-the-test";

const roomWithSecret = {
  name: "demo",
  targetRepo: "../demo-project",
  agents: [
    {
      id: "scout",
      name: "Scout",
      role: "roles/scout.md",
      model: "haiku",
      allowedTools: ["mcp__hq__*"],
      mcpServers: { mail: { command: "node", env: { PASSWORD: "${HQ_EXT_LIFECYCLE_SECRET}" } } },
    },
  ],
};

function start(status = "connected"): RunEvent {
  return {
    type: "start",
    sessionId: "s",
    model: "haiku",
    tools: [],
    mcpServers: [
      { name: "mail", status: "connected" },
      { name: "hq", status },
    ],
  };
}
const end: RunEvent = { type: "end", status: "done", reason: "success", summary: "OK", usage, costUsd: 0 };

/** What the engine saw of the config file at each step of a run. */
type Trace = { before: boolean; content: string; mode: number; afterStart: boolean | null; path: string };

/** Plays one script per run; between its events it looks at the config file, as the CLI's process would. */
function tracingEngine(scripts: RunEvent[][], traces: Trace[]): Engine {
  return {
    name: "claude",
    async *run(input: RunInput) {
      const trace: Trace = {
        before: fs.existsSync(input.mcpConfigPath),
        content: fs.readFileSync(input.mcpConfigPath, "utf8"),
        mode: fs.statSync(input.mcpConfigPath).mode & 0o777,
        afterStart: null,
        path: input.mcpConfigPath,
      };
      traces.push(trace);
      for (const event of scripts[traces.length - 1] ?? []) {
        yield event;
        // Resumed once the runner has handled the event.
        if (event.type === "start") trace.afterStart = fs.existsSync(input.mcpConfigPath);
      }
    },
  };
}

function withSecret<T>(body: () => Promise<T>): Promise<T> {
  process.env.HQ_EXT_LIFECYCLE_SECRET = SECRET;
  return body().finally(() => {
    delete process.env.HQ_EXT_LIFECYCLE_SECRET;
  });
}

test("the MCP config exists for the CLI to read, then is deleted as soon as the init event arrives", async () => {
  await withSecret(async () => {
    const config = makeHome({}, roomWithSecret);
    const traces: Trace[] = [];
    const run = startRun(
      { room: "demo", agent: "scout" },
      { config, engine: tracingEngine([[start(), end]], traces), send: async () => true },
    );
    await waitForRun(getDbAt(config.dbPath), run.id);
    const [trace] = traces;
    assert.equal(trace!.before, true);
    assert.ok(trace!.content.includes(SECRET), "the expanded value is in the file while the CLI starts");
    assert.equal(trace!.afterStart, false, "the file is gone right after the init event");
    assert.equal(fs.existsSync(path.join(config.runsDir, `${run.id}.mcp.json`)), false);
    if (process.platform !== "win32") assert.equal(trace!.mode, 0o600);
  });
});

test("the MCP config is deleted at the end of a run that never sent an init event", async () => {
  await withSecret(async () => {
    const config = makeHome({}, roomWithSecret);
    const traces: Trace[] = [];
    const run = startRun(
      { room: "demo", agent: "scout" },
      { config, engine: tracingEngine([[end]], traces), send: async () => true },
    );
    const row = await waitForRun(getDbAt(config.dbPath), run.id);
    assert.equal(row.status, "done");
    assert.equal(fs.existsSync(traces[0]!.path), false);
  });
});

test("the MCP config is deleted when the engine fails", async () => {
  await withSecret(async () => {
    const config = makeHome({}, roomWithSecret);
    let file = "";
    const engine: Engine = {
      name: "claude",
      async *run(input) {
        file = input.mcpConfigPath;
        assert.equal(fs.existsSync(file), true);
        throw new Error("the process could not start");
      },
    };
    const run = startRun({ room: "demo", agent: "scout" }, { config, engine, send: async () => true });
    const row = await waitForRun(getDbAt(config.dbPath), run.id);
    assert.equal(row.status, "failed");
    assert.equal(fs.existsSync(file), false);
  });
});

test("the MCP config is deleted when a run is stopped by its timeout, before any init event", async () => {
  await withSecret(async () => {
    const config = makeHome({ runTimeoutMs: 40 }, roomWithSecret);
    let file = "";
    const engine: Engine = {
      name: "claude",
      async *run(input) {
        file = input.mcpConfigPath;
        await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
        yield { type: "end", status: "failed", reason: "aborted", summary: "run aborted", usage, costUsd: 0 };
      },
    };
    const run = startRun({ room: "demo", agent: "scout" }, { config, engine, send: async () => true });
    const row = await waitForRun(getDbAt(config.dbPath), run.id);
    assert.equal(row.status, "failed");
    assert.match(row.summary ?? "", /Timed out/);
    assert.equal(fs.existsSync(file), false);
  });
});

test("the retry of a run stopped for a pending MCP server writes its own config, and both are deleted", async () => {
  await withSecret(async () => {
    const config = makeHome({}, roomWithSecret);
    const db = getDbAt(config.dbPath);
    const traces: Trace[] = [];
    const first = startRun(
      { room: "demo", agent: "scout" },
      {
        config,
        engine: tracingEngine([[start("pending"), end], [start(), end]], traces),
        send: async () => true,
        mcpRetryDelayMs: 20,
      },
    );
    await waitForRun(db, first.id);
    const deadline = Date.now() + 3_000;
    let runs: RunRow[] = [];
    while (runs.length < 2 && Date.now() < deadline) {
      runs = db.prepare("SELECT * FROM runs ORDER BY id").all() as RunRow[];
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(runs.length, 2);
    await waitForRun(db, runs[1]!.id);

    assert.equal(traces.length, 2);
    assert.notEqual(traces[0]!.path, traces[1]!.path, "each attempt has its own file");
    assert.equal(traces[1]!.before, true, "the retry found its file written");
    assert.ok(traces[1]!.content.includes(SECRET), "and with the expanded values");
    // The first attempt is never read past its init event; the retry is deleted at its own.
    assert.equal(traces[1]!.afterStart, false);
    for (const trace of traces) assert.equal(fs.existsSync(trace.path), false);
  });
});

test("writeMcpConfig replaces an existing file, and removeMcpConfig never throws", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-mcp-"));
  const file = path.join(dir, "7.mcp.json");
  fs.writeFileSync(file, "stale");
  writeMcpConfig({ file, repoRoot: process.cwd(), hqEnv: { HQ_RUN_ID: "7" }, extraServers: {}, env: {} });
  assert.match(fs.readFileSync(file, "utf8"), /mcpServers/);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(removeMcpConfig(file), true);
  assert.equal(removeMcpConfig(file), true, "already gone is fine");
  assert.equal(removeMcpConfig(path.join(dir, "missing", "1.mcp.json")), true);
});

test("the startup sweep deletes the old <run id>.mcp.json files and nothing else", () => {
  const runsDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "myhq-sweep-")), "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  const old = ["1.mcp.json", "22.mcp.json", "333.mcp.json"];
  const keep = ["1.jsonl", "22.jsonl", "chat-1-1.mcp.json", "notes.mcp.json", "4.mcp.json.bak", "x1.mcp.json", "5.json"];
  for (const name of [...old, ...keep]) fs.writeFileSync(path.join(runsDir, name), "{}");
  fs.mkdirSync(path.join(runsDir, "9.mcp.json"));

  assert.equal(purgeLeftoverMcpConfigs(runsDir), 3);
  assert.deepEqual(fs.readdirSync(runsDir).sort(), [...keep, "9.mcp.json"].sort());
  assert.equal(purgeLeftoverMcpConfigs(runsDir), 0, "a second sweep finds nothing");
  assert.equal(purgeLeftoverMcpConfigs(path.join(runsDir, "missing")), 0, "no runs directory yet is fine");
});
