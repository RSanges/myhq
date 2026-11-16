import path from "node:path";
import { readHomeSettings } from "./home-settings";
import { READ_GUARD_ENV } from "./read-guard-lib.mjs";
import { installReadGuard, readGuardScript, removeReadGuard } from "./write-guard";

/**
 * The read guard (docs/architecture.md, "The read guard"). Claude Code
 * approves a bare `Read`, `Glob` or `Grep` on any absolute path: not giving a
 * folder as `--add-dir` does not keep it from being read. So MyHQ holds the
 * reads itself, the way it holds the writes: a PreToolUse hook
 * (read-guard-hook.mjs) in the cwd's `.claude/settings.local.json`, its
 * configuration in MYHQ_READ_GUARD, every path through `realpath`, any error
 * a refusal. Two uses: the door's call reads only its folders (`only`), and
 * when the home has `privateDirs`, an agent's run or question reads none of
 * them (`deny`) but its own notebook and addDirs inside them (`except`).
 */

/** The hook's configuration (the ReadGuardConfig of read-guard-lib.mjs). */
export type ReadGuardConfig = {
  workDir: string;
  only: string[] | null;
  deny: string[];
  except: string[];
};

/** The environment addition that hands the configuration to the hook. */
export function readGuardEnv(config: ReadGuardConfig): Record<string, string> {
  return { [READ_GUARD_ENV]: JSON.stringify(config) };
}

/** The `privateDirs` of myhq.json, absolute; none when the file or the key is absent. Throws when myhq.json is invalid (fail closed). */
export function readPrivateDirs(home: string): string[] {
  return (readHomeSettings(home)?.privateDirs ?? []).map((dir) => path.resolve(home, dir));
}

/**
 * The read guard of an agent's run or question in `workDir`: with
 * `privateDirs`, the hook installed and its configuration returned (the
 * private folders denied, `readDirs` granted where they lie inside one: the
 * agent's notebook and its addDirs); without, nothing installed, a guard
 * left by an earlier configuration taken out, and no environment, so the
 * call is exactly what it was. Throws when myhq.json is invalid.
 */
export function agentReadGuard(p: {
  home: string;
  repoRoot: string;
  workDir: string;
  readDirs: readonly string[];
  ignoreInGit: boolean;
}): Record<string, string> {
  const deny = readPrivateDirs(p.home);
  if (deny.length === 0) {
    removeReadGuard(p.workDir);
    return {};
  }
  installReadGuard(p.workDir, { script: readGuardScript(p.repoRoot), ignoreInGit: p.ignoreInGit });
  return readGuardEnv({ workDir: path.resolve(p.workDir), only: null, deny, except: [...new Set(p.readDirs.map((dir) => path.resolve(dir)))] });
}
