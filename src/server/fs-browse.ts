import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { HqConfig } from "./config";
import { isInside } from "./config";
import { HqError } from "./errors";
import { readProjectsRoot } from "./home-settings";
import { loadHome, toPosix } from "./rooms";

/**
 * The folder browser behind « Parcourir » of the room form
 * (`GET /api/fs/dirs`). A browser never gives the absolute path of a folder
 * chosen in the system dialog, so MyHQ lists folders itself, read-only, and
 * only inside one root (`projectsRoot` of myhq.json, else the parent folder
 * of the home). Paths on the wire are relative to that root, with "/".
 */

/** Folders never listed (and refused when asked for by name), besides the hidden ones. */
export const HIDDEN_DIR_NAMES: ReadonlySet<string> = new Set(["node_modules", "data", "build"]);

/** The query of `GET /api/fs/dirs`: a path relative to the root, empty for the root itself. */
export const dirsQuerySchema = z.strictObject({
  path: z.string().max(1_000).default(""),
});

export type DirEntry = {
  name: string;
  /** Relative to the root, "/" separated: what to ask for next. */
  path: string;
  /** Looks like a project: a `.git`, a `package.json`, a `pyproject.toml` or a README. */
  project: boolean;
  /** The room whose target repository this folder is, null when none. */
  room: string | null;
};

export type DirListing = {
  /** Name of the root folder (its last segment), for the first crumb. */
  rootName: string;
  /** The folder listed, relative to the root: "" for the root. */
  path: string;
  /** The folder above, relative to the root, null at the root. */
  parent: string | null;
  /** What `POST /api/onboarding` expects for this folder (relative to the home, else absolute). */
  target: string;
  project: boolean;
  room: string | null;
  dirs: DirEntry[];
};

const isHidden = (name: string) => name.startsWith(".") || HIDDEN_DIR_NAMES.has(name);

const outside = (what: string) => new HqError("PATH_OUTSIDE_ROOT", 400, `${what} is not inside the projects root.`);

/** The segments of a relative path, or PATH_OUTSIDE_ROOT for anything that is absolute or climbs. */
function segmentsOf(raw: string): string[] {
  if (raw.includes("\0") || raw.includes("\\") || raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
    throw outside(`The path "${raw}"`);
  }
  const segments = raw.split("/").filter((s) => s !== "" && s !== ".");
  for (const segment of segments) {
    if (segment === ".." || segment.includes(":")) throw outside(`The path "${raw}"`);
  }
  return segments;
}

const keyOf = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);

const real = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

/** Whether the folder holds a sign of a project. Unreadable folders are not projects. */
function looksLikeProject(dir: string): boolean {
  try {
    return fs
      .readdirSync(dir)
      .some(
        (name) =>
          name === ".git" || name === "package.json" || name === "pyproject.toml" || /^readme(\.[a-z0-9]+)?$/i.test(name),
      );
  } catch {
    return false;
  }
}

/** The target repositories of the rooms (as written and as resolved) to the room name. */
function roomTargets(home: string): Map<string, string> {
  const targets = new Map<string, string>();
  for (const room of loadHome(home).rooms) {
    targets.set(keyOf(room.targetRepo), room.name);
    targets.set(keyOf(real(room.targetRepo)), room.name);
  }
  return targets;
}

/** What `POST /api/onboarding` takes for a folder: relative to the home, absolute when there is no relative way. */
function onboardingPath(home: string, dir: string): string {
  const rel = path.relative(home, dir);
  return path.isAbsolute(rel) ? dir : toPosix(rel) || ".";
}

/**
 * Lists the sub-folders of a folder of the projects root. Throws
 * PATH_OUTSIDE_ROOT (400) for a path that is absolute, climbs with `..`, or
 * leads out of the root through a link; DIR_NOT_FOUND (404) for a path that is
 * not a folder, or is hidden or heavy (`.git`, `node_modules`, ...);
 * ROOT_NOT_FOUND (404) when the root itself is missing.
 */
export function listDirs(config: HqConfig, query: z.infer<typeof dirsQuerySchema>): DirListing {
  const root = readProjectsRoot(config.home);
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
    if (!fs.statSync(realRoot).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new HqError("ROOT_NOT_FOUND", 404, `The projects root ${root} is not a directory.`);
  }
  const segments = segmentsOf(query.path);
  const dir = path.join(root, ...segments);
  const notFound = () => new HqError("DIR_NOT_FOUND", 404, `No folder at "${segments.join("/")}".`);
  let realDir: string;
  try {
    realDir = fs.realpathSync(dir);
  } catch {
    throw notFound();
  }
  if (!isInside(realRoot, realDir)) throw outside(`The path "${query.path}"`);
  if (!fs.statSync(realDir).isDirectory() || segments.some(isHidden)) throw notFound();

  const targets = roomTargets(config.home);
  const roomOf = (logical: string) => targets.get(keyOf(logical)) ?? targets.get(keyOf(real(logical))) ?? null;

  const dirs: DirEntry[] = [];
  for (const entry of fs.readdirSync(realDir, { withFileTypes: true })) {
    if (isHidden(entry.name)) continue;
    const child = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      // A link counts only when it leads to a folder that is still inside the root.
      try {
        const target = fs.realpathSync(child);
        if (!fs.statSync(target).isDirectory() || !isInside(realRoot, target)) continue;
      } catch {
        continue;
      }
    } else if (!entry.isDirectory()) {
      continue;
    }
    dirs.push({
      name: entry.name,
      path: [...segments, entry.name].join("/"),
      project: looksLikeProject(child),
      room: roomOf(child),
    });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || (a.name < b.name ? -1 : 1));

  return {
    rootName: path.basename(root) || root,
    path: segments.join("/"),
    parent: segments.length === 0 ? null : segments.slice(0, -1).join("/"),
    target: onboardingPath(config.home, dir),
    project: looksLikeProject(dir),
    room: roomOf(dir),
    dirs,
  };
}
