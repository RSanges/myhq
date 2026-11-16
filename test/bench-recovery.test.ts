import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { benchOf, closeArchivedBenches, closeBench, runGit, type GitRun } from "../src/server/benches";
import { closeBlocked, listBlocked, relaunchBlocked } from "../src/server/blocked";
import type { Db } from "../src/server/db";
import type { Engine, RunEvent, RunInput } from "../src/server/engine";
import { idSchema, loadHome } from "../src/server/rooms";
import { entryRule } from "../src/server/supervisor";
import { createSubject, updateSubject } from "../src/server/subjects";
import { strings } from "../src/ui/strings";
import { benchRow, commit, done, git, office, quiet, read, run, workingEngine } from "./bench-helpers";
import { waitForRun } from "./helpers";

// What a closing does when things are not as planned (docs/architecture.md,
// "Several benches"): ignored outputs, a bench gone or half removed, the
// agent's worktree in an unusual state, Git errors, name collisions; and the
// one stable note per bench that costs no run. On throwaway repositories.

const b = strings.deskModules.standard.bench;
const FORCE_FLAGS = ["--force", "-f", "-D", "--hard"];

/** Every Git call of a closing, recorded and run for real; `instead` may answer a call in its place. */
function recording(calls: string[][], instead?: (args: readonly string[], cwd: string) => ReturnType<GitRun> | undefined): GitRun {
  return (args, cwd) => {
    calls.push([...args]);
    return instead?.(args, cwd) ?? runGit(args, cwd);
  };
}

/** Never by force, whatever path the closing took. */
function neverForced(calls: string[][]): void {
  for (const args of calls) for (const flag of FORCE_FLAGS) assert.ok(!args.includes(flag), `never ${flag}: git ${args.join(" ")}`);
}

const archive = (db: Db, id: number) => db.prepare("UPDATE subjects SET status = 'archived' WHERE id = ?").run(id);
const noteOf = (db: Db, subject: number) => {
  const id = benchRow(db, subject)!.note_task_id!;
  return db.prepare("SELECT id, status, note, text, subject_id FROM tasks WHERE id = ?").get(id) as {
    id: number;
    status: string;
    note: string;
    text: string;
    subject_id: number | null;
  };
};
const mergeHead = (dir: string): string | null => {
  try {
    return git(dir, "rev-parse", "-q", "--verify", "MERGE_HEAD");
  } catch {
    return null;
  }
};

/** A home whose agent did one subject's work, committed on its bench. */
async function oneSubject(work: (dir: string) => void = (dir) => commit(dir, "one.txt", "one\n"), extra: Record<string, unknown> = {}) {
  const o = office(extra);
  const one = createSubject(o.db, "demo", "dev", "One");
  await run(o.config, o.db, workingEngine({ "Work.": work }), "Work.", one.id);
  return { ...o, one, bench: benchOf(o.agent, one.id)! };
}

test("closing carries the bench's ignored outputs into the agent's worktree, never over what is there, never MyHQ's own files", async () => {
  const { config, db, base } = office();
  await run(config, db, workingEngine({ "General.": (dir) => commit(dir, ".gitignore", "out/\ncache/\n") }), "General.");
  // The agent's worktree already has a cache, with a file of the same path.
  fs.mkdirSync(path.join(base, "cache"), { recursive: true });
  fs.writeFileSync(path.join(base, "cache", "a.txt"), "base's a\n");
  const one = createSubject(db, "demo", "dev", "One");
  const work = (dir: string) => {
    fs.mkdirSync(path.join(dir, "out", "renders"), { recursive: true });
    fs.writeFileSync(path.join(dir, "out", "renders", "render.mp4"), "the render\n");
    fs.mkdirSync(path.join(dir, "cache"), { recursive: true });
    fs.writeFileSync(path.join(dir, "cache", "a.txt"), "bench's a\n");
    fs.writeFileSync(path.join(dir, "cache", "b.txt"), "bench's b\n");
  };
  await run(config, db, workingEngine({ "Work.": work }), "Work.", one.id);
  const bench = benchOf(loadHome(config.home).rooms[0]!.agents[0]!, one.id)!;
  assert.ok(fs.existsSync(path.join(bench.dir, ".claude", "settings.local.json")), "MyHQ's own settings are in the bench");
  fs.rmSync(path.join(base, ".claude"), { recursive: true, force: true });
  archive(db, one.id);
  const calls: string[][] = [];
  assert.equal(closeBench(db, one.id, recording(calls)), "closed");
  assert.ok(!fs.existsSync(bench.dir), "the bench is removed");
  assert.equal(read(path.join(base, "out", "renders", "render.mp4")), "the render\n", "a whole ignored folder is moved");
  assert.equal(read(path.join(base, "cache", "a.txt")), "base's a\n", "never overwritten");
  assert.equal(read(path.join(base, "cache", "b.txt")), "bench's b\n", "a folder both have is descended into");
  assert.ok(!fs.existsSync(path.join(base, ".claude", "settings.local.json")), "MyHQ's own files are not carried");
  assert.equal(git(base, "status", "--porcelain"), "");
  neverForced(calls);
});

test("ignored outputs that cannot be carried hold the merged bench, and nothing is deleted", async () => {
  const { db, base, one, bench } = await oneSubject((dir) => {
    commit(dir, ".gitignore", "out/\n");
    fs.mkdirSync(path.join(dir, "out"));
    fs.writeFileSync(path.join(dir, "out", "render.mp4"), "the render\n");
  });
  archive(db, one.id);
  const calls: string[][] = [];
  const failing = recording(calls, (args) => (args[0] === "ls-files" ? { ok: false, code: 128, out: "", err: "fatal: simulated" } : undefined));
  assert.equal(closeBench(db, one.id, failing), "carry");
  assert.ok(fs.existsSync(path.join(bench.dir, "out", "render.mp4")), "the render stays in the bench");
  assert.ok(fs.existsSync(path.join(base, ".gitignore")), "the merge was done");
  assert.match(noteOf(db, one.id).note, /n'a pas pu reporter/);
  assert.ok(!calls.some((args) => args[0] === "worktree" && args[1] === "remove"));
  // Asked again: carried, removed.
  assert.equal(closeBench(db, one.id, recording(calls), { force: true }), "closed");
  assert.equal(read(path.join(base, "out", "render.mp4")), "the render\n");
  neverForced(calls);
});

test("the merge never overwrites an ignored file of the agent's worktree: held, said, nothing touched", async () => {
  const o = office();
  await run(o.config, o.db, workingEngine({ "General.": (dir) => commit(dir, ".gitignore", "local.env\n") }), "General.");
  fs.writeFileSync(path.join(o.base, "local.env"), "the owner's configuration\n");
  const one = createSubject(o.db, "demo", "dev", "One");
  const work = (dir: string) => {
    fs.writeFileSync(path.join(dir, "local.env"), "the bench's version\n");
    git(dir, "add", "-f", "local.env");
    git(dir, "commit", "-q", "-m", "Add local.env");
  };
  await run(o.config, o.db, workingEngine({ "Work.": work }), "Work.", one.id);
  archive(o.db, one.id);
  const calls: string[][] = [];
  assert.equal(closeBench(o.db, one.id, recording(calls)), "overwrite");
  assert.equal(read(path.join(o.base, "local.env")), "the owner's configuration\n");
  assert.equal(mergeHead(o.base), null);
  assert.ok(calls.some((args) => args[0] === "merge" && args.includes("--no-overwrite-ignore")));
  assert.match(noteOf(o.db, one.id).note, /écraserait/);
  neverForced(calls);
});

test("a Git error is retried with a growing wait, never latched on the same tips; a forced try closes once it passes", async () => {
  const { db, base, one } = await oneSubject();
  const gitDir = git(base, "rev-parse", "--absolute-git-dir");
  fs.writeFileSync(path.join(gitDir, "index.lock"), "");
  archive(db, one.id);
  const calls: string[][] = [];
  assert.equal(closeBench(db, one.id, recording(calls)), "error");
  assert.match(noteOf(db, one.id).note, /Git a répondu : .*index\.lock/);
  fs.rmSync(path.join(gitDir, "index.lock"));
  const before = calls.length;
  closeArchivedBenches(db, { git: recording(calls) });
  assert.equal(calls.length, before, "the tick waits: no Git call before the wait is over");
  assert.equal(closeBench(db, one.id, recording(calls), { force: true }), "closed", "the same tips are tried again after an error");
  assert.ok(fs.existsSync(path.join(base, "one.txt")));
  assert.equal(noteOf(db, one.id).status, "done");
  neverForced(calls);
});

test("a locked bench is held once and not tried again at every tick", async () => {
  const { db, base, one, bench } = await oneSubject();
  git(base, "worktree", "lock", bench.dir);
  archive(db, one.id);
  const calls: string[][] = [];
  assert.equal(closeBench(db, one.id, recording(calls)), "error");
  const first = calls.length;
  closeArchivedBenches(db, { git: recording(calls) });
  closeArchivedBenches(db, { git: recording(calls) });
  assert.equal(calls.length, first);
  assert.equal(calls.filter((args) => args[0] === "merge").length, 1);
  neverForced(calls);
});

test("a bench deleted by hand: forgotten by Git, its branch merged, closed; the reopened subject works again", async () => {
  const { config, db, base, one, bench } = await oneSubject();
  fs.rmSync(bench.dir, { recursive: true, force: true });
  archive(db, one.id);
  const calls: string[][] = [];
  assert.equal(closeBench(db, one.id, recording(calls)), "closed");
  assert.ok(calls.some((args) => args.join(" ") === "worktree prune"));
  assert.ok(fs.existsSync(path.join(base, "one.txt")), "its committed work is merged");
  assert.ok(!git(base, "worktree", "list").includes(bench.dir.split(path.sep).join("/")));
  neverForced(calls);

  // Deleted while open: the next run makes it again from its branch.
  updateSubject(db, "demo", "dev", one.id, { status: "open" });
  assert.equal((await run(config, db, workingEngine({ "Again.": (dir) => commit(dir, "again.txt", "again\n") }), "Again.", one.id)).status, "done");
  fs.rmSync(bench.dir, { recursive: true, force: true });
  const again = await run(config, db, workingEngine({}), "Once more.", one.id);
  assert.equal(again.status, "done", "no 'missing but already registered worktree'");
  assert.ok(fs.existsSync(path.join(bench.dir, "again.txt")));
});

test("a closing that stopped after removing the bench, or after deleting its branch, finishes on the next try", async () => {
  const { repo, db, base, one, bench } = await oneSubject();
  git(base, "merge", "--no-edit", bench.branch);
  git(base, "worktree", "remove", bench.dir);
  archive(db, one.id);
  assert.equal(closeBench(db, one.id), "closed");
  assert.equal(git(repo, "branch", "--list", bench.branch), "");

  const o = await oneSubject();
  git(o.base, "merge", "--no-edit", o.bench.branch);
  git(o.base, "worktree", "remove", o.bench.dir);
  git(o.base, "branch", "-d", o.bench.branch);
  archive(o.db, o.one.id);
  assert.equal(closeBench(o.db, o.one.id), "closed");
});

test("a half removed bench (Git forgot it, a file was held open) closes, its remnant left and never taken for the home's own repository", async () => {
  const { config, db, base, one, bench } = await oneSubject((dir) => {
    commit(dir, "a.txt", "a\n");
    commit(dir, "z.txt", "z\n");
  });
  // The home is a Git repository of its own, as a home that versions its rooms is.
  git(config.home, "init", "-q");
  archive(db, one.id);
  const calls: string[][] = [];
  const halfRemove = recording(calls, (args) => {
    if (args[0] !== "worktree" || args[1] !== "remove") return undefined;
    // What Windows leaves when a file is held open: the rest deleted, the worktree unregistered, the removal failed.
    for (const name of fs.readdirSync(bench.dir)) if (name !== "z.txt") fs.rmSync(path.join(bench.dir, name), { recursive: true, force: true });
    runGit(["worktree", "prune"], base);
    return { ok: false, code: 255, out: "", err: `error: failed to delete '${bench.dir}': Directory not empty` };
  });
  assert.equal(closeBench(db, one.id, halfRemove), "closed");
  assert.deepEqual(fs.readdirSync(bench.dir), ["z.txt"], "the remnant is left as it is");
  assert.ok(fs.existsSync(path.join(base, "z.txt")), "the work is merged");
  assert.equal(benchRow(db, one.id)?.state, null);
  neverForced(calls);
});

test("someone's merge in progress in the agent's worktree is left alone: held, said, never aborted", async () => {
  const { db, base, one } = await oneSubject();
  git(base, "checkout", "-q", "-b", "side");
  commit(base, "side.txt", "s\n");
  git(base, "checkout", "-q", "hq/dev");
  git(base, "merge", "-s", "ours", "--no-commit", "side");
  const theirs = mergeHead(base);
  assert.ok(theirs);
  archive(db, one.id);
  const calls: string[][] = [];
  assert.equal(closeBench(db, one.id, recording(calls)), "baseOperation");
  assert.equal(mergeHead(base), theirs, "their merge is still in progress");
  assert.ok(!calls.some((args) => args[0] === "merge"));
  assert.equal(noteOf(db, one.id).note, `${b.baseOperation({ subject: "« One »", dir: base })} ${b.retry}`);
});

test("MyHQ's own merge left half done is aborted first, and the conflict told as a conflict", async () => {
  const { db, base, one, bench } = await oneSubject((dir) => commit(dir, "README.md", "one\n"));
  commit(base, "README.md", "base\n");
  assert.throws(() => git(base, "merge", "--no-edit", bench.branch));
  archive(db, one.id);
  const calls: string[][] = [];
  assert.equal(closeBench(db, one.id, recording(calls)), "conflict");
  assert.equal(git(base, "status", "--porcelain"), "", "no conflict markers left to commit");
  assert.equal(mergeHead(base), null);
  assert.equal(benchRow(db, one.id)?.state, "conflict");
  neverForced(calls);
});

test("a merge that stops without a conflict (a commit signature that fails) is aborted and told as an error", async () => {
  const { repo, config, db, base, one } = await oneSubject();
  await run(config, db, workingEngine({ "General.": (dir) => commit(dir, "general.txt", "g\n") }), "General.");
  git(repo, "config", "commit.gpgsign", "true");
  git(repo, "config", "gpg.program", path.join(os.tmpdir(), "myhq-no-such-gpg"));
  archive(db, one.id);
  const calls: string[][] = [];
  assert.equal(closeBench(db, one.id, recording(calls)), "error");
  assert.equal(mergeHead(base), null);
  assert.equal(git(base, "status", "--porcelain"), "");
  neverForced(calls);
});

test("a tag named like the bench's branch changes nothing: full refs everywhere", async () => {
  const { repo, db, base, one, bench } = await oneSubject();
  git(repo, "tag", bench.branch, "hq/dev");
  archive(db, one.id);
  const calls: string[][] = [];
  assert.equal(closeBench(db, one.id, recording(calls)), "closed");
  assert.ok(fs.existsSync(path.join(base, "one.txt")), "the bench's work, not the tag's");
  assert.equal(git(repo, "branch", "--list", bench.branch), "");
  assert.ok(calls.some((args) => args[0] === "merge" && args.includes(`refs/heads/${bench.branch}`)));
  assert.ok(calls.some((args) => args.join(" ") === "symbolic-ref --quiet HEAD"));
  neverForced(calls);
});

test("an agent id cannot name another agent's bench", () => {
  const { agent } = office();
  const bench = benchOf(agent, 1)!;
  assert.equal(bench.branch, "hq/dev.subject-1");
  assert.equal(path.basename(bench.dir), "dev.subject-1");
  assert.equal(idSchema.safeParse("dev.subject-1").success, false, "an agent id never holds the separator");
  assert.equal(idSchema.safeParse("dev--subject-1").success, true, "which the old one was not");
});

test("the agent's worktree missing is said as such, not as uncommitted changes", async () => {
  const { db, base, one } = await oneSubject();
  fs.renameSync(base, `${base}-moved`);
  archive(db, one.id);
  assert.equal(closeBench(db, one.id), "baseMissing");
  assert.equal(noteOf(db, one.id).note, `${b.baseMissing({ subject: "« One »", dir: base })} ${b.retry}`);
});

test("one stable note per bench, the owner's: rewritten as the hold changes, put back when closed, never a run of the supervisor", async () => {
  const { config, db, base, one, bench } = await oneSubject((dir) => fs.writeFileSync(path.join(dir, "d.txt"), "x"));
  archive(db, one.id);
  closeArchivedBenches(db, { force: true });
  assert.equal(benchRow(db, one.id)?.state, "dirty");
  git(bench.dir, "add", "d.txt");
  git(bench.dir, "commit", "-q", "-m", "d");
  fs.writeFileSync(path.join(base, "stray.txt"), "s");
  closeArchivedBenches(db, { force: true });
  assert.equal(benchRow(db, one.id)?.state, "base");
  fs.writeFileSync(path.join(bench.dir, "e.txt"), "e");
  closeArchivedBenches(db, { force: true });
  fs.rmSync(path.join(bench.dir, "e.txt"));
  closeArchivedBenches(db, { force: true });
  const notes = db.prepare("SELECT id FROM tasks WHERE source = 'manual' AND run_id IS NULL").all();
  assert.equal(notes.length, 1, "one task across four holds");
  const note = noteOf(db, one.id);
  assert.equal(note.note, b.base({ subject: "« One »", dir: base, base: "hq/dev" }));
  assert.equal(note.subject_id, null);

  const home = loadHome(config.home);
  const entry = listBlocked(db, home, config).find((each) => each.id === note.id)!;
  assert.equal(entry.handedOff, true);
  assert.equal(entry.cause, "bench");
  assert.equal(entryRule(entry).kind, "wait");

  // The owner closes it while the bench is still held: it comes back at the next try.
  closeBlocked(db, { kind: "task", id: note.id });
  closeArchivedBenches(db, { force: true });
  assert.equal(noteOf(db, one.id).status, "blocked");
  assert.equal(noteOf(db, one.id).id, note.id);
});

test("« Relancer » on a bench note tries the closing again first: a hold of the owner's starts no run, a bench that closes neither", async () => {
  const { config, db, base, one } = await oneSubject();
  git(base, "checkout", "-q", "-b", "elsewhere");
  archive(db, one.id);
  closeBench(db, one.id);
  const note = noteOf(db, one.id);
  assert.equal(benchRow(db, one.id)?.state, "baseBranch");
  const runs = () => (db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n;
  const before = runs();
  const held = relaunchBlocked(config, db, { kind: "task", id: note.id }, { engine: workingEngine({}), send: quiet });
  assert.equal(held.waiting?.code, "BENCH_HELD");
  assert.equal(runs(), before);
  assert.equal(noteOf(db, one.id).status, "blocked");
  git(base, "checkout", "-q", "hq/dev");
  const closed = relaunchBlocked(config, db, { kind: "task", id: note.id }, { engine: workingEngine({}), send: quiet });
  assert.equal(closed.waiting?.code, "BENCH_CLOSED");
  assert.equal(runs(), before);
  assert.equal(noteOf(db, one.id).status, "done");
  assert.ok(benchRow(db, one.id)?.closed_at);
});

test("« Relancer » on uncommitted work in the bench asks the agent, whose run's end closes the bench", async () => {
  const { config, db, base, one, bench } = await oneSubject((dir) => fs.writeFileSync(path.join(dir, "draft.txt"), "draft\n"));
  archive(db, one.id);
  assert.equal(closeBench(db, one.id), "dirty");
  const note = noteOf(db, one.id);
  const seen: RunInput[] = [];
  const committing: Engine = {
    name: "claude",
    async *run(input: RunInput): AsyncIterable<RunEvent> {
      seen.push(input);
      if (fs.existsSync(path.join(input.workDir, "draft.txt"))) {
        git(input.workDir, "add", "draft.txt");
        git(input.workDir, "commit", "-q", "-m", "Keep the draft");
      }
      yield done;
    },
  };
  const relaunch = relaunchBlocked(config, db, { kind: "task", id: note.id }, { engine: committing, send: quiet });
  assert.ok(relaunch.run, "a run starts for what the agent settles");
  await waitForRun(db, relaunch.run!.id);
  assert.equal(seen[0]!.workDir, bench.dir);
  assert.ok(seen[0]!.prompt.includes(note.text), "the note's text is its task");
  assert.ok(benchRow(db, one.id)?.closed_at, "the end of its run closes the bench");
  assert.ok(fs.existsSync(path.join(base, "draft.txt")));
  assert.ok(!fs.existsSync(bench.dir));
});

test("closing waits while a task of the subject is pending, then closes", async () => {
  const { db, one } = await oneSubject();
  archive(db, one.id);
  const at = new Date().toISOString();
  const task = Number(
    db
      .prepare("INSERT INTO tasks (room, agent_id, source, text, status, subject_id, created_at, updated_at) VALUES ('demo', 'dev', 'manual', 'T', 'pending', ?, ?, ?)")
      .run(one.id, at, at).lastInsertRowid,
  );
  assert.equal(closeBench(db, one.id), "busy");
  assert.equal(benchRow(db, one.id)?.state, null, "nothing told for a wait");
  db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task);
  assert.equal(closeBench(db, one.id), "closed");
});

test("no hook and no fsmonitor of the repository runs, at the bench's creation or at its closing", async () => {
  const o = office();
  const marks = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-marks-"));
  const hooks = path.join(o.repo, ".hooks");
  fs.mkdirSync(hooks);
  for (const name of ["post-checkout", "post-merge", "pre-merge-commit", "post-commit", "reference-transaction"]) {
    fs.writeFileSync(path.join(hooks, name), `#!/bin/sh\necho ran > "${path.join(marks, name).split(path.sep).join("/")}"\n`, { mode: 0o755 });
  }
  git(o.repo, "config", "core.hooksPath", hooks.split(path.sep).join("/"));
  const monitor = path.join(hooks, "fsmonitor");
  fs.writeFileSync(monitor, `#!/bin/sh\necho ran > "${path.join(marks, "fsmonitor").split(path.sep).join("/")}"\n`, { mode: 0o755 });
  git(o.repo, "config", "core.fsmonitor", monitor.split(path.sep).join("/"));
  const one = createSubject(o.db, "demo", "dev", "One");
  await run(o.config, o.db, workingEngine({ "Work.": (dir) => commit(dir, "one.txt", "one\n") }), "Work.", one.id);
  // The general subject moves on, so the closing makes a merge commit.
  fs.rmSync(marks, { recursive: true, force: true });
  fs.mkdirSync(marks);
  commit(o.base, "general.txt", "g\n");
  fs.rmSync(marks, { recursive: true, force: true });
  fs.mkdirSync(marks);
  archive(o.db, one.id);
  assert.equal(closeBench(o.db, one.id), "closed");
  assert.deepEqual(fs.readdirSync(marks), [], "nothing of the repository ran");
  // And they would have: a plain commit in that repository runs them.
  commit(o.base, "control.txt", "c\n");
  assert.ok(fs.readdirSync(marks).includes("post-commit"), "the hooks are real");
});
