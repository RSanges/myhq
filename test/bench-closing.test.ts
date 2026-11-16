import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { benchOf, closeArchivedBenches, closeBench, runGit, type GitRun } from "../src/server/benches";
import { listBlocked } from "../src/server/blocked";
import type { Db, TaskRow } from "../src/server/db";
import type { Engine, RunEvent, RunInput } from "../src/server/engine";
import { loadHome } from "../src/server/rooms";
import { startRun } from "../src/server/runner";
import { createSubject, settleSubject, updateSubject } from "../src/server/subjects";
import { strings } from "../src/ui/strings";
import { benchRow, commit, done, git, office, quiet, read, run, workingEngine } from "./bench-helpers";
import { waitForRun } from "./helpers";

// Closing a bench once its subject is archived (docs/architecture.md, "Several
// benches"), on throwaway repositories: merged when clean, kept and told to
// the owner otherwise, never by force.

const b = strings.deskModules.standard.bench;

/** Every Git call of a closing, recorded, run for real. */
export function recordingGit(calls: string[][]): GitRun {
  return (args, cwd) => {
    calls.push([...args]);
    return runGit(args, cwd);
  };
}

export const taskRow = (db: Db, id: number) => db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow;
export const branchExists = (repo: string, branch: string) => git(repo, "branch", "--list", branch) !== "";
export const archive = (db: Db, id: number) => updateSubject(db, "demo", "dev", id, { status: "archived" });


test("closing: a clean bench is merged into the agent's branch, removed and its branch deleted, never by force; nothing new needs no merge", async () => {
  const { repo, config, db, agent, base } = office();
  const one = createSubject(db, "demo", "dev", "One");
  const two = createSubject(db, "demo", "dev", "Two");
  const engine = workingEngine({ "Work on one.": (dir) => commit(dir, "one.txt", "one\n") });
  await run(config, db, engine, "Work on one.", one.id);
  await run(config, db, engine, "Look at two.", two.id);
  const benchOne = benchOf(agent, one.id)!;
  const calls: string[][] = [];

  db.prepare("UPDATE subjects SET status = 'archived' WHERE id = ?").run(one.id);
  assert.equal(closeBench(db, one.id, recordingGit(calls)), "closed");
  assert.ok(!fs.existsSync(benchOne.dir), "the bench is removed");
  assert.ok(!branchExists(repo, benchOne.branch), "its branch deleted");
  assert.equal(read(path.join(base, "one.txt")), "one\n", "its work merged into the agent's worktree");
  assert.ok(benchRow(db, one.id)?.closed_at);
  assert.ok(calls.some((args) => args[0] === "merge"));

  const head = git(base, "rev-parse", "HEAD");
  db.prepare("UPDATE subjects SET status = 'archived' WHERE id = ?").run(two.id);
  assert.equal(closeBench(db, two.id, recordingGit(calls)), "closed");
  assert.equal(git(base, "rev-parse", "HEAD"), head, "a branch with nothing new is not merged");
  assert.equal(calls.filter((args) => args[0] === "merge").length, 1);
  for (const args of calls) {
    for (const flag of ["--force", "-f", "-D", "--hard"]) assert.ok(!args.includes(flag), `never ${flag}: git ${args.join(" ")}`);
  }
  assert.equal(closeBench(db, two.id), "none", "a closed bench is not closed again");
});

test("a subject validated closes itself, and its bench with it; the owner's archive does the same", async () => {
  const { repo, config, db, agent } = office();
  const one = createSubject(db, "demo", "dev", "One");
  const two = createSubject(db, "demo", "dev", "Two");
  const engine = workingEngine({ "Work on one.": (dir) => commit(dir, "one.txt", "one\n"), "Work on two.": (dir) => commit(dir, "two.txt", "two\n") });
  await run(config, db, engine, "Work on one.", one.id);
  await run(config, db, engine, "Work on two.", two.id);
  const at = new Date().toISOString();
  db.prepare(
    `INSERT INTO approvals (room, agent_id, type, title, body, payload, status, created_at, decided_at, subject_id)
     VALUES ('demo', 'dev', 'article', 'One', 'B', '{}', 'approved', ?, ?, ?)`,
  ).run(at, at, one.id);
  assert.equal(settleSubject(db, one.id), true);
  assert.ok(!fs.existsSync(benchOf(agent, one.id)!.dir));
  assert.ok(!branchExists(repo, benchOf(agent, one.id)!.branch));
  archive(db, two.id);
  assert.ok(!fs.existsSync(benchOf(agent, two.id)!.dir));
  assert.ok(benchRow(db, two.id)?.closed_at);
});

test("closing: uncommitted work keeps the bench and tells the owner once; committed, it closes", async () => {
  const { config, db, agent, base } = office();
  const one = createSubject(db, "demo", "dev", "One");
  const engine = workingEngine({ "Work on one.": (dir) => fs.writeFileSync(path.join(dir, "draft.txt"), "not committed\n") });
  await run(config, db, engine, "Work on one.", one.id);
  const bench = benchOf(agent, one.id)!;
  archive(db, one.id);
  assert.ok(fs.existsSync(path.join(bench.dir, "draft.txt")), "nothing is lost");
  const row = benchRow(db, one.id)!;
  assert.equal(row.state, "dirty");
  const note = taskRow(db, row.note_task_id!);
  assert.equal(note.status, "blocked");
  assert.equal(note.subject_id, one.id);
  assert.equal(note.note, b.dirty({ subject: "« One »", dir: bench.dir, branch: bench.branch }));
  const entry = listBlocked(db, loadHome(config.home), config).find((each) => each.id === note.id);
  assert.equal(entry?.cause, "myhqNote");
  assert.equal(entry?.reason, note.note, "said as written");
  // Again and again: no second note.
  closeArchivedBenches(db);
  closeArchivedBenches(db);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE source = 'manual' AND status = 'blocked'").get() as { n: number }).n, 1);

  git(bench.dir, "add", "draft.txt");
  git(bench.dir, "commit", "-q", "-m", "Keep the draft");
  closeArchivedBenches(db);
  assert.ok(benchRow(db, one.id)?.closed_at);
  assert.ok(fs.existsSync(path.join(base, "draft.txt")));
  assert.equal(taskRow(db, note.id).status, "done", "MyHQ's note is settled with it");
});

test("closing: a conflict aborts the merge, keeps the bench, says the two branches once; resolved, it closes", async () => {
  const { config, db, agent, base } = office();
  const one = createSubject(db, "demo", "dev", "One");
  const two = createSubject(db, "demo", "dev", "Two");
  const engine = workingEngine({
    "Work on one.": (dir) => commit(dir, "README.md", "# One's way\n"),
    "Work on two.": (dir) => commit(dir, "README.md", "# Two's way\n"),
  });
  await run(config, db, engine, "Work on one.", one.id);
  await run(config, db, engine, "Work on two.", two.id);
  archive(db, one.id);
  assert.ok(benchRow(db, one.id)?.closed_at);
  const calls: string[][] = [];
  db.prepare("UPDATE subjects SET status = 'archived' WHERE id = ?").run(two.id);
  assert.equal(closeBench(db, two.id, recordingGit(calls)), "conflict");
  const bench = benchOf(agent, two.id)!;
  assert.ok(fs.existsSync(bench.dir), "the bench is kept");
  assert.equal(git(base, "status", "--porcelain"), "", "the merge was aborted cleanly");
  assert.throws(() => git(base, "rev-parse", "-q", "--verify", "MERGE_HEAD"));
  assert.equal(read(path.join(base, "README.md")), "# One's way\n");
  const row = benchRow(db, two.id)!;
  assert.equal(taskRow(db, row.note_task_id!).note, b.conflict({ subject: "« Two »", branch: bench.branch, base: "hq/dev" }));
  // The same tips: not tried again, not told again.
  assert.equal(closeBench(db, two.id, recordingGit(calls)), "unchanged");
  assert.equal(calls.filter((args) => args[0] === "merge" && args[1] !== "--abort").length, 1);
  assert.ok(calls.some((args) => args.join(" ") === "merge --abort"));

  // The agent merges the agent's branch into its bench and resolves.
  try {
    git(bench.dir, "merge", "hq/dev");
  } catch {
    // The conflict, as expected.
  }
  fs.writeFileSync(path.join(bench.dir, "README.md"), "# Both ways\n");
  git(bench.dir, "add", "README.md");
  git(bench.dir, "commit", "-q", "--no-edit");
  assert.equal(closeBench(db, two.id, recordingGit(calls)), "closed");
  assert.equal(read(path.join(base, "README.md")), "# Both ways\n");
  assert.equal(taskRow(db, row.note_task_id!).status, "done");
  for (const args of calls) for (const flag of ["--force", "-f", "-D", "--hard"]) assert.ok(!args.includes(flag));
});

test("closing waits while the agent's worktree is busy or dirty, then closes; a reopened subject gets a fresh bench", async () => {
  const { config, db, agent, base } = office();
  const one = createSubject(db, "demo", "dev", "One");
  await run(config, db, workingEngine({ "Work on one.": (dir) => commit(dir, "one.txt", "one\n") }), "Work on one.", one.id);
  const bench = benchOf(agent, one.id)!;

  // A run of the general subject works in the agent's worktree: the closing waits, and says nothing.
  let open = () => {};
  const gate = new Promise<void>((resolve) => (open = resolve));
  const held: Engine = {
    name: "claude",
    async *run(): AsyncIterable<RunEvent> {
      await gate;
      yield done;
    },
  };
  const general = startRun({ room: "demo", agent: "dev", task: "Routine." }, { config, engine: held, send: quiet });
  archive(db, one.id);
  assert.equal(closeBench(db, one.id), "busy");
  assert.equal(benchRow(db, one.id)?.state, null, "nothing told for a wait that passes");
  assert.ok(fs.existsSync(bench.dir));
  open();
  await waitForRun(db, general.id);
  assert.ok(benchRow(db, one.id)?.closed_at, "the end of that run closes it");
  assert.ok(fs.existsSync(path.join(base, "one.txt")));

  // Reopened: its next run gets a fresh bench, from the agent's branch as it is now.
  updateSubject(db, "demo", "dev", one.id, { status: "open" });
  const seen: RunInput[] = [];
  await run(config, db, workingEngine({ "Work on one again.": (dir) => commit(dir, "again.txt", "again\n") }, seen), "Work on one again.", one.id);
  assert.equal(seen[0]!.workDir, bench.dir);
  assert.ok(fs.existsSync(path.join(bench.dir, "one.txt")), "with the work merged before");
  assert.equal(benchRow(db, one.id)?.closed_at, null);

  // The agent's worktree with uncommitted changes: told once, then closed once clean.
  fs.writeFileSync(path.join(base, "stray.txt"), "left by a general run\n");
  archive(db, one.id);
  const row = benchRow(db, one.id)!;
  assert.equal(row.state, "base");
  assert.equal(taskRow(db, row.note_task_id!).subject_id, null, "settled in the agent's worktree: a relaunch works on the general subject");
  assert.ok(fs.existsSync(bench.dir));
  fs.rmSync(path.join(base, "stray.txt"));
  closeArchivedBenches(db);
  assert.ok(benchRow(db, one.id)?.closed_at);
  assert.ok(fs.existsSync(path.join(base, "again.txt")));
  assert.equal(taskRow(db, row.note_task_id!).status, "done");
});
