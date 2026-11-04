import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildClaudeArgs } from "../src/server/claude-engine";
import type { Engine, RunEvent, RunInput } from "../src/server/engine";
import { getDbAt } from "../src/server/db";
import { loadHome } from "../src/server/rooms";
import { startRun } from "../src/server/runner";
import { skillTools, syncSkills } from "../src/server/skills";
import { makeHome, makeRepo, waitForRun } from "./helpers";

const agent = { id: "scout", name: "Scout", role: "roles/scout.md", model: "haiku", allowedTools: ["Read", "mcp__hq__*"] };

/** A demo home whose room has two skill folders under rooms/demo/skills. */
function skillHome(agentOverrides: Record<string, unknown> = {}, roomOverrides: Record<string, unknown> = {}) {
  const config = makeHome(
    {},
    { name: "demo", targetRepo: "../demo-project", ...roomOverrides, agents: [{ ...agent, ...agentOverrides }] },
  );
  const roomDir = path.join(config.home, "rooms", "demo");
  for (const name of ["alpha", "beta"]) {
    const dir = path.join(roomDir, "skills", name);
    fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\nBody of ${name}.\n`);
    fs.writeFileSync(path.join(dir, "scripts", "tool.py"), "print('hi')\n");
  }
  return { config, roomDir };
}

for (const [label, skills, pattern] of [
  ["a skill folder without SKILL.md", ["skills/empty"], /has no SKILL\.md/],
  ["a skill folder that does not exist", ["skills/nope"], /not found/],
  ["a skill that is a file", ["skills/alpha/SKILL.md"], /not found/],
  ["a skill outside the room directory", ["../../elsewhere/alpha"], /inside the room directory/],
  ["the room directory itself", ["."], /inside the room directory/],
  ["an absolute skill path", ["/etc/alpha"], /relative to the room directory/],
  ["a Windows absolute skill path", ["C:\\skills\\alpha"], /relative to the room directory/],
  ["two skills with the same folder name", ["skills/alpha", "skills/../skills/alpha"], /same folder name/],
  ["a folder name with a space", ["skills/with space"], /folder name/],
] as const) {
  test(`rejects ${label} with an explicit error`, () => {
    const { config, roomDir } = skillHome({ skills });
    fs.mkdirSync(path.join(roomDir, "skills", "empty"), { recursive: true });
    fs.mkdirSync(path.join(roomDir, "skills", "with space"), { recursive: true });
    fs.writeFileSync(path.join(roomDir, "skills", "with space", "SKILL.md"), "x");
    const home = loadHome(config.home);
    assert.equal(home.rooms.length, 0);
    assert.match(home.invalid[0]!.error, pattern);
    assert.match(home.invalid[0]!.error, /room\.json/);
  });
}

test("rejects an empty skills list and a non-array", () => {
  for (const skills of [[], "skills/alpha", [3]]) {
    const { config } = skillHome({ skills });
    const home = loadHome(config.home);
    assert.equal(home.rooms.length, 0, JSON.stringify(skills));
    assert.match(home.invalid[0]!.error, /agents\.0\.skills/);
  }
});

test("loads the skills of an agent as absolute folders; the field is optional", () => {
  const { config, roomDir } = skillHome({ skills: ["skills/alpha", "skills/beta"] });
  const home = loadHome(config.home);
  assert.deepEqual(home.invalid, []);
  assert.deepEqual(home.rooms[0]!.agents[0]!.skills, [
    path.join(roomDir, "skills", "alpha"),
    path.join(roomDir, "skills", "beta"),
  ]);
  assert.deepEqual(loadHome(makeHome().home).rooms[0]!.agents[0]!.skills, []);
});

test("syncs a skill folder into .claude/skills, replaces a stale copy and leaves other skills alone", () => {
  const { roomDir } = skillHome();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-skillwork-"));
  const alpha = path.join(roomDir, "skills", "alpha");
  const other = path.join(work, ".claude", "skills", "other");
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, "SKILL.md"), "mine");

  syncSkills(work, [alpha]);
  const copy = path.join(work, ".claude", "skills", "alpha");
  assert.match(fs.readFileSync(path.join(copy, "SKILL.md"), "utf8"), /Body of alpha/);
  assert.equal(fs.readFileSync(path.join(copy, "scripts", "tool.py"), "utf8"), "print('hi')\n");
  assert.ok(!fs.existsSync(path.join(copy, ".gitignore")), "no .gitignore outside a worktree");

  // The source changes (a file is edited, one removed, one added): the copy follows.
  fs.writeFileSync(path.join(alpha, "SKILL.md"), "---\nname: alpha\n---\nNew body.\n");
  fs.rmSync(path.join(alpha, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(alpha, "extra.md"), "extra");
  fs.writeFileSync(path.join(copy, "stale.txt"), "left over from an older version");
  syncSkills(work, [alpha]);
  assert.match(fs.readFileSync(path.join(copy, "SKILL.md"), "utf8"), /New body/);
  assert.ok(fs.existsSync(path.join(copy, "extra.md")));
  assert.ok(!fs.existsSync(path.join(copy, "scripts")));
  assert.ok(!fs.existsSync(path.join(copy, "stale.txt")));

  assert.equal(fs.readFileSync(path.join(other, "SKILL.md"), "utf8"), "mine");
});

test("syncing nothing creates nothing", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-skillwork-"));
  syncSkills(work, []);
  assert.ok(!fs.existsSync(path.join(work, ".claude")));
});

test("refuses to overwrite a folder of the same name that MyHQ did not create", () => {
  const { roomDir } = skillHome();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-skillwork-"));
  const own = path.join(work, ".claude", "skills", "alpha");
  fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(path.join(own, "SKILL.md"), "the repository's own skill");
  assert.throws(() => syncSkills(work, [path.join(roomDir, "skills", "alpha")]), /not created by MyHQ/);
  assert.equal(fs.readFileSync(path.join(own, "SKILL.md"), "utf8"), "the repository's own skill");
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("in a Git worktree the copied skills are ignored: not in status, not added, not committed", () => {
  const { roomDir } = skillHome();
  const repo = makeRepo();
  const work = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "myhq-skillwt-")), "dev");
  git(repo, "worktree", "add", "-b", "hq/dev", work);
  // A skill the repository really versions sits next to ours.
  const versioned = path.join(work, ".claude", "skills", "versioned");
  fs.mkdirSync(versioned, { recursive: true });
  fs.writeFileSync(path.join(versioned, "SKILL.md"), "versioned");
  git(work, "add", ".claude/skills/versioned");
  git(work, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "-m", "versioned skill");

  const both = [path.join(roomDir, "skills", "alpha"), path.join(roomDir, "skills", "beta")];
  syncSkills(work, both, { ignoreInGit: true });
  assert.ok(fs.existsSync(path.join(work, ".claude", "skills", "alpha", "SKILL.md")));
  assert.equal(git(work, "status", "--porcelain", "--untracked-files=all"), "");
  git(work, "add", "-A");
  assert.equal(git(work, "diff", "--cached", "--name-only"), "");
  git(work, "add", ".claude");
  assert.equal(git(work, "diff", "--cached", "--name-only"), "");
  assert.equal(git(work, "ls-files", ".claude"), ".claude/skills/versioned/SKILL.md");

  // A second sync (replacing the copies) keeps it that way, and the main checkout is untouched.
  syncSkills(work, both, { ignoreInGit: true });
  assert.equal(git(work, "status", "--porcelain", "--untracked-files=all"), "");
  assert.equal(git(repo, "status", "--porcelain", "--untracked-files=all"), "");
  const exclude = path.join(repo, ".git", "info", "exclude");
  assert.ok(!fs.existsSync(exclude) || !fs.readFileSync(exclude, "utf8").includes("skills"));
});

test("the Skill tool is added to --tools only for an agent that has skills", () => {
  assert.deepEqual(skillTools({ allowedTools: ["Read", "Bash(git *)", "mcp__hq__*"], skills: ["/x/alpha"] }), [
    "Read",
    "Bash",
    "Skill",
  ]);
  assert.deepEqual(skillTools({ allowedTools: ["mcp__hq__*"], skills: ["/x/alpha"] }), ["Skill"]);
  assert.deepEqual(skillTools({ allowedTools: ["Read", "Skill"], skills: ["/x/alpha"] }), ["Read", "Skill"]);
  assert.deepEqual(skillTools({ allowedTools: ["Read"], tools: ["Read", "Glob"], skills: ["/x/alpha"] }), [
    "Read",
    "Glob",
    "Skill",
  ]);
  assert.equal(skillTools({ allowedTools: ["Read"], skills: [] }), undefined);
  assert.equal(skillTools({ allowedTools: ["Read"] }), undefined);
  assert.deepEqual(skillTools({ allowedTools: ["Read"], tools: ["Read"] }), ["Read"]);

  const tools = skillTools({ allowedTools: ["Read"], skills: ["/x/alpha"] });
  const args = buildClaudeArgs({ allowedTools: ["Read"], tools, maxBudgetUsd: 1 } as RunInput);
  assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 3), ["--tools", "Read", "Skill"]);
  // Project settings stay the only source: the user's own skills stay out.
  const at = args.indexOf("--setting-sources");
  assert.deepEqual(args.slice(at, at + 2), ["--setting-sources", "project,local"]);
});

const ends: RunEvent[] = [
  { type: "start", sessionId: "s", model: "haiku", tools: [], mcpServers: [] },
  {
    type: "end",
    status: "done",
    reason: "success",
    summary: "OK",
    usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    costUsd: 0,
  },
];

function recordingEngine(seen: RunInput[], check?: (input: RunInput) => void): Engine {
  return {
    name: "claude",
    async *run(input) {
      seen.push(input);
      check?.(input);
      for (const event of ends) yield event;
    },
  };
}

test("a run syncs the skills before the engine starts and gives it the Skill tool", async () => {
  const { config } = skillHome({ skills: ["skills/alpha"] });
  const seen: RunInput[] = [];
  let present = false;
  const run = startRun(
    { room: "demo", agent: "scout" },
    {
      config,
      engine: recordingEngine(seen, (input) => {
        present = fs.existsSync(path.join(input.workDir, ".claude", "skills", "alpha", "SKILL.md"));
      }),
      send: async () => true,
    },
  );
  assert.equal((await waitForRun(getDbAt(config.dbPath), run.id)).status, "done");
  assert.ok(present, "the skill is in place when the engine starts");
  assert.deepEqual(seen[0]!.tools, ["Read", "Skill"]);
  assert.ok(!seen[0]!.allowedTools.includes("Skill"));
});

test("an agent without skills runs as before: no .claude folder, default tools", async () => {
  const config = makeHome();
  const seen: RunInput[] = [];
  const run = startRun({ room: "demo", agent: "scout" }, { config, engine: recordingEngine(seen), send: async () => true });
  await waitForRun(getDbAt(config.dbPath), run.id);
  assert.equal(seen[0]!.tools, undefined);
  assert.ok(!fs.existsSync(path.join(seen[0]!.workDir, ".claude")));
});

test("a failing sync fails the run with the reason instead of starting the agent", async () => {
  const { config } = skillHome({ skills: ["skills/alpha"] });
  const own = path.join(config.home, "data", "work", "demo", "scout", ".claude", "skills", "alpha");
  fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(path.join(own, "SKILL.md"), "not ours");
  const seen: RunInput[] = [];
  const run = startRun({ room: "demo", agent: "scout" }, { config, engine: recordingEngine(seen), send: async () => true });
  const finished = await waitForRun(getDbAt(config.dbPath), run.id);
  assert.equal(finished.status, "failed");
  assert.match(finished.summary ?? "", /not created by MyHQ/);
  assert.equal(seen.length, 0);
});

test("a worktree agent's run leaves its skills out of Git", async () => {
  const repo = makeRepo();
  const { config } = skillHome(
    { skills: ["skills/alpha"], worktree: "data/worktrees/demo/scout" },
    { targetRepo: repo },
  );
  const seen: RunInput[] = [];
  const run = startRun({ room: "demo", agent: "scout" }, { config, engine: recordingEngine(seen), send: async () => true });
  assert.equal((await waitForRun(getDbAt(config.dbPath), run.id)).status, "done");
  const wt = seen[0]!.workDir;
  assert.ok(fs.existsSync(path.join(wt, ".claude", "skills", "alpha", "SKILL.md")));
  assert.equal(git(wt, "status", "--porcelain", "--untracked-files=all"), "");
});
