import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { POST } from "../src/app/api/agents/propose/route";
import { ChatService } from "../src/assistant/chat-service";
import { hqSubmit, hqSuggestAgent, ToolError, type HqContext } from "../src/mcp/tools";
import { AGENT_NEED_REASON, agentNeedTask, proposeAgent } from "../src/server/agent-need";
import { normalizeAgentProposal } from "../src/server/agent-proposal";
import { decideApproval } from "../src/server/approvals";
import {
  buildCatalog,
  folderSummary,
  frontmatterSummary,
  packageJsonSummary,
  pyprojectSummary,
  readCatalogDirs,
} from "../src/server/catalog";
import { getDbAt, type ApprovalRow, type Db, type RunRow, type TaskRow } from "../src/server/db";
import type { Engine, RunEvent, RunInput } from "../src/server/engine";
import { HqError } from "../src/server/errors";
import { readHomeLanguage } from "../src/server/export";
import { ONBOARDING_AGENT, ONBOARDING_ROOM, wakeOnboarding } from "../src/server/onboarding";
import { loadHome, syncHome } from "../src/server/rooms";
import { roleTemplatesDir } from "../src/server/templates";
import { chatConfig, makeHome, makeRepo, waitForRun } from "./helpers";

const send = async () => true;
const templatesDir = roleTemplatesDir(process.cwd());
const NEED = "Draw the illustrations of the landing page in the style of the brand.";

const endEvent = (status: "done" | "failed"): RunEvent => ({
  type: "end",
  status,
  reason: status === "done" ? "success" : "error",
  summary: status,
  usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
  costUsd: 0.01,
});

/** A proposal as the receptionist submits it. */
function proposal(overrides: Record<string, unknown> = {}, agent: Record<string, unknown> = {}) {
  return {
    room: "demo",
    agent: {
      id: "illustrator",
      name: "Illustrator",
      model: "sonnet",
      allowedTools: ["Read", "mcp__hq__hq_submit", "mcp__hq__hq_task_update"],
      maxBudgetUsd: 1,
      cron: "0 6 * * 1",
      armed: true,
      ...agent,
    },
    rolePrompt: "# Illustrator\n\nYou draw the illustrations of the project.",
    reason: "The project is a Next.js site and nobody draws.",
    need: NEED,
    requestedBy: "the owner",
    ...overrides,
  };
}

function setup() {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  syncHome(db, loadHome(config.home));
  const runId = Number(
    db
      .prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at) VALUES (?, ?, 'claude', 't', 'done', ?)")
      .run(ONBOARDING_ROOM, ONBOARDING_AGENT, new Date().toISOString()).lastInsertRowid,
  );
  const ctx: HqContext = { dbPath: config.dbPath, runId, agentId: ONBOARDING_AGENT, room: ONBOARDING_ROOM, templatesDir };
  return { config, db, ctx };
}

const submit = (db: Db, ctx: HqContext, payload: unknown = proposal()) =>
  hqSubmit(db, ctx, {
    type: "agent_proposal",
    title: "Proposition d'agent : illustrator (demo)",
    body: "An illustrator for the landing page.",
    payload: payload as Record<string, unknown>,
  }).approvalId;

/** A fake receptionist that records its input and submits a proposal through the real hq_submit. */
function submittingEngine(db: Db, seen: RunInput[], payload: unknown = proposal()): Engine {
  return {
    name: "claude",
    async *run(input) {
      seen.push(input);
      hqSubmit(
        db,
        { dbPath: "", runId: input.runId, agentId: input.agentId, room: input.room },
        { type: "agent_proposal", title: "t", body: "An illustrator.", payload: payload as Record<string, unknown> },
      );
      yield endEvent("done");
    },
  };
}

const row = (db: Db, id: number) => db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow;
const receptionRuns = (db: Db) =>
  db.prepare("SELECT * FROM runs WHERE room = ? AND task LIKE 'Propose an agent%' ORDER BY id").all(ONBOARDING_ROOM) as RunRow[];
const needTasks = (db: Db) =>
  db.prepare("SELECT * FROM tasks WHERE room = ? AND source = 'message' ORDER BY id").all(ONBOARDING_ROOM) as TaskRow[];

async function until(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// --- Payload ------------------------------------------------------------------

test("an agent proposal is normalized: no role, disarmed, a readable body with the role prompt and the room.json entry", () => {
  const { payload, body } = normalizeAgentProposal(proposal({}, { role: "roles/elsewhere.md" }), "An illustrator.");
  assert.equal(payload.agent.armed, false);
  assert.equal("role" in payload.agent, false);
  assert.equal(payload.rolePrompt, "# Illustrator\n\nYou draw the illustrations of the project.\n");
  assert.match(body, /^An illustrator\.\n\n## Agent proposé\n\n- Salle : demo/);
  assert.match(body, /- Agent : illustrator \(Illustrator\), modèle sonnet, budget 1 USD par tour/);
  assert.match(body, /- Routine : `0 6 \* \* 1` \(désarmée\)/);
  assert.match(body, /- Besoin : Draw the illustrations/);
  assert.match(body, /## Prompt de rôle \(roles\/illustrator\.md\)\n\n```markdown\n# Illustrator/);
  assert.match(body, /## Entrée de room\.json\n\n```json\n\{\n  "id": "illustrator"/);
  assert.match(body, /"role": "roles\/illustrator\.md"/);
});

test("an invalid agent proposal is refused with an explicit error", () => {
  const bad = (payload: unknown) => () => normalizeAgentProposal(payload, "b");
  assert.throws(bad(proposal({}, { model: "gpt" })), /agent\.model/);
  assert.throws(bad(proposal({}, { cron: "every day" })), /agent\.cron/);
  assert.throws(bad(proposal({}, { extra: 1 })), /agent/);
  assert.throws(bad(proposal({ rolePrompt: "# {{project}}: illustrator" })), /placeholder\(s\): \{\{project\}\}/);
  assert.throws(bad(proposal({ need: "" })), /need/);
  assert.throws(bad(proposal({ room: "Not A Room" })), /room/);
  assert.throws(bad({ ...proposal(), requestedBy: undefined }), /requestedBy/);
});

test("hq_submit takes an agent proposal from the receptionist only, for a known room and a free id", () => {
  const { db, ctx } = setup();
  assert.throws(() => submit(db, { ...ctx, room: "demo", agentId: "scout" }), (e) => e instanceof ToolError && /hq_suggest_agent/.test(e.message));
  assert.throws(() => submit(db, ctx, proposal({ room: "ghost" })), /unknown room "ghost"/);
  assert.throws(() => submit(db, ctx, proposal({}, { id: "scout" })), /already has an agent "scout"/);
  const id = submit(db, ctx);
  const item = row(db, id);
  assert.equal(item.status, "pending");
  assert.equal(item.type, "agent_proposal");
  assert.equal(JSON.parse(item.payload).agent.armed, false);
});

// --- Approval -----------------------------------------------------------------

test("approving writes the role and appends the agent to room.json, disarmed and live", () => {
  const { config, db, ctx } = setup();
  const id = submit(db, ctx);
  decideApproval(db, id, { decision: "approved" }, config);
  assert.equal(row(db, id).status, "approved");
  const dir = path.join(config.home, "rooms", "demo");
  assert.equal(fs.readFileSync(path.join(dir, "roles", "illustrator.md"), "utf8"), "# Illustrator\n\nYou draw the illustrations of the project.\n");
  const file = JSON.parse(fs.readFileSync(path.join(dir, "room.json"), "utf8")) as { agents: Record<string, unknown>[] };
  assert.deepEqual(file.agents.map((a) => a.id), ["scout", "illustrator"]);
  assert.equal(file.agents[1]!.role, "roles/illustrator.md");
  assert.equal(file.agents[1]!.armed, false);
  const agent = loadHome(config.home).rooms[0]!.agents.find((a) => a.id === "illustrator")!;
  assert.equal(agent.armed, false);
  assert.ok(db.prepare("SELECT 1 FROM agents WHERE room = 'demo' AND id = 'illustrator'").get(), "synced at once");
});

test("a duplicate id, an unknown room or an invalid result is refused: the item stays pending, the room as it was", () => {
  const { config, db, ctx } = setup();
  const dir = path.join(config.home, "rooms", "demo");
  const before = fs.readFileSync(path.join(dir, "room.json"), "utf8");
  const refused = (id: number, code: string, agent: string) => {
    assert.throws(() => decideApproval(db, id, { decision: "approved" }, config), (e: unknown) => e instanceof HqError && e.code === code);
    assert.equal(row(db, id).status, "pending");
    assert.equal(fs.readFileSync(path.join(dir, "room.json"), "utf8"), before);
    assert.equal(fs.existsSync(path.join(dir, "roles", `${agent}.md`)), false);
  };

  // Two proposals for the same id: the first approved wins, the second is refused.
  const first = submit(db, ctx);
  const second = submit(db, ctx);
  decideApproval(db, first, { decision: "approved" }, config);
  const after = fs.readFileSync(path.join(dir, "room.json"), "utf8");
  assert.throws(() => decideApproval(db, second, { decision: "approved" }, config), (e: unknown) => e instanceof HqError && e.code === "AGENT_EXISTS");
  assert.equal(row(db, second).status, "pending");
  assert.equal(fs.readFileSync(path.join(dir, "room.json"), "utf8"), after);

  // Back to one agent for the other cases.
  fs.writeFileSync(path.join(dir, "room.json"), before);
  fs.rmSync(path.join(dir, "roles", "illustrator.md"));
  syncHome(db, loadHome(config.home));

  // An agent whose working directory leaves the home would give an invalid room.
  refused(submit(db, ctx, proposal({}, { id: "outsider", workingDirectory: "../../elsewhere" })), "AGENT_PROPOSAL_INVALID", "outsider");
  // A role file left behind by hand takes the id too.
  fs.writeFileSync(path.join(dir, "roles", "stray.md"), "Mine.\n");
  assert.throws(
    () => decideApproval(db, submit(db, ctx, proposal({}, { id: "stray" })), { decision: "approved" }, config),
    (e: unknown) => e instanceof HqError && e.code === "AGENT_EXISTS",
  );
  assert.equal(fs.readFileSync(path.join(dir, "roles", "stray.md"), "utf8"), "Mine.\n");

  const orphan = submit(db, ctx);
  fs.renameSync(dir, `${dir}-gone`);
  assert.throws(() => decideApproval(db, orphan, { decision: "approved" }, config), (e: unknown) => e instanceof HqError && e.code === "ROOM_NOT_FOUND");
  assert.equal(row(db, orphan).status, "pending");
  fs.renameSync(`${dir}-gone`, dir);
  // It can still be approved once the room is back.
  decideApproval(db, orphan, { decision: "approved" }, config);
  assert.equal(row(db, orphan).status, "approved");
});

// --- Revision -----------------------------------------------------------------

test("a revision relaunches the receptionist on the same need, with the previous proposal and the remarks", async () => {
  const { config, db, ctx } = setup();
  const id = submit(db, ctx);
  const seen: RunInput[] = [];
  decideApproval(
    db,
    id,
    { decision: "revise", note: "Cheaper.", annotations: [{ quote: "An illustrator", comment: "A designer instead." }] },
    config,
    { engine: submittingEngine(db, seen), send },
  );
  const [run] = receptionRuns(db);
  assert.ok(run, "a run started at once");
  assert.equal(run.reason, "revise");
  assert.equal(run.task, agentNeedTask(NEED));
  assert.equal((await waitForRun(db, run.id)).status, "done");
  const input = seen[0]!;
  assert.equal(input.rolePath, path.join(process.cwd(), "templates", "agent-proposal.md"));
  assert.match(input.prompt, /REVISION RUN\. The user sent your previous proposal #\d+ back \(revise\)/);
  assert.match(input.prompt, /agent "illustrator" \(sonnet\) in room "demo"/);
  assert.match(input.prompt, /> An illustrator for the landing page\./);
  assert.doesNotMatch(input.prompt, /> ## Agent proposé/);
  assert.match(input.prompt, /À propos de « An illustrator » : A designer instead\./);
  assert.match(input.prompt, /Remarque générale : Cheaper\./);
  assert.match(input.prompt, new RegExp(`> ${NEED.replace(/\./g, "\\.")}`));
  const items = db.prepare("SELECT status FROM approvals ORDER BY id").all() as { status: string }[];
  assert.deepEqual(items.map((i) => i.status), ["revise", "pending"]);
});

test("a rejection of an agent proposal ends the matter: no task, no run; a stale revision is ignored", async () => {
  const { config, db, ctx } = setup();
  const seen: RunInput[] = [];
  const id = submit(db, ctx);
  decideApproval(db, id, { decision: "rejected", note: "Not this one." }, config, { engine: submittingEngine(db, seen), send });
  assert.equal(row(db, id).status, "rejected");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE source = 'revise'").get() as { n: number }).n, 0);
  assert.equal(receptionRuns(db).length, 0);
  assert.deepEqual(wakeOnboarding(config, db, { engine: submittingEngine(db, seen), send }), []);
  assert.equal(seen.length, 0);

  // A revision task whose item was rejected since is stale: nothing wakes for it.
  const second = submit(db, ctx);
  decideApproval(db, second, { decision: "revise", note: "Cheaper." });
  db.prepare("UPDATE approvals SET status = 'rejected' WHERE id = ?").run(second);
  assert.deepEqual(wakeOnboarding(config, db, { engine: submittingEngine(db, seen), send }), []);
  assert.equal(seen.length, 0);
  assert.equal(receptionRuns(db).length, 0);
});

// --- Triggers -----------------------------------------------------------------

test("proposeAgent starts an agent-mode run at once, with the home, the catalogue and who asked", async () => {
  const { config, db } = setup();
  const seen: RunInput[] = [];
  const { run } = proposeAgent({ need: NEED, room: "demo" }, { config, engine: submittingEngine(db, seen), send });
  assert.ok(run);
  assert.equal(run.reason, AGENT_NEED_REASON);
  assert.equal(run.task, agentNeedTask(NEED));
  assert.equal((await waitForRun(db, run.id)).status, "done");
  const input = seen[0]!;
  assert.equal(input.workDir, path.join(config.home, "rooms"));
  assert.equal(input.model, "sonnet");
  assert.deepEqual(input.tools, ["Read", "Glob", "Grep"]);
  assert.deepEqual(input.allowedTools, ["mcp__hq__hq_submit", "mcp__hq__hq_task_update"]);
  assert.equal(input.addDirs?.[0], templatesDir);
  assert.match(input.prompt, /^Agent proposal run #\d+ of MyHQ\./);
  assert.match(input.prompt, /Asked by: the owner\./);
  assert.match(input.prompt, /It comes from room "demo"/);
  assert.match(input.prompt, /- "demo" \(project room\), target repository \.\.\/demo-project:/);
  assert.match(input.prompt, /  - scout "Scout": haiku, You are a test agent\.; tools mcp__hq__\*; role demo\/roles\/scout\.md/);
  assert.match(input.prompt, /### \.\.\/demo-project \(room demo\)\n- \(missing\)/);
  assert.match(input.prompt, /- dev: developer/);
  assert.match(input.prompt, /Title of the hq_submit item: exactly in this form: "Agent proposal: <agent id> \(<room>\)"/);
  assert.deepEqual(needTasks(db).map((t) => t.status), ["done"]);
  assert.equal(row(db, 1).type, "agent_proposal");

  assert.throws(() => proposeAgent({ need: NEED, room: "ghost" }, { config, send }), (e: unknown) => e instanceof HqError && e.code === "ROOM_NOT_FOUND");
  assert.throws(() => proposeAgent({ need: " " }, { config, send }));
});

test("a busy receptionist: the API refuses and keeps nothing, a queued need runs when the busy run ends", async () => {
  const { config, db } = setup();
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const seen: RunInput[] = [];
  const engine: Engine = {
    name: "claude",
    async *run(input) {
      seen.push(input);
      if (seen.length === 1) await gate;
      yield endEvent("done");
    },
  };
  const first = proposeAgent({ need: "First need." }, { config, engine, send });
  assert.throws(() => proposeAgent({ need: NEED }, { config, engine, send }), (e: unknown) => e instanceof HqError && e.code === "AGENT_BUSY");
  assert.equal(needTasks(db).length, 1, "the refused request left no task");
  const queued = proposeAgent({ need: NEED }, { config, engine, send, queue: true });
  assert.equal(queued.run, null);
  release();
  await waitForRun(db, first.run!.id);
  await until(() => receptionRuns(db).length === 2);
  await waitForRun(db, receptionRuns(db)[1]!.id);
  assert.match(seen[1]!.prompt, /Draw the illustrations/);
  assert.deepEqual(needTasks(db).map((t) => t.status), ["done", "done"]);
});

test("POST /api/agents/propose starts the run, and refuses an invalid body or an unknown room", async () => {
  const { config, db } = setup();
  const saved = { home: process.env.MYHQ_HOME, bin: process.env.HQ_CLAUDE_BIN };
  process.env.MYHQ_HOME = config.home;
  process.env.HQ_CLAUDE_BIN = "claude-binary-not-installed-in-tests";
  const post = (body: unknown) =>
    POST(new Request("http://localhost/api/agents/propose", { method: "POST", body: JSON.stringify(body) }));
  try {
    assert.equal((await post({ need: "" })).status, 400);
    assert.equal((await post({ need: NEED, extra: 1 })).status, 400);
    const unknown = await post({ need: NEED, room: "ghost" });
    assert.equal(unknown.status, 404);
    assert.equal(((await unknown.json()) as { error: { code: string } }).error.code, "ROOM_NOT_FOUND");
    const res = await post({ need: NEED });
    assert.equal(res.status, 202);
    const { run } = (await res.json()) as { run: { id: number; reason: string; room: string } };
    assert.equal(run.reason, AGENT_NEED_REASON);
    assert.equal(run.room, ONBOARDING_ROOM);
    // No binary: the run fails, which proves it was really launched.
    assert.equal((await waitForRun(db, run.id)).status, "failed");
  } finally {
    if (saved.home === undefined) delete process.env.MYHQ_HOME;
    else process.env.MYHQ_HOME = saved.home;
    if (saved.bin === undefined) delete process.env.HQ_CLAUDE_BIN;
    else process.env.HQ_CLAUDE_BIN = saved.bin;
  }
});

test("hq_suggest_agent queues the need for the receptionist, once a day per need, and the wake-up runs it", async () => {
  const { config, db } = setup();
  const scout: HqContext = { dbPath: config.dbPath, runId: 1, agentId: "scout", room: "demo" };
  const first = hqSuggestAgent(db, scout, { need: NEED });
  assert.equal(first.queued, true);
  const [task] = needTasks(db);
  assert.equal(task!.text, NEED);
  assert.equal(task!.from_room, "demo");
  assert.equal(task!.from_agent, "scout");
  // The same need, spelled differently: not queued again.
  const again = hqSuggestAgent(db, scout, { need: `  ${NEED.toUpperCase()} ` });
  assert.equal(again.queued, false);
  assert.equal(again.taskId, task!.id);
  assert.equal(needTasks(db).length, 1);
  // Another need is.
  assert.equal(hqSuggestAgent(db, scout, { need: "Translate the app into German." }).queued, true);
  // A day later, the first need may be suggested again.
  db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 25 * 3600_000).toISOString(), task!.id);
  assert.equal(hqSuggestAgent(db, scout, { need: NEED }).queued, true);
  db.prepare("DELETE FROM tasks WHERE id > ?").run(task!.id);
  db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run(new Date().toISOString(), task!.id);
  assert.throws(() => hqSuggestAgent(db, { ...scout, room: ONBOARDING_ROOM, agentId: ONBOARDING_AGENT }, { need: NEED }), ToolError);

  const seen: RunInput[] = [];
  const [run] = wakeOnboarding(config, db, { engine: submittingEngine(db, seen), send });
  assert.ok(run);
  assert.equal(run.reason, AGENT_NEED_REASON);
  await waitForRun(db, run.id);
  assert.match(seen[0]!.prompt, /Asked by: agent scout of room demo[.]/);
  assert.match(seen[0]!.prompt, /"requestedBy": "agent scout of room demo"/);
  assert.deepEqual(wakeOnboarding(config, db, { send }), [], "nothing left to wake");
});

test("a failing agent-mode run is not retried in a loop", async () => {
  const { config, db } = setup();
  hqSuggestAgent(db, { dbPath: config.dbPath, runId: 1, agentId: "scout", room: "demo" }, { need: NEED });
  const failing: Engine = {
    name: "claude",
    async *run() {
      yield endEvent("failed");
    },
  };
  const [run] = wakeOnboarding(config, db, { engine: failing, send });
  await waitForRun(db, run!.id);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(receptionRuns(db).length, 1);
  assert.deepEqual(needTasks(db).map((t) => t.status), ["pending"]);
  assert.deepEqual(wakeOnboarding(config, db, { engine: failing, send }), []);
});

test("the chat's propose_agent action asks the receptionist, like the API", async () => {
  const { config, db } = setup();
  const requestsDir = path.join(config.home, "chat", "requests");
  const seen: RunInput[] = [];
  const service = new ChatService({
    config,
    db,
    chat: chatConfig({ cwd: config.home, requestsDir, actions: ["propose_agent"] }),
    env: { PATH: process.env.PATH },
    chatMaxBudgetUsd: 0.5,
    agentNeed: { engine: submittingEngine(db, seen), send },
    log: () => {},
    runChat: async () => {
      fs.mkdirSync(requestsDir, { recursive: true });
      fs.writeFileSync(path.join(requestsDir, "a.json"), JSON.stringify({ action: "propose_agent", need: NEED, room: "demo" }));
      return { ok: true, text: "Je demande à l'accueil.", costUsd: 0, tools: [] };
    },
  });
  const result = await service.ask("Il me faut un illustrateur", "desk");
  assert.match(result.reply, /L'accueil prépare une proposition d'agent \(tour #\d+\)/);
  const [run] = receptionRuns(db);
  assert.equal(run!.reason, AGENT_NEED_REASON);
  await waitForRun(db, run!.id);
  assert.match(seen[0]!.prompt, /It comes from room "demo"/);
  assert.deepEqual(fs.readdirSync(requestsDir), []);
});

// --- Catalogue ----------------------------------------------------------------

test("catalog.dirs is read apart: absent, valid, invalid (the rest of myhq.json still reads)", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-catalog-"));
  const write = (settings: unknown) => fs.writeFileSync(path.join(home, "myhq.json"), JSON.stringify(settings));
  assert.deepEqual(readCatalogDirs(home), { dirs: [], error: null });
  write({ language: "fr" });
  assert.deepEqual(readCatalogDirs(home), { dirs: [], error: null });
  write({ language: "fr", catalog: { dirs: ["../notes", "../notes", "/abs/place"] } });
  assert.deepEqual(readCatalogDirs(home), { dirs: [path.resolve(home, "../notes"), path.resolve(home, "/abs/place")], error: null });
  write({ language: "fr", catalog: { dirs: "../notes" } });
  const invalid = readCatalogDirs(home);
  assert.deepEqual(invalid.dirs, []);
  assert.match(invalid.error ?? "", /catalog\.dirs/);
  assert.equal(readHomeLanguage(home), "fr", "an invalid catalog does not break the other settings");
  write({ catalog: { dirs: [], extra: true } });
  assert.match(readCatalogDirs(home).error ?? "", /catalog/);
  fs.writeFileSync(path.join(home, "myhq.json"), "{ not json");
  assert.match(readCatalogDirs(home).error ?? "", /not valid JSON/);
});

test("the catalogue summarizes manifests and the frontmatter of notes", () => {
  assert.deepEqual(
    packageJsonSummary(JSON.stringify({ name: "web", description: "A site", dependencies: { next: "16", react: "19" }, devDependencies: { tsx: "4" }, scripts: { test: "x" } })),
    ["name web", "description: A site", "dependencies: next, react", "devDependencies: tsx", "scripts: test"],
  );
  assert.deepEqual(packageJsonSummary("{"), ["(not valid JSON)"]);
  assert.deepEqual(
    pyprojectSummary('[project]\nname = "api"\ndependencies = [\n  "fastapi>=0.110",\n  "pydantic[email]",\n]\n'),
    ["name api", "dependencies: fastapi, pydantic"],
  );
  assert.deepEqual(
    pyprojectSummary('[tool.poetry]\nname = "bot"\n\n[tool.poetry.dependencies]\npython = "^3.11"\nhttpx = "*"\n\n[build-system]\nrequires = ["poetry-core"]\n'),
    ["name bot", "dependencies: httpx"],
  );
  assert.equal(frontmatterSummary("---\ntags: [projet]\nstack: Expo, Supabase\n---\n# Title"), "tags: [projet]; stack: Expo, Supabase");
  assert.equal(frontmatterSummary("# No frontmatter"), null);
  assert.match(frontmatterSummary(`---\nnext: ${"x".repeat(400)}\n---\n`)!, /^next: x+\.\.\.$/);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-catalog-"));
  const repo = path.join(home, "repo");
  const notes = path.join(home, "notes");
  fs.mkdirSync(repo);
  fs.mkdirSync(notes);
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "web", dependencies: { next: "16" } }));
  fs.writeFileSync(path.join(repo, "README.md"), "# Web\n\nThe site.\n");
  fs.writeFileSync(path.join(notes, "Alpha.md"), "---\nstack: Next.js, Supabase\n---\nBody");
  fs.writeFileSync(path.join(notes, "Beta.md"), "No frontmatter");
  fs.writeFileSync(path.join(notes, "image.png"), "");
  assert.deepEqual(folderSummary(notes), ["Alpha.md: stack: Next.js, Supabase", "Beta.md"]);
  const room = { name: "web", dir: home, targetRepo: repo, color: null, shared: false, agents: [] };
  const catalog = buildCatalog(home, [room, { ...room, name: "web-2" }], [notes, path.join(home, "gone")]);
  assert.deepEqual(catalog.dirs, [repo, notes]);
  assert.equal(
    catalog.text,
    [
      "### repo (rooms web, web-2)",
      "- package.json: name web; dependencies: next",
      "- README: # Web / The site.",
      "",
      "### notes (catalogue folder)",
      "- Alpha.md: stack: Next.js, Supabase",
      "- Beta.md",
      "",
      "### gone (catalogue folder)",
      "- (missing)",
    ].join("\n"),
  );
});

test("an agent-mode run reads the catalogue folders of myhq.json, read-only", async () => {
  const { config, db } = setup();
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "demo-app", dependencies: { expo: "57" } }));
  const room = JSON.parse(fs.readFileSync(path.join(config.home, "rooms", "demo", "room.json"), "utf8")) as Record<string, unknown>;
  fs.writeFileSync(path.join(config.home, "rooms", "demo", "room.json"), JSON.stringify({ ...room, targetRepo: path.relative(config.home, repo) }));
  const notes = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-notes-"));
  fs.writeFileSync(path.join(notes, "Demo.md"), "---\nstack: Expo, Supabase\n---\n");
  fs.writeFileSync(path.join(config.home, "myhq.json"), JSON.stringify({ language: "fr", catalog: { dirs: [notes] } }));
  syncHome(db, loadHome(config.home));
  const seen: RunInput[] = [];
  const { run } = proposeAgent({ need: NEED }, { config, engine: submittingEngine(db, seen), send });
  await waitForRun(db, run!.id);
  const input = seen[0]!;
  assert.deepEqual(input.addDirs, [templatesDir, repo, notes]);
  assert.match(input.prompt, /- package\.json: name demo-app; dependencies: expo/);
  assert.match(input.prompt, /- Demo\.md: stack: Expo, Supabase/);
  assert.match(input.prompt, /Language of this home: fr \(French\)\. Write the title, the body, the reason and the whole role prompt in French/);
  assert.match(input.prompt, /"Proposition d'agent : <agent id> \(<room>\)"/);
});
