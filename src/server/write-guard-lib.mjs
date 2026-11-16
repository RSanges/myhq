// MyHQ write guard: the decisions of the hook (write-guard-hook.mjs), plain
// JavaScript without dependency. Only pure functions and constants live here,
// never an entry point: the hook imports them, and so do the modules that match
// paths the way the guard does (rooms.ts, live-room.ts). Importing this file
// never runs anything.

import fs from "node:fs";
import path from "node:path";

/** Environment variable holding the guard's configuration. */
export const GUARD_ENV = "MYHQ_WRITE_GUARD";

/** The built-in tools that write files, and the field of their input that names the file. */
export const WRITE_TOOLS = { Write: "file_path", Edit: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path" };

/** Files of the working directory no write may touch: they hold the hook itself. */
const PROTECTED = [".claude/settings.json", ".claude/settings.local.json"];

/** The write tools a notebook takes, and the largest note they may leave (bytes, UTF-8). */
export const NOTEBOOK_WRITE_TOOLS = ["Write", "Edit"];
export const NOTEBOOK_FILE_MAX = 200_000;

/**
 * Why a write to `relative` (inside a notebook, forward slashes) is refused,
 * or null: a notebook holds Markdown notes the owner reads, nothing hidden.
 * So no segment starting with a dot, none with a colon (a Windows stream) or
 * ending in a dot or a space, a `.md` file, at most NOTEBOOK_FILE_MAX bytes
 * once written (Write: its content; Edit: the file with the replacement).
 */
export function notebookRefusal(tool, input, target, relative) {
  if (!NOTEBOOK_WRITE_TOOLS.includes(tool)) return `a notebook takes ${NOTEBOOK_WRITE_TOOLS.join(" and ")} only`;
  const segments = relative.split("/");
  if (relative === "" || segments.some((segment) => segment.startsWith(".") || segment.includes(":") || /[. ]$/.test(segment))) {
    return "a notebook holds no hidden file or folder (no name starting with a dot, no colon, no name ending in a dot or a space)";
  }
  if (!/\.md$/i.test(segments[segments.length - 1])) return "a notebook holds Markdown notes only (.md files)";
  let size;
  if (tool === "Write") {
    size = Buffer.byteLength(typeof input.content === "string" ? input.content : "", "utf8");
  } else {
    let current;
    try {
      current = fs.readFileSync(target, "utf8");
    } catch {
      // No file to edit: the CLI refuses the edit itself.
      return null;
    }
    const before = typeof input.old_string === "string" ? input.old_string : "";
    const after = typeof input.new_string === "string" ? input.new_string : "";
    const edited = before === "" ? current : input.replace_all === true ? current.split(before).join(after) : current.replace(before, () => after);
    size = Buffer.byteLength(edited, "utf8");
  }
  if (size > NOTEBOOK_FILE_MAX) return `a note of a notebook is ${NOTEBOOK_FILE_MAX} bytes at most (this one would be ${size}): keep notes short, one topic each`;
  return null;
}

/**
 * @typedef {object} GuardConfig
 * @property {string} workDir Absolute working directory of the run.
 * @property {string[]} allow Patterns relative to workDir a write may match ("**": the whole folder).
 * @property {string[]} deny Patterns relative to workDir no write may match.
 * @property {string[]} writeDirs Absolute folders, outside workDir, writable in full.
 * @property {string[]} [notebooks] Absolute notebooks, outside workDir, writable under notebookRefusal's rules.
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
  const notebooks = config.notebooks ?? [];
  const where = [scope, ...config.writeDirs, ...notebooks.map((dir) => `${dir} (Markdown notes)`)].join("; ");
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
    for (const dir of notebooks) {
      const inNotebook = relativeInside(realRoot(dir), target, platform);
      if (inNotebook === null) continue;
      const why = notebookRefusal(tool, input.tool_input, target, inNotebook);
      return why ? refuse(why) : { allow: true };
    }
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
    !strings(config.writeDirs) ||
    !(config.notebooks === undefined || strings(config.notebooks))
  ) {
    throw new Error(`${GUARD_ENV} is not a valid guard configuration`);
  }
  return config;
}
