import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { askAgent } from "../src/server/agent-questions";
import { benchOf } from "../src/server/benches";
import type { Engine, RunEvent, RunInput } from "../src/server/engine";
import { benchLines } from "../src/server/runner";
import { createSubject } from "../src/server/subjects";
import { benchRow, commit, done, git, office, run, workingEngine } from "./bench-helpers";

// The benches of a parallel agent with a worktree (docs/architecture.md,
// "Several benches"), on throwaway repositories: one worktree per subject,
// made from the agent's branch, where its runs and questions work.

test("a subject's bench is a worktree made from the tip of the agent's branch; its run, its HQ_WORK_DIR and its question work there", async () => {
  const { repo, config, db, agent, base } = office();
  const seen: RunInput[] = [];
  const engine = workingEngine(
    {
      "Prepare the base.": (dir) => commit(dir, "base.txt", "from the agent's branch\n"),
      "Work on one.": (dir) => commit(dir, "one.txt", "one\n"),
      "Work on two.": (dir) => fs.writeFileSync(path.join(dir, "two.txt"), "two\n"),
    },
    seen,
  );
  const general = await run(config, db, engine, "Prepare the base.");
  assert.equal(seen[0]!.workDir, base, "the general subject keeps the agent's worktree");
  assert.doesNotMatch(seen[0]!.prompt, /bench of this subject/);

  const one = createSubject(db, "demo", "dev", "One");
  const two = createSubject(db, "demo", "dev", "Two");
  const bench = benchOf(agent, one.id)!;
  assert.equal(bench.dir, `${base}--subject-${one.id}`);
  assert.equal((await run(config, db, engine, "Work on one.", one.id)).status, "done");
  const input = seen[1]!;
  assert.equal(input.workDir, bench.dir);
  assert.equal(input.env?.HQ_WORK_DIR, bench.dir);
  assert.ok(input.prompt.includes(benchLines(bench)), "the run is told about its bench");
  assert.match(input.prompt, /uncommitted work blocks that closing/);
  assert.equal(git(bench.dir, "branch", "--show-current"), `hq/dev--subject-${one.id}`);
  assert.ok(fs.existsSync(path.join(bench.dir, "base.txt")), "made from the tip of the agent's branch");
  assert.ok(!fs.existsSync(path.join(repo, "base.txt")), "not from the repository's HEAD");
  // The write guard and its settings are in the bench, out of Git.
  assert.ok(fs.existsSync(path.join(bench.dir, ".claude", "settings.local.json")));
  assert.equal(git(bench.dir, "status", "--porcelain"), "");

  assert.equal((await run(config, db, engine, "Work on two.", two.id)).status, "done");
  const benchTwo = benchOf(agent, two.id)!.dir;
  assert.equal(seen[2]!.workDir, benchTwo);
  assert.ok(fs.existsSync(path.join(benchTwo, "two.txt")));
  assert.ok(!fs.existsSync(path.join(benchTwo, "one.txt")), "each subject on its own bench");
  assert.ok(!fs.existsSync(path.join(base, "one.txt")) && !fs.existsSync(path.join(base, "two.txt")), "and the agent's worktree untouched");
  assert.ok(general.id > 0);

  // A question in a subject reads its bench.
  const asked: RunInput[] = [];
  const answering: Engine = {
    name: "claude",
    async *run(q: RunInput): AsyncIterable<RunEvent> {
      asked.push(q);
      yield done;
    },
  };
  askAgent({ room: "demo", agent: "dev", question: "Where is one?", subject: one.id }, { config, engine: answering });
  askAgent({ room: "demo", agent: "dev", question: "And in general?" }, { config, engine: answering });
  for (let i = 0; i < 100 && asked.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(
    asked.map((q) => q.workDir).sort(),
    [base, bench.dir].sort(),
  );
});

test("without parallel an agent with a worktree works in it for every subject, and has no bench", async () => {
  const { config, db, base } = office({ parallel: false });
  const seen: RunInput[] = [];
  const one = createSubject(db, "demo", "dev", "One");
  await run(config, db, workingEngine({}, seen), "Work on one.", one.id);
  assert.equal(seen[0]!.workDir, base);
  assert.equal(seen[0]!.env?.HQ_WORK_DIR, base);
  assert.doesNotMatch(seen[0]!.prompt, /bench of this subject/);
  assert.equal(benchRow(db, one.id), undefined);
  assert.ok(!fs.existsSync(`${base}--subject-${one.id}`));
});

