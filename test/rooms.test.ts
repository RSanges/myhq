import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { getDbAt } from "../src/server/db";
import { loadHome, syncHome, type Agent } from "../src/server/rooms";
import { makeHome } from "./helpers";

const agent = { id: "scout", name: "Scout", role: "roles/scout.md", model: "sonnet", allowedTools: ["WebSearch"] };

test("loads a valid room with defaults resolved inside the home", () => {
  const config = makeHome();
  const home = loadHome(config.home);
  assert.deepEqual(home.invalid, []);
  const room = home.rooms[0]!;
  assert.equal(room.name, "demo");
  assert.equal(room.targetRepo, path.resolve(config.home, "../demo-project"));
  const scout = room.agents[0]!;
  assert.equal(scout.rolePath, path.join(config.home, "rooms", "demo", "roles", "scout.md"));
  assert.equal(scout.workDir, path.join(config.home, "data", "work", "demo", "scout"));
  assert.deepEqual(scout.mcpServers, {});
});

test("an empty home has no rooms", () => {
  const config = makeHome();
  fs.rmSync(path.join(config.home, "rooms"), { recursive: true });
  assert.deepEqual(loadHome(config.home).rooms, []);
});

for (const [label, roomJson, pattern] of [
  ["a bad model", { name: "demo", targetRepo: "x", agents: [{ ...agent, model: "gpt" }] }, /agents\.0\.model/],
  ["an unknown field", { name: "demo", targetRepo: "x", agents: [{ ...agent, extra: 1 }] }, /extra/],
  ["a name that differs from the folder", { name: "other", targetRepo: "x", agents: [agent] }, /must match its folder/],
  ["a missing role file", { name: "demo", targetRepo: "x", agents: [{ ...agent, role: "roles/none.md" }] }, /role file/],
  [
    "a working directory outside the home",
    { name: "demo", targetRepo: "x", agents: [{ ...agent, workingDirectory: "../elsewhere" }] },
    /must stay inside the home/,
  ],
  ["an invalid cron expression", { name: "demo", targetRepo: "x", agents: [{ ...agent, cron: "0 25 * * *" }] }, /hour 25/],
  [
    "a routine without a task",
    { name: "demo", targetRepo: "x", agents: [{ ...agent, cron: [{ cron: "0 7 * * *" }] }] },
    /agents\.0\.cron/,
  ],
  [
    "a worktree outside the home",
    { name: "demo", targetRepo: "x", agents: [{ ...agent, worktree: "../wt" }] },
    /worktree of "scout" must stay inside the home/,
  ],
  [
    "a worktree that differs from the working directory",
    { name: "demo", targetRepo: "x", agents: [{ ...agent, worktree: "data/wt/scout", workingDirectory: "data/other" }] },
    /works in its worktree/,
  ],
  [
    "a sprite that leaves the home",
    { name: "demo", targetRepo: "x", agents: [{ ...agent, sprite: "../../elsewhere/scout.png" }] },
    /sprite of "scout" must stay inside the home/,
  ],
  [
    "an absolute sprite path",
    { name: "demo", targetRepo: "x", agents: [{ ...agent, sprite: "/etc/scout.png" }] },
    /must be relative to the home/,
  ],
  [
    "a sprite that is not a png or a webp",
    { name: "demo", targetRepo: "x", agents: [{ ...agent, sprite: "rooms/demo/sprites/scout.gif" }] },
    /must be a \.png or \.webp file/,
  ],
  ["a duplicate agent id", { name: "demo", targetRepo: "x", agents: [agent, agent] }, /duplicate agent id/],
  [
    "a server named hq",
    { name: "demo", targetRepo: "x", agents: [{ ...agent, mcpServers: { hq: { command: "x" } } }] },
    /reserved/,
  ],
] as const) {
  test(`rejects ${label} with an explicit error`, () => {
    const config = makeHome({}, roomJson);
    const home = loadHome(config.home);
    assert.equal(home.rooms.length, 0);
    assert.match(home.invalid[0]!.error, pattern);
  });
}

test("rejects a file that is not JSON", () => {
  const config = makeHome();
  fs.writeFileSync(path.join(config.home, "rooms", "demo", "room.json"), "{ nope");
  assert.match(loadHome(config.home).invalid[0]!.error, /not valid JSON/);
});

test("syncs rooms and agents into the database", () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  syncHome(db, loadHome(config.home));
  const row = db.prepare("SELECT * FROM agents WHERE room = 'demo' AND id = 'scout'").get() as { role_path: string };
  assert.equal(row.role_path, "rooms/demo/roles/scout.md");
});

test("routines, armed state, worktree, deny list and read directories", () => {
  const config = makeHome({}, {
    name: "demo",
    targetRepo: "../demo-project",
    agents: [
      { ...agent, id: "scout", cron: "0 7 * * 1-5", armed: true, allowedTools: ["Read", "WebSearch"] },
      {
        ...agent,
        id: "dev",
        cron: [
          { cron: "0 5 * * *", task: "Fix one bug." },
          { cron: "0 17 * * fri", task: "Weekly summary." },
        ],
        worktree: "data/worktrees/demo/dev",
        workingDirectory: "data/worktrees/demo/dev",
        disallowedTools: ["Bash(git push *)"],
        allowedTools: ["Read", "Edit", "Bash(git *)"],
      },
      { ...agent, id: "writer", addDirs: ["../notes"] },
    ],
  });
  const home = loadHome(config.home);
  assert.deepEqual(home.invalid, []);
  const [scout, dev, writer] = home.rooms[0]!.agents as [Agent, Agent, Agent];
  assert.deepEqual(scout.routines, [{ cron: "0 7 * * 1-5", task: null }]);
  assert.equal(scout.armed, true);
  assert.deepEqual(scout.addDirs, [path.resolve(config.home, "../demo-project")]);
  assert.deepEqual(dev.routines.map((r) => r.task), ["Fix one bug.", "Weekly summary."]);
  assert.equal(dev.armed, false);
  assert.equal(dev.worktree, path.join(config.home, "data", "worktrees", "demo", "dev"));
  assert.equal(dev.workDir, dev.worktree);
  assert.deepEqual(dev.addDirs, []);
  assert.deepEqual(dev.disallowedTools, ["Bash(git push *)"]);
  assert.deepEqual(writer.routines, []);
  assert.deepEqual(writer.addDirs, [path.resolve(config.home, "../notes")]);
});

test("an optional sprite is resolved inside the home, and absent by default", () => {
  const config = makeHome(
    {},
    {
      name: "demo",
      targetRepo: "x",
      agents: [{ ...agent, sprite: "rooms/demo/sprites/scout.PNG" }, { ...agent, id: "writer", name: "Writer" }],
    },
  );
  const home = loadHome(config.home);
  assert.deepEqual(home.invalid, []);
  const [scout, writer] = home.rooms[0]!.agents;
  assert.equal(scout!.sprite, path.join(config.home, "rooms", "demo", "sprites", "scout.PNG"));
  assert.equal(writer!.sprite, null);
});
