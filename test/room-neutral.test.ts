import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

// MyHQ ships nothing personal: no project, person or asset of a given home.
// The words are built from fragments so that this file does not hold them.
const personal = new RegExp(
  [
    ["po", "go"],
    ["plan", "ygo"],
    ["rom", "ain"],
    ["san", "ges"],
    ["rs-", "prod"],
    ["cer", "vo"],
    ["rom", "2"],
  ]
    .map((parts) => parts.join(""))
    .join("|"),
  "i",
);

const root = path.join(import.meta.dirname, "..");
const textFile = /\.(ts|tsx|mjs|json|jsonl|md|css|txt|svg)$/i;

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const files = [
  ...walk(path.join(root, "public")),
  path.join(root, "test", "fixtures", "stream-json-message.synthetic.jsonl"),
  path.join(root, "scripts", "build-neutral-sprite.mjs"),
  path.join(root, "scripts", "replay-fixture.ts"),
  ...fs
    .readdirSync(path.join(root, "src", "ui"))
    .filter((name) => name.startsWith("room") || name.startsWith("agent-sheet"))
    .map((name) => path.join(root, "src", "ui", name)),
].filter((file) => fs.existsSync(file));

test("the room ships nothing personal: names of files and text of public/, the synthetic fixture, the room code", () => {
  assert.ok(files.some((file) => file.endsWith("neutral.png")), "the neutral sheet is under public/sprites");
  for (const file of files) {
    const relative = path.relative(root, file);
    assert.doesNotMatch(relative, personal, `${relative}: file name`);
    if (textFile.test(file)) assert.doesNotMatch(fs.readFileSync(file, "utf8"), personal, relative);
  }
});

test("the neutral sheet is a 512 by 512 PNG: 4 by 4 cells of 128 px", () => {
  const png = fs.readFileSync(path.join(root, "public", "sprites", "neutral.png"));
  assert.equal(png.toString("latin1", 1, 4), "PNG");
  assert.equal(png.readUInt32BE(16), 512);
  assert.equal(png.readUInt32BE(20), 512);
  assert.ok(png.length < 60_000);
});

test("the synthetic fixture says it is synthetic", () => {
  const first = fs
    .readFileSync(path.join(root, "test", "fixtures", "stream-json-message.synthetic.jsonl"), "utf8")
    .split("\n")[0]!;
  assert.match(first, /SYNTHETIC FIXTURE/);
});
