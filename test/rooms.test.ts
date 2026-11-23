import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { getDbAt } from "../src/server/db";
import { getState } from "../src/server/feed";
import { briefNotice, loadHome, syncHome, type Agent } from "../src/server/rooms";
import { buildSettingsView } from "../src/server/settings";
import { schedulerInfo } from "../src/server/routines";
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

test("a room colour is a hex colour; without one the room is neutral", () => {
  assert.equal(loadHome(makeHome().home).rooms[0]!.color, null);
  for (const color of ["#ff3d7f", "#FF3D7F", "#f37"]) {
    const config = makeHome({}, { name: "demo", targetRepo: "x", color, agents: [agent] });
    const home = loadHome(config.home);
    assert.deepEqual(home.invalid, [], color);
    assert.equal(home.rooms[0]!.color, color);
  }
  for (const color of ["pink", "ff3d7f", "#ff3d7", "#ff3d7f00ff", "rgb(255, 61, 127)", "#ggg", "", 7]) {
    const config = makeHome({}, { name: "demo", targetRepo: "x", color, agents: [agent] });
    const home = loadHome(config.home);
    assert.equal(home.rooms.length, 0, String(color));
    assert.match(home.invalid[0]!.error, /color/, String(color));
  }
});

test("the state exposes the colour of each room, null when it has none", () => {
  const config = makeHome({}, { name: "demo", targetRepo: "../demo-project", color: "#ff3d7f", agents: [agent] });
  const db = getDbAt(config.dbPath);
  assert.equal(getState(db, loadHome(config.home), schedulerInfo(config)).rooms[0]!.color, "#ff3d7f");
  const plain = makeHome();
  assert.equal(getState(getDbAt(plain.dbPath), loadHome(plain.home), schedulerInfo(plain)).rooms[0]!.color, null);
});

test("a room may take a decor for its suite of the single floor; an unknown decor makes it invalid", () => {
  assert.equal(loadHome(makeHome().home).rooms[0]!.decor, null);
  const config = makeHome({}, { name: "demo", targetRepo: "../demo-project", decor: "library", agents: [agent] });
  const home = loadHome(config.home);
  assert.deepEqual(home.invalid, []);
  assert.equal(home.rooms[0]!.decor, "library");
  assert.equal(getState(getDbAt(config.dbPath), home, schedulerInfo(config)).rooms[0]!.decor, "library");
  for (const decor of ["kitchen", "", 3]) {
    const invalid = loadHome(makeHome({}, { name: "demo", targetRepo: "x", decor, agents: [agent] }).home);
    assert.equal(invalid.rooms.length, 0, String(decor));
    assert.match(invalid.invalid[0]!.error, /decor/, String(decor));
  }
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

test("an agent may declare its piece with 1 to 8 patterns; none by default", () => {
  const config = makeHome(
    {},
    {
      name: "demo",
      targetRepo: "x",
      agents: [{ ...agent, pieces: ["renders/**/*.mp4", "./notes/draft-*.md"] }, { ...agent, id: "writer", name: "Writer" }],
    },
  );
  const home = loadHome(config.home);
  assert.deepEqual(home.invalid, []);
  const [scout, writer] = home.rooms[0]!.agents as [Agent, Agent];
  assert.deepEqual(scout.pieces, ["renders/**/*.mp4", "./notes/draft-*.md"]);
  assert.deepEqual(writer.pieces, []);
});

for (const [label, pieces] of [
  ["an empty list", []],
  ["more than 8 patterns", Array.from({ length: 9 }, (_, i) => `out/${i}.png`)],
  ["a pattern that climbs out", ["../elsewhere/*.png"]],
  ["a pattern under the user's home", ["~/renders/*.png"]],
  ["an absolute pattern", ["//renders/*.png"]],
  ["a blank pattern", ["  "]],
] as const) {
  test(`rejects pieces with ${label}`, () => {
    const config = makeHome({}, { name: "demo", targetRepo: "x", agents: [{ ...agent, pieces }] });
    const home = loadHome(config.home);
    assert.equal(home.rooms.length, 0);
    assert.match(home.invalid[0]!.error, /pieces/);
  });
}

test("orders: room.json accepts the boolean, the room carries it and syncHome mirrors it into the database", () => {
  const config = makeHome({}, { name: "demo", targetRepo: "x", orders: true, agents: [agent] });
  const home = loadHome(config.home);
  assert.deepEqual(home.invalid, []);
  assert.equal(home.rooms[0]!.orders, true);
  assert.equal(loadHome(makeHome().home).rooms[0]!.orders, false, "left out: no orders");
  const db = getDbAt(config.dbPath);
  syncHome(db, home);
  assert.deepEqual(db.prepare("SELECT name, orders FROM rooms").all(), [{ name: "demo", orders: 1 }]);
  const wrong = makeHome({}, { name: "demo", targetRepo: "x", orders: "yes", agents: [agent] });
  assert.equal(loadHome(wrong.home).invalid.length, 1);
});

// --- The room brief (room.json `brief`) ------------------------------------------------

/** A home whose room demo declares `brief`, its brief.md written unless `write` is false. */
function briefHome(brief: unknown, write = true) {
  const config = makeHome({}, { name: "demo", targetRepo: "x", agents: [agent, { ...agent, id: "dev", name: "Dev" }], brief });
  if (write) fs.writeFileSync(path.join(config.home, "rooms", "demo", "brief.md"), "Colours: black and gold.\n");
  return config;
}

test("brief: a room may declare its brief file, its reference folders and its keeper", () => {
  const config = briefHome({ file: "brief.md", references: ["../example-project/design", "refs/logos"], keeper: "dev" });
  const home = loadHome(config.home);
  assert.deepEqual(home.invalid, []);
  assert.deepEqual(home.rooms[0]!.brief, {
    file: path.join(config.home, "rooms", "demo", "brief.md"),
    references: [path.resolve(config.home, "../example-project/design"), path.join(config.home, "refs", "logos")],
    keeper: "dev",
  });
  const plain = briefHome({ file: "brief.md" });
  assert.deepEqual(loadHome(plain.home).rooms[0]!.brief, { file: path.join(plain.home, "rooms", "demo", "brief.md"), references: [], keeper: null });
  assert.equal(loadHome(makeHome().home).rooms[0]!.brief, null, "left out: no brief");
});

test("brief: a reference that does not exist on disk does not make the room invalid", () => {
  const config = briefHome({ file: "brief.md", references: ["refs/not-made-yet"] });
  assert.deepEqual(loadHome(config.home).invalid, []);
});

for (const [label, brief, pattern, write] of [
  ["a file that is not markdown", { file: "brief.txt" }, /brief\.file: must be a \.md file/, true],
  ["a file outside the room directory", { file: "../other/brief.md" }, /brief file must stay inside the room directory/, true],
  ["a missing file", { file: "brief.md" }, /brief file not found \(brief\.md\)/, false],
  ["an unknown keeper", { file: "brief.md", keeper: "ghost" }, /brief keeper "ghost" is no agent of the room/, true],
  ["an unknown field", { file: "brief.md", extra: 1 }, /extra/, true],
  ["too many references", { file: "brief.md", references: Array.from({ length: 17 }, (_, i) => `refs/${i}`) }, /brief\.references/, true],
  ["a reference in data/", { file: "brief.md", references: ["data/work"] }, /brief reference "data\/work" must not overlap the data\/ folder of the home/, true],
  ["a reference in rooms/", { file: "brief.md", references: ["rooms/demo"] }, /must not overlap the rooms\/ folder of the home/, true],
  ["a reference in assistant/", { file: "brief.md", references: ["assistant"] }, /must not overlap the assistant\/ folder of the home/, true],
  ["a reference holding the home", { file: "brief.md", references: ["."] }, /must not overlap the data\/ folder of the home/, true],
  ["a reference in the room folders", { file: "brief.md", references: ["folders/demo"] }, /must not overlap the room folders/, true],
] as const) {
  test(`brief: rejects ${label} with an explicit error`, () => {
    const home = loadHome(briefHome(brief, write).home);
    assert.equal(home.rooms.length, 0);
    assert.match(home.invalid[0]!.error, pattern);
  });
}

test("brief: a reference in the drop folder of assistant.json, or in the room folders of myhq.json, makes the room invalid", () => {
  const config = briefHome({ file: "brief.md", references: ["inbox/client"] });
  fs.writeFileSync(path.join(config.home, "assistant.json"), JSON.stringify({ dropDir: "inbox" }));
  assert.match(loadHome(config.home).invalid[0]!.error, /brief reference "inbox\/client" must not overlap the drop folder of assistant\.json/);
  const moved = briefHome({ file: "brief.md", references: ["deliveries"] });
  fs.writeFileSync(path.join(moved.home, "myhq.json"), JSON.stringify({ folders: { dir: "deliveries/rooms" } }));
  assert.match(loadHome(moved.home).invalid[0]!.error, /must not overlap the room folders/);
});

test("brief: a brief file reached through a link out of the room directory makes the room invalid", (t) => {
  const config = briefHome({ file: "notes/brief.md" }, false);
  const outside = path.join(config.home, "elsewhere");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "brief.md"), "Not the room's.\n");
  try {
    fs.symlinkSync(outside, path.join(config.home, "rooms", "demo", "notes"), "junction");
  } catch (error) {
    t.skip(`cannot create a directory link here: ${(error as Error).message}`);
    return;
  }
  assert.match(loadHome(config.home).invalid[0]!.error, /brief file must stay inside the room directory/);
});

// --- A project room without a brief (briefNotice) ---------------------------------------

test("brief notice: a project room without a brief, or with an empty one, is reported in the state and the settings, and stays valid", () => {
  const config = briefHome({ file: "brief.md" });
  fs.mkdirSync(path.join(config.home, "rooms", "studio", "roles"), { recursive: true });
  fs.writeFileSync(path.join(config.home, "rooms", "studio", "roles", "scout.md"), "You are a test agent.\n");
  fs.writeFileSync(
    path.join(config.home, "rooms", "studio", "room.json"),
    JSON.stringify({ name: "studio", targetRepo: "x", shared: true, agents: [agent] }),
  );
  fs.mkdirSync(path.join(config.home, "rooms", "plain", "roles"), { recursive: true });
  fs.writeFileSync(path.join(config.home, "rooms", "plain", "roles", "scout.md"), "You are a test agent.\n");
  fs.writeFileSync(path.join(config.home, "rooms", "plain", "room.json"), JSON.stringify({ name: "plain", targetRepo: "x", agents: [agent] }));
  const db = getDbAt(config.dbPath);
  const notices = () => {
    const home = loadHome(config.home);
    syncHome(db, home);
    assert.deepEqual(home.invalid, []);
    const state = getState(db, home, schedulerInfo(config)).roomsWithoutBrief;
    const settings = buildSettingsView(config, db, {}).rooms.map((room) => [room.name, room.briefNotice]);
    return { state, settings };
  };
  // demo has a brief with text, studio is shared (it serves the others): neither is reported.
  assert.deepEqual(notices(), {
    state: [{ room: "plain", reason: "none" }],
    settings: [["demo", null], ["plain", "none"], ["studio", null]],
  });
  fs.writeFileSync(path.join(config.home, "rooms", "demo", "brief.md"), "  \n\n");
  assert.deepEqual(notices().state, [
    { room: "demo", reason: "empty" },
    { room: "plain", reason: "none" },
  ]);
  assert.equal(briefNotice({ ...loadHome(config.home).rooms[0]!, brief: { file: path.join(config.home, "gone.md"), references: [], keeper: null } }), "missing");
});
