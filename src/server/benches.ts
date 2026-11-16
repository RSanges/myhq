import path from "node:path";
import { now, type Db } from "./db";
import type { Agent, Room } from "./rooms";
import { ensureWorktree, worktreeBranch } from "./worktree";

// Several benches (docs/architecture.md, "Several benches"). A parallel agent
// (room.json `parallel`) runs one run per subject at once. When it has a
// `worktree`, each subject other than the general one gets its own bench: a
// Git worktree beside the agent's, on its own branch, made from the tip of
// the agent's branch when the subject's first run starts. The general subject
// keeps the agent's worktree. A run, a question and the surveillance room of
// a subject work in its bench; once the subject is archived MyHQ merges the
// bench's branch into the agent's and removes the bench.

/** Where a subject's bench lives and what it merges into. */
export type Bench = {
  /** The bench, a sibling of the agent's worktree. */
  dir: string;
  /** Its branch, beside the agent's. */
  branch: string;
  /** The agent's own worktree and branch, which the bench comes from and merges into. */
  baseDir: string;
  baseBranch: string;
};

/** The bench of this subject, or null: the agent is not parallel, has no worktree, or it is the general subject. */
export function benchOf(agent: Pick<Agent, "id" | "worktree" | "parallel">, subjectId: number | null): Bench | null {
  if (!agent.parallel || !agent.worktree || subjectId === null) return null;
  return {
    dir: path.join(path.dirname(agent.worktree), `${path.basename(agent.worktree)}--subject-${subjectId}`),
    branch: `${worktreeBranch(agent.id)}--subject-${subjectId}`,
    baseDir: agent.worktree,
    baseBranch: worktreeBranch(agent.id),
  };
}

/** The working directory of a run or a question of this subject: its bench when it has one, else the agent's own. */
export const workDirOf = (agent: Pick<Agent, "id" | "worktree" | "parallel" | "workDir">, subjectId: number | null): string =>
  benchOf(agent, subjectId)?.dir ?? agent.workDir;

/**
 * Makes sure the bench exists before a run of its subject (the agent's own
 * worktree first): created from the tip of the agent's branch, or taken
 * again as it is. Records it, and a bench closed earlier (the subject was
 * reopened) starts afresh in the same row. Throws when Git fails: the run
 * then fails with the reason.
 */
export function openBench(db: Db, room: Room, agent: Agent, subjectId: number, bench: Bench): void {
  ensureWorktree({ repo: room.targetRepo, dir: bench.baseDir, branch: bench.baseBranch });
  ensureWorktree({ repo: room.targetRepo, dir: bench.dir, branch: bench.branch, base: bench.baseBranch });
  const at = now();
  db.prepare(
    `INSERT INTO benches (subject_id, room, agent_id, dir, branch, base_dir, base_branch, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (subject_id) DO UPDATE SET room = excluded.room, agent_id = excluded.agent_id, dir = excluded.dir,
       branch = excluded.branch, base_dir = excluded.base_dir, base_branch = excluded.base_branch, created_at = excluded.created_at,
       state = NULL, tried = NULL, note_task_id = NULL, closed_at = NULL, updated_at = excluded.updated_at
     WHERE benches.closed_at IS NOT NULL`,
  ).run(subjectId, room.name, agent.id, bench.dir, bench.branch, bench.baseDir, bench.baseBranch, at, at);
}
