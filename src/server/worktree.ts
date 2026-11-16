import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let emptyHooks: string | null = null;

/**
 * `args` with what every Git call of MyHQ on a worktree carries: no program of
 * the repository's configuration that MyHQ can turn off. No hooks (an empty
 * hooks folder of MyHQ's: a hooks path the repository sets, `.husky` say, is a
 * tracked folder that agents write), no fsmonitor. Filters and merge drivers
 * the repository declares still run.
 */
export function safeGitArgs(args: readonly string[]): string[] {
  emptyHooks ??= fs.mkdtempSync(path.join(os.tmpdir(), "myhq-no-hooks-"));
  return ["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${emptyHooks}`, ...args];
}

function git(args: string[], cwd?: string): string {
  return execFileSync("git", safeGitArgs(args), {
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
 * Forgets the worktrees of `repo` whose folder is gone (`git worktree prune`):
 * a bench removed by hand, or half removed, would otherwise refuse to be made
 * again ("missing but already registered worktree"). Removes no file.
 */
export function pruneWorktrees(repo: string): void {
  try {
    git(["worktree", "prune"], repo);
  } catch (error) {
    throw new Error(`git worktree prune in ${repo} failed: ${gitError(error)}`);
  }
}

/**
 * Makes sure `dir` is a Git worktree of `repo`, on branch `branch`: does
 * nothing when it already is one, creates it with `git worktree add`
 * otherwise (the branch is created from `base` when it does not exist yet,
 * the repository's current HEAD without one). Throws an explicit Error when
 * `dir` holds something else or when Git fails. Returns whether it created
 * the worktree. Its Git calls run no hook of the repository (safeGitArgs).
 */
export function ensureWorktree(params: { repo: string; dir: string; branch: string; base?: string }): boolean {
  const { repo, dir, branch, base } = params;
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
      branchExists
        ? ["worktree", "add", dir, branch]
        : ["worktree", "add", "-b", branch, dir, ...(base ? [`refs/heads/${base}`] : [])],
      repo,
    );
  } catch (error) {
    throw new Error(`git worktree add ${dir} failed: ${gitError(error)}`);
  }
  return true;
}
