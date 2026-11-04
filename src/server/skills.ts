import fs from "node:fs";
import path from "node:path";
import { builtInTools } from "./claude-engine";
import { isInside } from "./config";
import { HqError } from "./errors";

/**
 * Claude Code skills of a room agent (`skills` in room.json).
 *
 * The agents run `claude -p --setting-sources project,local` from their working
 * directory, so they never see the user's own skills. Claude Code reads project
 * skills from `<cwd>/.claude/skills/<name>/SKILL.md`: before each run, the
 * folders an agent lists are copied there (syncSkills), and the `Skill` tool is
 * added to its `--tools` (skillTools), without which the model cannot call them.
 */

/** Where Claude Code looks for project skills, relative to the working directory. */
const SKILLS_DIR = path.join(".claude", "skills");
/** Marks a copy made by MyHQ: only such a folder is ever replaced. */
const MARKER = ".myhq-skill";
/** A folder name is a safe path segment (it becomes the skill's folder in the working directory). */
const FOLDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Resolves the `skills` of an agent (paths relative to the room folder) to
 * absolute folders. Throws an explicit Error naming the agent and the path when
 * one leaves the room folder, is not a folder holding a SKILL.md, has an
 * unusable name, or shares its folder name with another skill of the agent.
 */
export function resolveSkillDirs(roomDir: string, agentId: string, skills: readonly string[]): string[] {
  const names = new Map<string, string>();
  return skills.map((skill) => {
    const where = `skill "${skill}" of "${agentId}"`;
    if (path.isAbsolute(skill) || path.win32.isAbsolute(skill) || path.posix.isAbsolute(skill)) {
      throw new Error(`${where} must be relative to the room directory`);
    }
    const dir = path.resolve(roomDir, skill);
    if (dir === path.resolve(roomDir) || !isInside(roomDir, dir)) {
      throw new Error(`${where} must be a folder inside the room directory`);
    }
    const name = path.basename(dir);
    if (!FOLDER_NAME.test(name)) {
      throw new Error(`${where}: folder name "${name}" must use letters, digits, '.', '-' or '_' (max 64)`);
    }
    const twin = names.get(name);
    if (twin !== undefined) throw new Error(`${where} has the same folder name as "${twin}"`);
    names.set(name, skill);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw new Error(`${where} not found (expected a folder containing SKILL.md)`);
    }
    if (!fs.existsSync(path.join(dir, "SKILL.md"))) {
      throw new Error(`${where} has no SKILL.md`);
    }
    return dir;
  });
}

/**
 * Copies each skill folder to `<workDir>/.claude/skills/<folder name>/`,
 * replacing a stale copy and leaving every other folder of `.claude/skills`
 * alone. A folder of that name that MyHQ did not create (a skill the repository
 * versions, say) is never overwritten: it is an error.
 *
 * With `ignoreInGit` (an agent in a Git worktree) each copy gets a `.gitignore`
 * holding `*`, so that Git ignores the whole folder, the `.gitignore` included.
 * That is per copy, needs no Git command and, unlike `.git/info/exclude`
 * (shared by every worktree of the repository, so it would also hide the
 * folder in the owner's own checkout), only touches the agent's worktree.
 */
export function syncSkills(workDir: string, skillDirs: readonly string[], opts: { ignoreInGit?: boolean } = {}): void {
  if (skillDirs.length === 0) return;
  const root = path.join(workDir, SKILLS_DIR);
  fs.mkdirSync(root, { recursive: true });
  for (const source of skillDirs) {
    const name = path.basename(source);
    const dest = path.join(root, name);
    if (fs.existsSync(dest) && !fs.existsSync(path.join(dest, MARKER))) {
      throw new HqError(
        "SKILL_CONFLICT",
        409,
        `Cannot sync skill "${name}": ${dest} exists and was not created by MyHQ.`,
      );
    }
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(source, dest, { recursive: true });
    fs.writeFileSync(path.join(dest, MARKER), `Copied by MyHQ from ${source}\n`);
    if (opts.ignoreInGit) fs.writeFileSync(path.join(dest, ".gitignore"), "*\n");
  }
}

/**
 * The built-in tools of an agent that has skills: its usual ones plus `Skill`.
 * Claude Code needs it in `--tools` (a tool outside that list does not exist
 * for the model); no `--allowedTools` entry is needed to call a skill.
 * `undefined` when the agent has no skills (the default tools apply).
 */
export function skillTools(agent: { allowedTools: string[]; tools?: string[]; skills?: string[] }): string[] | undefined {
  if (!agent.skills?.length) return agent.tools;
  return [...new Set([...(agent.tools ?? builtInTools(agent.allowedTools)), "Skill"])];
}
