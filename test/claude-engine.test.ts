import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { buildClaudeArgs, parseStreamLine } from "../src/server/claude-engine";
import type { RunEvent, RunInput } from "../src/server/engine";
import { LocalEngine } from "../src/server/engine";

function parseFixture(name: string): RunEvent[] {
  return fs
    .readFileSync(path.join(import.meta.dirname, "fixtures", name), "utf8")
    .split("\n")
    .flatMap(parseStreamLine);
}

// Real output of `claude -p ... --output-format stream-json --verbose` (CLI
// 2.1.183, 2026-11-02), with machine paths replaced: a SessionStart hook
// message, init, two api_retry messages, a synthetic assistant message and a
// result flagged is_error with subtype "success" (expired login).
test("parses a real failed run: start, text, end failed with zero usage", () => {
  const events = parseFixture("stream-json-auth-error.jsonl");
  assert.deepEqual(
    events.map((e) => e.type),
    ["start", "text", "end"],
  );
  const start = events[0] as Extract<RunEvent, { type: "start" }>;
  assert.equal(start.model, "claude-haiku-4-5-20251001");
  assert.deepEqual(start.mcpServers, [{ name: "hq", status: "pending" }]);
  const end = events[2] as Extract<RunEvent, { type: "end" }>;
  assert.equal(end.status, "failed");
  assert.equal(end.reason, "success");
  assert.match(end.summary, /401/);
  assert.equal(end.costUsd, 0);
});

// Same message shapes, written by hand for a successful run with one tool
// call (no successful real run could be recorded yet, see docs/api.md).
test("parses a run with a tool call, its result, and usage and cost", () => {
  const events = parseFixture("stream-json-tool-run.synthetic.jsonl");
  assert.deepEqual(
    events.map((e) => e.type),
    ["start", "text", "tool_call", "tool_result", "text", "end"],
  );
  assert.deepEqual(events[2], {
    type: "tool_call",
    id: "toolu_01",
    name: "mcp__hq__hq_task_update",
    input: { status: "done", note: "smoke test" },
  });
  assert.deepEqual(events[3], { type: "tool_result", toolUseId: "toolu_01", isError: false, content: '{"updated":1}' });
  assert.deepEqual(events[5], {
    type: "end",
    status: "done",
    reason: "success",
    summary: "OK",
    usage: { inputTokens: 20, outputTokens: 60, cacheCreationInputTokens: 15000, cacheReadInputTokens: 15000 },
    costUsd: 0.0213,
  });
});

test("an error result fails the run with its errors as summary", () => {
  const [end] = parseStreamLine(
    JSON.stringify({ type: "result", subtype: "error_max_budget_usd", is_error: true, errors: ["budget exceeded"], total_cost_usd: 0.3 }),
  );
  assert.deepEqual(end, {
    type: "end",
    status: "failed",
    reason: "error_max_budget_usd",
    summary: "budget exceeded",
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    costUsd: 0.3,
  });
});

test("ignores blank, non-JSON and unknown lines", () => {
  assert.deepEqual(parseStreamLine(""), []);
  assert.deepEqual(parseStreamLine("not json"), []);
  assert.deepEqual(parseStreamLine('{"type":"rate_limit_event"}'), []);
});

test("builds the claude command line", () => {
  const input = {
    prompt: "Do it.",
    model: "sonnet",
    rolePath: "/h/rooms/demo/roles/scout.md",
    mcpConfigPath: "/h/data/runs/1.mcp.json",
    allowedTools: ["WebSearch", "mcp__hq__*"],
    maxBudgetUsd: 2,
  } as RunInput;
  const args = buildClaudeArgs(input);
  assert.deepEqual(args.slice(0, 15), [
    "-p",
    "Do it.",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    "sonnet",
    "--append-system-prompt-file",
    "/h/rooms/demo/roles/scout.md",
    "--mcp-config",
    "/h/data/runs/1.mcp.json",
    "--strict-mcp-config",
    "--setting-sources",
    "project,local",
    "--allowedTools",
  ]);
  assert.deepEqual(args.slice(15, 17), ["WebSearch", "mcp__hq__*"]);
  assert.equal(args[17], "--disallowedTools");
  assert.deepEqual(args.slice(-2), ["--max-budget-usd", "2"]);
  assert.ok(!args.includes("--max-turns"));
});

test("LocalEngine is a skeleton that throws", async () => {
  const iterator = new LocalEngine().run({} as RunInput)[Symbol.asyncIterator]();
  await assert.rejects(iterator.next(), /not implemented/);
});
