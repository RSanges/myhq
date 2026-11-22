import assert from "node:assert/strict";
import { test } from "node:test";
import { GET as approvalRoute } from "../src/app/api/approvals/[id]/route";
import { getDbAt, type Db } from "../src/server/db";
import { getState, lightState } from "../src/server/feed";
import { loadHome } from "../src/server/rooms";
import { schedulerInfo } from "../src/server/routines";
import { makeHome } from "./helpers";

const BIG = "x".repeat(50_000);

function add(db: Db, status: string, type: string, payload: object, body = `# Title\n\n${BIG}`): number {
  return Number(
    db
      .prepare(
        "INSERT INTO approvals (room, agent_id, type, title, body, payload, status, decision_note, created_at, decided_at) VALUES ('demo', 'scout', ?, 'T', ?, ?, ?, 'ok', ?, ?)",
      )
      .run(type, body, JSON.stringify(payload), status, new Date().toISOString(), status === "pending" ? null : new Date().toISOString())
      .lastInsertRowid,
  );
}

async function withHome<T>(run: (db: Db, config: ReturnType<typeof makeHome>) => Promise<T>): Promise<T> {
  const config = makeHome();
  const saved = process.env.MYHQ_HOME;
  process.env.MYHQ_HOME = config.home;
  try {
    return await run(getDbAt(config.dbPath), config);
  } finally {
    if (saved === undefined) delete process.env.MYHQ_HOME;
    else process.env.MYHQ_HOME = saved;
  }
}

type Item = { id: number; body: string; payload: Record<string, unknown>; light?: boolean; title: string; status: string };

test("the state of the API sends the history summarised and the pending items whole", async () => {
  await withHome(async (db, config) => {
    const done = add(db, "approved", "article", { url: "https://example.com", big: BIG });
    const proposal = add(db, "approved", "room_proposal", { room: { name: "demo", targetRepo: BIG }, claudeMd: BIG });
    const pending = add(db, "pending", "article", { url: "https://example.com" });
    const state = JSON.parse(JSON.stringify(lightState(getState(db, loadHome(config.home), schedulerInfo(config))))) as { approvals: { pending: Item[]; history: Item[] } };

    const light = state.approvals.history.find((a) => a.id === done)!;
    assert.equal(light.light, true);
    assert.ok(light.body.length <= 400, "the body is cut to what the folded line reads");
    assert.deepEqual(light.payload, {});
    assert.equal(light.title, "T");
    assert.equal(light.status, "approved");
    // The folded line of a room proposal shows the room's name, which the payload carries.
    assert.deepEqual(state.approvals.history.find((a) => a.id === proposal)!.payload, { room: { name: "demo" } });

    const whole = state.approvals.pending.find((a) => a.id === pending)!;
    assert.equal(whole.light, undefined);
    assert.equal(whole.body.length, BIG.length + 9);
    assert.deepEqual(whole.payload, { url: "https://example.com" });
    assert.ok(JSON.stringify(state.approvals.history).length < 5_000, "no full body of the history in the state");
    // The server-side snapshot itself stays whole for its other callers.
    assert.equal(getState(db, loadHome(config.home), schedulerInfo(config)).approvals.history.find((a) => a.id === done)!.body.length, BIG.length + 9);
  });
});

test("GET /api/approvals/[id] gives the whole item, or 404 / 400", async () => {
  await withHome(async (db) => {
    const id = add(db, "approved", "article", { url: "https://example.com" });
    const get = (raw: string) => approvalRoute(new Request(`http://127.0.0.1/api/approvals/${raw}`), { params: Promise.resolve({ id: raw }) } as never);
    const res = await get(String(id));
    assert.equal(res.status, 200);
    const { approval } = (await res.json()) as { approval: Item };
    assert.equal(approval.body.length, BIG.length + 9);
    assert.deepEqual(approval.payload, { url: "https://example.com" });
    assert.equal(approval.light, undefined);
    assert.equal((await get("999")).status, 404);
    assert.equal((await get("abc")).status, 400);
  });
});
