import assert from "node:assert/strict";
import { test } from "node:test";
import { readThread } from "../src/server/agent-thread";
import { getDbAt, type RunRow } from "../src/server/db";
import type { Engine, RunEvent, RunInput } from "../src/server/engine";
import { changesSince, getState } from "../src/server/feed";
import { hqStatus, inputs } from "../src/mcp/tools";
import { loadHome, syncHome } from "../src/server/rooms";
import { buildPrompt, startRun } from "../src/server/runner";
import {
  ANNOUNCE_MS,
  BUBBLE_CHARS,
  bubbleText,
  currentActivity,
  HQ_STATUS_TOOL,
  normalizeStatus,
  STATUS_MAX_CHARS,
  toolActivity,
} from "../src/ui/activity";
import { runSteps } from "../src/ui/agent-thread-model";
import { agentKey } from "../src/ui/model";
import { applyInput, createRoomModel, nextChangeAt, snapshotRoom, type RoomModel } from "../src/ui/room-model";
import { createRoomStore } from "../src/ui/room-store";
import { eventSchema, stateSchema, type HqEvent } from "../src/ui/schemas";
import { z } from "zod";
import { makeHome, waitForRun } from "./helpers";

// --- The words -------------------------------------------------------------------

test("a status is one line of 60 characters at most, as the tool takes it", () => {
  assert.equal(normalizeStatus("  rend le clip B,\n  2 sur 3 "), "rend le clip B, 2 sur 3");
  assert.equal(normalizeStatus("x".repeat(STATUS_MAX_CHARS)), "x".repeat(STATUS_MAX_CHARS));
  assert.equal(normalizeStatus("x".repeat(STATUS_MAX_CHARS + 1)), null);
  assert.equal(normalizeStatus("   "), null);
  assert.equal(normalizeStatus(""), null);
  assert.equal(normalizeStatus(42), null);
  assert.equal(normalizeStatus(undefined), null);
  // The tool refuses exactly what the interface ignores.
  const schema = z.object(inputs.hq_status);
  for (const text of ["", "   ", "x".repeat(STATUS_MAX_CHARS + 1)]) assert.equal(schema.safeParse({ text }).success, false, text);
  assert.equal(schema.safeParse({ text: "x".repeat(STATUS_MAX_CHARS) }).success, true);
});

test("the bubble shows 30 characters at most, cut with an ellipsis", () => {
  assert.equal(bubbleText("rend le clip B, 2 sur 3"), "rend le clip B, 2 sur 3");
  assert.equal(bubbleText("x".repeat(BUBBLE_CHARS)), "x".repeat(BUBBLE_CHARS));
  const cut = bubbleText("prépare le montage final de la vidéo de lancement");
  assert.equal(cut.length, BUBBLE_CHARS);
  assert.ok(cut.endsWith("…"));
  assert.equal(bubbleText("prépare le montage final       de la vidéo"), "prépare le montage final…");
});

test("the last tool in a few words, without a model", () => {
  assert.equal(toolActivity("Read", { file_path: "C:\\work\\notes\\brief.md" }), "lit brief.md");
  assert.equal(toolActivity("Read", { file_path: "/home/a/clips/b.mp4" }), "lit b.mp4");
  assert.equal(toolActivity("Read", {}), "lit des fichiers");
  assert.equal(toolActivity("Grep", { pattern: "x" }), "cherche dans les fichiers");
  assert.equal(toolActivity("Glob", { pattern: "**/*.md" }), "cherche dans les fichiers");
  assert.equal(toolActivity("Write", { file_path: "out/script.md" }), "écrit script.md");
  assert.equal(toolActivity("Edit", { file_path: "src/app.ts" }), "écrit app.ts");
  assert.equal(toolActivity("WebSearch", { query: "x" }), "cherche sur le web");
  assert.equal(toolActivity("WebFetch", { url: "https://x" }), "lit une page web");
  assert.equal(toolActivity("Bash", { command: "ffmpeg -i a.mp4 -vf scale=720:-1 b.mp4" }), "monte la vidéo");
  assert.equal(toolActivity("Bash", { command: "cd clips && FFMPEG_X=1 ffprobe a.mp4" }), "monte la vidéo");
  assert.equal(toolActivity("Bash", { command: "python3 tools/render.py" }), "lance un script");
  assert.equal(toolActivity("Bash", { command: "curl -s https://api.example.com" }), "lance un script");
  assert.equal(toolActivity("Bash", { command: "git status" }), "met à jour le code");
  assert.equal(toolActivity("Bash", { command: "npm run test" }), "lance les vérifications");
  assert.equal(toolActivity("Bash", { command: "ls -la" }), "lance une commande");
  assert.equal(toolActivity("mcp__hq__hq_submit", { type: "report" }), "dépose un item");
  assert.equal(toolActivity("mcp__hq__hq_message", { to: "writer" }), "écrit à writer");
  assert.equal(toolActivity("mcp__hq__hq_memory_read", { key: "k" }), "consulte sa mémoire");
  assert.equal(toolActivity("mcp__courrier__draft_reply", {}), "utilise courrier");
  assert.equal(toolActivity("mcp__my_mail__send", {}), "utilise my_mail");
  assert.equal(toolActivity(HQ_STATUS_TOOL, { text: "x" }), null, "its text says it");
  assert.equal(toolActivity("SomethingNew", {}), null);
});

test("the latest status wins for 2 minutes, then the last tool; an older tool never wins over it", () => {
  const announced = { text: "rend le clip B", at: 1_000 };
  const lastTool = { text: "lit b.mp4", at: 2_000 };
  assert.equal(currentActivity({ announced, lastTool }, 1_000 + ANNOUNCE_MS - 1), "rend le clip B");
  assert.equal(currentActivity({ announced, lastTool }, 1_000 + ANNOUNCE_MS), "lit b.mp4");
  assert.equal(currentActivity({ announced, lastTool: { text: "lit a.mp4", at: 500 } }, 1_000 + 10 * ANNOUNCE_MS), "rend le clip B");
  assert.equal(currentActivity({ announced, lastTool: null }, 1_000 + 10 * ANNOUNCE_MS), "rend le clip B");
  assert.equal(currentActivity({ announced: null, lastTool }, 3_000), "lit b.mp4");
  assert.equal(currentActivity({ announced: null, lastTool: null }, 3_000), null);
});

// --- The floor ---------------------------------------------------------------------

const ROOM = "demo";
const T0 = Date.parse("2026-11-08T10:00:00.000Z");
const SCOUT = agentKey(ROOM, "scout");
const runSeed = (id: number, status: "running" | "done") => ({
  id,
  room: ROOM,
  agentId: "scout",
  status,
  startedAt: new Date(T0).toISOString(),
  endedAt: status === "running" ? null : new Date(T0).toISOString(),
});
const call = (id: number, name: string, input: unknown, runId = 1): HqEvent => ({
  id,
  runId,
  room: ROOM,
  agentId: "scout",
  type: "tool_call",
  data: { id: `toolu_${id}`, name, input },
  createdAt: new Date(T0).toISOString(),
});

function working(): RoomModel {
  const model = applyInput(
    createRoomModel(ROOM),
    { type: "hydrate", agents: [{ id: "scout", name: "Scout", lastRun: null }], approvals: [] },
    T0 - 600_000,
  );
  return applyInput(model, { type: "run", run: runSeed(1, "running") }, T0);
}

const scout = (model: RoomModel, at: number) => snapshotRoom(model, at).agents.find((agent) => agent.key === SCOUT)!;

test("hq_status puts its words over the head, cut for the bubble, and does not make the agent type", () => {
  let model = working();
  model = applyInput(model, { type: "event", event: call(1, HQ_STATUS_TOOL, { text: "prépare le montage final de la vidéo de lancement" }) }, T0 + 1_000);
  const view = scout(model, T0 + 1_500);
  assert.equal(view.activity, "prépare le montage final de la vidéo de lancement");
  assert.deepEqual(view.bubble, { kind: "activity", text: bubbleText("prépare le montage final de la vidéo de lancement") });
  assert.notEqual(view.status.kind, "typing");
});

test("an invalid status is ignored, as the tool refuses it", () => {
  let model = working();
  model = applyInput(model, { type: "event", event: call(1, HQ_STATUS_TOOL, { text: "x".repeat(61) }) }, T0 + 1_000);
  model = applyInput(model, { type: "event", event: call(2, HQ_STATUS_TOOL, { text: "   " }) }, T0 + 1_100);
  assert.equal(scout(model, T0 + 1_500).activity, null);
});

test("the status wins over the tools for 2 minutes, then the last tool says what it does", () => {
  let model = working();
  model = applyInput(model, { type: "event", event: call(1, HQ_STATUS_TOOL, { text: "rend le clip B, 2 sur 3" }) }, T0 + 1_000);
  model = applyInput(model, { type: "event", event: call(2, "Read", { file_path: "clips/b.json" }) }, T0 + 5_000);
  assert.equal(scout(model, T0 + 6_000).activity, "rend le clip B, 2 sur 3");
  assert.equal(nextChangeAt(model, T0 + 6_000) <= T0 + 1_000 + ANNOUNCE_MS, true, "the floor is redrawn when it expires");
  assert.equal(scout(model, T0 + 1_000 + ANNOUNCE_MS).activity, "lit b.json");
  assert.deepEqual(scout(model, T0 + 1_000 + ANNOUNCE_MS).bubble, { kind: "activity", text: "lit b.json" });
});

test("without any status, the last tool is the safety net", () => {
  let model = working();
  model = applyInput(model, { type: "event", event: call(1, "Bash", { command: "ffmpeg -i a.mp4 b.mp4" }) }, T0 + 1_000);
  assert.equal(scout(model, T0 + 1_500).activity, "monte la vidéo");
  // One bubble at a time: a thought (a text event) shows for its 5 s over the safety net, then the net again.
  const text = (id: number, words: string): HqEvent => ({ ...call(id, "x", {}), type: "text", data: { text: words } });
  model = applyInput(model, { type: "event", event: text(2, "Let me check the render.") }, T0 + 2_000);
  assert.deepEqual(scout(model, T0 + 2_500).bubble, { kind: "thought", text: "Let me check the render." });
  assert.equal(scout(model, T0 + 2_500).activity, "monte la vidéo", "the chip and the sheet keep it");
  assert.deepEqual(scout(model, T0 + 8_000).bubble, { kind: "activity", text: "monte la vidéo" });
});

test("its own words win over a thought", () => {
  let model = working();
  model = applyInput(model, { type: "event", event: call(1, HQ_STATUS_TOOL, { text: "rend le clip B" }) }, T0 + 1_000);
  const thought: HqEvent = { ...call(2, "x", {}), type: "text", data: { text: "Rendering now." } };
  model = applyInput(model, { type: "event", event: thought }, T0 + 2_000);
  assert.deepEqual(scout(model, T0 + 2_500).bubble, { kind: "activity", text: "rend le clip B" });
});

test("no bubble between runs: the run ends, the agent waits then sleeps; a new run starts afresh", () => {
  let model = working();
  model = applyInput(model, { type: "event", event: call(1, HQ_STATUS_TOOL, { text: "rend le clip B" }) }, T0 + 1_000);
  model = applyInput(model, { type: "run", run: runSeed(1, "done") }, T0 + 2_000);
  const after = scout(model, T0 + 3_000);
  assert.equal(after.activity, null);
  assert.notEqual(after.bubble?.kind, "activity");
  assert.equal(scout(model, T0 + 10 * 60_000).bubble?.kind, "zzz");
  model = applyInput(model, { type: "run", run: { ...runSeed(2, "running") } }, T0 + 11 * 60_000);
  assert.equal(scout(model, T0 + 11 * 60_000 + 10).activity, null, "the status of the last run is gone");
});

test("a page opened during a run shows the bubble at once, from the snapshot", () => {
  const statusAt = new Date(T0 + 30_000).toISOString();
  const toolAt = new Date(T0 + 40_000).toISOString();
  const model = applyInput(
    createRoomModel(ROOM),
    {
      type: "hydrate",
      agents: [
        {
          id: "scout",
          name: "Scout",
          lastRun: runSeed(4, "running"),
          activity: { status: { text: "lit les avis du jour", at: statusAt }, tool: { name: "Read", input: { file_path: "a/avis.md" }, at: toolAt } },
        },
      ],
      approvals: [],
    },
    T0 + 60_000,
  );
  assert.equal(scout(model, T0 + 60_000).activity, "lit les avis du jour");
  assert.equal(scout(model, T0 + 30_000 + ANNOUNCE_MS).activity, "lit avis.md");
});

// --- Storage and diffusion -----------------------------------------------------------

test("hq_status is stored with the time and its run, and the thread lists the steps", () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  syncHome(db, loadHome(config.home));
  const runId = Number(
    db
      .prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at) VALUES ('demo', 'scout', 'claude', 't', 'running', ?)")
      .run(new Date().toISOString()).lastInsertRowid,
  );
  const ctx = { dbPath: config.dbPath, runId, agentId: "scout", room: "demo" };
  for (let step = 1; step <= 14; step++) hqStatus(db, ctx, { text: `étape ${step}` });
  assert.throws(() => hqStatus(db, ctx, { text: "x".repeat(61) }));
  const rows = db.prepare("SELECT run_id, room, agent_id, text FROM run_statuses ORDER BY id").all() as Record<string, unknown>[];
  assert.equal(rows.length, 14);
  assert.deepEqual(rows[0], { run_id: runId, room: "demo", agent_id: "scout", text: "étape 1" });

  const [entry] = readThread(db, "demo", "scout").entries;
  assert.ok(entry?.kind === "run");
  assert.equal(entry.run.statusCount, 14);
  assert.deepEqual(
    entry.run.statuses.map((status) => status.text),
    ["étape 3", "étape 4", "étape 5", "étape 6", "étape 7", "étape 8", "étape 9", "étape 10", "étape 11", "étape 12", "étape 13", "étape 14"],
  );
  const steps = runSteps(entry.run);
  assert.deepEqual(
    steps.shown.map((step) => [step.text, step.current]),
    [
      ["étape 12", false],
      ["étape 13", false],
      ["étape 14", true],
    ],
  );
  assert.equal(steps.folded.length, 9);
  assert.equal(steps.hidden, 2);
  assert.equal(runSteps({ ...entry.run, status: "done" }).shown.at(-1)?.current, false, "no current step once the run ended");

  // The snapshot of the page carries the latest status of the run in progress.
  const state = stateSchema.parse(JSON.parse(JSON.stringify(getState(db, loadHome(config.home), { enabled: false, running: false, timeZone: "UTC" }))));
  assert.equal(state.rooms[0]?.agents[0]?.activity?.status?.text, "étape 14");
});

test("diffusion: the tool call of a run reaches the floor through the event stream", async () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const usage = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const engine: Engine = {
    name: "claude",
    async *run(input: RunInput): AsyncIterable<RunEvent> {
      yield { type: "start", sessionId: "s", model: "haiku", tools: [], mcpServers: [{ name: "hq", status: "connected" }] };
      hqStatus(db, { dbPath: config.dbPath, runId: input.runId, agentId: input.agentId, room: input.room }, { text: "rend le clip B" });
      yield { type: "tool_call", id: "t1", name: HQ_STATUS_TOOL, input: { text: "rend le clip B" } };
      await held;
      yield { type: "end", status: "done", reason: "success", summary: "ok", usage, costUsd: 0 };
    },
  };
  const cursor = (db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM changes").get() as { seq: number }).seq;
  const store = createRoomStore();
  store.ingest({ kind: "state", state: stateSchema.parse(JSON.parse(JSON.stringify(getState(db, loadHome(config.home), { enabled: false, running: false, timeZone: "UTC" })))) }, T0);
  const run: RunRow = startRun({ room: "demo", agent: "scout" }, { config, engine });
  for (let i = 0; i < 100 && changesSince(db, cursor).items.every((item) => item.kind !== "event" || (item.data as { type: string }).type !== "tool_call"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const { items } = changesSince(db, cursor);
  let at = T0 + 1_000;
  for (const item of items) {
    if (item.kind === "run") store.ingest({ kind: "run", run: item.data as never }, (at += 10));
    if (item.kind === "event") store.ingest({ kind: "event", event: eventSchema.parse(item.data) }, (at += 10));
  }
  const view = snapshotRoom(store.get("demo"), at + 10).agents.find((agent) => agent.key === SCOUT)!;
  assert.equal(view.activity, "rend le clip B");
  assert.deepEqual(view.bubble, { kind: "activity", text: "rend le clip B" });
  release();
  await waitForRun(db, run.id);
});

test("the prompt of a run asks for hq_status at the start and at each notable step", () => {
  const config = makeHome();
  const home = loadHome(config.home);
  const room = home.rooms[0]!;
  const prompt = buildPrompt({ room, agent: room.agents[0]!, runId: 1, task: "T", mailbox: [], language: "fr" });
  assert.match(prompt, /hq_status \(if you have it\): once at the start, then at each notable step/);
  assert.match(prompt, /60 characters at most/);
  assert.match(prompt, /never a technical detail/);
});
