import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openDb, type Db } from "../src/server/db";
import { hqMcpServerCommand } from "../src/server/claude-engine";

let dir: string;
let db: Db;
let client: Client;
let runId: number;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-mcp-"));
  const dbPath = path.join(dir, "hq.db");
  db = openDb(dbPath);
  const at = new Date().toISOString();
  db.prepare("INSERT INTO rooms (name, target_repo, synced_at) VALUES ('demo', '../demo', ?)").run(at);
  db.prepare(
    "INSERT INTO agents (room, id, name, model, role_path, synced_at) VALUES ('demo', 'scout', 'Scout', 'sonnet', 'rooms/demo/roles/scout.md', ?), ('demo', 'writer', 'Writer', 'sonnet', 'rooms/demo/roles/writer.md', ?)",
  ).run(at, at);
  runId = Number(
    db
      .prepare(
        "INSERT INTO runs (room, agent_id, engine, task, status, started_at) VALUES ('demo', 'scout', 'claude', 'test', 'running', ?)",
      )
      .run(at).lastInsertRowid,
  );
  db.prepare(
    "INSERT INTO tasks (room, agent_id, source, text, status, run_id, created_at, updated_at) VALUES ('demo', 'scout', 'manual', 'test', 'in_progress', ?, ?, ?)",
  ).run(runId, at, at);

  const server = hqMcpServerCommand(process.cwd());
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: {
      ...(process.env as Record<string, string>),
      HQ_DB_PATH: dbPath,
      HQ_RUN_ID: String(runId),
      HQ_AGENT_ID: "scout",
      HQ_ROOM: "demo",
    },
    stderr: "pipe",
  });
  client = new Client({ name: "myhq-test", version: "0.0.0" });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as { type: string; text: string }[];
  return content.map((part) => part.text).join("");
}

test("lists the sixteen hq tools", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "hq_blocked",
    "hq_blocked_note",
    "hq_items",
    "hq_memory_read",
    "hq_memory_write",
    "hq_message",
    "hq_pending",
    "hq_read_decisions",
    "hq_relaunch",
    "hq_rooms",
    "hq_run_extend",
    "hq_run_status",
    "hq_run_stop",
    "hq_submit",
    "hq_suggest_agent",
    "hq_task_update",
  ]);
});

test("hq_submit creates a pending approval", async () => {
  const result = await client.callTool({
    name: "hq_submit",
    arguments: {
      type: "community_reply",
      title: "Reply to a thread",
      body: "A useful answer.",
      payload: { url: "https://example.com/thread/1", forum: "example" },
    },
  });
  assert.notEqual(result.isError, true, textOf(result));
  const { approvalId } = JSON.parse(textOf(result)) as { approvalId: number };
  const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(approvalId) as Record<string, unknown>;
  assert.equal(row.status, "pending");
  assert.equal(row.room, "demo");
  assert.equal(row.agent_id, "scout");
  assert.equal(row.run_id, runId);
  assert.equal(row.type, "community_reply");
  assert.deepEqual(JSON.parse(row.payload as string), {
    url: "https://example.com/thread/1",
    forum: "example",
  });
});

test("hq_pending lists the pending items of every room, without their bodies", async () => {
  const at = "2026-11-03T07:00:00.000Z";
  const insert = db.prepare(
    "INSERT INTO approvals (room, agent_id, type, title, body, status, created_at) VALUES (?, ?, ?, ?, 'secret body', ?, ?)",
  );
  const other = Number(insert.run("other", "mailer", "mail_reply", "Reply to Alice", "pending", at).lastInsertRowid);
  insert.run("demo", "writer", "community_reply", "Already decided", "approved", at);
  const result = await client.callTool({ name: "hq_pending", arguments: {} });
  assert.notEqual(result.isError, true, textOf(result));
  const { pending } = JSON.parse(textOf(result)) as { pending: Record<string, unknown>[] };
  assert.ok(pending.length >= 2);
  assert.deepEqual(pending.at(-1), {
    id: other,
    room: "other",
    agent: "mailer",
    forRoom: null,
    type: "mail_reply",
    title: "Reply to Alice",
    submittedAt: at,
  });
  assert.ok(pending.every((item) => !("body" in item)));
  assert.equal(pending.some((item) => item.title === "Already decided"), false);
  assert.ok(pending.some((item) => item.room === "demo" && item.type === "community_reply"));
});

test("hq_submit rejects invalid input", async () => {
  const result = await client.callTool({
    name: "hq_submit",
    arguments: { type: "Bad Type", title: "", body: "x" },
  });
  assert.equal(result.isError, true);
});

test("hq_message stores the message and creates a task for the recipient", async () => {
  const result = await client.callTool({
    name: "hq_message",
    arguments: { to: "writer", text: "Please draft a post." },
  });
  assert.notEqual(result.isError, true, textOf(result));
  const { messageId } = JSON.parse(textOf(result)) as { messageId: number };
  const message = db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as Record<string, unknown>;
  assert.equal(message.from_agent, "scout");
  assert.equal(message.to_agent, "writer");
  assert.equal(message.text, "Please draft a post.");
  const task = db
    .prepare("SELECT * FROM tasks WHERE source = 'message' AND ref_id = ?")
    .get(messageId) as Record<string, unknown>;
  assert.equal(task.agent_id, "writer");
  assert.equal(task.status, "pending");
});

test("hq_message refuses an unknown agent", async () => {
  const result = await client.callTool({ name: "hq_message", arguments: { to: "nobody", text: "hi" } });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Unknown agent/);
});

test("hq_task_update updates the task of the current run", async () => {
  const result = await client.callTool({
    name: "hq_task_update",
    arguments: { status: "done", note: "finished" },
  });
  assert.deepEqual(JSON.parse(textOf(result)), { updated: 1 });
  const task = db.prepare("SELECT * FROM tasks WHERE run_id = ?").get(runId) as Record<string, unknown>;
  assert.equal(task.status, "done");
  assert.equal(task.note, "finished");
});

test("hq_memory_write then hq_memory_read", async () => {
  await client.callTool({ name: "hq_memory_write", arguments: { key: "seen", value: "[1,2]" } });
  const result = await client.callTool({ name: "hq_memory_read", arguments: { key: "seen" } });
  assert.equal((JSON.parse(textOf(result)) as { value: string }).value, "[1,2]");
});

test("hq_read_decisions returns each decision once", async () => {
  db.prepare(
    "UPDATE approvals SET status = 'approved', decision_note = 'ok', decided_at = ? WHERE agent_id = 'scout'",
  ).run(new Date().toISOString());
  const first = JSON.parse(textOf(await client.callTool({ name: "hq_read_decisions", arguments: {} }))) as {
    decisions: { decision: string }[];
  };
  assert.equal(first.decisions.length, 1);
  assert.equal(first.decisions[0]?.decision, "approved");
  const second = JSON.parse(textOf(await client.callTool({ name: "hq_read_decisions", arguments: {} }))) as {
    decisions: unknown[];
  };
  assert.equal(second.decisions.length, 0);
});
