import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { hqSubmit, ToolError } from "../src/mcp/tools";
import { parseStreamLine } from "../src/server/claude-engine";
import { decideApproval } from "../src/server/approvals";
import { app } from "../src/server/app";
import { getDbAt, type ApprovalRow, type Db, type RunRow, type TaskRow } from "../src/server/db";
import type { Engine, RunEvent, RunInput } from "../src/server/engine";
import { HqError } from "../src/server/errors";
import { ONBOARDING_AGENT, ONBOARDING_ROOM, startOnboarding, suggestRoomName, wakeOnboarding } from "../src/server/onboarding";
import { normalizeRoomProposal } from "../src/server/proposal";
import { loadHome } from "../src/server/rooms";
import { roleTemplatesDir } from "../src/server/templates";
import { makeHome, makeRepo, waitForRun } from "./helpers";

// Built from code points: the repository never contains these characters.
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

const templatesDir = roleTemplatesDir(process.cwd());

/** A proposal as the onboarding agent submits it, for a project cloned next to the home. */
function proposal(targetRepo: string, name = "acme") {
  const values = {
    project: "Acme",
    targets: ["fix the open bugs"],
    audience: "people who use Acme",
    features: ["notes", "sharing"],
    autonomy: "A",
    guardrails: ["No promise outside the list."],
  };
  return {
    room: {
      name,
      targetRepo,
      agents: [
        {
          id: "dev",
          name: "Dev",
          model: "opus",
          allowedTools: ["Read", "Edit", "Bash(git *)", "mcp__hq__*"],
          cron: "0 5 * * *",
          armed: true,
          worktree: `data/worktrees/${name}/dev`,
          workingDirectory: `data/worktrees/${name}/dev`,
          disallowedTools: ["Bash(git push *)"],
          maxBudgetUsd: 1,
        },
        { id: "watch", name: "Watch", model: "haiku", allowedTools: ["WebSearch", "mcp__hq__*"] },
      ],
    },
    roles: {
      dev: { template: "dev", values, notes: "Run `npm test` before committing." },
      watch: { template: "competitor-watch", values: { ...values, autonomy: "C" } },
    },
    claudeMd: "## HQ agents\n\n- Tests: `npm test`.\n- Agents never push or deploy.",
  };
}

/** A fake onboarding engine that submits through the real hq_submit, as the MCP server would. */
function submittingEngine(db: Db, payload: unknown, seen: RunInput[]): Engine {
  return {
    name: "claude",
    async *run(input) {
      seen.push(input);
      hqSubmit(
        db,
        { dbPath: "", runId: input.runId, agentId: input.agentId, room: input.room, templatesDir },
        { type: "room_proposal", title: "Room proposal: acme", body: "Two agents for Acme.", payload: payload as Record<string, unknown> },
      );
      yield { type: "tool_result", toolUseId: "t1", isError: false, content: "{}" };
      yield {
        type: "end",
        status: "done",
        reason: "success",
        summary: "Submitted.",
        usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        costUsd: 0.05,
      };
    },
  };
}

function setup() {
  const config = makeHome();
  const repo = makeRepo();
  const db = getDbAt(config.dbPath);
  const targetRepo = path.relative(config.home, repo).split(path.sep).join("/");
  // The run the submissions belong to.
  const runId = Number(
    db
      .prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at) VALUES (?, ?, 'claude', 't', 'done', ?)")
      .run(ONBOARDING_ROOM, ONBOARDING_AGENT, new Date().toISOString()).lastInsertRowid,
  );
  const ctx = { dbPath: config.dbPath, runId, agentId: ONBOARDING_AGENT, room: ONBOARDING_ROOM, templatesDir };
  return { config, repo, db, targetRepo, ctx };
}

test("an onboarding run reads the target with read-only tools and submits a normalized room proposal", async () => {
  const { config, repo, db, targetRepo } = setup();
  const seen: RunInput[] = [];
  const run = startOnboarding(
    { path: targetRepo },
    { config, engine: submittingEngine(db, proposal(targetRepo), seen), send: async () => true },
  );
  assert.equal(run.room, ONBOARDING_ROOM);
  assert.equal(run.agent_id, ONBOARDING_AGENT);
  assert.equal((await waitForRun(db, run.id)).status, "done");

  const input = seen[0]!;
  assert.equal(input.workDir, repo);
  assert.equal(input.model, "sonnet");
  assert.equal(input.maxBudgetUsd, config.onboardingMaxBudgetUsd);
  assert.deepEqual(input.tools, ["Read", "Glob", "Grep"]);
  assert.deepEqual(input.allowedTools, ["mcp__hq__hq_submit", "mcp__hq__hq_task_update"]);
  assert.deepEqual(input.addDirs, [templatesDir, path.join(config.home, "rooms")]);
  assert.equal(input.rolePath, path.join(process.cwd(), "templates", "onboarding.md"));
  assert.match(input.prompt, new RegExp(`"targetRepo": "${targetRepo.replace(/\./g, "\\.")}"`));
  assert.match(input.prompt, /Rooms that already exist, and cannot be used: "demo"/);
  assert.match(input.prompt, /- dev: developer/);

  const row = db.prepare("SELECT * FROM approvals WHERE type = 'room_proposal'").get() as ApprovalRow;
  const payload = JSON.parse(row.payload) as {
    room: { agents: { role: string; armed: boolean }[] };
    roles: Record<string, { template: string; content: string }>;
  };
  assert.deepEqual(
    payload.room.agents.map((a) => [a.role, a.armed]),
    [
      ["roles/dev.md", false],
      ["roles/watch.md", false],
    ],
  );
  assert.match(payload.roles.dev!.content, /^# Acme: developer/);
  assert.match(payload.roles.dev!.content, /## Project notes\n\nRun `npm test` before committing\./);
  assert.doesNotMatch(payload.roles.watch!.content, /\{\{/);
  assert.match(row.body, /^Two agents for Acme\.\n\n## room\.json\n\n```json/);
  assert.match(row.body, /### watch \(competitor-watch\)/);
  assert.match(row.body, /## CLAUDE\.md block/);
});

test("hq_submit refuses an invalid room proposal with an explicit error", () => {
  const { db, targetRepo, ctx } = setup();
  const submit = (payload: unknown) =>
    hqSubmit(db, ctx, { type: "room_proposal", title: "t", body: "b", payload: payload as Record<string, unknown> });
  const valid = proposal(targetRepo);
  assert.throws(() => submit({ ...valid, roles: { dev: valid.roles.dev } }), (e) => e instanceof ToolError && /no role for agent\(s\) watch/.test(e.message));
  assert.throws(() => submit({ ...valid, roles: { ...valid.roles, extra: valid.roles.dev } }), /roles without an agent: extra/);
  assert.throws(() => submit({ ...valid, roles: { ...valid.roles, dev: { ...valid.roles.dev, template: "astronaut" } } }), /unknown role template/);
  assert.throws(() => submit({ ...valid, claudeMd: "" }), /claudeMd/);
  const badCron = { ...valid, room: { ...valid.room, agents: [{ ...valid.room.agents[1], cron: "every day" }] }, roles: { watch: valid.roles.watch } };
  assert.throws(() => submit(badCron), /room\.agents\.0\.cron/);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM approvals").get() as { n: number }).n, 0);
});

test("approving the proposal writes the room and the worktree, a second one with the same name is refused", () => {
  const { config, repo, db, targetRepo, ctx } = setup();
  const submit = () =>
    hqSubmit(db, ctx, { type: "room_proposal", title: "t", body: "b", payload: proposal(targetRepo) }).approvalId;

  const first = submit();
  const approved = decideApproval(db, first, { decision: "approved" }, config);
  assert.equal(approved.status, "approved");
  const roomDir = path.join(config.home, "rooms", "acme");
  const written = JSON.parse(fs.readFileSync(path.join(roomDir, "room.json"), "utf8")) as { agents: { armed: boolean }[] };
  assert.ok(written.agents.every((a) => a.armed === false));
  assert.match(fs.readFileSync(path.join(roomDir, "roles", "dev.md"), "utf8"), /^# Acme: developer/);
  const worktree = path.join(config.home, "data", "worktrees", "acme", "dev");
  assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: worktree, encoding: "utf8" }).trim(), "hq/dev");
  // Nothing lands in the target repository except Git's own worktree bookkeeping.
  assert.deepEqual(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim(), "");
  // The room is live without a restart.
  assert.ok(loadHome(config.home).rooms.some((r) => r.name === "acme"));
  assert.ok(db.prepare("SELECT 1 FROM agents WHERE room = 'acme' AND id = 'dev'").get());

  const before = fs.readFileSync(path.join(roomDir, "roles", "dev.md"), "utf8");
  const second = submit();
  assert.throws(
    () => decideApproval(db, second, { decision: "approved" }, config),
    (e: unknown) => e instanceof HqError && e.code === "ROOM_EXISTS" && e.status === 409,
  );
  assert.equal((db.prepare("SELECT status FROM approvals WHERE id = ?").get(second) as { status: string }).status, "pending");
  assert.equal(fs.readFileSync(path.join(roomDir, "roles", "dev.md"), "utf8"), before);
  // It can still be rejected.
  assert.equal(decideApproval(db, second, { decision: "rejected", note: "Already there." }, config).status, "rejected");
});

test("a room whose worktree cannot be created is not written", () => {
  const { config, db, targetRepo, ctx } = setup();
  const busy = path.join(config.home, "data", "worktrees", "acme", "dev");
  fs.mkdirSync(busy, { recursive: true });
  fs.writeFileSync(path.join(busy, "something.txt"), "x");
  const id = hqSubmit(db, ctx, { type: "room_proposal", title: "t", body: "b", payload: proposal(targetRepo) }).approvalId;
  assert.throws(
    () => decideApproval(db, id, { decision: "approved" }, config),
    (e: unknown) => e instanceof HqError && e.code === "WORKTREE_FAILED",
  );
  assert.equal(fs.existsSync(path.join(config.home, "rooms", "acme")), false);
});

test("onboarding refuses a path that is not a directory, and suggests room names", () => {
  const { config } = setup();
  assert.throws(
    () => startOnboarding({ path: "../does-not-exist" }, { config }),
    (e: unknown) => e instanceof HqError && e.code === "TARGET_NOT_FOUND",
  );
  assert.equal(suggestRoomName("My Café App"), "my-cafe-app");
  assert.equal(suggestRoomName("..."), "project");
});

// Real output of one onboarding run (CLI 2.1.183, haiku, --max-budget-usd
// 0.3, 2026-11-02) on a small scratch repository: it read the README, the
// manifest and the docs with Read and Glob, submitted a room proposal once
// through hq_submit and closed its task. Machine paths replaced, the
// thinking_tokens messages reduced to one, dashes written as JSON escapes.
test("a real onboarding stream: read-only tools, one submission, and a payload MyHQ accepts", () => {
  const events = fs
    .readFileSync(path.join(import.meta.dirname, "fixtures", "stream-json-onboarding.jsonl"), "utf8")
    .split("\n")
    .flatMap(parseStreamLine);
  const start = events[0] as Extract<RunEvent, { type: "start" }>;
  assert.equal(start.type, "start");
  assert.deepEqual(start.mcpServers, [{ name: "hq", status: "connected" }]);
  assert.deepEqual(
    start.tools.filter((t) => !t.startsWith("mcp__")),
    ["Glob", "Grep", "Read"],
  );
  const calls = events.filter((e): e is Extract<RunEvent, { type: "tool_call" }> => e.type === "tool_call");
  assert.ok(calls.every((c) => ["Read", "Glob", "Grep", "mcp__hq__hq_submit", "mcp__hq__hq_task_update"].includes(c.name)));
  const results = events.filter((e): e is Extract<RunEvent, { type: "tool_result" }> => e.type === "tool_result");
  assert.ok(results.every((r) => !r.isError), "no tool call was refused");
  const submits = calls.filter((c) => c.name === "mcp__hq__hq_submit");
  assert.equal(submits.length, 1);
  const end = events[events.length - 1] as Extract<RunEvent, { type: "end" }>;
  assert.equal(end.status, "done");
  assert.ok(end.costUsd > 0 && end.costUsd < 0.3);

  const input = submits[0]!.input as { type: string; body: string; payload: unknown };
  assert.equal(input.type, "room_proposal");
  const { payload, body } = normalizeRoomProposal(input.payload, input.body, templatesDir);
  assert.equal(payload.room.name, "tinylog");
  assert.equal(payload.room.targetRepo, "../tinylog");
  const dev = payload.room.agents.find((a) => a.id === "dev")!;
  assert.equal(dev.worktree, "data/worktrees/tinylog/dev");
  assert.equal(dev.armed, false);
  assert.ok(dev.disallowedTools?.includes("Bash(git push *)"));
  assert.match(payload.claudeMd, /^## HQ agents/);
  const written = [body, payload.claudeMd, ...Object.values(payload.roles).map((r) => r.content)].join("\n");
  assert.doesNotMatch(written, DASHES, "no em or en dash reaches the home");
  assert.doesNotMatch(written, /\{\{\w+\}\}/);
});

test("the onboarding prompt states the language of the home and the title to use", async () => {
  const run = async (language: string | null) => {
    const { config, db, targetRepo } = setup();
    if (language) fs.writeFileSync(path.join(config.home, "myhq.json"), JSON.stringify({ language }));
    const seen: RunInput[] = [];
    const started = startOnboarding(
      { path: targetRepo },
      { config, engine: submittingEngine(db, proposal(targetRepo), seen), send: async () => true },
    );
    await waitForRun(db, started.id);
    return seen[0]!.prompt;
  };

  const fr = await run("fr");
  assert.match(fr, /Language of this home: fr \(French\)/);
  assert.match(fr, /the "HQ agents" block of claudeMd/);
  assert.match(fr, /must be exactly in this form: "Proposition de salle : <room name>"/);
  assert.match(fr, /translate the whole prompt into French/);
  assert.match(fr, /"content": "<whole role prompt/);

  for (const prompt of [await run("en"), await run(null)]) {
    assert.match(prompt, /Language of this home: en \(English\)/);
    assert.match(prompt, /Title of the hq_submit item: "Room proposal: <room name>"/);
    assert.doesNotMatch(prompt, /Proposition de salle/);
    assert.doesNotMatch(prompt, /translate the whole prompt/);
  }
});

test("a role sent as content (translated by the agent) replaces the instantiated template", () => {
  const { db, targetRepo, ctx } = setup();
  const valid = proposal(targetRepo);
  const submit = (content: string) =>
    hqSubmit(db, ctx, {
      type: "room_proposal",
      title: "Proposition de salle : acme",
      body: "Deux agents pour Acme.",
      payload: { ...valid, roles: { ...valid.roles, dev: { ...valid.roles.dev, content } } },
    });
  assert.throws(() => submit("# Acme : développeur\n\nIl reste {{project}} ici."), /roles\.dev: content still has placeholder\(s\): \{\{project\}\}/);
  submit("# Acme : développeur\n\nTu corriges les bugs d'Acme.");
  const row = db.prepare("SELECT payload FROM approvals").get() as { payload: string };
  const roles = (JSON.parse(row.payload) as { roles: Record<string, { content: string }> }).roles;
  assert.equal(roles.dev!.content, "# Acme : développeur\n\nTu corriges les bugs d'Acme.\n");
  assert.match(roles.watch!.content, /^# Acme: /);
});

// A revision of a room proposal: the onboarding agent is in no room of the home,
// so wakeAgents does not know it; wakeOnboarding relaunches it on the same repository.

const send = async () => true;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met");
    await sleep(10);
  }
}

const endEvent = (status: "done" | "failed"): RunEvent => ({
  type: "end",
  status,
  reason: status === "done" ? "success" : "spawn_error",
  summary: status === "done" ? "ok" : "boom",
  usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
  costUsd: 0,
});

const submitProposal = (ctx: ReturnType<typeof setup>["ctx"], db: Db, targetRepo: string, name = "acme") =>
  hqSubmit(db, ctx, {
    type: "room_proposal",
    title: `Room proposal: ${name}`,
    body: "Two agents for Acme.",
    payload: proposal(targetRepo, name) as unknown as Record<string, unknown>,
  }).approvalId;

const revisionRuns = (db: Db) =>
  db.prepare("SELECT * FROM runs WHERE room = ? AND reason = 'revise' ORDER BY id").all(ONBOARDING_ROOM) as RunRow[];

const reviseTasks = (db: Db) =>
  db.prepare("SELECT * FROM tasks WHERE room = ? AND source = 'revise' ORDER BY id").all(ONBOARDING_ROOM) as TaskRow[];

test("a revision of a room proposal relaunches onboarding on the same repository, with the previous proposal and the remarks", async () => {
  const { config, repo, db, targetRepo, ctx } = setup();
  const id = submitProposal(ctx, db, targetRepo);
  const seen: RunInput[] = [];
  decideApproval(
    db,
    id,
    { decision: "revise", note: "Fewer agents.", annotations: [{ quote: "Two agents", comment: "One is enough." }] },
    config,
    { engine: submittingEngine(db, proposal(targetRepo), seen), send },
  );

  const [run] = revisionRuns(db);
  assert.ok(run, "a run started at once, with the reason revise");
  assert.equal(run.agent_id, ONBOARDING_AGENT);
  assert.equal(run.task, `Propose a room for the repository ${targetRepo}.`);
  assert.equal((await waitForRun(db, run.id)).status, "done");

  const input = seen[0]!;
  assert.equal(input.workDir, repo);
  assert.match(input.prompt, new RegExp(`"targetRepo": "${targetRepo.replace(/\./g, "\\.")}"`));
  assert.match(input.prompt, /REVISION RUN\. The user sent your previous proposal #\d+ back \(revise\)/);
  assert.match(input.prompt, /"Room proposal: acme", room "acme" with agents dev \(opus\), watch \(haiku\)/);
  assert.match(input.prompt, /> Two agents for Acme\./);
  assert.doesNotMatch(input.prompt, /> ## room\.json/);
  assert.match(input.prompt, /À propos de « Two agents » : One is enough\./);
  assert.match(input.prompt, /Remarque générale : Fewer agents\./);
  assert.match(input.prompt, /answers each remark/);
  assert.match(input.prompt, /Suggested room name: "acme"/);

  // The revision task was taken by the run; the new proposal is a new item, the old one stays sent back.
  assert.deepEqual(reviseTasks(db).map((t) => t.status), ["done"]);
  const items = db.prepare("SELECT id, status FROM approvals ORDER BY id").all() as { id: number; status: string }[];
  assert.deepEqual(items.map((i) => i.status), ["revise", "pending"]);
  // Approving the new one writes the room; a later proposal with the same name is still refused.
  decideApproval(db, items[1]!.id, { decision: "approved" }, config);
  assert.ok(loadHome(config.home).rooms.some((r) => r.name === "acme"));
  const again = submitProposal(ctx, db, targetRepo);
  assert.throws(
    () => decideApproval(db, again, { decision: "approved" }, config),
    (e: unknown) => e instanceof HqError && e.code === "ROOM_EXISTS",
  );
});

test("a rejection of a room proposal ends the matter: no task, no run; only a revision relaunches onboarding", async () => {
  const { config, db, targetRepo, ctx } = setup();
  const seen: RunInput[] = [];
  const id = submitProposal(ctx, db, targetRepo);
  const rejected = decideApproval(db, id, { decision: "rejected", note: "Later." }, config, {
    engine: submittingEngine(db, proposal(targetRepo), seen),
    send,
  });
  assert.equal(rejected.status, "rejected");
  assert.equal(reviseTasks(db).length, 0);
  assert.equal(revisionRuns(db).length, 0);
  // Nothing wakes it later either (the next wake-up, the next start of the app).
  assert.deepEqual(wakeOnboarding(config, db, { engine: submittingEngine(db, proposal(targetRepo), seen), send }), []);
  assert.equal(seen.length, 0);
  const runs = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE room = ? AND id <> ?").get(ONBOARDING_ROOM, ctx.runId) as { n: number };
  assert.equal(runs.n, 0);

  // A revision after a rejection still sends it back.
  const second = submitProposal(ctx, db, targetRepo);
  decideApproval(db, second, { decision: "revise", note: "Fewer agents." }, config, {
    engine: submittingEngine(db, proposal(targetRepo), seen),
    send,
  });
  const [run] = revisionRuns(db);
  assert.ok(run);
  await waitForRun(db, run.id);
  assert.doesNotMatch(seen[0]!.prompt, /which the user rejected/);
  assert.match(seen[0]!.prompt, /Fewer agents\./);
});

test("a stale revision task (its item is not in revise any more) is ignored by wakeOnboarding and by a run", async () => {
  const { config, db, targetRepo, ctx } = setup();
  const seen: RunInput[] = [];
  const id = submitProposal(ctx, db, targetRepo);
  // Decided without a config: the revision task waits.
  decideApproval(db, id, { decision: "revise", note: "Change it." });
  assert.deepEqual(reviseTasks(db).map((t) => t.status), ["pending"]);
  // The item was rejected since (or the task dates from the time a rejection relaunched it).
  db.prepare("UPDATE approvals SET status = 'rejected' WHERE id = ?").run(id);
  const engine = submittingEngine(db, proposal(targetRepo), seen);
  assert.deepEqual(wakeOnboarding(config, db, { engine, send }), []);
  assert.equal(seen.length, 0);

  // A run the owner starts by hand does not take it either.
  const run = startOnboarding({ path: targetRepo }, { config, engine: { name: "claude", async *run(input) { seen.push(input); yield endEvent("done"); } }, send });
  await waitForRun(db, run.id);
  assert.doesNotMatch(seen[0]!.prompt, /Change it\./);
  assert.deepEqual(reviseTasks(db).map((t) => t.status), ["pending"]);
});

test("the receptionist never submits a new room proposal for a repository whose latest one was rejected, unless the owner started the run", () => {
  const { config, db, targetRepo, ctx } = setup();
  const other = path.relative(config.home, makeRepo()).split(path.sep).join("/");
  const id = submitProposal(ctx, db, targetRepo);
  decideApproval(db, id, { decision: "rejected", note: "Later." }, config);
  const runWith = (reason: string | null) =>
    Number(
      db
        .prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at, reason) VALUES (?, ?, 'claude', 't', 'running', ?, ?)")
        .run(ONBOARDING_ROOM, ONBOARDING_AGENT, new Date().toISOString(), reason).lastInsertRowid,
    );
  const submitAs = (runId: number, repo: string, name: string) => submitProposal({ ...ctx, runId }, db, repo, name);

  // A run woken by MyHQ is refused, and nothing is stored.
  const before = (db.prepare("SELECT COUNT(*) AS n FROM approvals").get() as { n: number }).n;
  assert.throws(() => submitAs(runWith("revise"), targetRepo, "again"), (e: unknown) => e instanceof ToolError && /rejected/.test(e.message));
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM approvals").get() as { n: number }).n, before);
  // Another repository is not concerned.
  assert.ok(submitAs(runWith("revise"), other, "elsewhere"));
  // The owner started this run by hand: allowed.
  const again = submitAs(runWith(null), targetRepo, "again");
  assert.ok(again);
  // The latest proposal of the repository is now pending: the guard no longer applies.
  assert.ok(submitAs(runWith("revise"), targetRepo, "third"));
  // Rejecting that one closes the repository again.
  const latest = (db.prepare("SELECT MAX(id) AS id FROM approvals").get() as { id: number }).id;
  decideApproval(db, latest, { decision: "rejected", note: "No." }, config);
  assert.throws(() => submitAs(runWith("revise"), targetRepo, "fourth"), ToolError);
});

test("a revision while onboarding is busy waits, and runs when the busy run ends", async () => {
  const { config, db, targetRepo, ctx } = setup();
  const other = makeRepo();
  const otherRepo = path.relative(config.home, other).split(path.sep).join("/");
  const seen: RunInput[] = [];
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const engine: Engine = {
    name: "claude",
    async *run(input) {
      seen.push(input);
      if (seen.length === 1) await gate;
      yield endEvent("done");
    },
  };
  const first = startOnboarding({ path: otherRepo }, { config, engine, send });
  const id = submitProposal(ctx, db, targetRepo);
  const elsewhere = submitProposal(ctx, db, otherRepo, "other");
  decideApproval(db, id, { decision: "revise", note: "Change it." }, config, { engine, send });
  decideApproval(db, elsewhere, { decision: "revise", note: "Change that one." }, config, { engine, send });

  // One onboarding run at a time: both revisions wait.
  assert.equal(revisionRuns(db).length, 0);
  assert.deepEqual(reviseTasks(db).map((t) => t.status), ["pending", "pending"]);
  assert.equal(seen.length, 1);

  release();
  await waitForRun(db, first.id);
  await until(() => revisionRuns(db).length === 2);
  const runs = revisionRuns(db);
  // The oldest revision first, each on its own repository: they never share a run.
  assert.deepEqual(runs.map((r) => r.task), [
    `Propose a room for the repository ${targetRepo}.`,
    `Propose a room for the repository ${otherRepo}.`,
  ]);
  for (const run of runs) await waitForRun(db, run.id);
  assert.match(seen[1]!.prompt, /Change it./);
  assert.doesNotMatch(seen[1]!.prompt, /Change that one./);
  assert.match(seen[2]!.prompt, /Change that one./);
  assert.doesNotMatch(seen[2]!.prompt, /Change it./);
  assert.deepEqual(reviseTasks(db).map((t) => t.status), ["done", "done"]);
});

test("the daily cap leaves a revision pending, and a failing revision run is not retried in a loop", async () => {
  const { config, db, targetRepo, ctx } = setup();
  const id = submitProposal(ctx, db, targetRepo);
  const failing: Engine = {
    name: "claude",
    async *run() {
      yield endEvent("failed");
    },
  };
  decideApproval(db, id, { decision: "revise", note: "Change it." }, { ...config, maxRunsPerDay: 1 }, { engine: failing, send });
  // The setup run already counts for today: nothing started.
  assert.equal(revisionRuns(db).length, 0);
  assert.deepEqual(reviseTasks(db).map((t) => t.status), ["pending"]);

  wakeOnboarding(config, db, { engine: failing, send });
  await until(() => revisionRuns(db).length === 1);
  await waitForRun(db, revisionRuns(db)[0]!.id);
  await sleep(100);
  assert.equal(revisionRuns(db).length, 1, "the failed run did not wake itself again");
  assert.deepEqual(reviseTasks(db).map((t) => t.status), ["pending"]);
});

test("a revision whose repository is gone is blocked, not retried", () => {
  const { config, db, ctx } = setup();
  const id = submitProposal(ctx, db, "../vanished-project");
  decideApproval(db, id, { decision: "revise", note: "Change it." }, config, { send });
  assert.equal(revisionRuns(db).length, 0);
  const [task] = reviseTasks(db);
  assert.equal(task!.status, "blocked");
  assert.match(task!.note ?? "", /vanished-project/);
});

test("at startup, a pending revision of the onboarding agent runs without manual action", async () => {
  const { config, db, targetRepo, ctx } = setup();
  const id = submitProposal(ctx, db, targetRepo);
  // Decided while the app was down, or without a config: the task exists, nothing ran.
  decideApproval(db, id, { decision: "revise", note: "Change it." });
  assert.equal(revisionRuns(db).length, 0);
  assert.deepEqual(reviseTasks(db).map((t) => t.status), ["pending"]);

  const saved = { home: process.env.MYHQ_HOME, bin: process.env.HQ_CLAUDE_BIN };
  process.env.MYHQ_HOME = config.home;
  process.env.HQ_CLAUDE_BIN = "claude-binary-not-installed-in-tests";
  try {
    app();
  } finally {
    if (saved.home === undefined) delete process.env.MYHQ_HOME;
    else process.env.MYHQ_HOME = saved.home;
    if (saved.bin === undefined) delete process.env.HQ_CLAUDE_BIN;
    else process.env.HQ_CLAUDE_BIN = saved.bin;
  }
  const [run] = revisionRuns(db);
  assert.ok(run, "the sweep of the start started the run");
  assert.equal(run.task, `Propose a room for the repository ${targetRepo}.`);
  // No binary: the run fails, which proves it was really launched.
  assert.equal((await waitForRun(db, run.id)).status, "failed");
});
