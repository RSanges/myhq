import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { getDbAt, type Db } from "../src/server/db";
import { HqError } from "../src/server/errors";
import { exportIfDue, exportOnDemand, readExportSettings, writeDailyExport, type DailyExport } from "../src/server/export";
import { makeHome } from "./helpers";

function seed(db: Db) {
  const run = (startedAt: string) =>
    Number(
      db
        .prepare("INSERT INTO runs (room, agent_id, engine, task, status, cost_usd, started_at) VALUES ('demo', 'scout', 'claude', 't', 'done', 0.1, ?)")
        .run(startedAt).lastInsertRowid,
    );
  // 2 November 2026 in Paris (CET, +1) runs from 2026-11-01T23:00Z to 2026-11-02T23:00Z.
  const before = run("2026-11-01T22:59:00.000Z");
  const inside = run("2026-11-01T23:30:00.000Z");
  const late = run("2026-11-02T22:59:59.000Z");
  run("2026-11-02T23:00:00.000Z");
  db.prepare("INSERT INTO messages (room, from_agent, to_agent, text, run_id, created_at) VALUES ('demo', 'scout', 'writer', 'hi', ?, '2026-11-02T08:00:00.000Z')").run(inside);
  const approval = (createdAt: string, decidedAt: string | null) =>
    db
      .prepare("INSERT INTO approvals (room, agent_id, type, title, body, status, decided_at, created_at) VALUES ('demo', 'scout', 'post', 't', 'b', ?, ?, ?)")
      .run(decidedAt ? "approved" : "pending", decidedAt, createdAt);
  approval("2026-11-02T09:00:00.000Z", null); // created that day
  approval("2026-10-30T09:00:00.000Z", "2026-11-02T10:00:00.000Z"); // decided that day
  approval("2026-10-30T09:00:00.000Z", "2026-10-31T10:00:00.000Z"); // neither
  return { before, inside, late };
}

test("the daily export holds the runs, messages and approvals of one local day", () => {
  const config = makeHome();
  const db = getDbAt(config.dbPath);
  const ids = seed(db);
  const dir = path.join(config.home, "export");
  const { file } = writeDailyExport(db, { dir, date: "2026-11-02", timeZone: "Europe/Paris" });
  assert.equal(file, path.join(dir, "2026-11-02.json"));
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as DailyExport;
  assert.equal(data.date, "2026-11-02");
  assert.equal(data.timeZone, "Europe/Paris");
  assert.deepEqual(data.runs.map((r) => r.id), [ids.inside, ids.late]);
  assert.equal(data.runs[0]!.costUsd, 0.1);
  assert.equal(data.messages.length, 1);
  assert.equal(data.approvals.length, 2);
  // Written again on demand, the file is replaced, never duplicated.
  writeDailyExport(db, { dir, date: "2026-11-02", timeZone: "Europe/Paris" });
  assert.deepEqual(fs.readdirSync(dir), ["2026-11-02.json"]);
});

test("myhq.json is optional; the export is due once the hour has passed, once per day", () => {
  const config = makeHome({ timeZone: "Europe/Paris" });
  const db = getDbAt(config.dbPath);
  seed(db);
  assert.equal(readExportSettings(config.home), null);
  assert.equal(exportIfDue(config, db, new Date("2026-11-03T12:00:00Z")), null);
  assert.throws(() => exportOnDemand(config, db), (e: unknown) => e instanceof HqError && e.code === "EXPORT_NOT_CONFIGURED");

  fs.writeFileSync(path.join(config.home, "myhq.json"), JSON.stringify({ export: { dir: "journal", hour: 6 } }));
  assert.deepEqual(readExportSettings(config.home), { dir: path.join(config.home, "journal"), hour: 6 });
  // 05:30 in Paris: not yet.
  assert.equal(exportIfDue(config, db, new Date("2026-11-03T04:30:00Z")), null);
  // 07:00 in Paris: yesterday is written, then not again.
  const file = exportIfDue(config, db, new Date("2026-11-03T06:00:00Z"));
  assert.equal(file, path.join(config.home, "journal", "2026-11-02.json"));
  assert.equal(exportIfDue(config, db, new Date("2026-11-03T08:00:00Z")), null);

  const onDemand = exportOnDemand(config, db, "2026-11-02");
  assert.deepEqual(
    { runs: onDemand.runs, messages: onDemand.messages, approvals: onDemand.approvals },
    { runs: 2, messages: 1, approvals: 2 },
  );

  fs.writeFileSync(path.join(config.home, "myhq.json"), JSON.stringify({ export: { dir: "" } }));
  assert.throws(() => readExportSettings(config.home), /export\.dir/);
  fs.writeFileSync(path.join(config.home, "myhq.json"), JSON.stringify({ somethingElse: true }));
  assert.equal(readExportSettings(config.home), null);
});
