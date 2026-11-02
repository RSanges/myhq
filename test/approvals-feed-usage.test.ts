import assert from "node:assert/strict";
import { test } from "node:test";
import { decideApproval, decisionSchema } from "../src/server/approvals";
import { getDbAt, type Db } from "../src/server/db";
import { HqError } from "../src/server/errors";
import { changesSince, currentCursor } from "../src/server/feed";
import { getUsage } from "../src/server/usage";
import { makeHome } from "./helpers";

function freshDb(): Db {
  return getDbAt(makeHome().dbPath);
}

function addApproval(db: Db): number {
  return Number(
    db
      .prepare(
        "INSERT INTO approvals (room, agent_id, type, title, body, payload, status, created_at) VALUES ('demo', 'scout', 'community_reply', 'T', 'B', '{\"url\":\"u\"}', 'pending', ?)",
      )
      .run(new Date().toISOString()).lastInsertRowid,
  );
}

test("a decision needs a note unless it approves", () => {
  assert.equal(decisionSchema.safeParse({ decision: "approved" }).success, true);
  assert.equal(decisionSchema.safeParse({ decision: "rejected" }).success, false);
  assert.equal(decisionSchema.safeParse({ decision: "revise", note: "  " }).success, false);
  assert.equal(decisionSchema.safeParse({ decision: "maybe" }).success, false);
});

test("approve keeps the payload and refuses a second decision", () => {
  const db = freshDb();
  const id = addApproval(db);
  const approval = decideApproval(db, id, { decision: "approved" });
  assert.equal(approval.status, "approved");
  assert.deepEqual(approval.payload, { url: "u" });
  assert.ok(approval.decidedAt);
  assert.throws(
    () => decideApproval(db, id, { decision: "rejected", note: "no" }),
    (e: unknown) => e instanceof HqError && e.status === 409,
  );
  assert.throws(
    () => decideApproval(db, 999, { decision: "approved" }),
    (e: unknown) => e instanceof HqError && e.status === 404,
  );
});

test("revise sends the item back to its agent as a task", () => {
  const db = freshDb();
  const id = addApproval(db);
  decideApproval(db, id, { decision: "revise", note: "Shorter please." });
  const task = db.prepare("SELECT * FROM tasks WHERE source = 'revise' AND ref_id = ?").get(id) as {
    agent_id: string;
    status: string;
    text: string;
  };
  assert.equal(task.agent_id, "scout");
  assert.equal(task.status, "pending");
  assert.match(task.text, /Shorter please\./);
});

// Each change carries the entity as it is when the change is read.
test("the feed returns new and updated approvals after a cursor", () => {
  const db = freshDb();
  const start = currentCursor(db);
  const id = addApproval(db);
  decideApproval(db, id, { decision: "approved" });
  const { items, cursor } = changesSince(db, start);
  assert.deepEqual(
    items.map((i) => [i.kind, i.kind === "approval" ? i.data.status : null]),
    [
      ["approval", "approved"],
      ["approval", "approved"],
    ],
  );
  assert.equal(changesSince(db, cursor).items.length, 0);
});

test("usage sums today's runs and reports the cap", () => {
  const db = freshDb();
  const at = new Date().toISOString();
  db.prepare(
    "INSERT INTO runs (room, agent_id, engine, task, status, input_tokens, output_tokens, cost_usd, started_at) VALUES ('demo', 'scout', 'claude', 't', 'done', 10, 20, 0.5, ?), ('demo', 'scout', 'claude', 't', 'failed', 1, 2, 0.25, ?)",
  ).run(at, at);
  const usage = getUsage(db, 12);
  assert.equal(usage.days.length, 7);
  assert.equal(usage.today.runs, 2);
  assert.equal(usage.today.inputTokens, 11);
  assert.equal(usage.today.outputTokens, 22);
  assert.equal(usage.today.costUsd, 0.75);
  assert.equal(usage.week.runs, 2);
  assert.deepEqual(usage.cap, { maxRunsPerDay: 12, runsToday: 2, remaining: 10 });
});
