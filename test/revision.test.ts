import assert from "node:assert/strict";
import { test } from "node:test";
import { PATCH } from "../src/app/api/approvals/[id]/route";
import { hqReadDecisions, type HqContext } from "../src/mcp/tools";
import { decideApproval, decisionSchema } from "../src/server/approvals";
import { getDbAt, type ApprovalRow, type Db, type TaskRow } from "../src/server/db";
import { getState } from "../src/server/feed";
import { loadHome } from "../src/server/rooms";
import { schedulerInfo } from "../src/server/routines";
import { makeHome } from "./helpers";

const ANNOTATIONS = [{ quote: "the first passage", comment: "Too long.", position: 12 }];

function fresh() {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const ctx: HqContext = { dbPath: config.dbPath, runId: 1, agentId: "scout", room: "demo" };
  return { config, db, ctx };
}

function addApproval(db: Db): number {
  return Number(
    db
      .prepare(
        "INSERT INTO approvals (room, agent_id, type, title, body, payload, status, created_at) VALUES ('demo', 'scout', 'article', 'Long piece', 'B', '{}', 'pending', ?)",
      )
      .run(new Date().toISOString()).lastInsertRowid,
  );
}

const row = (db: Db, id: number) => db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow;
const reviseTasks = (db: Db, id: number) =>
  db.prepare("SELECT * FROM tasks WHERE source = 'revise' AND ref_id = ? ORDER BY id").all(id) as TaskRow[];

/** Revises without any wake-up (no config given), so that no run starts. */
const revise = (db: Db, id: number, body: { note?: string; annotations?: typeof ANNOTATIONS }) =>
  decideApproval(db, id, { decision: "revise", ...body });

test("an approved item can be sent back: it becomes revise and the approval is kept in its history", () => {
  const { db } = fresh();
  const id = addApproval(db);
  const approved = decideApproval(db, id, { decision: "approved" });
  assert.deepEqual(approved.decisionHistory, []);
  const revised = revise(db, id, { note: "Actually, shorter.", annotations: ANNOTATIONS });
  assert.equal(revised.status, "revise");
  assert.equal(revised.decisionNote, "Actually, shorter.");
  assert.deepEqual(revised.annotations, ANNOTATIONS);
  assert.deepEqual(revised.decisionHistory, [
    { decision: "approved", note: null, annotations: [], decidedAt: approved.decidedAt },
  ]);
  assert.deepEqual(JSON.parse(row(db, id).decision_history), revised.decisionHistory);
});

test("a rejected item can be sent back too, and the history keeps the reason", () => {
  const { db } = fresh();
  const id = addApproval(db);
  decideApproval(db, id, { decision: "rejected", note: "Off topic." });
  const revised = revise(db, id, { note: "On second thought, rework it." });
  assert.equal(revised.status, "revise");
  assert.equal(revised.decisionHistory[0]?.decision, "rejected");
  assert.equal(revised.decisionHistory[0]?.note, "Off topic.");
});

test("the revision task and hq_read_decisions carry the new revise, even after the agent read the approval", () => {
  const { db, ctx } = fresh();
  const id = addApproval(db);
  decideApproval(db, id, { decision: "approved" });
  assert.equal(hqReadDecisions(db, ctx).decisions[0]?.decision, "approved");
  revise(db, id, { note: "Actually, shorter.", annotations: ANNOTATIONS });
  const [task] = reviseTasks(db, id);
  assert.equal(task?.agent_id, "scout");
  assert.equal(task?.status, "pending");
  assert.equal(
    task?.text,
    `Revise your submission #${id} "Long piece" (article). User's remarks:\n1. À propos de « the first passage » : Too long.\n\nRemarque générale : Actually, shorter.`,
  );
  const [decision] = hqReadDecisions(db, ctx).decisions;
  assert.equal(decision?.decision, "revise");
  assert.equal(decision?.note, "1. À propos de « the first passage » : Too long.\n\nRemarque générale : Actually, shorter.");
  assert.equal(hqReadDecisions(db, ctx).decisions.length, 0, "read once");
});

test("another decision on a decided item is still refused", () => {
  const { db } = fresh();
  const id = addApproval(db);
  decideApproval(db, id, { decision: "approved" });
  for (const decision of [{ decision: "approved" }, { decision: "rejected", note: "No." }] as const) {
    assert.throws(() => decideApproval(db, id, decision), { code: "APPROVAL_ALREADY_DECIDED" });
  }
  assert.equal(row(db, id).status, "approved");
});

test("an item already in revise refuses a revise with nothing new, accepts one with new content", () => {
  const { db } = fresh();
  const id = addApproval(db);
  revise(db, id, { note: "Shorter." });
  assert.throws(() => revise(db, id, { note: "Shorter." }), { code: "APPROVAL_ALREADY_DECIDED" });
  assert.equal(reviseTasks(db, id).length, 1);
  const again = revise(db, id, { note: "Shorter.", annotations: ANNOTATIONS });
  assert.equal(again.decisionHistory.length, 1);
  assert.equal(again.decisionHistory[0]?.decision, "revise");
  assert.equal(reviseTasks(db, id).length, 2);
});

test("a first decision leaves the history empty, and the history grows with each revision", () => {
  const { db } = fresh();
  const id = addApproval(db);
  assert.deepEqual(revise(db, id, { note: "One." }).decisionHistory, []);
  revise(db, id, { note: "Two." });
  const third = revise(db, id, { note: "Three." });
  assert.deepEqual(
    third.decisionHistory.map((d) => d.note),
    ["One.", "Two."],
  );
});

test("a revision needs a note or remarks, whatever the status of the item", () => {
  const { db } = fresh();
  const id = addApproval(db);
  decideApproval(db, id, { decision: "approved" });
  assert.equal(decisionSchema.safeParse({ decision: "revise" }).success, false);
  assert.equal(row(db, id).status, "approved");
});

test("the desk state exposes the history, whether the execution task is done, and informational items", () => {
  const { config, db } = fresh();
  const id = addApproval(db);
  decideApproval(db, id, { decision: "approved" });
  const at = new Date().toISOString();
  const insertTask = db.prepare(
    "INSERT INTO tasks (room, agent_id, source, ref_id, text, status, created_at, updated_at) VALUES ('demo', 'scout', 'approval', ?, 't', ?, ?, ?)",
  );
  const state = () =>
    getState(db, loadHome(config.home), schedulerInfo(config)).approvals.history.find((a) => a.id === id)!;
  assert.equal(state().actionDone, false, "no execution task");
  const task = Number(insertTask.run(id, "pending", at, at).lastInsertRowid);
  assert.equal(state().actionDone, false, "the task has not run");
  db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task);
  assert.equal(state().actionDone, true);
  revise(db, id, { note: "Too late, but noted." });
  assert.equal(state().actionDone, true, "the revision is recorded, the action stays done");
  assert.equal(state().decisionHistory.length, 1);
  assert.equal(state().informational, false);
  db.prepare(
    "UPDATE approvals SET status = 'approved', decision_note = 'notification', decided_at = created_at WHERE id = ?",
  ).run(id);
  assert.equal(state().informational, true);
});

test("PATCH /api/approvals/[id] accepts revise on an approved item and refuses the rest", async () => {
  const { config, db } = fresh();
  const saved = { home: process.env.MYHQ_HOME, bin: process.env.HQ_CLAUDE_BIN };
  process.env.MYHQ_HOME = config.home;
  // The revision wakes the agent: a binary that does not exist, so that no real run starts.
  process.env.HQ_CLAUDE_BIN = "claude-binary-not-installed-in-tests";
  try {
    const patch = (id: number, body: unknown) =>
      PATCH(
        new Request(`http://127.0.0.1/api/approvals/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id: String(id) }) } as never,
      );
    const id = addApproval(db);
    assert.equal((await patch(id, { decision: "approved" })).status, 200);
    assert.equal((await patch(id, { decision: "approved" })).status, 409);
    assert.equal((await patch(id, { decision: "revise" })).status, 400, "nothing to revise with");
    const ok = await patch(id, { decision: "revise", note: "Shorter.", annotations: ANNOTATIONS });
    assert.equal(ok.status, 200);
    const { approval } = (await ok.json()) as {
      approval: { status: string; decisionHistory: { decision: string }[]; annotations: unknown[] };
    };
    assert.equal(approval.status, "revise");
    assert.deepEqual(
      approval.decisionHistory.map((d) => d.decision),
      ["approved"],
    );
    assert.deepEqual(approval.annotations, ANNOTATIONS);
    const same = await patch(id, { decision: "revise", note: "Shorter.", annotations: ANNOTATIONS });
    assert.equal(same.status, 409);
  } finally {
    for (const [key, value] of [
      ["MYHQ_HOME", saved.home],
      ["HQ_CLAUDE_BIN", saved.bin],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
