import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { PUT } from "../src/app/api/settings/[group]/route";
import { getConfig, liveConfig } from "../src/server/config";
import { getDbAt } from "../src/server/db";
import { HqError } from "../src/server/errors";
import { readFloorLayout, readNotifyTypes } from "../src/server/home-settings";
import { loadHome } from "../src/server/rooms";
import { isArmed, schedulerRunning, startScheduler } from "../src/server/routines";
import { startRun } from "../src/server/runner";
import { buildSettingsView, saveSettings, writeJsonAtomic } from "../src/server/settings";
import { makeHome } from "./helpers";

// The settings page: what is read, and what each group writes (validation,
// atomic writes, unknown keys kept, myhq.json over the environment).

const agent = { id: "scout", name: "Scout", role: "roles/scout.md", model: "haiku", allowedTools: ["mcp__hq__*"] };
const room = (extra: Record<string, unknown> = {}, agents: unknown[] = [agent]) => ({
  name: "demo",
  targetRepo: "../demo-project",
  agents,
  ...extra,
});

const settingsFile = (home: string) => path.join(home, "myhq.json");
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
const writeHomeFile = (home: string, value: unknown) => fs.writeFileSync(settingsFile(home), JSON.stringify(value));
const roomFile = (home: string, name = "demo") => path.join(home, "rooms", name, "room.json");
const leftovers = (dir: string) => fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"));

const savedHome = process.env.MYHQ_HOME;
afterEach(() => {
  if (savedHome === undefined) delete process.env.MYHQ_HOME;
  else process.env.MYHQ_HOME = savedHome;
});

test("myhq.json wins over the environment for the scheduler, the time zone and the daily cap", () => {
  const { home } = makeHome();
  const env = { MYHQ_HOME: home, HQ_SCHEDULER: "off", HQ_TIMEZONE: "Europe/Paris", HQ_MAX_RUNS_PER_DAY: "12" };
  assert.deepEqual(
    [getConfig(env).scheduler, getConfig(env).timeZone, getConfig(env).maxRunsPerDay],
    [false, "Europe/Paris", 12],
  );
  writeHomeFile(home, { scheduler: true, timeZone: "Asia/Tokyo", maxRunsPerDay: 3 });
  const config = getConfig(env);
  assert.deepEqual([config.scheduler, config.timeZone, config.maxRunsPerDay], [true, "Asia/Tokyo", 3]);
  // liveConfig reads the file again from a configuration built earlier.
  writeHomeFile(home, { maxRunsPerDay: 0 });
  const live = liveConfig(config);
  assert.deepEqual([live.scheduler, live.timeZone, live.maxRunsPerDay], [false, "Europe/Paris", 0]);
  // Without the file, the environment applies again.
  fs.rmSync(settingsFile(home));
  assert.equal(liveConfig(config).maxRunsPerDay, 12);
});

test("each runtime key is parsed apart: an invalid one never breaks the others nor the rest of the file", () => {
  const { home } = makeHome();
  const env = { MYHQ_HOME: home, HQ_TIMEZONE: "Europe/Paris", HQ_MAX_RUNS_PER_DAY: "12" };
  writeHomeFile(home, {
    scheduler: "yes",
    timeZone: "Mars/Olympus",
    maxRunsPerDay: 5,
    floor: { layout: "room-per-project" },
    notifyTypes: ["brief"],
  });
  const config = getConfig(env);
  assert.deepEqual([config.scheduler, config.timeZone, config.maxRunsPerDay], [false, "Europe/Paris", 5]);
  assert.equal(readFloorLayout(home).layout, "room-per-project");
  assert.deepEqual(readNotifyTypes(home), ["brief"]);
  // A file that is not JSON: the environment applies, nothing throws.
  fs.writeFileSync(settingsFile(home), "{ not json");
  assert.equal(getConfig(env).maxRunsPerDay, 12);
});

test("the view says where each value comes from and which keys are invalid", () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const env = { HQ_TIMEZONE: "Europe/Paris", HQ_MAX_RUNS_PER_DAY: "8" };
  const base = buildSettingsView(config, db, env);
  assert.equal(base.timeZone.source, "env");
  assert.equal(base.maxRunsPerDay.source, "env");
  assert.equal(base.scheduler.source, "default");
  assert.equal(base.layout, "floor-per-project");
  assert.deepEqual(base.language, { value: "en", options: ["fr", "en"] });
  writeHomeFile(config.home, { language: "fr_FR", timeZone: "Asia/Tokyo", maxRunsPerDay: -2, scheduler: true });
  const view = buildSettingsView(config, db, env);
  assert.equal(view.timeZone.source, "file");
  assert.equal(view.timeZone.effective, "Asia/Tokyo");
  assert.equal(view.timeZone.fallback, "Europe/Paris");
  assert.equal(view.scheduler.source, "file");
  assert.equal(view.maxRunsPerDay.source, "env");
  assert.equal(view.maxRunsPerDay.effective, 12);
  assert.equal(view.language.value, "en");
  assert.equal(view.errors.length, 2);
  assert.match(view.errors.join("\n"), /language/);
  assert.match(view.errors.join("\n"), /maxRunsPerDay/);
});

test("disposition et langue: writes floor.layout, language and timeZone, keeps every other key, 2-space JSON", () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  writeHomeFile(config.home, {
    desk: { objects: [{ id: "signer", object: "pile", label: "A signer", source: "approvals" }] },
    floor: { layout: "floor-per-project", future: 1 },
    custom: { keep: ["me"] },
    notifyTypes: ["brief"],
  });
  saveSettings(config, db, "layout", { layout: "room-per-project", language: "fr", timeZone: "Europe/Lisbon" });
  const text = fs.readFileSync(settingsFile(config.home), "utf8");
  const saved = JSON.parse(text) as Record<string, unknown>;
  assert.deepEqual(saved.floor, { layout: "room-per-project", future: 1 });
  assert.equal(saved.language, "fr");
  assert.equal(saved.timeZone, "Europe/Lisbon");
  assert.deepEqual(saved.custom, { keep: ["me"] });
  assert.deepEqual(saved.notifyTypes, ["brief"]);
  assert.deepEqual(Object.keys(saved), ["desk", "floor", "custom", "notifyTypes", "language", "timeZone"]);
  assert.equal(text, `${JSON.stringify(saved, null, 2)}\n`);
  assert.deepEqual(leftovers(config.home), []);
  // Null puts the time zone back to the environment.
  saveSettings(config, db, "layout", { layout: "floor-per-project", language: "en", timeZone: null });
  assert.equal("timeZone" in readJson(settingsFile(config.home)), false);
});

test("a save creates myhq.json when the home has none", () => {
  const config = makeHome();
  saveSettings(config, getDbAt(config.dbPath), "limits", { scheduler: null, maxRunsPerDay: 4 });
  assert.deepEqual(readJson(settingsFile(config.home)), { maxRunsPerDay: 4 });
});

test("invalid input is refused and nothing is written", () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  writeHomeFile(config.home, { custom: 1 });
  const before = fs.readFileSync(settingsFile(config.home), "utf8");
  const roomBefore = fs.readFileSync(roomFile(config.home), "utf8");
  const bad: [Parameters<typeof saveSettings>[2], unknown][] = [
    ["layout", { layout: "a-roof", language: "fr", timeZone: null }],
    ["layout", { layout: "room-per-project", language: "francais complet", timeZone: null }],
    ["layout", { layout: "room-per-project", language: "fr", timeZone: "Mars/Olympus" }],
    ["layout", { layout: "room-per-project", language: "fr", timeZone: null, extra: 1 }],
    ["limits", { scheduler: "on", maxRunsPerDay: 1 }],
    ["limits", { scheduler: true, maxRunsPerDay: -1 }],
    ["limits", { scheduler: true, maxRunsPerDay: 1.5 }],
    ["notifications", { notifyTypes: ["Not Snake"], summaries: [] }],
    ["rooms", { rooms: [{ name: "demo", color: "red", agents: [] }] }],
    ["rooms", { rooms: [{ name: "demo", color: null, agents: [{ id: "scout", model: "gpt", armed: false, maxBudgetUsd: null }] }] }],
    ["rooms", { rooms: [{ name: "demo", color: null, agents: [{ id: "scout", model: "opus", armed: false, maxBudgetUsd: 0 }] }] }],
  ];
  for (const [group, body] of bad) {
    assert.throws(() => saveSettings(config, db, group, body), { name: "ZodError" }, `${group} ${JSON.stringify(body)}`);
  }
  assert.equal(fs.readFileSync(settingsFile(config.home), "utf8"), before);
  assert.equal(fs.readFileSync(roomFile(config.home), "utf8"), roomBefore);
});

test("a myhq.json that cannot be read is never overwritten", () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  for (const content of ["{ not json", "[1, 2]"]) {
    fs.writeFileSync(settingsFile(config.home), content);
    for (const [group, body] of [
      ["layout", { layout: "room-per-project", language: "fr", timeZone: null }],
      ["limits", { scheduler: true, maxRunsPerDay: 1 }],
      ["notifications", { notifyTypes: ["brief"], summaries: [] }],
    ] as const) {
      assert.throws(
        () => saveSettings(config, db, group, body),
        (e: unknown) => e instanceof HqError && e.code === "SETTINGS_FILE_INVALID" && e.status === 409,
      );
    }
    assert.equal(fs.readFileSync(settingsFile(config.home), "utf8"), content);
  }
});

test("writes are atomic: a failure leaves the file as it was and no temporary file behind", () => {
  const config = makeHome();
  writeHomeFile(config.home, { custom: "kept" });
  const before = fs.readFileSync(settingsFile(config.home), "utf8");
  const original = fs.renameSync;
  fs.renameSync = () => {
    throw new Error("disk full");
  };
  try {
    assert.throws(
      () => saveSettings(config, getDbAt(config.dbPath), "limits", { scheduler: true, maxRunsPerDay: 2 }),
      /disk full/,
    );
  } finally {
    fs.renameSync = original;
  }
  assert.equal(fs.readFileSync(settingsFile(config.home), "utf8"), before);
  assert.deepEqual(leftovers(config.home), []);
  // The write itself goes to a temporary file first, then replaces the target.
  const target = path.join(config.home, "out.json");
  const renames: string[] = [];
  fs.renameSync = (from, to) => {
    renames.push(`${path.basename(String(from))} -> ${path.basename(String(to))}`);
    original(from, to);
  };
  try {
    writeJsonAtomic(target, { a: 1 });
  } finally {
    fs.renameSync = original;
  }
  assert.equal(renames.length, 1);
  assert.match(renames[0]!, /^\.out\.json\..+\.tmp -> out\.json$/);
  assert.equal(fs.readFileSync(target, "utf8"), `{\n  "a": 1\n}\n`);
});

test("planificateur et plafonds: the keys are written, null falls back to the environment, the scheduler follows without a restart", () => {
  const config = makeHome({ scheduler: false });
  const db = getDbAt(config.dbPath);
  assert.equal(startScheduler(config), null);
  assert.equal(schedulerRunning(), false);
  saveSettings(config, db, "limits", { scheduler: true, maxRunsPerDay: 7 });
  assert.deepEqual(readJson(settingsFile(config.home)), { scheduler: true, maxRunsPerDay: 7 });
  assert.equal(schedulerRunning(), true);
  assert.equal(buildSettingsView(config, db, {}).scheduler.running, true);
  assert.equal(liveConfig(config).maxRunsPerDay, 7);
  saveSettings(config, db, "limits", { scheduler: false, maxRunsPerDay: null });
  assert.deepEqual(readJson(settingsFile(config.home)), { scheduler: false });
  assert.equal(schedulerRunning(), false);
  assert.equal(fs.existsSync(path.join(config.dataDir, "scheduler.lock")), false);
  assert.equal(liveConfig(config).maxRunsPerDay, 12);
});

test("the daily cap of myhq.json applies to a run even when the caller holds an older configuration", () => {
  const config = makeHome({ maxRunsPerDay: 12 });
  saveSettings(config, getDbAt(config.dbPath), "limits", { scheduler: null, maxRunsPerDay: 0 });
  assert.throws(
    () => startRun({ room: "demo", agent: "scout" }, { config }),
    (e: unknown) => e instanceof HqError && e.code === "DAILY_CAP_REACHED" && /maxRunsPerDay/.test(e.message),
  );
});

test("notifications: notifyTypes goes to myhq.json, notifyRuns to the room of the agent, the rest of the room stays", () => {
  const writer = { ...agent, id: "writer", name: "Writer", cron: "0 8 * * *", maxBudgetUsd: 2 };
  const config = makeHome({}, room({ color: "#ff3d7f" }, [agent, writer]));
  const db = getDbAt(config.dbPath);
  writeHomeFile(config.home, { notifyTypes: ["old"], custom: true });
  saveSettings(config, db, "notifications", {
    notifyTypes: ["brief", "mail_alert", "brief"],
    summaries: [{ room: "demo", agent: "writer", summary: true }],
  });
  assert.deepEqual(readJson(settingsFile(config.home)), { notifyTypes: ["brief", "mail_alert"], custom: true });
  const saved = readJson(roomFile(config.home)) as { color: string; agents: Record<string, unknown>[] };
  assert.equal(saved.color, "#ff3d7f");
  assert.deepEqual(saved.agents[0], agent);
  assert.deepEqual(saved.agents[1], { ...writer, notifyRuns: "summary" });
  assert.equal(loadHome(config.home).rooms[0]!.agents[1]!.notifyRuns, "summary");
  assert.deepEqual(readNotifyTypes(config.home), ["brief", "mail_alert"]);
  assert.deepEqual(leftovers(path.dirname(roomFile(config.home))), []);
  saveSettings(config, db, "notifications", { notifyTypes: [], summaries: [{ room: "demo", agent: "writer", summary: false }] });
  assert.equal("notifyRuns" in (readJson(roomFile(config.home)) as { agents: object[] }).agents[1]!, false);
  assert.deepEqual(readJson(settingsFile(config.home)), { custom: true });
  assert.throws(
    () =>
      saveSettings(config, db, "notifications", {
        notifyTypes: [],
        summaries: [{ room: "demo", agent: "ghost", summary: true }],
      }),
    (e: unknown) => e instanceof HqError && e.code === "AGENT_NOT_FOUND",
  );
});

test("the types offered come from the database and from the roles, never the core ones", () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  fs.writeFileSync(
    path.join(config.home, "rooms", "demo", "roles", "scout.md"),
    "# Scout\n\n- `not_a_type`: outside the section\n\n## What you submit (`hq_submit`)\n\n- `community_reply`: a reply\n- `mail_alert`: an alert\n\n## Never\n\n- `nope`: no\n",
  );
  const insert = db.prepare(
    "INSERT INTO approvals (room, agent_id, type, title, body, payload, status, created_at) VALUES ('demo', 'scout', ?, 'T', 'B', '{}', 'pending', ?)",
  );
  insert.run("room_proposal", new Date().toISOString());
  insert.run("weekly_digest", new Date().toISOString());
  writeHomeFile(config.home, { notifyTypes: ["mail_alert"] });
  const view = buildSettingsView(config, db, {});
  assert.deepEqual(view.notifyTypes.selected, ["mail_alert"]);
  assert.deepEqual(view.notifyTypes.known, ["community_reply", "weekly_digest"]);
});

test("salles et agents: colour, model and budget go to room.json, the armed state to the database (which wins)", () => {
  const config = makeHome({}, room({}, [{ ...agent, cron: "0 7 * * *", armed: true }]));
  const db = getDbAt(config.dbPath);
  const body = (armed: boolean) => ({
    rooms: [{ name: "demo", color: "#AA00FF", agents: [{ id: "scout", model: "opus" as const, armed, maxBudgetUsd: 2.5 }] }],
  });
  saveSettings(config, db, "rooms", body(false));
  const saved = readJson(roomFile(config.home)) as { color: string; agents: Record<string, unknown>[] };
  assert.equal(saved.color, "#aa00ff");
  assert.equal(saved.agents[0]!.model, "opus");
  assert.equal(saved.agents[0]!.maxBudgetUsd, 2.5);
  // room.json still says armed: the database holds the change.
  assert.equal(saved.agents[0]!.armed, true);
  const agentNow = () => loadHome(config.home).rooms[0]!.agents[0]!;
  assert.equal(isArmed(db, "demo", agentNow()), false);
  assert.equal(buildSettingsView(config, db, {}).rooms[0]!.agents[0]!.armed, false);
  // Same values again: room.json is not rewritten, the arming flips back.
  const text = fs.readFileSync(roomFile(config.home), "utf8");
  saveSettings(config, db, "rooms", body(true));
  assert.equal(fs.readFileSync(roomFile(config.home), "utf8"), text);
  assert.equal(isArmed(db, "demo", agentNow()), true);
  // Colour and budget can be taken away.
  saveSettings(config, db, "rooms", {
    rooms: [{ name: "demo", color: null, agents: [{ id: "scout", model: "opus", armed: true, maxBudgetUsd: null }] }],
  });
  const cleared = readJson(roomFile(config.home)) as { agents: Record<string, unknown>[] };
  assert.equal("color" in cleared, false);
  assert.equal("maxBudgetUsd" in cleared.agents[0]!, false);
});

test("salles et agents: a save that cannot be applied writes nothing, in any room", () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const before = fs.readFileSync(roomFile(config.home), "utf8");
  const demo = { name: "demo", color: "#112233", agents: [{ id: "scout", model: "opus" as const, armed: true, maxBudgetUsd: 1 }] };
  assert.throws(
    () => saveSettings(config, db, "rooms", { rooms: [demo, { name: "ghost", color: null, agents: [] }] }),
    (e: unknown) => e instanceof HqError && e.code === "ROOM_NOT_FOUND",
  );
  assert.throws(
    () =>
      saveSettings(config, db, "rooms", {
        rooms: [{ ...demo, agents: [...demo.agents, { id: "ghost", model: "opus", armed: false, maxBudgetUsd: null }] }],
      }),
    (e: unknown) => e instanceof HqError && e.code === "AGENT_NOT_FOUND",
  );
  assert.equal(fs.readFileSync(roomFile(config.home), "utf8"), before);
  assert.equal(isArmed(db, "demo", loadHome(config.home).rooms[0]!.agents[0]!), false);
});

test("HTTP: PUT /api/settings/<group> saves one group and answers with every setting", async () => {
  const config = makeHome();
  process.env.MYHQ_HOME = config.home;
  const put = (group: string, body: unknown) =>
    PUT(
      new Request(`http://localhost/api/settings/${group}`, {
        method: "PUT",
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      { params: Promise.resolve({ group }) },
    );
  const saved = await put("layout", { layout: "room-per-project", language: "fr", timeZone: null });
  assert.equal(saved.status, 200);
  const answer = (await saved.json()) as { settings: { layout: string; rooms: { name: string }[] } };
  assert.equal(answer.settings.layout, "room-per-project");
  assert.deepEqual(answer.settings.rooms.map((each) => each.name), ["demo"]);
  assert.equal(readFloorLayout(config.home).layout, "room-per-project");

  const invalid = await put("limits", { scheduler: true, maxRunsPerDay: -1 });
  assert.equal(invalid.status, 400);
  assert.equal(((await invalid.json()) as { error: { code: string } }).error.code, "INVALID_INPUT");
  const notJson = await put("limits", "{");
  assert.equal(((await notJson.json()) as { error: { code: string } }).error.code, "INVALID_JSON");
  const unknown = await put("secrets", {});
  assert.equal(unknown.status, 404);
  assert.equal(((await unknown.json()) as { error: { code: string } }).error.code, "SETTINGS_GROUP_NOT_FOUND");

  fs.writeFileSync(settingsFile(config.home), "{ broken");
  const broken = await put("layout", { layout: "floor-per-project", language: "en", timeZone: null });
  assert.equal(broken.status, 409);
  assert.equal(((await broken.json()) as { error: { code: string } }).error.code, "SETTINGS_FILE_INVALID");
});
