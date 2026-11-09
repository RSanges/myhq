import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { mcpBundleDir } from "../mcp/bundle";
import { HqError } from "./errors";

/**
 * The write guard of agent runs and chat turns.
 *
 * Path rules such as `Write(**)` or `Write(models/**)` cannot be trusted to
 * the CLI: in print mode, some versions refuse every write they should allow,
 * while a bare `Write` or `--permission-mode acceptEdits` lets a write land
 * outside the working directory, `--add-dir` folders included (which MyHQ
 * gives for reading). So MyHQ gives the CLI bare tool names (cliToolRules)
 * and enforces the paths itself: a PreToolUse hook (write-guard-hook.mjs,
 * plain JavaScript started with `node`) installed in the working directory's
 * `.claude/settings.local.json` (loaded by `--setting-sources project,local`)
 * refuses any Write, Edit, MultiEdit or NotebookEdit whose resolved path
 * leaves the write roots of the run, given to it in MYHQ_WRITE_GUARD. An
 * agent whose rules allow no write gets no hook (the CLI refuses its writes);
 * a chat turn always gets one.
 */

/** Environment variable of the run holding the guard's configuration (read by the hook). */
export const WRITE_GUARD_ENV = "MYHQ_WRITE_GUARD";

/** Built-in tools that write files: their path rules are enforced by the guard. */
export const WRITE_TOOL_NAMES = ["Write", "Edit", "MultiEdit", "NotebookEdit"] as const;

/** File name of the hook script, which also identifies MyHQ's entry in a settings file. */
export const WRITE_GUARD_HOOK = "write-guard-hook.mjs";

const GITIGNORE_MARKER = "# Written by MyHQ: its per-run settings stay out of Git.";

/** The hook's configuration (the GuardConfig of write-guard-hook.mjs). */
export type WriteGuardConfig = {
  /** Absolute working directory. */
  workDir: string;
  /** Patterns relative to workDir that a write may match (`**`: the whole folder). */
  allow: string[];
  /** Patterns relative to workDir that no write may match. */
  deny: string[];
  /** Absolute folders outside workDir that are writable in full (the chat's `writeDirs`). */
  writeDirs: string[];
};

function splitRule(rule: string): { name: string; pattern: string | null } {
  const match = /^([^()]+)\(([\s\S]*)\)$/.exec(rule.trim());
  return match ? { name: match[1].trim(), pattern: match[2].trim() } : { name: rule.trim(), pattern: null };
}

const isWriteTool = (name: string): boolean => (WRITE_TOOL_NAMES as readonly string[]).includes(name);

/**
 * The guard's configuration for a run: what `allowedTools` lets the agent
 * write in its working directory (a bare write tool, `Write(**)`, `Write(./**)`
 * or `Write(/**)`: the whole folder; `Write(models/**)`: only there; the rules
 * of every write tool add up), what `disallowedTools` path rules forbid there,
 * and the folders outside it that are writable in full (`writeDirs`). The
 * `--add-dir` folders are never among them: they are read-only.
 */
export function writeGuardConfig(params: {
  workDir: string;
  allowedTools: readonly string[];
  disallowedTools?: readonly string[];
  writeDirs?: readonly string[];
}): WriteGuardConfig {
  const patterns = (rules: readonly string[], bare: string | null) => {
    const out: string[] = [];
    for (const rule of rules) {
      const { name, pattern } = splitRule(rule);
      if (!isWriteTool(name)) continue;
      const value = pattern === null || pattern === "" ? bare : pattern;
      if (value !== null && !out.includes(value)) out.push(value);
    }
    return out;
  };
  return {
    workDir: path.resolve(params.workDir),
    allow: patterns(params.allowedTools, "**"),
    // A bare write tool in disallowedTools removes the tool itself: the CLI handles it.
    deny: patterns(params.disallowedTools ?? [], null),
    writeDirs: (params.writeDirs ?? []).map((dir) => path.resolve(dir)),
  };
}

/**
 * The tool rules given to the CLI: a write tool rule with a path becomes the
 * bare tool name (`Write(models/**)` gives `Write`), the guard enforcing the
 * path. Every other rule is kept as written (`Bash(git *)`, `mcp__hq__*`).
 */
export function cliToolRules(rules: readonly string[]): string[] {
  const out = rules.map((rule) => {
    const { name, pattern } = splitRule(rule);
    return pattern !== null && isWriteTool(name) ? name : rule;
  });
  return [...new Set(out)];
}

/** The environment addition that hands the configuration to the hook. */
export function writeGuardEnv(config: WriteGuardConfig): Record<string, string> {
  return { [WRITE_GUARD_ENV]: JSON.stringify(config) };
}

/**
 * The hook script a run uses: the frozen copy made by `npm run build`
 * (build/mcp, beside the HQ MCP server, so that an agent editing this
 * repository never changes the guard of the runs in service), or the source
 * without one (development, tests).
 */
export function writeGuardScript(repoRoot: string): string {
  const frozen = path.join(mcpBundleDir(repoRoot), WRITE_GUARD_HOOK);
  return fs.existsSync(frozen) ? frozen : path.join(repoRoot, "src", "server", WRITE_GUARD_HOOK);
}

type HookGroup = { matcher?: unknown; hooks?: unknown };

function isGuardGroup(group: unknown): boolean {
  const hooks = (group as HookGroup | null)?.hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some((hook) => {
    const h = hook as { command?: unknown; args?: unknown } | null;
    const parts = [h?.command, ...(Array.isArray(h?.args) ? h.args : [])];
    return parts.some((part) => typeof part === "string" && part.replace(/\\/g, "/").endsWith(`/${WRITE_GUARD_HOOK}`));
  });
}

function writeIfChanged(file: string, content: string): void {
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === content) return;
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, content);
  try {
    // A CLI starting at that moment reads the old file or the new one, never half of one.
    fs.renameSync(temp, file);
  } catch {
    fs.rmSync(temp, { force: true });
    fs.writeFileSync(file, content);
  }
}

/**
 * Keeps `.claude/settings.local.json` out of Git in a worktree: a
 * `.claude/.gitignore` of MyHQ's that ignores that file and itself (no Git
 * command, nothing shared with the other worktrees, like the skills' copies).
 * When the repository has its own `.claude/.gitignore`, it is left alone, and
 * Git must already ignore the file: otherwise an explicit error, rather than
 * a settings file an agent could commit.
 */
function keepOutOfGit(workDir: string): void {
  const file = path.join(workDir, ".claude", ".gitignore");
  const ours = `${GITIGNORE_MARKER}\nsettings.local.json\n.gitignore\n`;
  if (!fs.existsSync(file) || fs.readFileSync(file, "utf8").startsWith(GITIGNORE_MARKER)) {
    writeIfChanged(file, ours);
    return;
  }
  try {
    execFileSync("git", ["check-ignore", "-q", path.join(".claude", "settings.local.json")], {
      cwd: workDir,
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {
    throw new HqError(
      "WRITE_GUARD_GIT",
      409,
      `Cannot install the write guard in ${workDir}: .claude/.gitignore is the repository's own and Git does not ignore .claude/settings.local.json. Add it to that .gitignore.`,
    );
  }
}

/**
 * Installs the guard's PreToolUse hook in `<workDir>/.claude/settings.local.json`:
 * MyHQ's entry is put first (a previous one replaced), every other setting
 * and hook of the file is kept. The hook runs `node <script>` without a shell
 * (exec form), and blocks the write if it fails to run (`onFailure`). The
 * CLI's own `permissions.blockWritesOutsideWorkingDirectories` (Claude Code
 * 2.1.314+, ignored by older versions) is turned on as a second layer: it
 * refuses writes outside the working directories even if the hook does not
 * run, though it lets `--add-dir` folders through, which only the hook
 * refuses. Throws
 * an explicit error when the file exists and is not a JSON object. With
 * `ignoreInGit` (a worktree, a folder of a versioned home) the file is kept
 * out of Git (keepOutOfGit).
 */
export function installWriteGuard(
  workDir: string,
  opts: { script: string; node?: string; ignoreInGit?: boolean },
): void {
  const dir = path.join(workDir, ".claude");
  const file = path.join(dir, "settings.local.json");
  fs.mkdirSync(dir, { recursive: true });
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      throw new HqError("WRITE_GUARD_SETTINGS", 409, `Cannot install the write guard: ${file} is not valid JSON (${(error as Error).message}).`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HqError("WRITE_GUARD_SETTINGS", 409, `Cannot install the write guard: ${file} is not a JSON object.`);
    }
    settings = parsed as Record<string, unknown>;
  }
  const hooks =
    settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks)
      ? (settings.hooks as Record<string, unknown>)
      : {};
  const previous = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  const entry = {
    matcher: WRITE_TOOL_NAMES.join("|"),
    hooks: [
      {
        type: "command",
        command: (opts.node ?? process.execPath).replace(/\\/g, "/"),
        args: [opts.script.replace(/\\/g, "/")],
        timeout: 30,
        onFailure: "block",
      },
    ],
  };
  const permissions =
    settings.permissions && typeof settings.permissions === "object" && !Array.isArray(settings.permissions)
      ? (settings.permissions as Record<string, unknown>)
      : {};
  const next = {
    ...settings,
    permissions: { ...permissions, blockWritesOutsideWorkingDirectories: true },
    hooks: { ...hooks, PreToolUse: [entry, ...previous.filter((group) => !isGuardGroup(group))] },
  };
  // Out of Git first: a refusal must leave no settings file behind for an agent to commit.
  if (opts.ignoreInGit) keepOutOfGit(workDir);
  writeIfChanged(file, `${JSON.stringify(next, null, 2)}\n`);
}
