// MyHQ read guard: the decisions of its hook (read-guard-hook.mjs), plain
// JavaScript without dependency but the write guard's library, which sits
// beside it (the frozen build copies the four files). Only pure functions and
// constants live here, never an entry point. Importing this file never runs
// anything.

import path from "node:path";
import { relativeInside, resolveReal } from "./write-guard-lib.mjs";

/** Environment variable holding the guard's configuration. */
export const READ_GUARD_ENV = "MYHQ_READ_GUARD";

/** The built-in tools that read files, and the field of their input that names the place (Glob and Grep search the cwd without it). */
export const READ_TOOLS = { Read: "file_path", Glob: "path", Grep: "path" };

/**
 * @typedef {object} ReadGuardConfig
 * @property {string} workDir Absolute working directory of the call: a relative path, and a search without `path`, are there.
 * @property {string[] | null} only When set, the only folders a read may reach (the door's call).
 * @property {string[]} deny Folders no read may reach, nor a search hold (the home's `privateDirs`).
 * @property {string[]} except Folders that stay readable when they lie inside a denied one (an agent's notebook and its addDirs).
 */

function realRoot(dir) {
  try {
    return resolveReal(dir);
  } catch {
    return path.resolve(dir);
  }
}

/**
 * Whether a resolved Windows path is a plain local one: a drive, no stream
 * (`file:stream`), no segment ending in a dot or a space (which Windows
 * drops when it opens the path), no UNC or device form (`\\host\C$\...`
 * reaches the same files under another name).
 */
function plainWindowsPath(p) {
  if (!/^[A-Za-z]:\\/.test(p) || p.slice(2).includes(":")) return false;
  return !p.slice(3).split("\\").some((segment) => /[. ]$/.test(segment));
}

/** Whether a Glob pattern could name a place outside its `path`: absolute, from the home folder, or with a `..` segment. */
function patternLeaves(pattern) {
  const p = pattern.trim();
  if (p.startsWith("~") || path.posix.isAbsolute(p) || path.win32.isAbsolute(p) || /^[A-Za-z]:/.test(p)) return true;
  return /(^|[\\/{,])\.\.($|[\\/},])/.test(p);
}

/**
 * The decision on one PreToolUse input: `{ allow: true }` (the guard has no
 * objection) or `{ allow: false, reason }`. Read is judged on its file, Glob
 * and Grep on the folder they search (the cwd without `path`); a search is
 * refused too when the folder holds a denied one.
 * @param {any} input The hook input (tool_name, tool_input, cwd).
 * @param {ReadGuardConfig} config
 * @param {string} [platform]
 * @returns {{ allow: true } | { allow: false, reason: string }}
 */
export function decideRead(input, config, platform = process.platform) {
  const tool = input?.tool_name;
  if (typeof tool !== "string" || !Object.hasOwn(READ_TOOLS, tool)) return { allow: true };
  const field = READ_TOOLS[tool];
  const search = tool !== "Read";
  const raw = input.tool_input?.[field];
  const where = config.only ? ` You may read only in: ${config.only.join("; ")}.` : "";
  const refuse = (what, why) => ({ allow: false, reason: `MyHQ read guard: ${tool} of ${what} refused: ${why}.${where}` });
  if (search ? raw !== undefined && raw !== null && typeof raw !== "string" : typeof raw !== "string" || raw.trim() === "") {
    return refuse(`no valid ${field}`, `${tool} needs a ${field} that is a path`);
  }
  if (tool === "Glob") {
    const pattern = input.tool_input?.pattern;
    if (typeof pattern !== "string" || patternLeaves(pattern)) {
      return refuse(`the pattern ${JSON.stringify(pattern)}`, "a pattern stays below the folder searched (no absolute path, no ~, no ..): give the folder as path");
    }
  }
  if (platform === "win32" && typeof raw === "string" && /^[A-Za-z]:(?![\\/])/.test(raw.trim())) {
    // `D:notes.md` is relative to the current folder of drive D, which this process may not share with the CLI.
    return refuse(raw, "a drive-relative path is ambiguous: give an absolute path");
  }
  const base = typeof input.cwd === "string" && input.cwd ? input.cwd : config.workDir;
  let target;
  try {
    target = resolveReal(path.resolve(base, typeof raw === "string" && raw.trim() !== "" ? raw : "."));
  } catch (error) {
    return refuse(String(raw), error.message);
  }
  if (platform === "win32" && !plainWindowsPath(target)) return refuse(target, "it is not a plain local path");
  if (config.only && !config.only.some((root) => relativeInside(realRoot(root), target, platform) !== null)) {
    return refuse(target, "it is outside the folders you may read");
  }
  for (const dir of config.deny) {
    const closed = realRoot(dir);
    if (relativeInside(closed, target, platform) !== null) {
      const open = config.except.some((each) => {
        const granted = realRoot(each);
        return relativeInside(closed, granted, platform) !== null && relativeInside(granted, target, platform) !== null;
      });
      if (!open) return refuse(target, "it is in a private folder of the owner; for a fact you need from there, ask the assistant (hq_ask_assistant)");
    } else if (search && relativeInside(target, closed, platform) !== null) {
      return refuse(target, "the search would reach a private folder of the owner; search a folder that does not hold it");
    }
  }
  return { allow: true };
}

/**
 * Reads the configuration from the environment; throws when it is missing or malformed.
 * @param {Record<string, string | undefined>} [env]
 * @returns {ReadGuardConfig}
 */
export function readReadConfig(env = process.env) {
  const raw = env[READ_GUARD_ENV];
  if (!raw) throw new Error(`${READ_GUARD_ENV} is not set (this folder's reads are guarded by MyHQ, which sets it for its calls)`);
  const config = JSON.parse(raw);
  const paths = (value) => Array.isArray(value) && value.every((item) => typeof item === "string" && path.isAbsolute(item));
  if (
    !config ||
    typeof config.workDir !== "string" ||
    !path.isAbsolute(config.workDir) ||
    !(config.only === null || paths(config.only)) ||
    !paths(config.deny) ||
    !paths(config.except)
  ) {
    throw new Error(`${READ_GUARD_ENV} is not a valid read guard configuration`);
  }
  return config;
}
