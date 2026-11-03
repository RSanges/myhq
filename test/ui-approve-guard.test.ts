import assert from "node:assert/strict";
import { test } from "node:test";
import { stepGuard, type GuardAction, type GuardState } from "../src/ui/approve-guard";

const step = (state: GuardState, action: GuardAction, drafts: number) => stepGuard(state, action, drafts);

test("approve without a draft goes straight through", () => {
  assert.deepEqual(step("idle", "approve", 0), { state: "idle", effect: "approve" });
});

test("approve with drafts asks first and sends nothing", () => {
  assert.deepEqual(step("idle", "approve", 1), { state: "confirming", effect: "none" });
  assert.deepEqual(step("idle", "approve", 7), { state: "confirming", effect: "none" });
});

test("while confirming: revise sends the revision, approve anyway sends the approval, both close the guard", () => {
  assert.deepEqual(step("confirming", "revise", 2), { state: "idle", effect: "revise" });
  assert.deepEqual(step("confirming", "approveAnyway", 2), { state: "idle", effect: "approve" });
});

test("Escape cancels the confirmation and sends nothing", () => {
  assert.deepEqual(step("confirming", "escape", 2), { state: "idle", effect: "none" });
});

test("clicking Approuver again while confirming changes nothing", () => {
  assert.deepEqual(step("confirming", "approve", 2), { state: "confirming", effect: "none" });
});

test("the confirmation goes away once the last draft is removed, and stays while some are left", () => {
  assert.deepEqual(step("confirming", "drafts", 0), { state: "idle", effect: "none" });
  assert.deepEqual(step("confirming", "drafts", 1), { state: "confirming", effect: "none" });
  assert.deepEqual(step("idle", "drafts", 3), { state: "idle", effect: "none" });
});

test("outside the confirmation, its buttons and Escape do nothing", () => {
  for (const action of ["revise", "approveAnyway", "escape"] as const) {
    assert.deepEqual(step("idle", action, 2), { state: "idle", effect: "none" });
  }
});
