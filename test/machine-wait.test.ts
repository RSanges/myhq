import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { listBlocked } from "../src/server/blocked";
import type { HqConfig } from "../src/server/config";
import { getDbAt, type Db } from "../src/server/db";
import { vetoesIdle, type MachineReading } from "../src/server/machine";
import { listQueue } from "../src/server/queue";
import { loadHome, syncHome } from "../src/server/rooms";
import { wakeAgents } from "../src/server/runner";
import { strings } from "../src/ui/strings";
import { makeHome } from "./helpers";

// A task held back only by the machine's memory gate, or by the home's veto command saying to wait, resolves itself:
// it is a wait, shown in the queue, never a block of the Standard that the owner would close.

const r = strings.deskModules.standard.reasons;
const agent = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, role: "roles/scout.md", model: "haiku", allowedTools: ["mcp__hq__*"], ...extra });

function home(agents: Record<string, unknown>[], myhq?: unknown): { config: HqConfig; db: Db } {
  const config = makeHome({}, { name: "demo", targetRepo: "../demo", agents });
  if (myhq !== undefined) fs.writeFileSync(path.join(config.home, "myhq.json"), JSON.stringify(myhq));
  const db = getDbAt(config.dbPath);
  syncHome(db, loadHome(config.home));
  return { config, db };
}

const reading = (over: Partial<MachineReading> = {}): MachineReading => ({
  at: "2026-11-16T10:00:00.000Z",
  ramFreeGb: 10,
  ramTotalGb: 32,
  vramUsedGb: 2,
  vramTotalGb: 24,
  ...over,
});

/** A pending task of an agent, older than the 15 minutes after which the Standard lists what is stuck. */
function oldTask(db: Db, agentId: string): number {
  const at = new Date(Date.now() - 20 * 60_000).toISOString();
  return Number(
    db
      .prepare("INSERT INTO tasks (room, agent_id, source, text, status, created_at, updated_at) VALUES ('demo', ?, 'chat', 'work', 'pending', ?, ?)")
      .run(agentId, at, at).lastInsertRowid,
  );
}

test("a task that waits for free memory is in the queue with its reason, not on the Standard", () => {
  const { config, db } = home([agent("a", { needs: { ramGb: 6 } })]);
  const tight = () => reading({ ramFreeGb: 4 });
  oldTask(db, "a");
  const [entry] = listQueue(db, config, loadHome(config.home), tight);
  assert.equal(entry!.cause, "machine");
  assert.equal(entry!.reason, r.machine({ kind: "ram", needGb: 6, keepGb: 2, freeGb: 4, reservedGb: 0, leftGb: 4 }));
  assert.deepEqual(listBlocked(db, loadHome(config.home), config, new Date(), tight), []);
});

test("a GPU that cannot be read stays on the Standard: nothing says it will be read again", () => {
  const { config, db } = home([agent("g", { needs: { vramGb: 4 } })]);
  const unknown = () => reading({ vramUsedGb: null, vramTotalGb: null });
  oldTask(db, "g");
  const entries = listBlocked(db, loadHome(config.home), config, new Date(), unknown);
  assert.deepEqual(entries.map((entry) => [entry.cause, entry.reason]), [["machine", r.vramUnknown(4)]]);
});

test("a task the home's veto command says to wait for is in the queue, not on the Standard", async () => {
  const { config, db } = home([agent("painter", { needs: { ramGb: 1 } })], {
    machine: { veto: { command: [process.execPath, "veto.cjs"], timeoutSeconds: 2 } },
  });
  fs.writeFileSync(path.join(config.home, "veto.cjs"), `process.stdout.write(JSON.stringify({ wait: true, reason: "A game is running" }));`);
  oldTask(db, "painter");
  const deps = { config, engine: { name: "claude", async *run() {} } as never, send: async () => true, machine: () => reading() };
  assert.deepEqual(wakeAgents(config, db, deps), []);
  // While the command is asked, then once it said to wait: a wait both times.
  assert.deepEqual(listBlocked(db, loadHome(config.home), config, new Date(), () => reading()), []);
  await vetoesIdle();
  assert.equal(listQueue(db, config, loadHome(config.home), () => reading())[0]!.reason, r.veto("A game is running"));
  assert.deepEqual(listBlocked(db, loadHome(config.home), config, new Date(), () => reading()), []);
});
