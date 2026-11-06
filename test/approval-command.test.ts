import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { hqSubmit, ToolError, type HqContext } from "../src/mcp/tools";
import { approvalCommandsIdle } from "../src/server/approval-command";
import { decideApproval } from "../src/server/approvals";
import type { HqConfig } from "../src/server/config";
import { getDbAt, type Db, type RunRow, type TaskRow } from "../src/server/db";
import type { Engine, RunEvent, RunInput } from "../src/server/engine";
import { APPROVAL_SELECT, toApproval, type ApprovalRowWithAction } from "../src/server/feed";
import { portierIdle, type PortierCall } from "../src/server/portier";
import { loadHome, syncHome } from "../src/server/rooms";
import { makeHome, waitForRun } from "./helpers";

// Approved items executed without a model turn: `onApproval: "command"` runs
// the agent's command with the item on stdin (success: the item is executed;
// failure: the agent gets the task, with the error, and is woken), and
// hq_submit `onApprove` has MyHQ deliver the orders of an approved item itself.

const usage = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const done: RunEvent = { type: "end", status: "done", reason: "success", summary: "ok", usage, costUsd: 0 };

function engine(seen: RunInput[] = []): Engine {
  return {
    name: "claude",
    async *run(input) {
      seen.push(input);
      yield done;
    },
  };
}

/** The command of the agent: a Node script of the home that records its stdin and environment, then does what `mode` says. */
const SCRIPT = `
import fs from "node:fs";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  fs.writeFileSync("seen.json", JSON.stringify({ input: JSON.parse(input), home: process.env.MYHQ_HOME ?? null, leaked: process.env.HQ_TEST_SECRET ?? null, cwd: process.cwd() }));
  const mode = process.argv[2];
  if (mode === "ok") console.log(JSON.stringify({ ok: true, note: "Envoyé à client@example.com." }));
  else if (mode === "silent") console.log("done");
  else { console.error("SMTP indisponible"); process.exit(3); }
});
`;

/** Room "demo": a mailer with an approval command, Social (onApproval task) and Motion. */
function office(mode: "ok" | "silent" | "fail"): { config: HqConfig; db: Db } {
  const base = { role: "roles/scout.md", model: "haiku", allowedTools: ["mcp__hq__*"] };
  const config = makeHome(
    { portier: { enabled: true, model: "haiku" } },
    {
      name: "demo",
      targetRepo: "../demo-project",
      agents: [
        { id: "mailer", name: "Mailer", ...base, onApproval: "command", approvalCommand: [process.execPath, "tools/send.mjs", mode] },
        { id: "social", name: "Social", ...base, onApproval: "task" },
        { id: "motion", name: "Motion", ...base },
      ],
    },
  );
  fs.mkdirSync(path.join(config.home, "tools"), { recursive: true });
  fs.writeFileSync(path.join(config.home, "tools", "send.mjs"), SCRIPT);
  const db = getDbAt(config.dbPath);
  syncHome(db, loadHome(config.home));
  return { config, db };
}

function addApproval(db: Db, agent: string): number {
  return Number(
    db
      .prepare(
        "INSERT INTO approvals (room, agent_id, type, title, body, payload, status, created_at) VALUES ('demo', ?, 'mail_reply', 'Réponse à Léa', 'Bonjour Léa, c''est d''accord.', '{\"to\":\"lea@example.com\"}', 'pending', ?)",
      )
      .run(agent, new Date().toISOString()).lastInsertRowid,
  );
}

const runsOf = (db: Db, agent: string) => db.prepare("SELECT * FROM runs WHERE agent_id = ? ORDER BY id").all(agent) as RunRow[];
const approvalTasks = (db: Db) => db.prepare("SELECT * FROM tasks WHERE source = 'approval' ORDER BY id").all() as TaskRow[];
const dto = (db: Db, id: number) => toApproval(db.prepare(`${APPROVAL_SELECT} WHERE a.id = ?`).get(id) as ApprovalRowWithAction);
const seenBy = (config: HqConfig) => JSON.parse(fs.readFileSync(path.join(config.home, "seen.json"), "utf8")) as Record<string, unknown>;

test("approval command: on approval MyHQ runs it with the item on stdin, the item is executed with its note, and no model turn", async () => {
  const { config, db } = office("ok");
  const seen: RunInput[] = [];
  const id = addApproval(db, "mailer");
  process.env.HQ_TEST_SECRET = "never-given";
  try {
    decideApproval(db, id, { decision: "approved", note: "Vas-y." }, config, { engine: engine(seen) });
    await approvalCommandsIdle();
  } finally {
    delete process.env.HQ_TEST_SECRET;
  }
  const [task] = approvalTasks(db);
  assert.equal(task?.status, "done");
  assert.equal(task?.note, "Envoyé à client@example.com.");
  assert.equal(runsOf(db, "mailer").length, 0, "no run");
  assert.equal(seen.length, 0);
  const item = dto(db, id);
  assert.equal(item.actionDone, true);
  assert.equal(item.actionNote, "Envoyé à client@example.com.");

  const stdin = seenBy(config);
  assert.deepEqual(stdin.input, {
    item: { id, room: "demo", agent: "mailer", kind: "mail_reply", title: "Réponse à Léa", body: "Bonjour Léa, c'est d'accord.", payload: { to: "lea@example.com" }, note: "Vas-y." },
  });
  assert.equal(stdin.home, config.home, "MYHQ_HOME is given");
  assert.equal(stdin.leaked, null, "the app's own variables are not");
  assert.equal(path.resolve(String(stdin.cwd)), path.resolve(config.home), "it runs in the home");
});

test("approval command: a failure, or an answer without ok, falls back to the task: the agent is woken with the error", async () => {
  for (const mode of ["fail", "silent"] as const) {
    const { config, db } = office(mode);
    const seen: RunInput[] = [];
    const id = addApproval(db, "mailer");
    decideApproval(db, id, { decision: "approved" }, config, { engine: engine(seen) });
    await approvalCommandsIdle();
    const [task] = approvalTasks(db);
    assert.ok(task);
    assert.match(task.text, new RegExp(`^Exécute l'item approuvé n° ${id} : Réponse à Léa`));
    assert.match(task.text, mode === "fail" ? /exited with code 3: SMTP indisponible/ : /without the JSON \{ "ok": true \}/);
    const [run] = runsOf(db, "mailer");
    assert.ok(run, "the agent is woken, as with onApproval task");
    assert.equal(run.reason, "approval");
    await waitForRun(db, run.id);
    assert.match(seen.at(-1)!.prompt, /MyHQ a lancé la commande d'approbation/);
    assert.equal(dto(db, id).actionNote, null);
  }
});

test("approval command: onApproval command needs approvalCommand, and a proposed agent may not carry one", async () => {
  const config = makeHome(
    {},
    { name: "demo", targetRepo: "../x", agents: [{ id: "mailer", name: "M", role: "roles/scout.md", model: "haiku", allowedTools: [], onApproval: "command" }] },
  );
  assert.match(loadHome(config.home).invalid[0]?.error ?? "", /approvalCommand is required/);
  const { proposedAgentSchema } = await import("../src/server/agent-proposal");
  const proposed = { id: "a", name: "A", model: "haiku", allowedTools: [], armed: false, approvalCommand: ["node", "x.mjs"] };
  assert.equal(proposedAgentSchema.safeParse(proposed).success, false);
});

test("onApprove: on approval MyHQ delivers the order with the item's text, the recipient is woken without the portier, the submitter is not", async () => {
  const { config, db } = office("ok");
  const seen: RunInput[] = [];
  const calls: unknown[] = [];
  const portier: PortierCall = async (input) => {
    calls.push(input);
    throw new Error("the portier must not be asked");
  };
  const runId = Number(
    db
      .prepare("INSERT INTO runs (room, agent_id, engine, task, status, started_at, ended_at) VALUES ('demo', 'social', 'claude', 't', 'done', ?, ?)")
      .run(new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() - 30_000).toISOString()).lastInsertRowid,
  );
  const social: HqContext = { dbPath: config.dbPath, runId, agentId: "social", room: "demo", home: config.home, appEnv: {} };

  assert.throws(
    () => hqSubmit(db, social, { type: "script", title: "Script", body: "B", onApprove: [{ to: "demo/nobody", text: "Go." }] }),
    (error: unknown) => error instanceof ToolError && /onApprove: Unknown agent "nobody"/.test(error.message),
  );
  const { approvalId } = hqSubmit(db, social, {
    type: "script",
    title: "Script du Reel d'ouverture",
    body: "Plan 1 : le logo. Plan 2 : la promesse.",
    onApprove: [{ to: "motion", text: "Monte ce script en 20 s." }],
  });

  decideApproval(db, approvalId, { decision: "approved" }, config, { engine: engine(seen), portier });
  await portierIdle();
  const [run] = runsOf(db, "motion");
  assert.ok(run, "Motion is woken at once");
  assert.equal(run.reason, "message");
  await waitForRun(db, run.id);
  const prompt = seen.at(-1)!.prompt;
  assert.match(prompt, /Message from social: Monte ce script en 20 s\./);
  assert.match(prompt, new RegExp(`--- Approved item #${approvalId} \\(script\\): Script du Reel d'ouverture`));
  assert.match(prompt, /Plan 1 : le logo\. Plan 2 : la promesse\./);
  assert.equal(calls.length, 0, "expects action: no portier");
  assert.equal(runsOf(db, "social").length, 1, "Social is not woken to relay it (its one run is the submitting one)");
  assert.equal(approvalTasks(db).length, 0, "and gets no task for it");
  const expects = db.prepare("SELECT w.expects FROM message_wake w JOIN tasks t ON t.id = w.task_id WHERE t.agent_id = 'motion'").get() as { expects: string };
  assert.equal(expects.expects, "action");
  // Delivered once.
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM messages WHERE to_agent = 'motion'").get() as { n: number }).n, 1);
  assert.ok((db.prepare("SELECT delivered_at FROM approval_relays WHERE approval_id = ?").get(approvalId) as { delivered_at: string | null }).delivered_at);
});
