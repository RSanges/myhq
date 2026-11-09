import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { askChat, buildChatArgs } from "../src/assistant/chat";
import { buildClaudeArgs } from "../src/server/claude-engine";
import type { Engine, RunInput } from "../src/server/engine";
import { getDbAt } from "../src/server/db";
import { startRun } from "../src/server/runner";
import {
  cliToolRules,
  installWriteGuard,
  WRITE_GUARD_ENV,
  WRITE_GUARD_HOOK,
  writeGuardConfig,
  writeGuardEnv,
  writeGuardScript,
} from "../src/server/write-guard";
import { decide, patternRegExp, readConfig, relativeInside } from "../src/server/write-guard-hook.mjs";
import { chatConfig, makeHome, makeRepo, waitForRun } from "./helpers";

const HOOK = path.join(process.cwd(), "src", "server", WRITE_GUARD_HOOK);

/** A working directory, a sibling folder (read-only, like an --add-dir) and a third one (writable, like a chat writeDir). */
function dirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-guard-"));
  const work = path.join(root, "work");
  const added = path.join(root, "added");
  const writable = path.join(root, "writable");
  for (const dir of [work, added, writable]) fs.mkdirSync(dir, { recursive: true });
  return { root, work, added, writable };
}

const write = (file: string, cwd?: string) => ({ tool_name: "Write", tool_input: { file_path: file, content: "x" }, ...(cwd ? { cwd } : {}) });

function config(work: string, allowedTools: string[], extra: { disallowedTools?: string[]; writeDirs?: string[] } = {}) {
  return writeGuardConfig({ workDir: work, allowedTools, ...extra });
}

// --- Rules -----------------------------------------------------------------------

test("the guard's configuration comes from the write rules; the CLI gets them without their path", () => {
  const cfg = writeGuardConfig({
    workDir: "/w",
    allowedTools: ["Read", "Write(models/**)", "Edit(models/**)", "Edit(tests/**)", "Bash(git *)", "mcp__hq__*"],
    disallowedTools: ["Write(supabase/**)", "Edit", "Bash(git push*)"],
    writeDirs: ["/vault"],
  });
  assert.deepEqual(cfg.allow, ["models/**", "tests/**"]);
  assert.deepEqual(cfg.deny, ["supabase/**"]);
  assert.deepEqual(cfg.writeDirs, [path.resolve("/vault")]);
  assert.deepEqual(writeGuardConfig({ workDir: "/w", allowedTools: ["Write", "Edit(**)"] }).allow, ["**"]);
  assert.deepEqual(writeGuardConfig({ workDir: "/w", allowedTools: ["Read", "Bash(ls*)"] }).allow, []);

  assert.deepEqual(cliToolRules(["Read", "Write(**)", "Edit(./**)", "Write(models/**)", "NotebookEdit(nb/**)", "Bash(git add models/*)", "Agent(cad-reviewer)", "mcp__hq__*"]), [
    "Read",
    "Write",
    "Edit",
    "NotebookEdit",
    "Bash(git add models/*)",
    "Agent(cad-reviewer)",
    "mcp__hq__*",
  ]);
  assert.deepEqual(JSON.parse(writeGuardEnv(cfg)[WRITE_GUARD_ENV]!), cfg);
});

test("path patterns are anchored at the working directory", () => {
  const ok = (pattern: string, relative: string) => patternRegExp(pattern, "linux")?.test(relative) ?? false;
  for (const all of ["**", "./**", "/**"]) assert.ok(ok(all, "a/b/c.py") && ok(all, "x"), all);
  assert.ok(ok("models/**", "models/part.py"));
  assert.ok(ok("models/**", "models/a/b/part.py"));
  assert.ok(!ok("models/**", "part.py"));
  assert.ok(!ok("models/**", "other/models/part.py"));
  assert.ok(!ok("models/**", "models-old/part.py"));
  assert.ok(ok("models", "models/part.py"), "a pattern without a wildcard covers what lies under it");
  assert.ok(ok("*.md", "notes.md"));
  assert.ok(!ok("*.md", "docs/notes.md"), "* stays inside one segment");
  assert.ok(ok("docs/**/*.md", "docs/notes.md") && ok("docs/**/*.md", "docs/a/b/notes.md"));
  assert.ok(!ok("models/**", "Models/part.py"));
  assert.ok(patternRegExp("models/**", "win32")!.test("Models/part.py"), "case is ignored on Windows");
  for (const none of ["//etc/**", "~/x/**", "../x/**", "a/../../b", ""]) assert.equal(patternRegExp(none, "linux"), null, none);
});

test("a path is inside a root by whole segments, without case on Windows and macOS", () => {
  assert.equal(relativeInside("/w/agent", "/w/agent/a/b.txt", "linux"), "a/b.txt");
  assert.equal(relativeInside("/w/agent", "/w/agent", "linux"), "");
  assert.equal(relativeInside("/w/agent", "/w/agent-2/b.txt", "linux"), null);
  assert.equal(relativeInside("/w/agent", "/w/b.txt", "linux"), null);
  assert.equal(relativeInside("/w/Agent", "/w/agent/b.txt", "linux"), null);
  assert.equal(relativeInside("C:\\W\\Agent", "c:\\w\\agent\\Sub\\b.txt", "win32"), "Sub/b.txt");
  assert.equal(relativeInside("C:\\W\\Agent\\", "C:\\W\\Agent2\\b.txt", "win32"), null);
  assert.equal(relativeInside("/Users/x/Work", "/users/x/work/b.txt", "darwin"), "b.txt");
});

// --- Decisions -------------------------------------------------------------------

test("a write is allowed in the working directory and refused outside it and in a read-only folder", () => {
  const { root, work, added } = dirs();
  const cfg = config(work, ["Read", "Write(**)", "Edit(**)"]);
  assert.deepEqual(decide(write(path.join(work, "inside.txt")), cfg), { allow: true });
  assert.deepEqual(decide(write(path.join(work, "new", "deep", "file.txt")), cfg), { allow: true });
  for (const target of [path.join(root, "outside.txt"), path.join(work, "..", "outside.txt"), path.join(added, "a.txt"), work]) {
    const decision = decide(write(target), cfg);
    assert.equal(decision.allow, false, target);
  }
  const outside = decide(write(path.join(added, "a.txt")), cfg);
  assert.ok(!outside.allow);
  assert.match(outside.reason, /MyHQ write guard: Write to .* refused: it is outside your working directory/);
  assert.match(outside.reason, /read-only/);
  assert.ok(outside.reason.includes(fs.realpathSync.native(work)));
  // A relative path resolves against the session's cwd, as the CLI does.
  assert.equal(decide(write("rel.txt", work), cfg).allow, true);
  assert.equal(decide(write("../rel.txt", work), cfg).allow, false);
});

test("every write tool is guarded, other tools are not", () => {
  const { root, work } = dirs();
  const cfg = config(work, ["Write", "Edit", "MultiEdit", "NotebookEdit"]);
  const out = path.join(root, "x.ipynb");
  for (const tool of ["Write", "Edit", "MultiEdit"]) {
    assert.equal(decide({ tool_name: tool, tool_input: { file_path: out } }, cfg).allow, false, tool);
  }
  assert.equal(decide({ tool_name: "NotebookEdit", tool_input: { notebook_path: out } }, cfg).allow, false);
  assert.equal(decide({ tool_name: "NotebookEdit", tool_input: { notebook_path: path.join(work, "n.ipynb") } }, cfg).allow, true);
  assert.equal(decide({ tool_name: "Write", tool_input: {} }, cfg).allow, false, "no path is a refusal");
  assert.equal(decide({ tool_name: "Read", tool_input: { file_path: out } }, cfg).allow, true);
  assert.equal(decide({ tool_name: "mcp__x__Edit", tool_input: { file_path: out } }, cfg).allow, true);
});

test("a rule with a sub-path limits the writes to it; a deny rule wins", () => {
  const { work } = dirs();
  const cao = config(work, ["Read", "Write(models/**)", "Edit(models/**)", "Write(tests/**)"]);
  assert.equal(decide(write(path.join(work, "models", "part.py")), cao).allow, true);
  assert.equal(decide(write(path.join(work, "tests", "test_part.py")), cao).allow, true);
  const root = decide(write(path.join(work, "root.py")), cao);
  assert.equal(root.allow, false);
  assert.ok(!root.allow && /only under: models\/\*\*, tests\/\*\*/.test(root.reason));
  const dev = config(work, ["Write", "Edit"], { disallowedTools: ["Write(supabase/**)", "Edit(supabase/**)"] });
  assert.equal(decide(write(path.join(work, "src", "a.ts")), dev).allow, true);
  const denied = decide(write(path.join(work, "supabase", "migrations", "1.sql")), dev);
  assert.ok(!denied.allow && /your rules deny writing there/.test(denied.reason));
  assert.equal(decide(write(path.join(work, "a.ts")), config(work, ["Read"])).allow, false, "no write rule, no write");
});

test("the settings that hold the hook cannot be written", () => {
  const { work } = dirs();
  const cfg = config(work, ["Write"]);
  for (const file of ["settings.local.json", "settings.json", "SETTINGS.LOCAL.JSON"]) {
    const decision = decide(write(path.join(work, ".claude", file)), cfg, "win32");
    assert.equal(decision.allow, false, file);
  }
  assert.equal(decide(write(path.join(work, ".claude", "notes.md")), cfg).allow, true);
});

test("the chat's writeDirs are writable in full, its other folders are not", () => {
  const { work, added, writable } = dirs();
  const cfg = config(work, ["Read", "Write", "Edit"], { writeDirs: [writable] });
  assert.equal(decide(write(path.join(writable, "deep", "note.md")), cfg).allow, true);
  assert.equal(decide(write(path.join(added, "note.md")), cfg).allow, false);
  const reason = decide(write(path.join(added, "note.md")), cfg);
  assert.ok(!reason.allow && reason.reason.includes(writable));
});

test("links are resolved: a link inside the working directory to a folder outside does not let a write out", (t) => {
  const { root, work, added } = dirs();
  const cfg = config(work, ["Write"]);
  try {
    fs.symlinkSync(added, path.join(work, "escape"), "junction");
  } catch (error) {
    t.skip(`cannot create a directory link here: ${(error as Error).message}`);
    return;
  }
  assert.equal(decide(write(path.join(work, "escape", "a.txt")), cfg).allow, false);
  assert.equal(decide(write(path.join(work, "escape", "new", "a.txt")), cfg).allow, false);
  // And a working directory reached through a link is still itself.
  const alias = path.join(root, "alias");
  fs.symlinkSync(work, alias, "junction");
  assert.equal(decide(write(path.join(alias, "a.txt")), config(alias, ["Write"])).allow, true);
  assert.equal(decide(write(path.join(work, "a.txt")), config(alias, ["Write"])).allow, true);
});

test("a dangling file link is refused, since the write would land at its target", (t) => {
  const { root, work } = dirs();
  const link = path.join(work, "dangling.txt");
  try {
    fs.symlinkSync(path.join(root, "nowhere.txt"), link, "file");
  } catch (error) {
    t.skip(`cannot create a file link here: ${(error as Error).message}`);
    return;
  }
  const decision = decide(write(link), config(work, ["Write"]));
  assert.ok(!decision.allow && /cannot resolve/.test(decision.reason));
});

test("on Windows the case of a path does not matter", { skip: process.platform !== "win32" }, () => {
  const { root, work } = dirs();
  const cfg = config(work, ["Write(models/**)"]);
  assert.equal(decide(write(path.join(work.toUpperCase(), "MODELS", "Part.py")), cfg).allow, true);
  assert.equal(decide(write(path.join(root.toLowerCase(), "WORK2", "a.txt")), cfg).allow, false);
});

test("the configuration is read from the environment, and its absence is an error", () => {
  assert.throws(() => readConfig({}), /MYHQ_WRITE_GUARD is not set/);
  assert.throws(() => readConfig({ [WRITE_GUARD_ENV]: "{}" }), /not a valid guard configuration/);
  assert.throws(() => readConfig({ [WRITE_GUARD_ENV]: JSON.stringify({ workDir: "rel", allow: [], deny: [], writeDirs: [] }) }));
  const cfg = config(path.resolve("/w"), ["Write"]);
  assert.deepEqual(readConfig(writeGuardEnv(cfg)), cfg);
});

test("the hook script refuses with exit code 2 and a reason on stderr, and says nothing otherwise", () => {
  const { root, work } = dirs();
  const env = { ...process.env, ...writeGuardEnv(config(work, ["Write"])) };
  const run = (input: string, extraEnv: NodeJS.ProcessEnv = env) =>
    spawnSync(process.execPath, [HOOK], { input, env: extraEnv, encoding: "utf8", windowsHide: true });
  const inside = run(JSON.stringify(write(path.join(work, "a.txt"))));
  assert.equal(inside.status, 0);
  assert.equal(inside.stdout + inside.stderr, "");
  const outside = run(JSON.stringify(write(path.join(root, "a.txt"))));
  assert.equal(outside.status, 2);
  assert.match(outside.stderr, /MyHQ write guard: Write to .* refused/);
  assert.equal(outside.stdout, "");
  // It fails closed: no configuration, or input that is not JSON.
  const bare = { ...process.env };
  delete bare[WRITE_GUARD_ENV];
  assert.equal(run(JSON.stringify(write(path.join(work, "a.txt"))), bare).status, 2);
  assert.equal(run("not json").status, 2);
});

// --- Installation ----------------------------------------------------------------

const settingsOf = (work: string) =>
  JSON.parse(fs.readFileSync(path.join(work, ".claude", "settings.local.json"), "utf8")) as {
    hooks: { PreToolUse: { matcher: string; hooks: { type: string; command: string; args: string[]; onFailure: string }[] }[] } & Record<string, unknown>;
  } & Record<string, unknown>;

test("installing the hook writes an exec-form PreToolUse entry and keeps everything else of the file", () => {
  const { work } = dirs();
  installWriteGuard(work, { script: HOOK, node: "C:\\node\\node.exe" });
  const fresh = settingsOf(work);
  assert.equal(fresh.hooks.PreToolUse.length, 1);
  assert.deepEqual(fresh.permissions, { blockWritesOutsideWorkingDirectories: true }, "the CLI's own guard, as a second layer");
  assert.deepEqual(fresh.hooks.PreToolUse[0], {
    matcher: "Write|Edit|MultiEdit|NotebookEdit",
    hooks: [{ type: "command", command: "C:/node/node.exe", args: [HOOK.replace(/\\/g, "/")], timeout: 30, onFailure: "block" }],
  });

  const file = path.join(work, ".claude", "settings.local.json");
  const own = { matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] };
  fs.writeFileSync(
    file,
    JSON.stringify({ permissions: { allow: ["Read"] }, env: { A: "1" }, hooks: { PreToolUse: [own, ...fresh.hooks.PreToolUse], Stop: [own] } }),
  );
  installWriteGuard(work, { script: HOOK });
  installWriteGuard(work, { script: HOOK });
  const merged = settingsOf(work);
  assert.deepEqual(merged.permissions, { allow: ["Read"], blockWritesOutsideWorkingDirectories: true });
  assert.deepEqual(merged.env, { A: "1" });
  assert.deepEqual((merged.hooks as Record<string, unknown>).Stop, [own]);
  assert.equal(merged.hooks.PreToolUse.length, 2, "MyHQ's entry is replaced, never duplicated");
  assert.equal(merged.hooks.PreToolUse[0]!.hooks[0]!.command, process.execPath.replace(/\\/g, "/"));
  assert.deepEqual(merged.hooks.PreToolUse[1], own);
  assert.ok(!fs.readdirSync(path.join(work, ".claude")).some((name) => name.endsWith(".tmp")));
});

test("a settings file that is not a JSON object is an explicit error", () => {
  const { work } = dirs();
  fs.mkdirSync(path.join(work, ".claude"));
  const file = path.join(work, ".claude", "settings.local.json");
  fs.writeFileSync(file, "{ nope");
  assert.throws(() => installWriteGuard(work, { script: HOOK }), /not valid JSON/);
  fs.writeFileSync(file, "[]");
  assert.throws(() => installWriteGuard(work, { script: HOOK }), /not a JSON object/);
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("in a Git worktree the settings file is ignored: not in status, not added, not committed", () => {
  const repo = makeRepo();
  const work = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "myhq-guardwt-")), "dev");
  git(repo, "worktree", "add", "-b", "hq/dev", work);
  installWriteGuard(work, { script: HOOK, ignoreInGit: true });
  assert.ok(fs.existsSync(path.join(work, ".claude", "settings.local.json")));
  assert.equal(git(work, "status", "--porcelain", "--untracked-files=all"), "");
  git(work, "add", "-A");
  assert.equal(git(work, "diff", "--cached", "--name-only"), "");
  installWriteGuard(work, { script: HOOK, ignoreInGit: true });
  assert.equal(git(work, "status", "--porcelain", "--untracked-files=all"), "");
  assert.equal(git(repo, "status", "--porcelain", "--untracked-files=all"), "", "the main checkout is untouched");
});

test("a repository's own .claude/.gitignore is left alone, and must already ignore the settings file", () => {
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, ".claude"));
  fs.writeFileSync(path.join(repo, ".claude", ".gitignore"), "cache/\n");
  git(repo, "add", ".claude/.gitignore");
  git(repo, "commit", "-q", "-m", "own gitignore");
  assert.throws(() => installWriteGuard(repo, { script: HOOK, ignoreInGit: true }), /Git does not ignore \.claude\/settings\.local\.json/);
  assert.ok(!fs.existsSync(path.join(repo, ".claude", "settings.local.json")), "nothing left behind to commit");

  fs.writeFileSync(path.join(repo, ".claude", ".gitignore"), "cache/\nsettings.local.json\n");
  git(repo, "commit", "-q", "-am", "ignore local settings");
  installWriteGuard(repo, { script: HOOK, ignoreInGit: true });
  assert.equal(fs.readFileSync(path.join(repo, ".claude", ".gitignore"), "utf8"), "cache/\nsettings.local.json\n");
  assert.equal(git(repo, "status", "--porcelain", "--untracked-files=all"), "");
});

test("without a frozen build the hook runs from the sources", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-noguard-"));
  assert.equal(writeGuardScript(root), path.join(root, "src", "server", WRITE_GUARD_HOOK));
});

// --- Agent runs and chat turns ----------------------------------------------------

test("the CLI gets the write rules without their path, and the deny rules as written", () => {
  const args = buildClaudeArgs({
    allowedTools: ["Read", "Write(models/**)", "Edit(models/**)", "Bash(uv run tools/*)", "mcp__hq__*"],
    disallowedTools: ["Write(supabase/**)"],
    maxBudgetUsd: 1,
  } as RunInput);
  const allowed = args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--disallowedTools"));
  assert.deepEqual(allowed, ["Read", "Write", "Edit", "Bash(uv run tools/*)", "mcp__hq__*"]);
  assert.ok(args.slice(args.indexOf("--disallowedTools")).includes("Write(supabase/**)"));
  assert.deepEqual(args.slice(args.indexOf("--tools") + 1, args.indexOf("--allowedTools")), ["Read", "Write", "Edit", "Bash"]);
});

test("an agent run installs the guard in its working directory and hands it its rules", async () => {
  const config = makeHome(
    {},
    {
      name: "demo",
      targetRepo: "../demo-project",
      agents: [
        {
          id: "scout",
          name: "Scout",
          role: "roles/scout.md",
          model: "haiku",
          allowedTools: ["Read", "Write(models/**)", "mcp__hq__*"],
          disallowedTools: ["Write(models/secret/**)"],
          addDirs: ["rooms"],
        },
      ],
    },
  );
  const seen: RunInput[] = [];
  const engine: Engine = {
    name: "claude",
    async *run(input) {
      seen.push(input);
      yield { type: "end", status: "done", reason: "success", summary: "OK", usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, costUsd: 0 };
    },
  };
  const run = startRun({ room: "demo", agent: "scout" }, { config, engine, send: async () => true });
  assert.equal((await waitForRun(getDbAt(config.dbPath), run.id)).status, "done");
  const input = seen[0]!;
  const guard = readConfig(input.env);
  assert.deepEqual(guard, {
    workDir: input.workDir,
    allow: ["models/**"],
    deny: ["models/secret/**"],
    writeDirs: [],
  });
  const hook = settingsOf(input.workDir).hooks.PreToolUse[0]!.hooks[0]!;
  assert.equal(hook.args[0], writeGuardScript(config.repoRoot).replace(/\\/g, "/"));
  assert.equal(decide(write(path.join(input.addDirs![0]!, "x.md")), guard).allow, false, "an --add-dir is read-only");
});

test("a chat turn installs the guard in its cwd, with its writeDirs, and adds them to the readable folders", async () => {
  const { root, work, added, writable } = dirs();
  const requestsDir = path.join(added, "requests");
  const chat = chatConfig({
    cwd: work,
    addDirs: [added],
    writeDirs: [writable, path.join(work, "sub")],
    requestsDir,
    allowedTools: ["Read", "Write", "Edit(**)"],
    permissionMode: "acceptEdits",
  });
  const args = buildChatArgs(chat, { continue: false, maxBudgetUsd: 1 });
  const addDirs = args.flatMap((arg, i) => (arg === "--add-dir" ? [args[i + 1]] : []));
  assert.deepEqual(addDirs, [added, writable], "a writeDir inside cwd needs no --add-dir");
  assert.deepEqual(args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--disallowedTools")), ["Read", "Write", "Edit"]);

  let env: Record<string, string | undefined> = {};
  const outcome = await askChat({
    chat,
    text: "hi",
    continue: false,
    bin: "claude",
    env: { PATH: "x" },
    maxBudgetUsd: 1,
    writeGuardScript: HOOK,
    run: async (params) => {
      env = params.env;
      return { ok: true, text: "ok", costUsd: 0 };
    },
  });
  assert.equal(outcome.ok, true);
  assert.equal(env.PATH, "x");
  const guard = readConfig(env);
  assert.deepEqual(guard.writeDirs, [writable, path.join(work, "sub"), requestsDir]);
  assert.equal(decide(write(path.join(writable, "n.md")), guard).allow, true);
  assert.equal(decide(write(path.join(requestsDir, "r.json")), guard).allow, true, "the requests directory is the chat's to write");
  assert.equal(decide(write(path.join(added, "n.md")), guard).allow, false);
  assert.equal(decide(write(path.join(root, "n.md")), guard).allow, false);
  assert.ok(fs.existsSync(path.join(work, ".claude", "settings.local.json")));
  assert.ok(fs.readFileSync(path.join(work, ".claude", ".gitignore"), "utf8").includes("settings.local.json"));
});
