import assert from "node:assert/strict";
import { test } from "node:test";
import { approvalHash, parseHash, resolveApprovalLink, runHash, runStartKey, tabOf } from "../src/ui/deep-link";
import type { FeedEntry } from "../src/ui/model";

test("parseHash reads #approval-<id> and #run-<id> and nothing else", () => {
  assert.deepEqual(parseHash("#approval-12"), { kind: "approval", id: 12 });
  assert.deepEqual(parseHash("#run-3"), { kind: "run", id: 3 });
  assert.deepEqual(parseHash("run-3"), { kind: "run", id: 3 });
  const bad = ["", "#", "#approval-", "#approval-0", "#approval-01", "#approval--1", "#approval-1.5", "#approval-12a", "#approval-1234567890", "#Approval-1", "#other-4", "#approval-1&x"];
  for (const hash of bad) assert.equal(parseHash(hash), null, hash);
});

test("the hashes built for the alerts are read back by parseHash", () => {
  assert.equal(approvalHash(5), "#approval-5");
  assert.equal(runHash(9), "#run-9");
  assert.deepEqual(parseHash(approvalHash(5)), { kind: "approval", id: 5 });
  assert.deepEqual(parseHash(runHash(9)), { kind: "run", id: 9 });
});

test("an approval link selects the tab of the item, and an unknown id or a run link selects nothing", () => {
  const items = [
    { id: 1, status: "pending" },
    { id: 2, status: "approved" },
    { id: 3, status: "rejected" },
    { id: 4, status: "revise" },
  ];
  assert.deepEqual(resolveApprovalLink({ kind: "approval", id: 1 }, items), { id: 1, tab: "pending" });
  for (const id of [2, 3, 4]) assert.deepEqual(resolveApprovalLink({ kind: "approval", id }, items), { id, tab: "history" });
  assert.equal(resolveApprovalLink({ kind: "approval", id: 99 }, items), null);
  assert.equal(resolveApprovalLink({ kind: "run", id: 1 }, items), null);
  assert.equal(resolveApprovalLink(null, items), null);
  assert.equal(tabOf("pending"), "pending");
  assert.equal(tabOf("approved"), "history");
});

const eventEntry = (id: number, runId: number, type: string): FeedEntry => ({
  key: `event:${id}`,
  at: "2026-11-04T10:00:00.000Z",
  room: "demo",
  kind: "event",
  event: { id, runId, room: "demo", agentId: "scout", type, data: {}, createdAt: "2026-11-04T10:00:00.000Z" } as never,
});

test("a run link scrolls to the start of the run, or to its oldest event the page holds", () => {
  // Newest first, as the feed lists them.
  const entries: FeedEntry[] = [
    eventEntry(9, 2, "end"),
    eventEntry(8, 2, "text"),
    eventEntry(7, 2, "start"),
    eventEntry(6, 1, "end"),
    eventEntry(5, 1, "text"),
  ];
  assert.equal(runStartKey(entries, 2), "event:7");
  assert.equal(runStartKey(entries, 1), "event:5", "no start event held: the oldest one");
  assert.equal(runStartKey(entries, 3), null);
  assert.equal(runStartKey([], 1), null);
});
