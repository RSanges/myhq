import assert from "node:assert/strict";
import { test } from "node:test";
import { PATCH } from "../src/app/api/approvals/[id]/route";
import { hqReadDecisions, type HqContext } from "../src/mcp/tools";
import { cutQuote, decisionText, parseAnnotations, QUOTE_TEXT_MAX } from "../src/server/annotations";
import { decideApproval, decisionSchema } from "../src/server/approvals";
import { getDbAt, type ApprovalRow, type Db } from "../src/server/db";
import { getState } from "../src/server/feed";
import { loadHome } from "../src/server/rooms";
import { schedulerInfo } from "../src/server/routines";
import { makeHome } from "./helpers";

const ANNOTATIONS = [
  { quote: "the first passage", comment: "Too long.", position: 12 },
  { quote: "the second passage", comment: "Say it with numbers.", position: 480 },
];

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

test("annotations: revise may rest on them alone, reject keeps its reason, approve takes none", () => {
  const ok = (body: unknown) => decisionSchema.safeParse(body).success;
  assert.equal(ok({ decision: "revise", annotations: ANNOTATIONS }), true);
  assert.equal(ok({ decision: "revise", annotations: [] }), false);
  assert.equal(ok({ decision: "revise", note: "Shorter.", annotations: ANNOTATIONS }), true);
  assert.equal(ok({ decision: "rejected", annotations: ANNOTATIONS }), false);
  assert.equal(ok({ decision: "rejected", note: "No.", annotations: ANNOTATIONS }), true);
  assert.equal(ok({ decision: "approved", annotations: ANNOTATIONS }), false);
  assert.equal(ok({ decision: "approved", annotations: [] }), true);
});

test("annotations: quote and comment 1 to 2000 characters, at most 30, nothing else", () => {
  const ok = (annotations: unknown) => decisionSchema.safeParse({ decision: "revise", annotations }).success;
  const one = (over: object) => [{ quote: "q", comment: "c", ...over }];
  assert.equal(ok(one({})), true);
  assert.equal(ok(one({ quote: "" })), false);
  assert.equal(ok(one({ quote: "   " })), false);
  assert.equal(ok(one({ quote: "q".repeat(2000) })), true);
  assert.equal(ok(one({ quote: "q".repeat(2001) })), false);
  assert.equal(ok(one({ comment: "" })), false);
  assert.equal(ok(one({ comment: "c".repeat(2000) })), true);
  assert.equal(ok(one({ comment: "c".repeat(2001) })), false);
  assert.equal(ok(one({ position: -1 })), false);
  assert.equal(ok(one({ position: 1.5 })), false);
  assert.equal(ok(one({ extra: 1 })), false);
  assert.equal(ok(Array.from({ length: 30 }, () => one({})[0])), true);
  assert.equal(ok(Array.from({ length: 31 }, () => one({})[0])), false);
});

test("a revise decision stores its annotations with the note and exposes them", () => {
  const { config, db } = fresh();
  const id = addApproval(db);
  const approval = decideApproval(db, id, { decision: "revise", note: "Overall, shorter.", annotations: ANNOTATIONS });
  assert.deepEqual(approval.annotations, ANNOTATIONS);
  assert.equal(approval.decisionNote, "Overall, shorter.");
  assert.deepEqual(JSON.parse(row(db, id).annotations), ANNOTATIONS);
  const state = getState(db, loadHome(config.home), schedulerInfo(config));
  assert.deepEqual(state.approvals.history.find((a) => a.id === id)?.annotations, ANNOTATIONS);
});

test("without annotations nothing changes: no remarks, the single note, the usual task text", () => {
  const { db, ctx } = fresh();
  const id = addApproval(db);
  const approval = decideApproval(db, id, { decision: "revise", note: "Shorter please." });
  assert.deepEqual(approval.annotations, []);
  assert.equal(row(db, id).annotations, "[]");
  const task = db.prepare("SELECT text FROM tasks WHERE source = 'revise' AND ref_id = ?").get(id) as { text: string };
  assert.equal(task.text, `Revise your submission #${id} "Long piece" (article). User's note: Shorter please.`);
  assert.equal(hqReadDecisions(db, ctx).decisions[0]?.note, "Shorter please.");
});

test("the revision task and the decision the agent reads carry the numbered remarks, then the general note", () => {
  const { db, ctx } = fresh();
  const id = addApproval(db);
  decideApproval(db, id, { decision: "revise", note: "Overall, shorter.", annotations: ANNOTATIONS });
  const expected = [
    "1. À propos de « the first passage » : Too long.",
    "2. À propos de « the second passage » : Say it with numbers.",
    "",
    "Remarque générale : Overall, shorter.",
  ].join("\n");
  const task = db.prepare("SELECT text FROM tasks WHERE source = 'revise' AND ref_id = ?").get(id) as { text: string };
  assert.equal(task.text, `Revise your submission #${id} "Long piece" (article). User's remarks:\n${expected}`);
  const [decision] = hqReadDecisions(db, ctx).decisions;
  assert.equal(decision?.decision, "revise");
  assert.equal(decision?.note, expected);
  assert.equal(hqReadDecisions(db, ctx).decisions.length, 0, "read once");
});

test("remarks without a general note, and on a rejection", () => {
  const { db, ctx } = fresh();
  const revised = addApproval(db);
  decideApproval(db, revised, { decision: "revise", annotations: [ANNOTATIONS[0]!] });
  const rejected = addApproval(db);
  decideApproval(db, rejected, { decision: "rejected", note: "Off topic.", annotations: [ANNOTATIONS[1]!] });
  const decisions = hqReadDecisions(db, ctx).decisions;
  assert.equal(decisions[0]?.note, "1. À propos de « the first passage » : Too long.");
  assert.equal(
    decisions[1]?.note,
    "1. À propos de « the second passage » : Say it with numbers.\n\nRemarque générale : Off topic.",
  );
  assert.equal(row(db, revised).decision_note, null);
});

test("a long quote is cut at 200 characters and its blanks collapsed", () => {
  assert.equal(cutQuote("a".repeat(200)), "a".repeat(200));
  assert.equal(cutQuote("a".repeat(201)), `${"a".repeat(QUOTE_TEXT_MAX)}…`);
  assert.equal(cutQuote("  one\n\ntwo   three "), "one two three");
  const text = decisionText(null, [{ quote: "x".repeat(450), comment: "Cut." }]);
  assert.equal(text, `1. À propos de « ${"x".repeat(200)}… » : Cut.`);
  assert.equal(decisionText("note", []), "note");
  assert.equal(decisionText(null, []), null);
});

test("an unreadable annotations column counts as none", () => {
  assert.deepEqual(parseAnnotations("not json"), []);
  assert.deepEqual(parseAnnotations('[{"quote":""}]'), []);
  assert.deepEqual(parseAnnotations(null), []);
});

test("PATCH /api/approvals/[id] accepts annotations and refuses the invalid ones", async () => {
  const { config, db } = fresh();
  const saved = process.env.MYHQ_HOME;
  process.env.MYHQ_HOME = config.home;
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
    const bad = await patch(id, { decision: "revise", annotations: [{ quote: "", comment: "c" }] });
    assert.equal(bad.status, 400);
    const tooMany = await patch(id, {
      decision: "revise",
      annotations: Array.from({ length: 31 }, () => ({ quote: "q", comment: "c" })),
    });
    assert.equal(tooMany.status, 400);
    assert.equal(row(db, id).status, "pending");
    const good = await patch(id, { decision: "revise", annotations: ANNOTATIONS });
    assert.equal(good.status, 200);
    const { approval } = (await good.json()) as { approval: { status: string; annotations: unknown[]; decisionNote: null } };
    assert.equal(approval.status, "revise");
    assert.deepEqual(approval.annotations, ANNOTATIONS);
    assert.equal(approval.decisionNote, null);
  } finally {
    if (saved === undefined) delete process.env.MYHQ_HOME;
    else process.env.MYHQ_HOME = saved;
  }
});
