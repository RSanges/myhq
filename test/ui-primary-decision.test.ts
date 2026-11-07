import assert from "node:assert/strict";
import { test } from "node:test";
import { primaryDecision } from "../src/ui/primary-decision";

test("without a comment or a remark the main button approves", () => {
  assert.equal(primaryDecision("", 0), "approved");
  assert.equal(primaryDecision("   \n", 0), "approved");
});

test("a general comment turns the main button into a revision", () => {
  assert.equal(primaryDecision("Shorter, please", 0), "revise");
});

test("a remark on a passage alone turns the main button into a revision", () => {
  assert.equal(primaryDecision("", 1), "revise");
  assert.equal(primaryDecision("  ", 3), "revise");
});
