import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { hqSubmit, ToolError } from "../src/mcp/tools";
import { decideApproval } from "../src/server/approvals";
import { getDbAt, type ApprovalRow, type Db } from "../src/server/db";
import type { Engine, RunInput } from "../src/server/engine";
import { HqError } from "../src/server/errors";
import { ONBOARDING_AGENT, ONBOARDING_ROOM, startOnboarding, suggestRoomName } from "../src/server/onboarding";
import { loadHome } from "../src/server/rooms";
import { roleTemplatesDir } from "../src/server/templates";
import { makeHome, makeRepo, waitForRun } from "./helpers";

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
  assert.deepEqual(input.addDirs, [templatesDir]);
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
