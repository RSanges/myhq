import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { strings } from "../ui/strings";
import { isInside } from "./config";
import { now, type Db } from "./db";
import type { Agent, Room } from "./rooms";
import { isSkillCopy } from "./skills";
import { ensureWorktree, pruneWorktrees, safeGitArgs, worktreeBranch } from "./worktree";

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

/**
 * Between the agent's worktree (or branch) and the subject: a dot, which an
 * agent id cannot hold (`idSchema`), so that no agent's own branch or
 * worktree ever has the name of another agent's bench.
 */
const BENCH_SEPARATOR = ".subject-";

/** The bench of this subject, or null: the agent is not parallel, has no worktree, or it is the general subject. */
export function benchOf(agent: Pick<Agent, "id" | "worktree" | "parallel">, subjectId: number | null): Bench | null {
  if (!agent.parallel || !agent.worktree || subjectId === null) return null;
  return {
    dir: path.join(path.dirname(agent.worktree), `${path.basename(agent.worktree)}${BENCH_SEPARATOR}${subjectId}`),
    branch: `${worktreeBranch(agent.id)}${BENCH_SEPARATOR}${subjectId}`,
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
 * again as it is. A bench whose folder is gone (removed by hand, or half
 * removed) is first forgotten by Git (`git worktree prune`), then made again
 * from its branch when it still has one. Records it, and a bench closed
 * earlier (the subject was reopened) starts afresh in the same row. Throws
 * when Git fails: the run then fails with the reason.
 */
export function openBench(db: Db, room: Room, agent: Agent, subjectId: number, bench: Bench): void {
  ensureWorktree({ repo: room.targetRepo, dir: bench.baseDir, branch: bench.baseBranch });
  if (!fs.existsSync(path.join(bench.dir, ".git"))) pruneWorktrees(room.targetRepo);
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

/**
 * What holds a closing back and is told to the owner. The agent settles
 * three: work not committed in the bench (`dirty`), a merge conflict
 * (`conflict`), changes not committed in its own worktree (`base`). The
 * owner settles the others: the agent's worktree on another branch
 * (`baseBranch`), in the middle of a merge, a rebase, a cherry-pick or a
 * revert (`baseOperation`), missing (`baseMissing`); a merge that would
 * overwrite files Git does not track there (`overwrite`); ignored files of
 * the bench that could not be carried (`carry`); any other Git error (`error`).
 */
export type BenchHold = "dirty" | "conflict" | "base" | "baseBranch" | "baseOperation" | "baseMissing" | "overwrite" | "carry" | "error";

/** The holds a run of the agent settles: « Relancer » on their note starts one. */
export const AGENT_HOLDS: ReadonlySet<string> = new Set<BenchHold>(["dirty", "conflict", "base"]);

/**
 * What a closing attempt did: `closed` (merged if needed, removed, branch
 * deleted); `busy` (a run, a question or a task of the subject, or a run in
 * the agent's worktree: tried again later, nothing told); a hold, told to the
 * owner; `unchanged` (not tried: a held bench whose next try is not due yet,
 * or a conflict with the same two branch tips); `none` (no open bench);
 * `open` (the subject is not archived).
 */
export type BenchOutcome = "closed" | "busy" | BenchHold | "unchanged" | "none" | "open";

/** One Git call: its exit, its output and its error. */
export type GitResult = { ok: boolean; code: number | null; out: string; err: string };
export type GitRun = (args: readonly string[], cwd: string) => GitResult;

/** Longest a Git call of a closing may take: the calls are synchronous, in the server's process. */
export const BENCH_GIT_TIMEOUT_MS = 30_000;

/**
 * Git as a closing runs it: an argument array (no shell), a timeout, no hook
 * and no fsmonitor (safeGitArgs), and never a repository above `cwd`
 * (GIT_CEILING_DIRECTORIES: a bench or a worktree that is gone is never taken
 * for a repository around it, such as a home that Git versions). Never throws.
 */
export const runGit: GitRun = (args, cwd) => {
  try {
    const out = execFileSync("git", safeGitArgs(args), {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(cwd)) },
      maxBuffer: 64 * 1024 * 1024,
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

/** The first wait before a held bench is tried again by the scheduler's tick, doubled at each hold up to RETRY_MAX_MS. */
export const RETRY_FIRST_MS = 60_000;
export const RETRY_MAX_MS = 30 * 60_000;

/** When each held bench is tried again by the tick (in memory: a restart tries each one at its first tick). */
const retries = new Map<number, { holds: number; at: number }>();

const retryDue = (subjectId: number): boolean => Date.now() >= (retries.get(subjectId)?.at ?? 0);

function heldAgain(subjectId: number): void {
  const holds = (retries.get(subjectId)?.holds ?? 0) + 1;
  retries.set(subjectId, { holds, at: Date.now() + Math.min(RETRY_FIRST_MS * 2 ** (holds - 1), RETRY_MAX_MS) });
}

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

/** What a hold says: `error` is Git's message, or the path and the reason of a file not carried. */
type HoldDetail = { tried?: string | null; error?: string; path?: string; budget?: boolean };

/** The note of a hold, for the owner, in French. */
function holdNote(db: Db, bench: BenchRow, hold: BenchHold, detail: HoldDetail): string {
  const b = strings.deskModules.standard.bench;
  const subject = subjectLabel(db, bench.subject_id);
  const error = oneLine(detail.error ?? "");
  const owners = (note: string) => `${note} ${b.retry}`;
  switch (hold) {
    case "dirty":
      return b.dirty({ subject, dir: bench.dir, branch: bench.branch });
    case "conflict":
      return b.conflict({ subject, branch: bench.branch, base: bench.base_branch });
    case "base":
      return b.base({ subject, dir: bench.base_dir, base: bench.base_branch });
    case "baseBranch":
      return owners(b.baseBranch({ subject, dir: bench.base_dir, base: bench.base_branch }));
    case "baseOperation":
      return owners(b.baseOperation({ subject, dir: bench.base_dir }));
    case "baseMissing":
      return owners(b.baseMissing({ subject, dir: bench.base_dir }));
    case "overwrite":
      return owners(b.overwrite({ subject, dir: bench.base_dir, error }));
    case "carry":
      return owners(
        detail.budget
          ? b.carryBudget({ subject, dir: bench.dir, base: bench.base_dir, entries: CARRY_ENTRIES_MAX, seconds: CARRY_MS / 1000 })
          : b.carryFailed({ subject, dir: bench.dir, base: bench.base_dir, path: detail.path ?? "", error }),
      );
    case "error":
      return owners(b.error({ subject, error }));
  }
}

/** The text of the note's task: what the agent does if the owner relaunches it, or what holds the bench for an owner's hold. */
function holdText(bench: BenchRow, hold: BenchHold): string {
  const at = `subject #${bench.subject_id} (${bench.dir}, branch ${bench.branch})`;
  switch (hold) {
    case "dirty":
      return `Your bench of subject #${bench.subject_id} (${bench.dir}) has changes that are not committed, so MyHQ cannot close it. Commit on ${bench.branch} what belongs to the subject, put aside what does not, then finish your turn: MyHQ merges ${bench.branch} into ${bench.base_branch} and closes the bench.`;
    case "conflict":
      return `Merging ${bench.branch} into ${bench.base_branch} conflicts: two of your subjects changed the same files. In your bench of subject #${bench.subject_id} (${bench.dir}), merge ${bench.base_branch} into ${bench.branch}, resolve the conflicts, commit, then finish your turn: MyHQ merges it and closes the bench.`;
    case "base":
      return `Your own worktree (${bench.base_dir}) has changes that are not committed, so MyHQ cannot merge the bench of subject #${bench.subject_id} into it. Commit on ${bench.base_branch} what belongs there, put aside what does not, then finish your turn.`;
    default:
      return `MyHQ keeps the bench of ${at} open until the owner settles what its note says.`;
  }
}

/**
 * Tells the owner what holds the closing back, on one stable entry per
 * bench: its note task (a blocked task of the agent on the Standard, MyHQ's
 * note said as written, handed to the owner, `blocked.ts`), created at the
 * first hold and kept until the bench closes. A later hold, or the same one,
 * rewrites its note and its text in place; a task that left « blocked » (the
 * owner closed it, or a relaunched run ended) is put back, so an open bench
 * never goes out of the owner's sight. A task pending or in progress, or one
 * a run blocked in its own words, is left as it is. Sets when the scheduler
 * tries the bench again. Returns the hold.
 */
function tell(db: Db, bench: BenchRow, hold: BenchHold, detail: HoldDetail = {}): BenchHold {
  const note = holdNote(db, bench, hold, detail);
  const text = holdText(bench, hold);
  // A hold of the agent's own worktree is settled there: a relaunch of its note works on the general subject.
  const subject = hold === "base" ? null : bench.subject_id;
  const at = now();
  db.transaction(() => {
    const task =
      bench.note_task_id === null
        ? undefined
        : (db.prepare("SELECT status, run_id FROM tasks WHERE id = ?").get(bench.note_task_id) as { status: string; run_id: number | null } | undefined);
    let id = bench.note_task_id;
    if (task === undefined) {
      id = Number(
        db
          .prepare(
            `INSERT INTO tasks (room, agent_id, source, text, status, note, subject_id, created_at, updated_at)
             VALUES (?, ?, 'manual', ?, 'blocked', ?, ?, ?, ?)`,
          )
          .run(bench.room, bench.agent_id, text, note, subject, at, at).lastInsertRowid,
      );
    } else if (task.status === "done" || (task.status === "blocked" && task.run_id === null)) {
      db.prepare(
        `UPDATE tasks SET status = 'blocked', run_id = NULL, text = ?, note = ?, subject_id = ?, updated_at = ?
         WHERE id = ? AND (status <> 'blocked' OR text IS NOT ? OR note IS NOT ? OR subject_id IS NOT ?)`,
      ).run(text, note, subject, at, id, text, note, subject);
    }
    db.prepare("UPDATE benches SET state = ?, tried = ?, note_task_id = ?, updated_at = ? WHERE subject_id = ?").run(
      hold,
      detail.tried ?? null,
      id,
      at,
      bench.subject_id,
    );
  }).immediate();
  heldAgain(bench.subject_id);
  return hold;
}

/** Whether `dir` is a Git worktree whose top is `dir` itself (`no`: missing, or not a repository); an error otherwise. */
function worktreeAt(dir: string, git: GitRun): "yes" | "no" | { error: string } {
  if (!fs.existsSync(dir)) return "no";
  const top = git(["rev-parse", "--show-toplevel"], dir);
  if (!top.ok) return top.code === 128 && /not a git repository/i.test(top.err) ? "no" : { error: top.err };
  try {
    const same = path.relative(fs.realpathSync.native(dir), fs.realpathSync.native(top.out)) === "";
    return same ? "yes" : { error: `${dir} is inside the repository ${top.out}, not a worktree of its own` };
  } catch (error) {
    return { error: String(error) };
  }
}

/** The first line of a file of the Git folder (MERGE_HEAD), or null. */
function readRef(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/)[0]!.trim() || null;
  } catch {
    return null;
  }
}

/** What marks an operation in progress in a worktree's own Git folder. */
const IN_PROGRESS = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"];

/** The most entries, and the longest time, the carrying of a bench's ignored files may take before the bench is held. */
export const CARRY_ENTRIES_MAX = 100_000;
export const CARRY_MS = 10_000;

type CarryStop = { budget: true } | { budget: false; path: string; error: string };

/** A file or folder of MyHQ's own in a working directory, never carried: the guards' settings, its `.claude/.gitignore`, a skill copy. */
function myhqOwn(benchDir: string, rel: string): boolean {
  const p = rel.split(path.sep).join("/");
  if (p === ".claude/settings.local.json" || p === ".claude/.gitignore") return true;
  return /^\.claude\/skills\/[^/]+$/.test(p) && isSkillCopy(path.join(benchDir, rel));
}

/** A folder that may hold MyHQ's own files: always descended into, never moved whole. */
const holdsMyhqOwn = (rel: string): boolean => {
  const p = rel.split(path.sep).join("/");
  return p === ".claude" || p === ".claude/skills";
};

/**
 * Carries what Git ignores in the bench into the agent's worktree, at the
 * same relative path, before the bench is removed: what the agent's worktree
 * does not have is moved (a whole ignored folder in one rename), a folder it
 * also has is descended into, and what it already has at that path is left
 * to go with the bench (a virtual environment, a cache, dependencies).
 * Nothing is overwritten, MyHQ's own files stay, no link is followed (a link
 * is moved as a link, and a file never lands through a link out of the
 * agent's worktree). Idempotent: what was moved before is no longer in the
 * bench. Returns why it stopped (the budget, or a move that failed), or null.
 */
function carryIgnored(benchDir: string, baseDir: string, git: GitRun): CarryStop | null {
  const listed = git(["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], benchDir);
  if (!listed.ok) return { budget: false, path: ".", error: oneLine(listed.err) };
  const baseReal = fs.realpathSync.native(baseDir);
  const deadline = Date.now() + CARRY_MS;
  let entries = 0;
  const visit = (rel: string): CarryStop | null => {
    if (++entries > CARRY_ENTRIES_MAX || Date.now() > deadline) return { budget: true };
    if (myhqOwn(benchDir, rel)) return null;
    const from = path.join(benchDir, rel);
    const to = path.join(baseDir, rel);
    try {
      const source = fs.lstatSync(from, { throwIfNoEntry: false });
      if (!source) return null;
      const target = fs.lstatSync(to, { throwIfNoEntry: false });
      if (source.isDirectory() && (holdsMyhqOwn(rel) || target?.isDirectory())) {
        for (const name of fs.readdirSync(from)) {
          const stop = visit(path.join(rel, name));
          if (stop) return stop;
        }
        return null;
      }
      if (target) return null;
      let existing = path.dirname(to);
      while (!fs.existsSync(existing)) existing = path.dirname(existing);
      if (!isInside(baseReal, fs.realpathSync.native(existing))) {
        return { budget: false, path: rel, error: strings.deskModules.standard.bench.carryOutside };
      }
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      return null;
    } catch (error) {
      return { budget: false, path: rel, error: (error as { code?: string }).code ?? String(error) };
    }
  };
  for (const entry of listed.out.split("\0")) {
    if (entry === "") continue;
    const stop = visit(path.normalize(entry.replace(/\/$/, "")));
    if (stop) return stop;
  }
  return null;
}

/**
 * Closes the bench of an archived subject, never losing work. In order
 * (docs/architecture.md, "Several benches", gives the Git commands):
 * 1. it waits (`busy`) while a run, a question or a task of the subject is
 *    going on; a held bench is tried again only once its wait is over,
 *    unless `force` (the end of a run of the agent, the owner asking);
 * 2. the agent's own worktree must be there (`baseMissing`);
 * 3. a bench whose folder is gone or no longer a worktree is forgotten by
 *    Git (`git worktree prune`) and its branch merged as usual; one that is
 *    there with changes Git does not ignore is kept (`dirty`);
 * 4. it waits (`busy`) while a run works in the agent's worktree; a merge
 *    of MyHQ's own left there (its MERGE_HEAD is the bench's tip) is
 *    aborted; any other operation in progress (`baseOperation`), another
 *    branch (`baseBranch`) or uncommitted changes (`base`) hold it;
 * 5. a branch with nothing new is not merged; a merge never overwrites an
 *    ignored file (`overwrite` when Git refuses); one that stops is aborted,
 *    a `conflict` when paths are unmerged (tried again only once a tip
 *    moved), an `error` otherwise;
 * 6. what Git ignores in the bench is carried into the agent's worktree
 *    (carryIgnored, `carry` when it cannot);
 * 7. the worktree is removed and the branch deleted, neither by force; a
 *    removal that fails once Git has forgotten the worktree (a file held
 *    open on Windows) leaves a remnant that is logged, and the bench closes.
 * Every Git call goes through `git` (runGit). Never throws.
 */
export function closeBench(db: Db, subjectId: number, git: GitRun = runGit, opts: { force?: boolean } = {}): BenchOutcome {
  try {
    const bench = db.prepare("SELECT * FROM benches WHERE subject_id = ? AND closed_at IS NULL").get(subjectId) as BenchRow | undefined;
    if (!bench) return "none";
    const subject = db.prepare("SELECT status FROM subjects WHERE id = ?").get(subjectId) as { status: string } | undefined;
    if (subject?.status !== "archived") return "open";
    if (benchBusy(db, subjectId)) return "busy";
    if (bench.state !== null && !opts.force && !retryDue(subjectId)) return "unchanged";
    return attempt(db, bench, git);
  } catch (error) {
    console.error(`[benches] the bench of subject #${subjectId} could not be closed`, error);
    return "error";
  }
}

function attempt(db: Db, bench: BenchRow, git: GitRun): BenchOutcome {
  const base = bench.base_dir;
  const error = (result: { err: string }, tried?: string) => tell(db, bench, "error", { tried, error: result.err });
  const baseThere = worktreeAt(base, git);
  if (baseThere === "no") return tell(db, bench, "baseMissing");
  if (baseThere !== "yes") return tell(db, bench, "error", { error: baseThere.error });

  const benchThere = worktreeAt(bench.dir, git);
  if (typeof benchThere === "object") return tell(db, bench, "error", { error: benchThere.error });
  const present = benchThere === "yes";
  if (present) {
    const changes = git(["--no-optional-locks", "status", "--porcelain"], bench.dir);
    if (!changes.ok) return error(changes);
    if (changes.out !== "") return tell(db, bench, "dirty");
  } else {
    // Removed by hand, half removed, or removed by a closing that stopped before recording it: Git forgets it, its branch is merged as usual.
    const pruned = git(["worktree", "prune"], base);
    if (!pruned.ok) return error(pruned);
  }
  if (baseBusy(db, bench)) return "busy";

  const benchTip = git(["rev-parse", "--verify", "--quiet", `refs/heads/${bench.branch}^{commit}`], base);
  if (!benchTip.ok && (present || benchTip.code !== 1)) return error(benchTip);
  // No bench and no branch: a closing that stopped after deleting it. Nothing is left to merge.
  if (!benchTip.ok) return finish(db, bench, git, null);

  const gitDir = git(["rev-parse", "--absolute-git-dir"], base);
  if (!gitDir.ok) return error(gitDir);
  if (readRef(path.join(gitDir.out, "MERGE_HEAD")) === benchTip.out) {
    // MyHQ's own merge, left half done by a crash or a timeout between the merge and its abort: undone first.
    const abort = git(["merge", "--abort"], base);
    if (!abort.ok) return error(abort);
  }
  if (IN_PROGRESS.some((name) => fs.existsSync(path.join(gitDir.out, name)))) return tell(db, bench, "baseOperation");
  const head = git(["symbolic-ref", "--quiet", "HEAD"], base);
  if (!head.ok && head.code !== 1) return error(head);
  if (!head.ok || head.out !== `refs/heads/${bench.base_branch}`) return tell(db, bench, "baseBranch");
  const changes = git(["--no-optional-locks", "status", "--porcelain"], base);
  if (!changes.ok) return error(changes);
  if (changes.out !== "") return tell(db, bench, "base");
  const baseTip = git(["rev-parse", "--verify", "HEAD^{commit}"], base);
  if (!baseTip.ok) return error(baseTip);

  const tried = `${benchTip.out} ${baseTip.out}`;
  if (bench.state === "conflict" && bench.tried === tried) {
    heldAgain(bench.subject_id);
    return "unchanged";
  }
  const merged = git(["merge-base", "--is-ancestor", benchTip.out, baseTip.out], base);
  if (!merged.ok && merged.code !== 1) return error(merged, tried);
  if (!merged.ok) {
    const merge = git(["merge", "--no-edit", "--no-overwrite-ignore", `refs/heads/${bench.branch}`], base);
    if (!merge.ok) {
      const unmerged = git(["ls-files", "--unmerged"], base);
      if (fs.existsSync(path.join(gitDir.out, "MERGE_HEAD"))) {
        const abort = git(["merge", "--abort"], base);
        if (!abort.ok) return tell(db, bench, "error", { tried, error: `git merge --abort: ${abort.err}` });
      }
      if (unmerged.ok && unmerged.out !== "") return tell(db, bench, "conflict", { tried });
      if (/would be overwritten by merge/i.test(merge.err)) return tell(db, bench, "overwrite", { tried, error: merge.err });
      return error(merge, tried);
    }
  }
  return finish(db, bench, git, present ? tried : null);
}

/** Carries the ignored files, removes the bench when it is there (`tried` given), deletes its branch, records it closed. */
function finish(db: Db, bench: BenchRow, git: GitRun, tried: string | null): BenchOutcome {
  const base = bench.base_dir;
  if (tried !== null) {
    const stop = carryIgnored(bench.dir, base, git);
    if (stop) return tell(db, bench, "carry", stop.budget ? { tried, budget: true } : { tried, path: stop.path, error: stop.error });
    const removed = git(["worktree", "remove", bench.dir], base);
    if (!removed.ok) {
      const still = worktreeAt(bench.dir, git);
      if (still !== "no") return tell(db, bench, "error", { tried, error: removed.err });
      console.error(`[benches] Git forgot the bench of subject #${bench.subject_id} but could not remove all of ${bench.dir} (${oneLine(removed.err)}): what is left there is no longer Git's, and the bench is closed`);
    }
  } else if (fs.existsSync(bench.dir)) {
    console.error(`[benches] ${bench.dir}, the bench of subject #${bench.subject_id}, is no longer a Git worktree: left as it is, and the bench is closed`);
  }
  if (git(["rev-parse", "--verify", "--quiet", `refs/heads/${bench.branch}`], base).ok) {
    // `git branch -d` acts on branches only (a tag of the same name never matters) and refuses an unmerged branch or one checked out elsewhere.
    const deleted = git(["branch", "-d", bench.branch], base);
    // Merged, so nothing is lost: a branch Git refuses to delete stays, and the bench is closed all the same.
    if (!deleted.ok) console.error(`[benches] the branch ${bench.branch} of the closed bench of subject #${bench.subject_id} was kept: ${oneLine(deleted.err)}`);
  }
  const at = now();
  db.transaction(() => {
    db.prepare("UPDATE benches SET closed_at = ?, state = NULL, tried = NULL, updated_at = ? WHERE subject_id = ?").run(at, at, bench.subject_id);
    if (bench.note_task_id !== null) {
      db.prepare("UPDATE tasks SET status = 'done', note = ?, updated_at = ? WHERE id = ? AND status IN ('blocked', 'pending')").run(
        strings.deskModules.standard.bench.solved,
        at,
        bench.note_task_id,
      );
    }
  }).immediate();
  retries.delete(bench.subject_id);
  return "closed";
}

/**
 * Tries again to close every open bench of an archived subject (of one agent
 * when given): what waited for a run, a question or the agent's worktree,
 * and, once its wait is over or with `force`, what was told to the owner (a
 * bench made clean since closes). Called at each tick of the scheduler, and
 * with `force` at the end of each run of the agent. Never throws.
 */
export function closeArchivedBenches(db: Db, opts: { of?: { room: string; agentId: string }; force?: boolean; git?: GitRun } = {}): void {
  const { of } = opts;
  try {
    const rows = db
      .prepare(
        `SELECT b.subject_id FROM benches b JOIN subjects s ON s.id = b.subject_id
         WHERE b.closed_at IS NULL AND s.status = 'archived'${of ? " AND b.room = ? AND b.agent_id = ?" : ""} ORDER BY b.subject_id`,
      )
      .all(...(of ? [of.room, of.agentId] : [])) as { subject_id: number }[];
    for (const row of rows) closeBench(db, row.subject_id, opts.git, { force: opts.force });
  } catch (error) {
    console.error("[benches] the benches of archived subjects could not be looked at", error);
  }
}

/**
 * Whether a task is MyHQ's note on a bench, as MyHQ wrote it (said as written
 * on the Standard); a task a run took since (its own words, a failed run) is not.
 */
export const isBenchNote = (db: Db, taskId: number): boolean =>
  db.prepare("SELECT 1 FROM benches b JOIN tasks t ON t.id = b.note_task_id WHERE b.note_task_id = ? AND t.run_id IS NULL").get(taskId) !== undefined;

/**
 * « Relancer » on an entry that holds MyHQ's note on an open bench: the
 * closing is tried again at once. Returns `BENCH_CLOSED` when it closed,
 * `BENCH_HELD` when it is still held for a reason only the owner settles
 * (no run is started for it), or null: the relaunch goes on as usual and a
 * run of the agent settles the hold (commit, resolve a conflict).
 */
export function retryBenchNote(db: Db, taskIds: readonly number[], git: GitRun = runGit): "BENCH_CLOSED" | "BENCH_HELD" | null {
  const row = db
    .prepare("SELECT subject_id FROM benches WHERE closed_at IS NULL AND note_task_id IN (SELECT value FROM json_each(?)) LIMIT 1")
    .get(JSON.stringify(taskIds)) as { subject_id: number } | undefined;
  if (!row) return null;
  closeBench(db, row.subject_id, git, { force: true });
  const after = db.prepare("SELECT state, closed_at FROM benches WHERE subject_id = ?").get(row.subject_id) as { state: string | null; closed_at: string | null };
  if (after.closed_at !== null) return "BENCH_CLOSED";
  return after.state !== null && !AGENT_HOLDS.has(after.state) ? "BENCH_HELD" : null;
}
