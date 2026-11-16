import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getDbAt, type Db, type RunRow } from "../src/server/db";
import type { Engine, RunEvent, RunInput } from "../src/server/engine";
import { loadHome, syncHome } from "../src/server/rooms";
import { startRun } from "../src/server/runner";
import { makeHome, makeRepo, waitForRun } from "./helpers";

// What the tests of the benches share (benches.test.ts, bench-closing.test.ts): a home
// whose agent works in a worktree of a throwaway repository, and an engine that works there.

export const usage = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
export const done: RunEvent = { type: "end", status: "done", reason: "success", summary: "ok", usage, costUsd: 0 };
export const quiet = async () => false;

export const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
/** A file as written, whatever line ends the checkout gave it (core.autocrlf). */
export const read = (file: string) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
export const commit = (dir: string, file: string, text: string) => {
  fs.writeFileSync(path.join(dir, file), text);
  git(dir, "add", file);
  git(dir, "commit", "-q", "-m", `Write ${file}`);
};

/** A home whose agent "dev" works in a worktree of a throwaway repository; `parallel` unless told otherwise. */
export function office(extra: Record<string, unknown> = {}) {
  const repo = makeRepo();
  const config = makeHome({}, {
    name: "demo",
    targetRepo: repo,
    agents: [
      {
        id: "dev",
        name: "Dev",
        role: "roles/scout.md",
        model: "haiku",
        allowedTools: ["Write", "mcp__hq__*"],
        worktree: "data/worktrees/dev",
        parallel: true,
        ...extra,
      },
    ],
  });
  const db = getDbAt(config.dbPath);
  syncHome(db, loadHome(config.home));
  const agent = loadHome(config.home).rooms[0]!.agents[0]!;
  return { repo, config, db, agent, base: agent.worktree! };
}

/** An engine that runs, in the run's working directory, what the task of its prompt names; `seen` records the runs. */
export function workingEngine(actions: Record<string, (dir: string) => void> = {}, seen: RunInput[] = []): Engine {
  return {
    name: "claude",
    async *run(input: RunInput): AsyncIterable<RunEvent> {
      seen.push(input);
      for (const [task, act] of Object.entries(actions)) if (input.prompt.includes(`Task:\n${task}\n`) || input.prompt.endsWith(`Task:\n${task}`)) act(input.workDir);
      yield done;
    },
  };
}

export async function run(config: ReturnType<typeof office>["config"], db: Db, engine: Engine, task: string, subject: number | null = null): Promise<RunRow> {
  const started = startRun({ room: "demo", agent: "dev", task }, { config, engine, send: quiet, subject });
  return waitForRun(db, started.id);
}

export const benchRow = (db: Db, subject: number) =>
  db.prepare("SELECT * FROM benches WHERE subject_id = ?").get(subject) as { closed_at: string | null; state: string | null; note_task_id: number | null } | undefined;
