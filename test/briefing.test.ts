import assert from "node:assert/strict";
import { test } from "node:test";
import { getDbAt, now } from "../src/server/db";
import type { Engine, RunEvent, RunInput } from "../src/server/engine";
import { startRun } from "../src/server/runner";
import { makeHome, waitForRun } from "./helpers";

const usage = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

const doneEvents: RunEvent[] = [
  { type: "start", sessionId: "s-1", model: "haiku", tools: [], mcpServers: [] },
  { type: "text", text: "Done." },
  { type: "end", status: "done", reason: "success", summary: "Done.", usage, costUsd: 0.01 },
];

function fakeEngine(seen: RunInput[], events: RunEvent[] = doneEvents): Engine {
  return {
    name: "claude",
    async *run(input) {
      seen.push(input);
      for (const event of events) yield event;
    },
  };
}

// --- what MyHQ already knows goes into the prompt -------------------------------------

function addDecision(db: ReturnType<typeof getDbAt>, title: string): number {
  const at = now();
  return Number(
    db
      .prepare(
        "INSERT INTO approvals (room, agent_id, type, title, body, payload, status, decision_note, decided_at, created_at) VALUES ('demo', 'scout', 'post', ?, 'B', '{\"url\":\"u\"}', 'approved', 'Go.', ?, ?)",
      )
      .run(title, at, at).lastInsertRowid,
  );
}

test("the prompt gives the new decisions, once, and the memory, and asks for hq_task_update only when blocked", async () => {
  const seen: RunInput[] = [];
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const id = addDecision(db, "Launch post");
  db.prepare("INSERT INTO memories (room, agent_id, key, value, updated_at) VALUES ('demo', 'scout', 'seen_threads', '[1,2]', ?)").run(now());
  await waitForRun(db, startRun({ room: "demo", agent: "scout" }, { config, engine: fakeEngine(seen) }).id);
  const prompt = seen[0]!.prompt;
  assert.match(prompt, new RegExp(`Item #${id} \\(post\\) "Launch post": approved`));
  assert.match(prompt, /Note: Go\./);
  assert.match(prompt, /Payload: \{"url":"u"\}/);
  assert.match(prompt, /- seen_threads \(updated [^)]+\):\n {2}\[1,2\]/);
  assert.match(prompt, /do not call hq_read_decisions or hq_memory_read/);
  assert.match(prompt, /Call it only when you are blocked/);
  assert.ok(!/hq_task_update for your task/.test(prompt));
  assert.ok(prompt.trimEnd().split("\n").at(-1)!.startsWith("Today is "), "the date line stays last");
  const row = db.prepare("SELECT seen_by_agent_at FROM approvals WHERE id = ?").get(id) as { seen_by_agent_at: string | null };
  assert.ok(row.seen_by_agent_at, "given once: marked seen");

  await waitForRun(db, startRun({ room: "demo", agent: "scout" }, { config, engine: fakeEngine(seen) }).id);
  assert.match(seen[1]!.prompt, /New decisions of the user on your submissions: none\./);
});

test("decisions given to a run that never reached the model are given back", async () => {
  const seen: RunInput[] = [];
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const id = addDecision(db, "Launch post");
  const down: RunEvent[] = [{ type: "start", sessionId: null, model: null, tools: [], mcpServers: [{ name: "mail", status: "failed" }] }];
  const original = console.error;
  console.error = () => undefined;
  try {
    const run = startRun({ room: "demo", agent: "scout" }, { config, engine: fakeEngine(seen, down), mcpRetryDelayMs: 10, send: async () => true });
    await waitForRun(db, run.id);
    // Its one retry fails the same way.
    for (let i = 0; i < 100 && !db.prepare("SELECT 1 FROM runs WHERE id = ?").get(run.id + 1); i++) await new Promise((r) => setTimeout(r, 10));
    await waitForRun(db, run.id + 1);
  } finally {
    console.error = original;
  }
  assert.equal(seen.length, 2);
  assert.match(seen[1]!.prompt, /Launch post/, "the retry gets the decision again");
  const row = db.prepare("SELECT seen_by_agent_at FROM approvals WHERE id = ?").get(id) as { seen_by_agent_at: string | null };
  assert.equal(row.seen_by_agent_at, null);
});
