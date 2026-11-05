// MyHQ write guard: a Claude Code PreToolUse hook (plain JavaScript, no
// dependency, so that it starts fast with `node`).
//
// MyHQ installs it in `<working directory>/.claude/settings.local.json` before
// each agent run and chat turn (see write-guard.ts), and gives it the write
// roots of that run in the MYHQ_WRITE_GUARD environment variable (JSON, see
// GuardConfig below). Claude Code runs it before every Write, Edit, MultiEdit
// and NotebookEdit call, with the call as JSON on stdin. It refuses (exit
// code 2, reason on stderr, which Claude Code shows to the model) any write
// whose resolved path (links resolved, case ignored where the file system
// ignores it) leaves the roots; it says nothing (exit code 0, no output) when
// the write is inside them, so the CLI's own permission flow goes on. Any
// error (no configuration, unreadable input, a link that cannot be resolved)
// is a refusal: the guard fails closed.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Environment variable holding the guard's configuration. */
export const GUARD_ENV = "MYHQ_WRITE_GUARD";

/** The built-in tools that write files, and the field of their input that names the file. */
export const WRITE_TOOLS = { Write: "file_path", Edit: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path" };

/** Files of the working directory no write may touch: they hold the hook itself. */
const PROTECTED = [".claude/settings.json", ".claude/settings.local.json"];

/**
 * @typedef {object} GuardConfig
 * @property {string} workDir Absolute working directory of the run.
 * @property {string[]} allow Patterns relative to workDir a write may match ("**": the whole folder).
 * @property {string[]} deny Patterns relative to workDir no write may match.
 * @property {string[]} writeDirs Absolute folders, outside workDir, writable in full.
 */

/** Whether paths compare without case on this platform. */
export function caseInsensitive(platform = process.platform) {
  return platform === "win32" || platform === "darwin";
}

function key(p, platform) {
  const slashed = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return caseInsensitive(platform) ? slashed.toLowerCase() : slashed;
}

/**
 * The path of `target` relative to `root` with forward slashes ("" for the
 * root itself), or null when it is not inside. Both are absolute, resolved.
 */
export function relativeInside(root, target, platform = process.platform) {
  const r = key(root, platform);
  const t = key(target, platform);
  if (t === r) return "";
  if (!t.startsWith(`${r}/`)) return null;
  return target.replace(/\\/g, "/").slice(root.replace(/\\/g, "/").replace(/\/+$/, "").length + 1);
}

/**
 * Resolves an absolute path the way the file system will: the deepest part
 * that exists goes through realpath (links, junctions and short names
 * resolved, the real case), the rest is appended. Throws on a link that
 * cannot be resolved (a dangling link would send the write to its target).
 */
export function resolveReal(absolute) {
  const missing = [];
  let current = path.resolve(absolute);
  for (;;) {
    let stat = null;
    try {
      stat = fs.lstatSync(current);
    } catch {
      stat = null;
    }
    if (stat) {
      let real;
      try {
        real = fs.realpathSync.native(current);
      } catch (error) {
        throw new Error(`cannot resolve ${current}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return missing.length > 0 ? path.join(real, ...missing.reverse()) : real;
    }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(absolute);
    missing.push(path.basename(current));
    current = parent;
  }
}

/**
 * A permission-rule path pattern as a RegExp on a path relative to the
 * working directory (forward slashes). Anchored at the working directory:
 * `./x` and `/x` are `x`; `**` matches any depth, `*` and `?` stay inside one
 * segment; a pattern without a wildcard also matches what lies under it.
 * Null for a pattern that cannot name a place of the working directory
 * (`//absolute`, `~/home`, a `..` segment, empty).
 */
export function patternRegExp(pattern, platform = process.platform) {
  let p = pattern.trim().replace(/\\/g, "/");
  if (p.startsWith("//") || p.startsWith("~")) return null;
  p = p.replace(/^\.\//, "").replace(/^\/+/, "");
  if (p === "" || p.split("/").includes("..")) return null;
  let source = "";
  for (let i = 0; i < p.length; i += 1) {
    const c = p[i];
    if (c === "*" && p[i + 1] === "*") {
      if (p[i + 2] === "/") {
        source += "(?:.*/)?";
        i += 2;
      } else {
        source += ".*";
        i += 1;
      }
    } else if (c === "*") source += "[^/]*";
    else if (c === "?") source += "[^/]";
    else source += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  if (!/[*?]/.test(p)) source += "(?:/.*)?";
  return new RegExp(`^${source}$`, caseInsensitive(platform) ? "i" : "");
}

function matches(patterns, relative, platform) {
  return patterns.some((pattern) => patternRegExp(pattern, platform)?.test(relative) ?? false);
}

function realRoot(dir) {
  try {
    return resolveReal(dir);
  } catch {
    return path.resolve(dir);
  }
}

/**
 * The decision on one PreToolUse input: `{ allow: true }` (the guard has no
 * objection) or `{ allow: false, reason }`.
 * @param {any} input The hook input (tool_name, tool_input, cwd).
 * @param {GuardConfig} config
 * @param {string} [platform]
 * @returns {{ allow: true } | { allow: false, reason: string }}
 */
export function decide(input, config, platform = process.platform) {
  const tool = input?.tool_name;
  if (typeof tool !== "string" || !Object.hasOwn(WRITE_TOOLS, tool)) return { allow: true };
  const field = WRITE_TOOLS[tool];
  const raw = input.tool_input?.[field];
  if (typeof raw !== "string" || raw.trim() === "") {
    return { allow: false, reason: `MyHQ write guard: ${tool} without a ${field}: refused.` };
  }
  const base = typeof input.cwd === "string" && input.cwd ? input.cwd : config.workDir;
  let target;
  try {
    target = resolveReal(path.resolve(base, raw));
  } catch (error) {
    return { allow: false, reason: `MyHQ write guard: ${tool} to ${raw} refused: ${error.message}.` };
  }
  const workDir = realRoot(config.workDir);
  const relative = relativeInside(workDir, target, platform);
  const scope = config.allow.includes("**") ? workDir : `${workDir} (only under: ${config.allow.join(", ")})`;
  const where = [scope, ...config.writeDirs].join("; ");
  const refuse = (why) => ({
    allow: false,
    reason:
      `MyHQ write guard: ${tool} to ${target} refused: ${why}. You may write only in: ${where}. ` +
      "Other folders you can read (--add-dir) are read-only. Write the file inside your working directory instead.",
  });
  if (relative !== null && PROTECTED.some((file) => key(file, platform) === key(relative, platform))) {
    return refuse("this file holds MyHQ's settings for your runs");
  }
  if (relative === null) {
    if (config.writeDirs.some((dir) => relativeInside(realRoot(dir), target, platform) !== null)) return { allow: true };
    return refuse("it is outside your working directory");
  }
  if (matches(config.deny, relative, platform)) return refuse("your rules deny writing there");
  if (relative !== "" && matches(config.allow, relative, platform)) return { allow: true };
  return refuse("your rules do not allow writing there");
}

/**
 * Reads the configuration from the environment; throws when it is missing or malformed.
 * @param {Record<string, string | undefined>} [env]
 * @returns {GuardConfig}
 */
export function readConfig(env = process.env) {
  const raw = env[GUARD_ENV];
  if (!raw) throw new Error(`${GUARD_ENV} is not set (this folder's writes are guarded by MyHQ, which sets it for its runs)`);
  const config = JSON.parse(raw);
  const strings = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
  if (
    !config ||
    typeof config.workDir !== "string" ||
    !path.isAbsolute(config.workDir) ||
    !strings(config.allow) ||
    !strings(config.deny) ||
    !strings(config.writeDirs)
  ) {
    throw new Error(`${GUARD_ENV} is not a valid guard configuration`);
  }
  return config;
}

async function main() {
  let decision;
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    decision = decide(JSON.parse(Buffer.concat(chunks).toString("utf8")), readConfig());
  } catch (error) {
    decision = { allow: false, reason: `MyHQ write guard: write refused: ${error instanceof Error ? error.message : String(error)}.` };
  }
  if (!decision.allow) {
    process.stderr.write(`${decision.reason}\n`);
    process.exitCode = 2;
  }
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && key(path.resolve(process.argv[1]), process.platform) === key(self, process.platform)) void main();
