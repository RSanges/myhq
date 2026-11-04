import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { toPosix, type Room } from "./rooms";

/**
 * The technology catalogue the receptionist bases an agent proposal on: the
 * target repositories of the rooms (package.json, pyproject.toml, README)
 * and the extra read-only places of `catalog.dirs` in myhq.json (for example
 * a folder of project notes whose frontmatter lists the owner's stack).
 * MyHQ summarizes them in the run prompt; the receptionist may read further
 * in them, read-only.
 */

/** The `catalog` block of myhq.json. */
export const catalogSettingsSchema = z.strictObject({
  /** Extra folders to read, relative to the home or absolute. */
  dirs: z.array(z.string().trim().min(1).max(1_000)).max(20).default([]),
});

/**
 * The `catalog.dirs` of myhq.json, as absolute paths, none when the file or
 * the key is absent. Read apart from the rest of the file (like `floor`): an
 * invalid block gives no folder and the reason, and never breaks the other
 * settings. Never throws.
 */
export function readCatalogDirs(home: string): { dirs: string[]; error: string | null } {
  const file = path.join(home, "myhq.json");
  let raw: unknown;
  try {
    if (!fs.existsSync(file)) return { dirs: [], error: null };
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return { dirs: [], error: `myhq.json is not valid JSON: ${(error as Error).message}` };
  }
  const block = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).catalog : undefined;
  if (block === undefined) return { dirs: [], error: null };
  const parsed = catalogSettingsSchema.safeParse(block);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `catalog.${issue.path.join(".")}: ${issue.message}`).join("; ");
    return { dirs: [], error: `myhq.json: ${details}` };
  }
  return { dirs: [...new Set(parsed.data.dirs.map((dir) => path.resolve(home, dir)))], error: null };
}

const isDir = (dir: string) => {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
};

const readText = (file: string): string | null => {
  try {
    return fs.statSync(file).isFile() ? fs.readFileSync(file, "utf8") : null;
  } catch {
    return null;
  }
};

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}...` : text);

const names = (record: unknown): string[] =>
  record && typeof record === "object" && !Array.isArray(record) ? Object.keys(record) : [];

/** The package names of a list of PEP 508 requirements ("fastapi>=0.110" gives "fastapi"). */
function requirementNames(list: string): string[] {
  return [...list.matchAll(/["']([^"']+)["']/g)]
    .map((m) => m[1]!.trim().split(/[\s<>=!~;[(@]/)[0]!)
    .filter((name) => name !== "");
}

/** What a pyproject.toml says of the project: its name and its dependencies. */
export function pyprojectSummary(text: string): string[] {
  const lines: string[] = [];
  const name = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(text)?.[1];
  if (name) lines.push(`name ${name}`);
  const deps = new Set<string>();
  // The list ends at the first "]" outside quotes ("pydantic[email]" keeps its extras).
  for (const m of text.matchAll(/^\s*dependencies\s*=\s*\[((?:"[^"]*"|'[^']*'|[^\]"'])*)\]/gm)) {
    for (const dep of requirementNames(m[1]!)) deps.add(dep);
  }
  // Poetry: the keys of [tool.poetry.dependencies] and of its groups.
  for (const m of text.matchAll(/^\[tool\.poetry\.(?:group\.[\w-]+\.)?(?:dev-)?dependencies\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/gm)) {
    for (const key of m[1]!.matchAll(/^\s*([A-Za-z0-9_.-]+)\s*=/gm)) if (key[1] !== "python") deps.add(key[1]!);
  }
  if (deps.size > 0) lines.push(`dependencies: ${[...deps].join(", ")}`);
  return lines;
}

/** What a package.json says of the project: name, description, dependencies, scripts. */
export function packageJsonSummary(text: string): string[] {
  let data: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return ["(unreadable)"];
    data = parsed as Record<string, unknown>;
  } catch {
    return ["(not valid JSON)"];
  }
  const lines: string[] = [];
  if (typeof data.name === "string") lines.push(`name ${data.name}`);
  if (typeof data.description === "string") lines.push(`description: ${cut(data.description, 200)}`);
  for (const key of ["dependencies", "devDependencies", "scripts"] as const) {
    const list = names(data[key]);
    if (list.length > 0) lines.push(`${key}: ${list.join(", ")}`);
  }
  return lines;
}

const README_MAX = 800;

/** The first lines of a README, without blank lines, cut. */
function readmeSummary(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");
  return cut(lines.slice(0, 15).join(" / "), README_MAX);
}

/** The manifests of a repository (package.json, pyproject.toml, README), summarized; none when it has none. */
export function repositorySummary(dir: string): string[] {
  const lines: string[] = [];
  const pkg = readText(path.join(dir, "package.json"));
  if (pkg !== null) lines.push(`package.json: ${packageJsonSummary(pkg).join("; ")}`);
  const py = readText(path.join(dir, "pyproject.toml"));
  if (py !== null) lines.push(`pyproject.toml: ${pyprojectSummary(py).join("; ") || "(no name or dependency found)"}`);
  const readme = ["README.md", "README", "readme.md", "Readme.md"].map((name) => readText(path.join(dir, name))).find((t) => t !== null);
  if (readme) lines.push(`README: ${readmeSummary(readme)}`);
  return lines;
}

const FRONTMATTER_LINES = 10;
const FRONTMATTER_LINE_MAX = 160;

/** The YAML frontmatter of a Markdown note, one line per entry, each cut; null when it has none. */
export function frontmatterSummary(text: string): string | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) return null;
  const lines = m[1]!
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .slice(0, FRONTMATTER_LINES)
    .map((line) => cut(line.trim(), FRONTMATTER_LINE_MAX));
  return lines.length > 0 ? lines.join("; ") : null;
}

const NOTES_MAX = 80;

/** A catalogue folder: its own manifests, then its Markdown notes (top level) with their frontmatter. */
export function folderSummary(dir: string): string[] {
  const lines = repositorySummary(dir);
  let notes: string[];
  try {
    notes = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md") && !/^readme\.md$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return lines;
  }
  for (const name of notes.slice(0, NOTES_MAX)) {
    const front = frontmatterSummary(readText(path.join(dir, name)) ?? "");
    lines.push(front ? `${name}: ${front}` : name);
  }
  if (notes.length > NOTES_MAX) lines.push(`(and ${notes.length - NOTES_MAX} more notes)`);
  return lines;
}

const CATALOG_MAX = 40_000;

export type Catalog = {
  /** The Markdown section of the run prompt. */
  text: string;
  /** The folders the receptionist may read besides its working directory (existing ones only). */
  dirs: string[];
};

/**
 * The catalogue of a home: one entry per target repository of a room (the
 * rooms that share a repository share the entry), then one per catalogue
 * folder. A folder that does not exist is named as missing and not read.
 * Cut at a total size, so that the prompt stays reasonable.
 */
export function buildCatalog(home: string, rooms: Room[], catalogDirs: string[]): Catalog {
  const rel = (dir: string) => toPosix(path.relative(home, dir)) || ".";
  const sections: string[] = [];
  const dirs: string[] = [];
  const repos = new Map<string, string[]>();
  for (const room of rooms) repos.set(room.targetRepo, [...(repos.get(room.targetRepo) ?? []), room.name]);
  for (const [repo, owners] of repos) {
    const exists = isDir(repo);
    if (exists) dirs.push(repo);
    const lines = exists ? repositorySummary(repo) : ["(missing)"];
    sections.push(`### ${rel(repo)} (room${owners.length > 1 ? "s" : ""} ${owners.join(", ")})`, ...(lines.length ? lines : ["(no manifest)"]).map((l) => `- ${l}`), "");
  }
  for (const dir of catalogDirs) {
    const exists = isDir(dir);
    if (exists && !dirs.includes(dir)) dirs.push(dir);
    const lines = exists ? folderSummary(dir) : ["(missing)"];
    sections.push(`### ${rel(dir)} (catalogue folder)`, ...(lines.length ? lines : ["(empty)"]).map((l) => `- ${l}`), "");
  }
  const text = sections.join("\n").trim();
  return { text: text.length > CATALOG_MAX ? `${text.slice(0, CATALOG_MAX)}\n(catalogue cut)` : text, dirs };
}
