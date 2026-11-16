import fs from "node:fs";
import path from "node:path";
import { builtInTools } from "./claude-engine";
import type { Agent } from "./rooms";
import { skillTools } from "./skills";

// The notebook of an agent (room.json `notebook`, docs/architecture.md, "The
// notebook"): one folder of its own, often in the owner's notes vault outside
// the home, where it keeps what lasts (what was agreed with the owner, the
// owner's preferences, the lessons of a piece of work), one Markdown note per
// topic, which the owner opens and corrects. A run reads and writes it (an
// `--add-dir` and the only `notebooks` entry of its write guard, which holds
// it to Markdown notes), and so does a question, where it is the only place a
// write may land. The state of the
// bench (a commit, a step in progress) stays in hq_memory. This module only
// lists the folder and writes the lines of the prompts: the confinement is the
// write guard's (write-guard.ts).

/** The tools a notebook needs: they exist for the run even when its rules have no write, the guard holding them to the notebook. */
export const NOTEBOOK_TOOLS = ["Write", "Edit"] as const;

/**
 * What a run of an agent with a notebook gets on top of its own access:
 * the folder (created when missing) as an `--add-dir`, and Write and Edit
 * among its tools and its allowed rules. The guard's configuration is
 * still computed from the agent's own rules, with the notebook as its only
 * `notebooks` entry (runner.ts): the added bare rules widen nothing in the
 * working directory.
 */
export function notebookAccess(agent: Pick<Agent, "notebook" | "addDirs" | "allowedTools" | "tools" | "skills">): {
  dir: string;
  addDirs: string[];
  allowedTools: string[];
  tools: string[];
} {
  const dir = agent.notebook!;
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    addDirs: [...new Set([...agent.addDirs, dir])],
    allowedTools: [...new Set([...agent.allowedTools, ...NOTEBOOK_TOOLS])],
    tools: [...new Set([...(skillTools(agent) ?? builtInTools(agent.allowedTools)), ...NOTEBOOK_TOOLS])],
  };
}

/** How many files of the notebook a prompt lists, the latest changed first. */
export const NOTEBOOK_LIST_MAX = 50;
/** How deep the listing goes below the notebook. */
const NOTEBOOK_DEPTH = 3;

export type NotebookFile = { name: string; size: number; changedAt: string };

/** The files of the notebook (name relative to it, size, last change), the latest changed first; none when it is missing. */
export function notebookFiles(dir: string): NotebookFile[] {
  const files: NotebookFile[] = [];
  const walk = (folder: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (depth < NOTEBOOK_DEPTH) walk(full, depth + 1);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(full);
          files.push({ name: path.relative(dir, full).split(path.sep).join("/"), size: stat.size, changedAt: stat.mtime.toISOString() });
        } catch {
          // Gone in between: left out.
        }
      }
    }
  };
  walk(dir, 0);
  return files.sort((a, b) => b.changedAt.localeCompare(a.changedAt) || a.name.localeCompare(b.name));
}

/**
 * The notebook block of a prompt: where it is, its files (no content, the
 * latest NOTEBOOK_LIST_MAX), and what belongs in it. In a question, it also
 * says to write there what is settled with the owner, when it is settled.
 */
export function notebookText(dir: string, language: string, mode: "run" | "question"): string {
  const files = notebookFiles(dir);
  const lines = [
    "## Your notebook",
    "",
    `Your notebook is the folder ${dir}. You read and write it with Read, Write and Edit; the owner opens it and corrects it.`,
    "What belongs in it: what was agreed with the owner, the owner's lasting preferences, the lessons of a piece of work worth keeping. One Markdown note per topic, dated, short, in " +
      `${language}; update the note of a topic rather than add a second one. The state of your bench (a commit, a step in progress) stays in hq_memory, not here.`,
  ];
  if (mode === "question") {
    lines.push(
      "Here it is the only place you may write: write to it what you and the owner settle, when you settle it, and say so in one short sentence of your answer. Nothing else is written.",
    );
  }
  if (files.length === 0) {
    lines.push("", "It holds no note yet.");
  } else {
    lines.push("", `Its notes, the latest changed first${files.length > NOTEBOOK_LIST_MAX ? ` (${NOTEBOOK_LIST_MAX} of ${files.length})` : ""}:`);
    for (const file of files.slice(0, NOTEBOOK_LIST_MAX)) lines.push(`- ${file.name} (${file.size} bytes, changed ${file.changedAt})`);
  }
  return lines.join("\n");
}
