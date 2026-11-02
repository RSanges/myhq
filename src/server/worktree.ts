import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

function gitError(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr?.trim();
  return stderr || (error instanceof Error ? error.message : String(error));
}

/** The branch of an agent's worktree. */
export const worktreeBranch = (agentId: string): string => `hq/${agentId}`;

/**
 * Makes sure `dir` is a Git worktree of `repo`, on branch `branch`: does
 * nothing when it already is one, creates it with `git worktree add`
 * otherwise (the branch is created from the repository's current HEAD when it
 * does not exist yet). Throws an explicit Error when `dir` holds something
 * else or when Git fails. Returns whether it created the worktree.
 */
export function ensureWorktree(params: { repo: string; dir: string; branch: string }): boolean {
  const { repo, dir, branch } = params;
  if (fs.existsSync(path.join(dir, ".git"))) return false;
  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
    throw new Error(`${dir} exists, is not empty and is not a Git worktree`);
  }
  try {
    git(["rev-parse", "--git-dir"], repo);
  } catch (error) {
    throw new Error(`${repo} is not a Git repository: ${gitError(error)}`);
  }
  let branchExists = true;
  try {
    git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo);
  } catch {
    branchExists = false;
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  try {
    git(
      branchExists ? ["worktree", "add", dir, branch] : ["worktree", "add", "-b", branch, dir],
      repo,
    );
  } catch (error) {
    throw new Error(`git worktree add ${dir} failed: ${gitError(error)}`);
  }
  return true;
}
