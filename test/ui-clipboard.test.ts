import assert from "node:assert/strict";
import { test } from "node:test";
import { copyLabel, copyText, type CopyIo } from "../src/ui/clipboard";
import { strings } from "../src/ui/strings";

const io = (over: Partial<CopyIo> = {}): CopyIo & { legacy: string[]; written: string[] } => {
  const legacy: string[] = [];
  const written: string[] = [];
  return {
    legacy,
    written,
    writeText: async (text) => void written.push(text),
    legacyCopy: (text) => (legacy.push(text), true),
    ...over,
  };
};

test("copies with the Clipboard API, and calls it before any await", async () => {
  const calls = io();
  const pending = copyText("hello", calls);
  // Still inside the (synchronous) click handler: the write has already started.
  assert.deepEqual(calls.written, ["hello"]);
  assert.equal(await pending, "copied");
  assert.deepEqual(calls.legacy, []);
});

test("falls back to the legacy copy when the Clipboard API is missing or refuses", async () => {
  const missing = io({ writeText: undefined });
  assert.equal(await copyText("a", missing), "copied");
  assert.deepEqual(missing.legacy, ["a"]);

  const refusing = io({ writeText: () => Promise.reject(new Error("denied")) });
  assert.equal(await copyText("b", refusing), "copied");
  assert.deepEqual(refusing.legacy, ["b"]);

  const throwing = io({
    writeText: () => {
      throw new Error("sync failure");
    },
  });
  assert.equal(await copyText("c", throwing), "copied");
});

test("asks for a manual copy when nothing works", async () => {
  assert.equal(await copyText("x", io({ writeText: undefined, legacyCopy: () => false })), "manual");
  assert.equal(
    await copyText(
      "x",
      io({
        writeText: undefined,
        legacyCopy: () => {
          throw new Error("no execCommand");
        },
      }),
    ),
    "manual",
  );
});

test("each state has its own label", () => {
  assert.equal(copyLabel("idle", strings.desk.copy), "Copier le texte");
  assert.equal(copyLabel("copied", strings.desk.copy), "Copié !");
  assert.match(copyLabel("manual", strings.desk.copy), /Ctrl\+C/);
});
