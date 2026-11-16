import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { askAgent, questionsIdle, questionSystemText } from "../src/server/agent-questions";
import { buildClaudeArgs } from "../src/server/claude-engine";
import { getDbAt } from "../src/server/db";
import type { Engine, RunInput } from "../src/server/engine";
import { NOTEBOOK_LIST_MAX, notebookFiles, notebookText } from "../src/server/notebook";
import { loadHome } from "../src/server/rooms";
import { startRun } from "../src/server/runner";
import { WRITE_GUARD_ENV } from "../src/server/write-guard";
import { decide, readConfig } from "../src/server/write-guard-lib.mjs";
import { makeHome, waitForRun } from "./helpers";

const usage = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

/** A notes vault outside the home, as the owner keeps one: each agent gets one folder of it. */
function vault(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "myhq-vault-"));
}

function room(agent: Record<string, unknown>, extra: Record<string, unknown>[] = []) {
  return {
    name: "demo",
    targetRepo: "../demo-project",
    agents: [{ id: "scout", name: "Scout", role: "roles/scout.md", model: "sonnet", allowedTools: ["Read", "mcp__hq__*"], ...agent }, ...extra],
  };
}

/** The values of a flag of the argument list, up to the next flag. */
function flagValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  args.forEach((arg, index) => {
    if (arg !== flag) return;
    for (let i = index + 1; i < args.length && !args[i]!.startsWith("--"); i++) values.push(args[i]!);
  });
  return values;
}

/** An engine double that records its input and ends at once. */
function recordingEngine(seen: RunInput[]): Engine {
  return {
    name: "claude",
    async *run(input) {
      seen.push(input);
      input.onRawLine?.(JSON.stringify({ type: "result", subtype: "success", result: "Noted." }));
      yield { type: "start", sessionId: "s", model: "sonnet", tools: [], mcpServers: [{ name: "hq", status: "connected" }] };
      yield { type: "end", status: "done", reason: "success", summary: "Noted.", usage, costUsd: 0.01 };
    },
  };
}

test("room.json notebook: resolved like addDirs, outside the home allowed, and refused where it would open what it must not", () => {
  const notes = path.join(vault(), "Agents", "scout");
  const config = makeHome({}, room({ notebook: notes }));
  const home = loadHome(config.home);
  assert.equal(home.invalid.length, 0, home.invalid[0]?.error);
  assert.equal(home.rooms[0]!.agents[0]!.notebook, notes);
  // Relative to the home, like addDirs.
  const relative = makeHome({}, room({ notebook: "../vault/scout" }));
  assert.equal(loadHome(relative.home).rooms[0]!.agents[0]!.notebook, path.resolve(relative.home, "../vault/scout"));
  // Without one: none.
  assert.equal(loadHome(makeHome().home).rooms[0]!.agents[0]!.notebook, null);

  const invalid = (agent: Record<string, unknown>, extra: Record<string, unknown>[] = []) =>
    loadHome(makeHome({}, room(agent, extra)).home).invalid[0]?.error ?? "";
  // Its working directory, inside it, or holding it: the working directory would become writable in a question.
  assert.match(invalid({ notebook: "data/work/demo/scout" }), /notebook of "scout" must not be, hold or sit inside the working directory/);
  assert.match(invalid({ notebook: "data/work/demo/scout/notes" }), /working directory of "scout"/);
  assert.match(invalid({ notebook: "data" }), /working directory of "scout"/);
  // Another agent's working directory, the roles and room.json files, the database.
  assert.match(invalid({ notebook: "data/work/demo/other" }, [{ id: "other", name: "Other", role: "roles/scout.md", model: "haiku", allowedTools: [] }]), /working directory of "other"/);
  assert.match(invalid({ notebook: "rooms/demo" }), /must not overlap the rooms\/ folder/);
  // Inside another agent's notebook, or holding it.
  const shared = vault();
  assert.match(
    invalid({ notebook: shared }, [{ id: "other", name: "Other", role: "roles/scout.md", model: "haiku", allowedTools: [], notebook: path.join(shared, "other") }]),
    /notebook of "other" overlaps the notebook of "scout"/,
  );
  assert.match(invalid({ notebook: 3 }), /notebook/);
});

test("two rooms may not share a notebook: the second room is invalid, the first one loads", () => {
  const notes = vault();
  const config = makeHome({}, room({ notebook: notes }));
  const second = path.join(config.home, "rooms", "second");
  fs.mkdirSync(path.join(second, "roles"), { recursive: true });
  fs.writeFileSync(path.join(second, "roles", "scout.md"), "A second agent.\n");
  fs.writeFileSync(path.join(second, "room.json"), JSON.stringify({ ...room({ notebook: path.join(notes, "sub") }), name: "second" }));
  const home = loadHome(config.home);
  assert.deepEqual(home.rooms.map((each) => each.name), ["demo"]);
  assert.match(home.invalid[0]!.error, /overlaps the notebook of "demo\/scout"/);
});

test("a run with a notebook: the folder is created, readable and writable there only, and the prompt lists its notes", async () => {
  const notes = path.join(vault(), "scout");
  const config = makeHome({}, room({ notebook: notes }));
  const seen: RunInput[] = [];
  const run = startRun({ room: "demo", agent: "scout", task: "Work." }, { config, engine: recordingEngine(seen) });
  await waitForRun(getDbAt(config.dbPath), run.id);
  const input = seen[0]!;
  assert.ok(fs.statSync(notes).isDirectory(), "MyHQ creates the notebook");
  const args = buildClaudeArgs(input);
  assert.ok(flagValues(args, "--add-dir").includes(notes), "readable: an --add-dir");
  assert.deepEqual(flagValues(args, "--tools"), ["Read", "Write", "Edit"], "Write and Edit exist even for an agent whose rules have none");
  assert.ok(flagValues(args, "--allowedTools").includes("Write"));
  // Writable there only: the guard's one writeDirs entry, nothing of the working directory (the agent's rules allow no write there).
  const guard = readConfig({ [WRITE_GUARD_ENV]: input.env[WRITE_GUARD_ENV] });
  assert.deepEqual(guard.writeDirs, [notes]);
  assert.deepEqual(guard.allow, []);
  assert.ok(fs.existsSync(path.join(input.workDir, ".claude", "settings.local.json")), "the hook is installed");
  assert.match(input.prompt, /## Your notebook/);
  assert.match(input.prompt, /It holds no note yet\./);
  assert.match(input.prompt, /state of your bench .* stays in hq_memory/);
});

test("a run without a notebook keeps its access as it was: no added folder, tool or guard", async () => {
  const config = makeHome({}, room({}));
  const seen: RunInput[] = [];
  const run = startRun({ room: "demo", agent: "scout", task: "Work." }, { config, engine: recordingEngine(seen) });
  await waitForRun(getDbAt(config.dbPath), run.id);
  const args = buildClaudeArgs(seen[0]!);
  assert.deepEqual(flagValues(args, "--tools"), ["Read"]);
  assert.ok(!flagValues(args, "--allowedTools").includes("Write"));
  assert.ok(!seen[0]!.prompt.includes("## Your notebook"));
  assert.ok(!fs.existsSync(path.join(seen[0]!.workDir, ".claude", "settings.local.json")), "no guard for an agent that writes nothing");
});

test("a question with a notebook: Write and Edit exist, the guard holds them to the notebook, and the working directory is not writable", async () => {
  const notes = path.join(vault(), "scout");
  fs.mkdirSync(notes, { recursive: true });
  fs.writeFileSync(path.join(notes, "2026-11-14 tone of the posts.md"), "Short sentences, no emoji.\n");
  // The agent writes its working directory in its runs: a question must not.
  const config = makeHome({}, room({ notebook: notes, allowedTools: ["Read", "Write", "Bash(git *)", "mcp__hq__*"] }));
  const seen: RunInput[] = [];
  askAgent({ room: "demo", agent: "scout", question: "Let's settle it: no emoji in the posts." }, { config, engine: recordingEngine(seen) });
  await questionsIdle();
  const input = seen[0]!;
  const args = buildClaudeArgs(input);
  assert.deepEqual(flagValues(args, "--tools"), ["Read", "Glob", "Grep", "Write", "Edit"]);
  assert.deepEqual(flagValues(args, "--allowedTools"), ["Read", "Glob", "Grep", "Write", "Edit", "mcp__hq__hq_memory_read", "mcp__hq__hq_items"]);
  const denied = flagValues(args, "--disallowedTools");
  for (const tool of ["Bash", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch", "Task", "mcp__hq__hq_memory_write"]) assert.ok(denied.includes(tool), `${tool} stays denied`);
  assert.ok(!denied.includes("Write") && !denied.includes("Edit"));
  assert.ok(flagValues(args, "--add-dir").includes(notes));

  // The guard, as the hook reads it from the environment of this question.
  const guard = readConfig({ [WRITE_GUARD_ENV]: input.env[WRITE_GUARD_ENV] });
  assert.deepEqual(guard, { workDir: path.resolve(input.workDir), allow: [], deny: [], writeDirs: [notes] });
  assert.ok(fs.existsSync(path.join(input.workDir, ".claude", "settings.local.json")), "the hook is installed in the question's working directory");
  const write = (file: string) => decide({ tool_name: "Write", tool_input: { file_path: file }, cwd: input.workDir }, guard);
  assert.deepEqual(write(path.join(notes, "2026-11-16 emoji.md")), { allow: true }, "inside the notebook: accepted");
  assert.deepEqual(decide({ tool_name: "Edit", tool_input: { file_path: path.join(notes, "2026-11-14 tone of the posts.md") }, cwd: input.workDir }, guard), { allow: true });
  assert.equal(write(path.join(input.workDir, "notes.md")).allow, false, "the working directory: refused");
  assert.equal(write("notes.md").allow, false, "a relative path lands in the working directory: refused");
  assert.equal(write(path.join(input.workDir, ".claude", "settings.local.json")).allow, false, "the hook's own settings: refused");
  assert.equal(write(path.join(path.dirname(notes), "elsewhere.md")).allow, false, "beside the notebook: refused");
  assert.equal(write(path.join(notes, "..", "escape.md")).allow, false, "out of it through ..: refused");

  // The prompts: where it is, its notes without their content, and to write what is settled.
  assert.match(input.prompt, /## Your notebook/);
  assert.match(input.prompt, /2026-11-14 tone of the posts\.md \(27 bytes, changed /);
  assert.ok(!input.prompt.includes("Short sentences, no emoji."), "no content of a note");
  assert.match(input.prompt, /write to it what you and the owner settle, when you settle it/);
});

test("a question without a notebook stays as it was: three read tools, no guard, the same system text", async () => {
  const config = makeHome({}, room({}));
  const seen: RunInput[] = [];
  askAgent({ room: "demo", agent: "scout", question: "How are you?" }, { config, engine: recordingEngine(seen) });
  await questionsIdle();
  const input = seen[0]!;
  assert.deepEqual(flagValues(buildClaudeArgs(input), "--tools"), ["Read", "Glob", "Grep"]);
  assert.equal(input.env[WRITE_GUARD_ENV], undefined);
  assert.deepEqual(input.addDirs, loadHome(config.home).rooms[0]!.agents[0]!.addDirs);
  assert.ok(!input.prompt.includes("## Your notebook"));
  assert.equal(questionSystemText("French"), questionSystemText("French", false, false));
  assert.match(questionSystemText("French"), /you write no file, submit nothing, send no message/);
  assert.match(questionSystemText("French", false, true), /you write no file except the notes of your notebook/);
});

test("the notebook listing: newest first, no hidden files, capped in the prompt", () => {
  const dir = vault();
  fs.mkdirSync(path.join(dir, ".obsidian"));
  fs.writeFileSync(path.join(dir, ".obsidian", "app.json"), "{}");
  for (let i = 0; i < NOTEBOOK_LIST_MAX + 5; i++) {
    const file = path.join(dir, `note-${String(i).padStart(2, "0")}.md`);
    fs.writeFileSync(file, "x");
    const at = new Date(Date.UTC(2026, 10, 1, 0, i));
    fs.utimesSync(file, at, at);
  }
  const files = notebookFiles(dir);
  assert.equal(files.length, NOTEBOOK_LIST_MAX + 5);
  assert.equal(files[0]!.name, `note-${NOTEBOOK_LIST_MAX + 4}.md`);
  assert.ok(!files.some((file) => file.name.includes(".obsidian")));
  const text = notebookText(dir, "French", "run");
  assert.match(text, new RegExp(`\\(${NOTEBOOK_LIST_MAX} of ${NOTEBOOK_LIST_MAX + 5}\\)`));
  assert.equal(text.split("\n").filter((line) => line.startsWith("- note-")).length, NOTEBOOK_LIST_MAX);
  assert.doesNotMatch(text, /write to it what you and the owner settle/, "that line is the question's");
});
