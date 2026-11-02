import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ensureWorktree } from "../src/server/worktree";

/** A temporary Git repository with one commit. */
export function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "README.md"), "# Test project\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return repo;
}

test("creates a worktree on its branch once, then leaves it alone", () => {
  const repo = makeRepo();
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "myhq-wt-")), "data", "worktrees", "dev");
  assert.equal(ensureWorktree({ repo, dir, branch: "hq/dev" }), true);
  assert.ok(fs.existsSync(path.join(dir, "README.md")));
  const branch = execFileSync("git", ["branch", "--show-current"], { cwd: dir, encoding: "utf8" }).trim();
  assert.equal(branch, "hq/dev");
  assert.equal(ensureWorktree({ repo, dir, branch: "hq/dev" }), false);
});

test("reuses an existing branch and refuses a folder that holds something else", () => {
  const repo = makeRepo();
  execFileSync("git", ["branch", "hq/dev"], { cwd: repo });
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-wt-"));
  assert.equal(ensureWorktree({ repo, dir: path.join(base, "dev"), branch: "hq/dev" }), true);
  const busy = path.join(base, "busy");
  fs.mkdirSync(busy);
  fs.writeFileSync(path.join(busy, "file.txt"), "x");
  assert.throws(() => ensureWorktree({ repo, dir: busy, branch: "hq/other" }), /not empty/);
  assert.throws(() => ensureWorktree({ repo: base, dir: path.join(base, "x"), branch: "hq/x" }), /not a Git repository/);
});
