import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strings } from "../ui/strings";
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
// bench's branch into the agent's and removes the bench (closeBench).

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

// --- Closing a bench ----------------------------------------------------------------------

type BenchRow = {
  subject_id: number;
  room: string;
  agent_id: string;
  dir: string;
  branch: string;
  base_dir: string;
  base_branch: string;
  state: BenchHold | null;
  tried: string | null;
  note_task_id: number | null;
  closed_at: string | null;
};

/** What holds a closing back and is told to the owner: work not committed in the bench, a merge conflict, the agent's worktree not ready, a Git error. */
export type BenchHold = "dirty" | "conflict" | "base" | "error";

/**
 * What a closing attempt did: `closed` (merged if needed, removed, branch
 * deleted); `busy` (a run, a question or a task of the subject, or a run in
 * the agent's worktree: tried again later, nothing told); a hold, told to the
 * owner once; `unchanged` (a conflict or an error tried again with the same
 * two branch tips: not tried again); `none` (no open bench); `open` (the
 * subject is not archived).
 */
export type BenchOutcome = "closed" | "busy" | BenchHold | "unchanged" | "none" | "open";

/** One Git call: its exit, its output and its error. */
export type GitResult = { ok: boolean; code: number | null; out: string; err: string };
export type GitRun = (args: readonly string[], cwd: string) => GitResult;

/** Longest a Git call of a closing may take. */
export const BENCH_GIT_TIMEOUT_MS = 60_000;

let emptyHooks: string | null = null;

/**
 * Git as a closing runs it: an argument array (no shell), a timeout, and no
 * program of the repository's configuration that MyHQ can turn off: no
 * hooks (an empty hooks folder of MyHQ's), no fsmonitor. Never throws.
 */
export const runGit: GitRun = (args, cwd) => {
  emptyHooks ??= fs.mkdtempSync(path.join(os.tmpdir(), "myhq-no-hooks-"));
  try {
    const out = execFileSync("git", ["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${emptyHooks}`, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: BENCH_GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    return { ok: true, code: 0, out: out.trim(), err: "" };
  } catch (error) {
    const failed = error as { status?: number | null; stdout?: string; stderr?: string; message?: string };
    const err = (typeof failed.stderr === "string" ? failed.stderr.trim() : "") || failed.message || String(error);
    return { ok: false, code: failed.status ?? null, out: typeof failed.stdout === "string" ? failed.stdout.trim() : "", err };
  }
};

/** One line of a Git error, for a note. */
const oneLine = (text: string): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 300 ? `${line.slice(0, 300)}...` : line;
};

/**
 * Something of the bench's own subject is going on, or waits to: a run, a
 * question, a task pending or in progress (a relaunched note of MyHQ's
 * included). The closing waits for it.
 */
function benchBusy(db: Db, subjectId: number): boolean {
  const row = db
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM runs WHERE subject_id = ? AND status = 'running')
         OR EXISTS (SELECT 1 FROM agent_questions WHERE subject_id = ? AND status = 'running')
         OR EXISTS (SELECT 1 FROM tasks WHERE subject_id = ? AND status IN ('pending', 'in_progress')) AS busy`,
    )
    .get(subjectId, subjectId, subjectId) as { busy: number };
  return row.busy === 1;
}

/** A run of the agent works in its own worktree: a run of the general subject, or of a subject without an open bench. */
function baseBusy(db: Db, bench: BenchRow): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM runs r WHERE r.room = ? AND r.agent_id = ? AND r.status = 'running'
           AND (r.subject_id IS NULL OR NOT EXISTS (SELECT 1 FROM benches b WHERE b.subject_id = r.subject_id AND b.closed_at IS NULL))
         LIMIT 1`,
      )
      .get(bench.room, bench.agent_id) !== undefined
  );
}

/** How the owner's note names the subject: its title, or its number. */
function subjectLabel(db: Db, subjectId: number): string {
  const row = db.prepare("SELECT title FROM subjects WHERE id = ?").get(subjectId) as { title: string | null } | undefined;
  return row?.title ? `« ${row.title} »` : `#${subjectId}`;
}

/**
 * Tells the owner what holds the closing back, once per hold: a blocked task
 * of the agent on the Standard, with MyHQ's note (said as written) and, as
 * its text, what the agent would do if the owner relaunches it. The same hold
 * again only refreshes the note of a task still blocked (one the owner
 * closed stays closed); another hold closes the previous task and opens a
 * new one. Returns the hold.
 */
function tell(db: Db, bench: BenchRow, hold: BenchHold, detail: { tried?: string | null; error?: string }): BenchHold {
  const b = strings.deskModules.standard.bench;
  const subject = subjectLabel(db, bench.subject_id);
  const error = oneLine(detail.error ?? "");
  const note =
    hold === "dirty"
      ? b.dirty({ subject, dir: bench.dir, branch: bench.branch })
      : hold === "conflict"
        ? b.conflict({ subject, branch: bench.branch, base: bench.base_branch })
        : hold === "base"
          ? b.base({ subject, dir: bench.base_dir, base: bench.base_branch })
          : b.error({ subject, error });
  const text =
    hold === "dirty"
      ? `Your bench of subject #${bench.subject_id} (${bench.dir}) has changes that are not committed, so MyHQ cannot close it. Commit on ${bench.branch} what belongs to the subject, put aside what does not, then finish your turn: MyHQ merges ${bench.branch} into ${bench.base_branch} and closes the bench.`
      : hold === "conflict"
        ? `Merging ${bench.branch} into ${bench.base_branch} conflicts: two of your subjects changed the same files. In your bench of subject #${bench.subject_id} (${bench.dir}), merge ${bench.base_branch} into ${bench.branch}, resolve the conflicts, commit, then finish your turn: MyHQ merges it and closes the bench.`
        : hold === "base"
          ? `Your own worktree (${bench.base_dir}) has changes that are not committed, or is not on ${bench.base_branch}, so MyHQ cannot merge the bench of subject #${bench.subject_id} into it. Commit or put aside those changes on ${bench.base_branch}, then finish your turn.`
          : `MyHQ could not close your bench of subject #${bench.subject_id} (${bench.dir}, branch ${bench.branch}): ${error}. Look at it, put it right without losing any work, then finish your turn.`;
  const at = now();
  db.transaction(() => {
    if (bench.state === hold && bench.note_task_id !== null) {
      db.prepare("UPDATE tasks SET note = ?, updated_at = ? WHERE id = ? AND status = 'blocked' AND note <> ?").run(note, at, bench.note_task_id, note);
      db.prepare("UPDATE benches SET tried = ?, updated_at = ? WHERE subject_id = ?").run(detail.tried ?? null, at, bench.subject_id);
      return;
    }
    if (bench.note_task_id !== null) {
      db.prepare("UPDATE tasks SET status = 'done', note = ?, updated_at = ? WHERE id = ? AND status = 'blocked'").run(b.solved, at, bench.note_task_id);
    }
    // A hold of the agent's own worktree is settled there: a relaunch of its note works on the general subject.
    const task = Number(
      db
        .prepare(
          `INSERT INTO tasks (room, agent_id, source, text, status, note, subject_id, created_at, updated_at)
           VALUES (?, ?, 'manual', ?, 'blocked', ?, ?, ?, ?)`,
        )
        .run(bench.room, bench.agent_id, text, note, hold === "base" ? null : bench.subject_id, at, at).lastInsertRowid,
    );
    db.prepare("UPDATE benches SET state = ?, tried = ?, note_task_id = ?, updated_at = ? WHERE subject_id = ?").run(
      hold,
      detail.tried ?? null,
      task,
      at,
      bench.subject_id,
    );
  }).immediate();
  return hold;
}

/**
 * Closes the bench of an archived subject, never losing work:
 * 1. a bench with changes Git does not ignore (tracked or not) is kept and
 *    the owner told (`dirty`);
 * 2. its branch is merged into the agent's, inside the agent's own worktree,
 *    only when that worktree is on its branch, clean and used by no run
 *    (otherwise `busy`, or `base` told when it is dirty or elsewhere); a
 *    branch with nothing new is not merged;
 * 3. a conflict aborts the merge, keeps the bench and tells the owner the
 *    two branches (`conflict`), tried again only once a tip moved;
 * 4. after it, the worktree is removed and the branch deleted, neither by
 *    force (`git worktree remove`, `git branch -d`).
 * Waits (`busy`) while a run, a question or a task of the subject is going
 * on. Every Git call goes through `git` (runGit). Never throws.
 */
export function closeBench(db: Db, subjectId: number, git: GitRun = runGit): BenchOutcome {
  try {
    const bench = db.prepare("SELECT * FROM benches WHERE subject_id = ? AND closed_at IS NULL").get(subjectId) as BenchRow | undefined;
    if (!bench) return "none";
    const subject = db.prepare("SELECT status FROM subjects WHERE id = ?").get(subjectId) as { status: string } | undefined;
    if (subject?.status !== "archived") return "open";
    if (benchBusy(db, subjectId)) return "busy";
    if (!fs.existsSync(bench.dir)) return tell(db, bench, "error", { error: `${bench.dir} is missing` });
    const changes = git(["--no-optional-locks", "status", "--porcelain"], bench.dir);
    if (!changes.ok) return tell(db, bench, "error", { error: changes.err });
    if (changes.out !== "") return tell(db, bench, "dirty", {});
    if (baseBusy(db, bench)) return "busy";
    const head = git(["symbolic-ref", "--quiet", "--short", "HEAD"], bench.base_dir);
    const base = head.ok ? git(["--no-optional-locks", "status", "--porcelain"], bench.base_dir) : head;
    if (!head.ok || head.out !== bench.base_branch || !base.ok || base.out !== "") return tell(db, bench, "base", {});
    const tips = git(["rev-parse", `refs/heads/${bench.branch}`, `refs/heads/${bench.base_branch}`], bench.base_dir);
    if (!tips.ok) return tell(db, bench, "error", { error: tips.err });
    const tried = tips.out.split(/\s+/).join(" ");
    if ((bench.state === "conflict" || bench.state === "error") && bench.tried === tried) return "unchanged";
    const merged = git(["merge-base", "--is-ancestor", `refs/heads/${bench.branch}`, "HEAD"], bench.base_dir);
    if (!merged.ok && merged.code !== 1) return tell(db, bench, "error", { tried, error: merged.err });
    if (!merged.ok) {
      const merge = git(["merge", "--no-edit", bench.branch], bench.base_dir);
      if (!merge.ok) {
        if (!git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], bench.base_dir).ok) return tell(db, bench, "error", { tried, error: merge.err });
        const abort = git(["merge", "--abort"], bench.base_dir);
        if (!abort.ok) return tell(db, bench, "error", { tried, error: `git merge --abort failed: ${abort.err}` });
        return tell(db, bench, "conflict", { tried });
      }
    }
    const removed = git(["worktree", "remove", bench.dir], bench.base_dir);
    if (!removed.ok) return tell(db, bench, "error", { tried, error: removed.err });
    const deleted = git(["branch", "-d", bench.branch], bench.base_dir);
    // Merged, so nothing is lost: a branch Git refuses to delete stays, and the bench is closed all the same.
    if (!deleted.ok) console.error(`[benches] the branch ${bench.branch} of the closed bench of subject #${subjectId} was kept: ${oneLine(deleted.err)}`);
    const at = now();
    db.transaction(() => {
      db.prepare("UPDATE benches SET closed_at = ?, state = NULL, tried = NULL, updated_at = ? WHERE subject_id = ?").run(at, at, subjectId);
      if (bench.note_task_id !== null) {
        db.prepare("UPDATE tasks SET status = 'done', note = ?, updated_at = ? WHERE id = ? AND status = 'blocked'").run(
          strings.deskModules.standard.bench.solved,
          at,
          bench.note_task_id,
        );
      }
    }).immediate();
    return "closed";
  } catch (error) {
    console.error(`[benches] the bench of subject #${subjectId} could not be closed`, error);
    return "error";
  }
}

/**
 * Tries again to close every open bench of an archived subject (of one agent
 * when given): what waited for a run, a question or the agent's worktree,
 * and what was told to the owner (a bench made clean since closes). Called
 * at each tick of the scheduler and at the end of each run. Never throws.
 */
export function closeArchivedBenches(db: Db, of?: { room: string; agentId: string }, git: GitRun = runGit): void {
  try {
    const rows = db
      .prepare(
        `SELECT b.subject_id FROM benches b JOIN subjects s ON s.id = b.subject_id
         WHERE b.closed_at IS NULL AND s.status = 'archived'${of ? " AND b.room = ? AND b.agent_id = ?" : ""} ORDER BY b.subject_id`,
      )
      .all(...(of ? [of.room, of.agentId] : [])) as { subject_id: number }[];
    for (const row of rows) closeBench(db, row.subject_id, git);
  } catch (error) {
    console.error("[benches] the benches of archived subjects could not be looked at", error);
  }
}

/** Whether a task is MyHQ's note on a bench it could not close (said as written on the Standard). */
export const isBenchNote = (db: Db, taskId: number): boolean =>
  db.prepare("SELECT 1 FROM benches WHERE note_task_id = ?").get(taskId) !== undefined;
