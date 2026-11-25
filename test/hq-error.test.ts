import assert from "node:assert/strict";
import { test } from "node:test";
import { errorResponse, HqError, isHqError } from "../src/server/errors";

// Next.js builds the instrumentation hook and each route apart: an HqError thrown by a service one of them
// keeps on globalThis (the chat service) is of another copy of the class. It must still be answered as itself.

/** The HqError of another bundle: same name, code and status, another class. */
class OtherCopy extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HqError";
  }
}

test("errorResponse: an HqError of another copy of the module keeps its code and status, not INTERNAL", async () => {
  const response = errorResponse(new OtherCopy("MACHINE_BUSY", 409, "The machine cannot take the run now."));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: { code: "MACHINE_BUSY", message: "The machine cannot take the run now." } });
  assert.equal(isHqError(new HqError("AGENT_BUSY", 409, "busy")), true);
});

test("isHqError: an ordinary error, or one that only borrows the name, is not one", async () => {
  assert.equal(isHqError(new Error("boom")), false);
  const named = new Error("boom");
  named.name = "HqError";
  assert.equal(isHqError(named), false);
  assert.equal(isHqError({ name: "HqError", code: "X", status: 409 }), false);
  assert.equal(errorResponse(new Error("boom")).status, 500);
});
