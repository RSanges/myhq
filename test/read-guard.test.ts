import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { agentReadGuard, readGuardEnv, type ReadGuardConfig } from "../src/server/read-guard";
import { decideRead, READ_GUARD_ENV, readReadConfig } from "../src/server/read-guard-lib.mjs";
import { installReadGuard, installWriteGuard, READ_GUARD_HOOK, READ_GUARD_LIB, removeReadGuard, WRITE_GUARD_HOOK, WRITE_GUARD_LIB } from "../src/server/write-guard";

const HOOK = path.join(process.cwd(), "src", "server", READ_GUARD_HOOK);
const B = "\\";

/** A cwd, a folder the door reads, a folder beside it, and a private one holding a granted folder. */
function dirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-read-"));
  const cwd = path.join(root, "cwd");
  const readable = path.join(root, "vault", "Projects");
  const beside = path.join(root, "vault", "Projects-old");
  const closed = path.join(root, "vault", "Private");
  const granted = path.join(closed, "Agents", "scout");
  for (const dir of [cwd, readable, beside, granted]) fs.mkdirSync(dir, { recursive: true });
  for (const [dir, name] of [[readable, "brief.md"], [beside, "old.md"], [closed, "bank.md"], [granted, "tone.md"]] as const) fs.writeFileSync(path.join(dir, name), "x");
  return { root, cwd, readable, beside, closed, granted };
}

const read = (file: unknown, cwd?: string) => ({ tool_name: "Read", tool_input: { file_path: file }, ...(cwd ? { cwd } : {}) });
const search = (tool: "Glob" | "Grep", where: string | undefined, pattern = "*", cwd?: string) => ({
  tool_name: tool,
  tool_input: { pattern, ...(where === undefined ? {} : { path: where }) },
  ...(cwd ? { cwd } : {}),
});

const door = (d: ReturnType<typeof dirs>): ReadGuardConfig => ({ workDir: d.cwd, only: [d.readable], deny: [], except: [] });
const agent = (d: ReturnType<typeof dirs>): ReadGuardConfig => ({ workDir: d.cwd, only: null, deny: [d.closed], except: [d.granted] });

// --- The door: only its folders ------------------------------------------------------

test("the door's call reads its folders only: a read, a glob and a grep elsewhere are refused", () => {
  const d = dirs();
  const cfg = door(d);
  assert.deepEqual(decideRead(read(path.join(d.readable, "brief.md")), cfg), { allow: true });
  assert.deepEqual(decideRead(search("Glob", d.readable, "**/*.md"), cfg), { allow: true });
  assert.deepEqual(decideRead(search("Grep", path.join(d.readable, "brief.md"), "x"), cfg), { allow: true });
  for (const input of [
    read(path.join(d.closed, "bank.md")),
    read(path.join(d.beside, "old.md")),
    read(path.join(d.readable, "..", "Private", "bank.md")),
    read(path.join(d.readable, "..")),
    search("Glob", d.closed),
    search("Grep", path.join(d.root, "vault"), "x"),
  ]) {
    const decision = decideRead(input, cfg);
    assert.equal(decision.allow, false, JSON.stringify(input));
  }
  const refused = decideRead(read(path.join(d.closed, "bank.md")), cfg);
  assert.ok(!refused.allow && /MyHQ read guard: Read of .* refused: it is outside the folders you may read\. You may read only in: /.test(refused.reason));
});

test("a search without a path is a search of the cwd, which is not a root of the door", () => {
  const d = dirs();
  assert.equal(decideRead(search("Glob", undefined, "**/*.md"), door(d)).allow, false);
  assert.equal(decideRead(search("Grep", undefined, "x", d.cwd), door(d)).allow, false);
  assert.equal(decideRead(search("Grep", "", "x"), door(d)).allow, false);
  // A cwd that is a root, on purpose, is searched.
  assert.deepEqual(decideRead(search("Glob", undefined, "*", d.readable), { ...door(d), workDir: d.readable }), { allow: true });
  // A relative path resolves against the session's cwd.
  assert.deepEqual(decideRead(read("brief.md", d.readable), door(d)), { allow: true });
  assert.equal(decideRead(read("../Private/bank.md", d.readable), door(d)).allow, false);
});

test("a Glob pattern stays below its path: absolute, ~ or .. patterns are refused", () => {
  const d = dirs();
  for (const pattern of [`${d.closed.replace(/\\/g, "/")}/*`, "/etc/*", "C:/Users/*", "C:x/*", "~/notes/*", "../Private/*", "**/../../*", "{..,x}/*", `..${B}Private${B}*`]) {
    const decision = decideRead(search("Glob", d.readable, pattern), door(d));
    assert.ok(!decision.allow && /a pattern stays below the folder searched/.test(decision.reason), pattern);
  }
  assert.deepEqual(decideRead(search("Glob", d.readable, "**/notes..md"), door(d)), { allow: true }, "dots inside a name are fine");
  assert.equal(decideRead({ tool_name: "Glob", tool_input: { path: d.readable } }, door(d)).allow, false, "no pattern: refused");
});

test("a malformed input is a refusal; other tools are not the read guard's", () => {
  const d = dirs();
  for (const input of [read(undefined), read(""), read(3), search("Grep", 3 as unknown as string)]) {
    assert.equal(decideRead(input, door(d)).allow, false, JSON.stringify(input));
  }
  assert.deepEqual(decideRead({ tool_name: "Write", tool_input: { file_path: path.join(d.closed, "x.md") } }, door(d)), { allow: true });
  assert.deepEqual(decideRead({ tool_name: "mcp__x__Read", tool_input: { file_path: path.join(d.closed, "x.md") } }, door(d)), { allow: true });
});

test("links are resolved: a junction inside a root to a folder outside does not let a read out", (t) => {
  const d = dirs();
  try {
    fs.symlinkSync(d.closed, path.join(d.readable, "escape"), "junction");
    fs.symlinkSync(path.join(d.root, "gone"), path.join(d.readable, "dangling"), "junction");
  } catch (error) {
    t.skip(`cannot create a directory link here: ${(error as Error).message}`);
    return;
  }
  assert.equal(decideRead(read(path.join(d.readable, "escape", "bank.md")), door(d)).allow, false);
  assert.equal(decideRead(search("Grep", path.join(d.readable, "escape"), "x"), door(d)).allow, false);
  const dangling = decideRead(read(path.join(d.readable, "dangling", "x.md")), door(d));
  assert.ok(!dangling.allow && /cannot resolve/.test(dangling.reason));
  // And a root reached through a link is still itself.
  const alias = path.join(d.root, "alias");
  fs.symlinkSync(d.readable, alias, "junction");
  assert.deepEqual(decideRead(read(path.join(alias, "brief.md")), door(d)), { allow: true });
  assert.deepEqual(decideRead(read(path.join(d.readable, "brief.md")), { ...door(d), only: [alias] }), { allow: true });
});

test("on Windows: case, short and device forms are resolved, and UNC, stream or dotted forms are refused", { skip: process.platform !== "win32" }, () => {
  const d = dirs();
  const bank = path.join(d.closed, "bank.md");
  assert.deepEqual(decideRead(read(path.join(d.readable.toUpperCase(), "BRIEF.MD")), door(d)), { allow: true });
  for (const cfg of [door(d), agent(d)]) {
    for (const raw of [
      `${B}${B}?${B}${bank}`,
      `${B}${B}.${B}${bank}`,
      `${B}${B}localhost${B}${bank[0]}$${bank.slice(2)}`,
      `${B}${B}127.0.0.1${B}${bank[0]}$${bank.slice(2)}`,
      `${B}${B}?${B}UNC${B}localhost${B}${bank[0]}$${bank.slice(2)}`,
      `${bank}::$DATA`,
      `${bank}:stream`,
      `${d.closed}.${B}bank.md`,
      `${d.closed} ${B}bank.md`,
      `${bank}.`,
      bank.toLowerCase(),
    ]) {
      assert.equal(decideRead(read(raw), cfg).allow, false, `${cfg.only ? "door" : "agent"}: ${raw}`);
    }
  }
  assert.equal(decideRead(read(`${d.readable[0]}:brief.md`, d.readable), door(d)).allow, false, "a drive-relative path is not the cwd's");
});

// --- An agent: privateDirs closed, its own grants open ---------------------------------

test("privateDirs: a private folder is closed, but for a granted folder inside it; a search may not hold one", () => {
  const d = dirs();
  const cfg = agent(d);
  assert.equal(decideRead(read(path.join(d.closed, "bank.md")), cfg).allow, false);
  const refused = decideRead(read(path.join(d.closed, "bank.md")), cfg);
  assert.ok(!refused.allow && /private folder of the owner; .*hq_ask_assistant/.test(refused.reason));
  assert.deepEqual(decideRead(read(path.join(d.granted, "tone.md")), cfg), { allow: true });
  assert.deepEqual(decideRead(search("Grep", d.granted, "x"), cfg), { allow: true });
  assert.equal(decideRead(read(path.join(d.granted, "..", "..", "bank.md")), cfg).allow, false);
  assert.deepEqual(decideRead(read(path.join(d.readable, "brief.md")), cfg), { allow: true }, "outside the private folders, nothing changes");
  assert.deepEqual(decideRead(search("Glob", undefined, "**/*"), cfg), { allow: true }, "the cwd holds no private folder");
  for (const where of [path.join(d.root, "vault"), d.root]) {
    const decision = decideRead(search("Grep", where, "x"), cfg);
    assert.ok(!decision.allow && /the search would reach a private folder/.test(decision.reason), where);
  }
  // A grant that holds the private folder opens nothing of it: only a folder inside it is an opening.
  assert.equal(decideRead(read(path.join(d.closed, "bank.md")), { ...cfg, except: [path.join(d.root, "vault")] }).allow, false);
  assert.deepEqual(decideRead(read(path.join(d.closed, "bank.md")), { ...cfg, except: [d.closed] }), { allow: true }, "the private folder itself, granted");
});

test("the configuration is read from the environment, and its absence or a bad one is an error", () => {
  const d = dirs();
  assert.throws(() => readReadConfig({}), /MYHQ_READ_GUARD is not set/);
  assert.throws(() => readReadConfig({ [READ_GUARD_ENV]: "{}" }), /not a valid read guard configuration/);
  assert.throws(() => readReadConfig({ [READ_GUARD_ENV]: JSON.stringify({ ...door(d), only: ["relative"] }) }), /not a valid/);
  assert.throws(() => readReadConfig({ [READ_GUARD_ENV]: JSON.stringify({ ...door(d), deny: null }) }), /not a valid/);
  assert.deepEqual(readReadConfig(readGuardEnv(door(d))), door(d));
  assert.deepEqual(readReadConfig(readGuardEnv(agent(d))), agent(d));
});

// --- The hook ------------------------------------------------------------------------

function runHook(script: string, input: unknown, env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [script], { input: typeof input === "string" ? input : JSON.stringify(input), env, encoding: "utf8", windowsHide: true });
}

test("the hook refuses with exit code 2 and a reason on stderr, says nothing otherwise, and fails closed", () => {
  const d = dirs();
  const env = { ...process.env, ...readGuardEnv(door(d)) };
  const inside = runHook(HOOK, read(path.join(d.readable, "brief.md")), env);
  assert.equal(inside.status, 0);
  assert.equal(inside.stdout + inside.stderr, "");
  const outside = runHook(HOOK, read(path.join(d.closed, "bank.md")), env);
  assert.equal(outside.status, 2);
  assert.match(outside.stderr, /MyHQ read guard: Read of .* refused/);
  const bare = { ...process.env };
  delete bare[READ_GUARD_ENV];
  assert.equal(runHook(HOOK, read(path.join(d.readable, "brief.md")), bare).status, 2, "no configuration: refused");
  assert.equal(runHook(HOOK, "not json", env).status, 2);
  // Without its libraries beside it, it refuses too.
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-read-copy-"));
  fs.copyFileSync(HOOK, path.join(copy, READ_GUARD_HOOK));
  const alone = runHook(path.join(copy, READ_GUARD_HOOK), read(path.join(d.readable, "brief.md")), env);
  assert.equal(alone.status, 2);
  assert.match(alone.stderr, /MyHQ read guard: read refused/);
  fs.copyFileSync(path.join(path.dirname(HOOK), READ_GUARD_LIB), path.join(copy, READ_GUARD_LIB));
  assert.equal(runHook(path.join(copy, READ_GUARD_HOOK), read(path.join(d.readable, "brief.md")), env).status, 2, "nor without the write guard's library");
  fs.copyFileSync(path.join(path.dirname(HOOK), WRITE_GUARD_LIB), path.join(copy, WRITE_GUARD_LIB));
  assert.equal(runHook(path.join(copy, READ_GUARD_HOOK), read(path.join(d.readable, "brief.md")), env).status, 0, "the three files together work");
});

// --- Installation --------------------------------------------------------------------

const settingsOf = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, ".claude", "settings.local.json"), "utf8")) as Record<string, unknown> & {
  hooks: { PreToolUse: { matcher: string; hooks: { command: string; args: string[]; onFailure: string; timeout: number; type: string }[] }[] };
};

test("installing the read guard writes its own exec-form entry beside the write guard's, and removing it leaves the rest", () => {
  const { cwd } = dirs();
  installReadGuard(cwd, { script: HOOK, node: "C:\\node\\node.exe" });
  const fresh = settingsOf(cwd);
  assert.deepEqual(fresh.hooks.PreToolUse, [
    { matcher: "Read|Glob|Grep", hooks: [{ type: "command", command: "C:/node/node.exe", args: [HOOK.replace(/\\/g, "/")], timeout: 30, onFailure: "block" }] },
  ]);
  assert.equal(fresh.permissions, undefined, "the read guard changes no permission");
  const writeHook = path.join(process.cwd(), "src", "server", WRITE_GUARD_HOOK);
  installWriteGuard(cwd, { script: writeHook });
  installReadGuard(cwd, { script: HOOK });
  installReadGuard(cwd, { script: HOOK });
  const both = settingsOf(cwd);
  assert.deepEqual(both.hooks.PreToolUse.map((group) => group.matcher), ["Read|Glob|Grep", "Write|Edit|MultiEdit|NotebookEdit"], "each guard once");
  removeReadGuard(cwd);
  assert.deepEqual(settingsOf(cwd).hooks.PreToolUse.map((group) => group.matcher), ["Write|Edit|MultiEdit|NotebookEdit"]);
  const before = fs.readFileSync(path.join(cwd, ".claude", "settings.local.json"), "utf8");
  removeReadGuard(cwd);
  assert.equal(fs.readFileSync(path.join(cwd, ".claude", "settings.local.json"), "utf8"), before, "nothing to take out: untouched");
  removeReadGuard(path.join(cwd, "nowhere"));
});

test("an agent's read guard: nothing without privateDirs, the private folders and its grants with them", () => {
  const d = dirs();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-read-home-"));
  const params = { home, repoRoot: process.cwd(), workDir: d.cwd, readDirs: [d.granted, d.readable], ignoreInGit: false };
  assert.deepEqual(agentReadGuard(params), {});
  assert.ok(!fs.existsSync(path.join(d.cwd, ".claude")), "no file written");
  fs.writeFileSync(path.join(home, "myhq.json"), JSON.stringify({ privateDirs: [d.closed, "notes/private"] }));
  const env = agentReadGuard(params);
  assert.deepEqual(readReadConfig(env), { workDir: d.cwd, only: null, deny: [d.closed, path.join(home, "notes", "private")], except: [d.granted, d.readable] });
  assert.equal(settingsOf(d.cwd).hooks.PreToolUse[0]!.matcher, "Read|Glob|Grep");
  fs.writeFileSync(path.join(home, "myhq.json"), JSON.stringify({ privateDirs: [""] }));
  assert.throws(() => agentReadGuard(params), /privateDirs/);
});
