import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getDbAt } from "../src/server/db";
import type { Engine, RunEvent, RunInput } from "../src/server/engine";
import { homeRosterLines, roleSummary } from "../src/server/home-roster";
import { ONBOARDING_ROOM, buildOnboardingPrompt, startOnboarding } from "../src/server/onboarding";
import { loadHome } from "../src/server/rooms";
import { roleTemplatesDir } from "../src/server/templates";
import { makeHome, makeRepo, waitForRun } from "./helpers";

const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

/** Adds a shared studio "creation" (a CAD agent) next to the "demo" room of the test home. */
function addStudio(home: string) {
  const dir = path.join(home, "rooms", "creation");
  fs.mkdirSync(path.join(dir, "roles"), { recursive: true });
  fs.writeFileSync(path.join(dir, "roles", "cao.md"), "# CAD\n\nYou model\nparts in 3D and deliver STL files.\n\n## Rules\n\nNever guess.\n");
  fs.writeFileSync(
    path.join(dir, "room.json"),
    JSON.stringify({
      name: "creation",
      targetRepo: "../creation",
      shared: true,
      agents: [{ id: "cao", name: "CAO", role: "roles/cao.md", model: "opus", allowedTools: ["Read", "mcp__hq__*"] }],
    }),
  );
}

test("roleSummary takes the first paragraph after the title, else the title, cut and without dashes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-role-"));
  const write = (name: string, text: string) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, text);
    return file;
  };
  assert.equal(roleSummary(write("a.md", "# CAD\n\nYou model\nparts in 3D.\n\nNext paragraph.")), "You model parts in 3D.");
  assert.equal(roleSummary(write("b.md", "---\nname: x\n---\n# Only a title\n")), "Only a title");
  assert.equal(roleSummary(write("c.md", `You work ${String.fromCharCode(0x2014)} fast.`)), "You work, fast.");
  assert.ok(roleSummary(write("d.md", `# T\n\n${"word ".repeat(100)}`)).endsWith("..."));
  assert.equal(roleSummary(path.join(dir, "missing.md")), "");
});

test("the roster lists every agent with its model and role, and marks the shared studios", () => {
  const config = makeHome();
  addStudio(config.home);
  const home = loadHome(config.home);
  const text = homeRosterLines(home, path.join(config.home, "rooms")).join("\n");
  assert.match(text, /- "demo" \(project room\), target repository \.\.\/demo-project:/);
  assert.match(text, /  - scout "Scout": haiku, You are a test agent\.; tools mcp__hq__\*; role demo\/roles\/scout\.md/);
  assert.match(text, /- "creation" \(shared studio: you can order from it/);
  assert.match(text, /  - cao "CAO": opus, You model parts in 3D and deliver STL files\.; tools Read, mcp__hq__\*; role creation\/roles\/cao\.md/);
  assert.equal(text.match(/shared studio/g)?.length, 1);
  assert.deepEqual(homeRosterLines({ ...home, rooms: [] }, config.home), ["(no room yet)"]);
});

test("the room proposal prompt carries the roster and the rule against agents that a shared studio already covers", () => {
  const prompt = buildOnboardingPrompt({
    runId: 1,
    target: "/repo",
    targetRepo: "../repo",
    roomName: "repo",
    existingRooms: ["demo"],
    roster: ['- "creation" (shared studio: you can order from it), target repository ../creation:', '  - cao "CAO": opus, You model parts in 3D.; role creation/roles/cao.md'],
    roomsDir: "/home/rooms",
    templatesDir: roleTemplatesDir(process.cwd()),
    mailbox: [],
  });
  assert.match(prompt, /Rooms and agents of the home \(you can read \/home\/rooms; the role paths below are relative to it\):\n- "creation" \(shared studio/);
  assert.match(prompt, /  - cao "CAO": opus/);
  assert.match(prompt, /Never propose an agent whose trade already exists in a shared studio/);
  assert.match(prompt, /hq_message/);
  assert.doesNotMatch(prompt, DASHES);
});

test("a room proposal run gets the roster in its prompt and read access to rooms/", async () => {
  const config = makeHome();
  addStudio(config.home);
  const repo = makeRepo();
  const db = getDbAt(config.dbPath);
  const seen: RunInput[] = [];
  const end: RunEvent = {
    type: "end",
    status: "done",
    reason: "success",
    summary: "ok",
    usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    costUsd: 0.01,
  };
  const engine: Engine = {
    name: "claude",
    async *run(input) {
      seen.push(input);
      yield end;
    },
  };
  const target = path.relative(config.home, repo).split(path.sep).join("/");
  const run = startOnboarding({ path: target }, { config, engine, send: async () => true });
  assert.equal(run.room, ONBOARDING_ROOM);
  await waitForRun(db, run.id);
  const input = seen[0]!;
  const roomsDir = path.join(config.home, "rooms");
  assert.deepEqual(input.addDirs, [roleTemplatesDir(process.cwd()), roomsDir]);
  assert.equal(input.workDir, repo);
  assert.match(input.prompt, /- "creation" \(shared studio: you can order from it/);
  assert.match(input.prompt, /  - cao "CAO": opus, You model parts in 3D and deliver STL files\./);
  assert.match(input.prompt, /Never propose an agent whose trade already exists in a shared studio/);
});
