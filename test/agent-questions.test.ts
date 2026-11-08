import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  askAgent,
  askSchema,
  QUESTION_MAX_CHARS,
  questionsIdle,
  readDiscussion,
  recoverInterruptedQuestions,
  resetDiscussion,
  type QuestionRow,
} from "../src/server/agent-questions";
import { buildClaudeArgs } from "../src/server/claude-engine";
import { getDbAt, now } from "../src/server/db";
import type { Engine, RunEvent, RunInput } from "../src/server/engine";
import { HqError } from "../src/server/errors";
import { readContext } from "../src/mcp/tools";
import { startRun } from "../src/server/runner";
import { getUsage } from "../src/server/usage";
import { makeHome, waitForRun } from "./helpers";

const usage = { inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 30, cacheReadInputTokens: 40 };

/** A room whose agent has its own MCP server and every write tool: a question must get none of them. */
const writerRoom = {
  name: "demo",
  targetRepo: "../demo-project",
  agents: [
    {
      id: "scout",
      name: "Scout",
      role: "roles/scout.md",
      model: "sonnet",
      effort: "high",
      allowedTools: ["Read", "Write", "Edit", "Bash(git *)", "WebFetch", "mcp__hq__*", "mcp__mail__*"],
      mcpServers: { mail: { command: "node", args: ["mail.js"] } },
    },
  ],
};

type Seen = { input: RunInput; mcp: string; system: string };

/**
 * An engine double: it records what it was given (the MCP config and the
 * system prompt as files, before the runner deletes them), optionally waits
 * for a release, then replays a result line and the end event.
 */
function fakeEngine(params: { seen?: Seen[]; gate?: Promise<void>; answer?: string; costUsd?: number; events?: RunEvent[] } = {}): Engine {
  return {
    name: "claude",
    async *run(input) {
      params.seen?.push({
        input,
        mcp: fs.readFileSync(input.mcpConfigPath, "utf8"),
        system: fs.readFileSync(input.rolePath, "utf8"),
      });
      yield { type: "start", sessionId: "q-1", model: "claude-sonnet-test", tools: ["Read", "Glob", "Grep"], mcpServers: [{ name: "hq", status: "connected" }] };
      if (params.gate) await params.gate;
      if (params.events) {
        for (const event of params.events) yield event;
        return;
      }
      const answer = params.answer ?? "I render them with **Remotion**.";
      input.onRawLine?.(JSON.stringify({ type: "result", subtype: "success", result: answer }));
      yield { type: "tool_call", id: "t1", name: "Read", input: { file_path: "notes.md" } };
      yield { type: "end", status: "done", reason: "success", summary: answer.slice(0, 100), usage, costUsd: params.costUsd ?? 0.042 };
    },
  };
}

/** An engine that answers only when it is stopped (as the real binary killed on abort). */
const silentEngine: Engine = {
  name: "claude",
  async *run(input) {
    await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
    yield { type: "end", status: "failed", reason: "aborted", summary: "run aborted", usage: { ...usage, outputTokens: 0 }, costUsd: 0 };
  },
};

function gate(): { promise: Promise<void>; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

function expectHqError(code: string, status: number) {
  return (error: unknown) => {
    assert.ok(error instanceof HqError, String(error));
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  };
}

const row = (db: ReturnType<typeof getDbAt>, id: number) =>
  db.prepare("SELECT * FROM agent_questions WHERE id = ?").get(id) as QuestionRow;

/** The values of a flag of the argument list, up to the next flag. */
function flagValues(args: string[], flag: string): string[] {
  const start = args.indexOf(flag);
  if (start < 0) return [];
  const values: string[] = [];
  for (let i = start + 1; i < args.length && !args[i]!.startsWith("--"); i++) values.push(args[i]!);
  return values;
}

test("the question schema: trimmed, not empty, bounded, nothing else", () => {
  assert.equal(askSchema.parse({ question: "  How do you make videos?  " }).question, "How do you make videos?");
  assert.equal(askSchema.safeParse({ question: "   " }).success, false);
  assert.equal(askSchema.safeParse({}).success, false);
  assert.equal(askSchema.safeParse({ question: "x".repeat(QUESTION_MAX_CHARS + 1) }).success, false);
  assert.equal(askSchema.safeParse({ question: "x".repeat(QUESTION_MAX_CHARS) }).success, true);
  assert.equal(askSchema.safeParse({ question: "ok", run: true }).success, false);
});

test("a question reads only: the binary gets Read, Glob, Grep and the HQ read tools, never a write", async () => {
  const config = makeHome({}, writerRoom);
  const seen: Seen[] = [];
  const db = getDbAt(config.dbPath);
  db.prepare("INSERT INTO memories (room, agent_id, key, value, updated_at) VALUES ('demo', 'scout', 'pipeline', 'Remotion then ffmpeg.', ?)").run(now());
  askAgent({ room: "demo", agent: "scout", question: "How do you make your videos?" }, { config, engine: fakeEngine({ seen }) });
  await questionsIdle();

  const { input, mcp, system } = seen[0]!;
  const args = buildClaudeArgs(input);
  assert.deepEqual(flagValues(args, "--tools"), ["Read", "Glob", "Grep"]);
  assert.deepEqual(flagValues(args, "--allowedTools"), ["Read", "Glob", "Grep", "mcp__hq__hq_memory_read", "mcp__hq__hq_items"]);
  const allowed = flagValues(args, "--allowedTools").join(" ");
  for (const write of ["Write", "Edit", "Bash", "WebFetch", "WebSearch", "hq_submit", "hq_message", "hq_ask", "hq_memory_write", "mcp__mail"]) {
    assert.ok(!allowed.includes(write), `${write} is not allowed`);
  }
  const denied = flagValues(args, "--disallowedTools");
  for (const tool of ["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "mcp__hq__hq_submit", "mcp__hq__hq_message", "mcp__hq__hq_ask", "mcp__hq__hq_memory_write"]) {
    assert.ok(denied.includes(tool), `${tool} is denied`);
  }
  assert.equal(flagValues(args, "--model")[0], "sonnet", "the agent's model");
  assert.equal(flagValues(args, "--effort")[0], "high", "and its effort");

  // The HQ server alone, read-only, without a run id; never the agent's own servers.
  const servers = (JSON.parse(mcp) as { mcpServers: Record<string, { env: Record<string, string> }> }).mcpServers;
  assert.deepEqual(Object.keys(servers), ["hq"]);
  assert.equal(servers.hq!.env.HQ_READ_ONLY, "1");
  assert.equal(servers.hq!.env.HQ_RUN_ID, undefined);
  assert.equal(input.env.HQ_RUN_ID, undefined);
  assert.ok(!fs.existsSync(input.mcpConfigPath), "the MCP config leaves the disk");

  // Its role, then the question mode; its memory in the prompt.
  assert.match(system, /You are a test agent\./);
  assert.match(system, /Question mode/);
  assert.match(system, /you write no file, submit nothing, send no message/);
  assert.match(input.prompt, /How do you make your videos\?/);
  assert.match(input.prompt, /Remotion then ffmpeg\./);
  assert.ok(!fs.existsSync(input.rolePath), "the system prompt file is removed");
});

test("a question is metered, never a run: no run, no task, no cap, no wake-up", async () => {
  // A cap of 0: no run may start today, a question still may.
  const config = makeHome({ maxRunsPerDay: 0, weeklyBudgetUsd: 10 });
  const db = getDbAt(config.dbPath);
  // A message waiting for the agent: a question must not wake it.
  db.prepare(
    "INSERT INTO tasks (room, agent_id, source, text, status, created_at, updated_at) VALUES ('demo', 'scout', 'message', 'hello', 'pending', ?, ?)",
  ).run(now(), now());
  const long = `${"word ".repeat(1500)}end.`;
  const asked = askAgent({ room: "demo", agent: "scout", question: "What are you doing?" }, { config, engine: fakeEngine({ answer: long, costUsd: 0.042 }) });
  assert.equal(asked.status, "running");
  await questionsIdle();

  const done = row(db, asked.id);
  assert.equal(done.status, "done");
  assert.equal(done.answer, long, "the full answer, not the engine's cut summary");
  assert.equal(done.cost_usd, 0.042);
  assert.equal(done.input_tokens, 10);
  assert.equal(done.output_tokens, 20);
  assert.equal(done.cache_creation_input_tokens, 30);
  assert.equal(done.cache_read_input_tokens, 40);
  assert.equal(done.model, "claude-sonnet-test");
  assert.equal(done.tool_calls, 1);
  assert.deepEqual(JSON.parse(done.tools), ["Read"]);

  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n, 0, "nothing in runs");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n, 0, "no run event");
  assert.equal((db.prepare("SELECT status FROM tasks").get() as { status: string }).status, "pending", "the message still waits");

  const metered = getUsage(db, 0, 10);
  assert.equal(metered.cap.runsToday, 0, "not in the cap");
  assert.equal(metered.today.runs, 0);
  assert.equal(metered.questions.today.questions, 1);
  assert.equal(metered.questions.today.costUsd, 0.042);
  assert.equal(metered.questions.week.costUsd, 0.042);
  assert.equal(metered.budget?.spentUsd, 0.042, "in the weekly budget");
});

test("a question does not take the agent's lock: it is answered while a run is in progress", async () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const hold = gate();
  const runEngine: Engine = {
    name: "claude",
    async *run() {
      await hold.promise;
      yield { type: "end", status: "done", reason: "success", summary: "OK", usage, costUsd: 0 };
    },
  };
  const run = startRun({ room: "demo", agent: "scout" }, { config, engine: runEngine, send: async () => true });
  const asked = askAgent({ room: "demo", agent: "scout", question: "Busy?" }, { config, engine: fakeEngine() });
  await questionsIdle();
  assert.equal(row(db, asked.id).status, "done");
  assert.equal((db.prepare("SELECT status FROM runs WHERE id = ?").get(run.id) as { status: string }).status, "running");
  hold.open();
  await waitForRun(db, run.id);
});

test("one question at a time per agent; a reset waits for it; the discussion goes on until a reset", async () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const hold = gate();
  const seen: Seen[] = [];
  const first = askAgent({ room: "demo", agent: "scout", question: "First?" }, { config, engine: fakeEngine({ gate: hold.promise, answer: "First answer." }) });
  assert.throws(() => askAgent({ room: "demo", agent: "scout", question: "Second?" }, { config, engine: fakeEngine() }), expectHqError("QUESTION_BUSY", 409));
  assert.throws(() => resetDiscussion(db, "demo", "scout"), expectHqError("QUESTION_BUSY", 409));
  hold.open();
  await questionsIdle();
  assert.equal(row(db, first.id).status, "done");

  // The next question gets the earlier exchange as context.
  askAgent({ room: "demo", agent: "scout", question: "And then?" }, { config, engine: fakeEngine({ seen }) });
  await questionsIdle();
  assert.match(seen[0]!.input.prompt, /Owner: First\?\nYou: First answer\./);
  assert.equal(readDiscussion(db, "demo", "scout").length, 2);

  // A new discussion: the sheet and the context start over, the cost stays metered.
  assert.equal(resetDiscussion(db, "demo", "scout"), 2);
  assert.deepEqual(readDiscussion(db, "demo", "scout"), []);
  const fresh: Seen[] = [];
  askAgent({ room: "demo", agent: "scout", question: "Fresh?" }, { config, engine: fakeEngine({ seen: fresh }) });
  await questionsIdle();
  assert.doesNotMatch(fresh[0]!.input.prompt, /First answer/);
  assert.equal(getUsage(db, 12).questions.today.questions, 3);
});

test("a question with no answer in time is stopped and says so", async () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const asked = askAgent({ room: "demo", agent: "scout", question: "Long one?" }, { config, engine: silentEngine, timeoutMs: 50 });
  await questionsIdle();
  const failed = row(db, asked.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "timeout");
  assert.equal(failed.answer, null);
  assert.match(failed.detail ?? "", /No answer after/);
  assert.equal(failed.input_tokens, 10, "what it read is still metered");
  // Over: the agent takes a question again.
  askAgent({ room: "demo", agent: "scout", question: "Short one?" }, { config, engine: fakeEngine() });
  await questionsIdle();
});

test("an engine failure and the budget are told apart", async () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const budget = askAgent(
    { room: "demo", agent: "scout", question: "Expensive?" },
    {
      config,
      engine: fakeEngine({ events: [{ type: "end", status: "failed", reason: "error_max_budget_usd", summary: "budget", usage, costUsd: 1 }] }),
    },
  );
  await questionsIdle();
  assert.equal(row(db, budget.id).error, "budget");
  assert.equal(row(db, budget.id).cost_usd, 1);
  const broken = askAgent(
    { room: "demo", agent: "scout", question: "Broken?" },
    { config, engine: fakeEngine({ events: [{ type: "end", status: "failed", reason: "no_result", summary: "exited", usage, costUsd: 0 }] }) },
  );
  await questionsIdle();
  assert.equal(row(db, broken.id).error, "error");
});

test("unknown agents are refused, and a question left running by a crash is closed at startup", () => {
  const config = makeHome();
  assert.throws(() => askAgent({ room: "demo", agent: "nobody", question: "Hi?" }, { config, engine: fakeEngine() }), expectHqError("AGENT_NOT_FOUND", 404));
  assert.throws(() => askAgent({ room: "nowhere", agent: "scout", question: "Hi?" }, { config, engine: fakeEngine() }), expectHqError("ROOM_NOT_FOUND", 404));
  const db = getDbAt(config.dbPath);
  db.prepare(
    "INSERT INTO agent_questions (room, agent_id, question, status, engine, started_at) VALUES ('demo', 'scout', 'Lost?', 'running', 'claude', ?)",
  ).run(now());
  assert.equal(recoverInterruptedQuestions(db), 1);
  const [lost] = readDiscussion(db, "demo", "scout");
  assert.equal(lost!.status, "failed");
  assert.equal(lost!.error, "interrupted");
});

test("the HQ server in read-only mode needs no run id and gives only hq_memory_read and hq_items", async () => {
  assert.throws(() => readContext({ HQ_DB_PATH: "/x/data/hq.db", HQ_AGENT_ID: "a", HQ_ROOM: "r" }), /HQ_RUN_ID/);
  const ctx = readContext({ HQ_DB_PATH: "/x/data/hq.db", HQ_AGENT_ID: "a", HQ_ROOM: "r", HQ_READ_ONLY: "1" });
  assert.equal(ctx.readOnly, true);

  const config = makeHome();
  const db = getDbAt(config.dbPath);
  db.prepare("INSERT INTO memories (room, agent_id, key, value, updated_at) VALUES ('demo', 'scout', 'k', 'v', ?)").run(now());
  // The sources, not the frozen copy of build/mcp, which may predate the read-only mode until the next build.
  const loader = pathToFileURL(path.join(process.cwd(), "node_modules", "tsx", "dist", "loader.mjs")).href;
  const server = { command: process.execPath, args: ["--import", loader, path.join(process.cwd(), "src", "mcp", "server.ts")] };
  const client = new Client({ name: "myhq-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: { ...(process.env as Record<string, string>), HQ_DB_PATH: config.dbPath, HQ_AGENT_ID: "scout", HQ_ROOM: "demo", HQ_READ_ONLY: "1" },
      stderr: "pipe",
    }),
  );
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ["hq_items", "hq_memory_read"]);
    const read = await client.callTool({ name: "hq_memory_read", arguments: { key: "k" } });
    assert.match((read.content as { text: string }[])[0]!.text, /"value":"v"/);
    // No tool that writes exists: the SDK answers an error, or throws one.
    const write = await client.callTool({ name: "hq_memory_write", arguments: { key: "k", value: "w" } }).catch(() => ({ isError: true }));
    assert.equal(write.isError, true);
  } finally {
    await client.close();
  }
  assert.equal((db.prepare("SELECT value FROM memories WHERE key = 'k'").get() as { value: string }).value, "v");
});
