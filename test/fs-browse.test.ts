import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { HqError } from "../src/server/errors";
import { listDirs } from "../src/server/fs-browse";
import { makeHome } from "./helpers";

const mkdir = (...parts: string[]) => fs.mkdirSync(path.join(...parts), { recursive: true });
const touch = (...parts: string[]) => {
  mkdir(path.dirname(path.join(...parts)));
  fs.writeFileSync(path.join(...parts), "x\n");
};

/** A projects root with a few demo folders, and a home that points at it with `projectsRoot`. */
function setup() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "myhq-browse-")));
  const root = path.join(base, "projects");
  mkdir(root, "alpha", "src");
  mkdir(root, "alpha", ".git");
  mkdir(root, "alpha", "node_modules", "dep");
  mkdir(root, "alpha", ".next");
  mkdir(root, "alpha", "data");
  mkdir(root, "alpha", "build");
  touch(root, "alpha", "notes.txt");
  touch(root, "node-app", "package.json");
  touch(root, "py-app", "pyproject.toml");
  touch(root, "docs-only", "Readme.md");
  mkdir(root, "plain", "inner");
  mkdir(root, ".hidden");
  mkdir(root, "node_modules");
  touch(root, "a-file.txt");
  mkdir(base, "outside", "secret");
  const config = makeHome();
  fs.writeFileSync(path.join(config.home, "myhq.json"), JSON.stringify({ projectsRoot: root }));
  return { base, root, config };
}

/** The error code a call throws, undefined when it does not throw. */
const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof HqError, String(error));
    return error.code;
  }
  return undefined;
};

test("the root lists only folders, without the hidden and the heavy ones", () => {
  const { config } = setup();
  const listing = listDirs(config, { path: "" });
  assert.deepEqual(
    listing.dirs.map((d) => d.name),
    ["alpha", "docs-only", "node-app", "plain", "py-app"],
  );
  assert.equal(listing.path, "");
  assert.equal(listing.parent, null);
  assert.equal(listing.rootName, "projects");
  const inAlpha = listDirs(config, { path: "alpha" });
  assert.deepEqual(
    inAlpha.dirs.map((d) => d.path),
    ["alpha/src"],
  );
  assert.equal(inAlpha.parent, "");
  assert.equal(listDirs(config, { path: "alpha/src/" }).path, "alpha/src");
});

test("a folder looks like a project with a .git, a package.json, a pyproject.toml or a README", () => {
  const { config } = setup();
  const byName = Object.fromEntries(listDirs(config, { path: "" }).dirs.map((d) => [d.name, d.project]));
  assert.deepEqual(byName, { alpha: true, "docs-only": true, "node-app": true, plain: false, "py-app": true });
  assert.equal(listDirs(config, { path: "alpha" }).project, true);
  assert.equal(listDirs(config, { path: "plain" }).project, false);
});

test("a folder that is the target of a room says which room", () => {
  const { root, config } = setup();
  const target = path.relative(config.home, path.join(root, "node-app")).split(path.sep).join("/");
  const roomFile = path.join(config.home, "rooms", "demo", "room.json");
  const room = JSON.parse(fs.readFileSync(roomFile, "utf8")) as { targetRepo: string };
  fs.writeFileSync(roomFile, JSON.stringify({ ...room, targetRepo: target }));
  const listing = listDirs(config, { path: "" });
  assert.deepEqual(
    listing.dirs.map((d) => [d.name, d.room]),
    [
      ["alpha", null],
      ["docs-only", null],
      ["node-app", "demo"],
      ["plain", null],
      ["py-app", null],
    ],
  );
  assert.equal(listDirs(config, { path: "node-app" }).room, "demo");
});

test("a path that leaves the root is refused: .., absolute, drive, backslash, stream", () => {
  const { base, config } = setup();
  for (const bad of [
    "..",
    "../outside",
    "alpha/../../outside",
    "alpha/..",
    "/",
    "/etc",
    path.join(base, "outside").split(path.sep).join("/"),
    "C:/Windows",
    "C:",
    "alpha\\..\\..",
    "alpha\\src",
    "alpha:stream",
    "alpha/\u0000",
  ]) {
    assert.equal(
      code(() => listDirs(config, { path: bad })),
      "PATH_OUTSIDE_ROOT",
      JSON.stringify(bad),
    );
  }
});

test("a link that leaves the root is neither listed nor followed; a link inside the root is", () => {
  const { base, root, config } = setup();
  fs.symlinkSync(path.join(base, "outside"), path.join(root, "escape"), "junction");
  fs.symlinkSync(path.join(root, "plain"), path.join(root, "shortcut"), "junction");
  const names = listDirs(config, { path: "" }).dirs.map((d) => d.name);
  assert.ok(!names.includes("escape"));
  assert.ok(names.includes("shortcut"));
  assert.equal(
    code(() => listDirs(config, { path: "escape" })),
    "PATH_OUTSIDE_ROOT",
  );
  assert.equal(
    code(() => listDirs(config, { path: "escape/secret" })),
    "PATH_OUTSIDE_ROOT",
  );
  assert.deepEqual(
    listDirs(config, { path: "shortcut" }).dirs.map((d) => d.name),
    ["inner"],
  );
});

test("hidden and heavy folders cannot be asked for, nor a file or a missing folder", () => {
  const { config } = setup();
  for (const bad of [
    ".hidden",
    "node_modules",
    "alpha/.git",
    "alpha/node_modules/dep",
    "alpha/.next",
    "alpha/data",
    "alpha/build",
    "a-file.txt",
    "nope",
    "alpha/nope",
  ]) {
    assert.equal(
      code(() => listDirs(config, { path: bad })),
      "DIR_NOT_FOUND",
      bad,
    );
  }
});

test("without projectsRoot, the root is the parent folder of the home", () => {
  const { base, config } = setup();
  const home = path.join(base, "home");
  mkdir(home);
  const listing = listDirs({ ...config, home }, { path: "" });
  assert.equal(listing.rootName, path.basename(base));
  assert.deepEqual(
    listing.dirs.map((d) => d.name),
    ["home", "outside", "projects"],
  );
  // A relative projectsRoot is relative to the home.
  fs.writeFileSync(path.join(home, "myhq.json"), JSON.stringify({ projectsRoot: "../projects" }));
  assert.equal(listDirs({ ...config, home }, { path: "" }).rootName, "projects");
});

test("an invalid projectsRoot falls back to the parent of the home, and a missing root is an error", () => {
  const { base, config } = setup();
  const home = path.join(base, "home");
  mkdir(home);
  fs.writeFileSync(path.join(home, "myhq.json"), JSON.stringify({ projectsRoot: 42 }));
  assert.equal(listDirs({ ...config, home }, { path: "" }).rootName, path.basename(base));
  fs.writeFileSync(path.join(home, "myhq.json"), "{ not json");
  assert.equal(listDirs({ ...config, home }, { path: "" }).rootName, path.basename(base));
  fs.writeFileSync(path.join(home, "myhq.json"), JSON.stringify({ projectsRoot: "does-not-exist" }));
  assert.equal(
    code(() => listDirs({ ...config, home }, { path: "" })),
    "ROOT_NOT_FOUND",
  );
});

test("target is the path POST /api/onboarding expects: relative to the home, and it resolves to the folder", () => {
  const { root, config } = setup();
  for (const sub of ["", "node-app", "alpha/src"]) {
    const listing = listDirs(config, { path: sub });
    assert.ok(!listing.target.includes("\\"));
    assert.equal(path.resolve(config.home, listing.target), path.join(root, ...sub.split("/").filter(Boolean)));
  }
  assert.equal(
    listDirs(config, { path: "node-app" }).target,
    path.relative(config.home, path.join(root, "node-app")).split(path.sep).join("/"),
  );
});
