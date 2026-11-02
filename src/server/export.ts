import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { HqConfig } from "./config";
import { DEFAULT_LANGUAGE, readHomeSettings } from "./home-settings";
import { getDbAt, type ApprovalRow, type Db, type MessageRow, type RunRow } from "./db";
import { HqError } from "./errors";
import { toApproval, toMessage, toRun, type ApprovalDto, type MessageDto, type RunDto } from "./feed";
import { addDays, dayKey, dayRange, wallTime } from "./time";

export { DEFAULT_LANGUAGE, homeSettingsSchema } from "./home-settings";

export type ExportSettings = { dir: string; hour: number };

/** The export settings of the home, or null when myhq.json or its `export` is absent. Throws when invalid. */
export function readExportSettings(home: string): ExportSettings | null {
  const settings = readHomeSettings(home)?.export;
  return settings ? { dir: path.resolve(home, settings.dir), hour: settings.hour } : null;
}

/** The language of the home (`language` in myhq.json), `en` when the file or the key is absent. Throws when invalid. */
export function readHomeLanguage(home: string): string {
  return readHomeSettings(home)?.language ?? DEFAULT_LANGUAGE;
}

export type DailyExport = {
  date: string;
  timeZone: string;
  generatedAt: string;
  runs: RunDto[];
  messages: MessageDto[];
  /** Approvals created or decided that day. */
  approvals: ApprovalDto[];
};

export const exportDateSchema = z.strictObject({
  date: z.iso.date().optional(),
});

/**
 * Writes `<dir>/<YYYY-MM-DD>.json`: the runs started, the messages sent and
 * the approvals created or decided during that calendar day of `timeZone`.
 * The file is replaced if it exists (written aside, then renamed).
 */
export function writeDailyExport(db: Db, p: { dir: string; date: string; timeZone: string }): { file: string; data: DailyExport } {
  const { start, end } = dayRange(p.date, p.timeZone);
  const from = start.toISOString();
  const to = end.toISOString();
  const runs = db
    .prepare("SELECT * FROM runs WHERE started_at >= ? AND started_at < ? ORDER BY id")
    .all(from, to) as RunRow[];
  const messages = db
    .prepare("SELECT * FROM messages WHERE created_at >= ? AND created_at < ? ORDER BY id")
    .all(from, to) as MessageRow[];
  const approvals = db
    .prepare(
      `SELECT * FROM approvals WHERE (created_at >= ? AND created_at < ?) OR (decided_at >= ? AND decided_at < ?)
       ORDER BY id`,
    )
    .all(from, to, from, to) as ApprovalRow[];
  const data: DailyExport = {
    date: p.date,
    timeZone: p.timeZone,
    generatedAt: new Date().toISOString(),
    runs: runs.map(toRun),
    messages: messages.map(toMessage),
    approvals: approvals.map(toApproval),
  };
  fs.mkdirSync(p.dir, { recursive: true });
  const file = path.join(p.dir, `${p.date}.json`);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(temp, file);
  return { file, data };
}

/** The day before `now` in the time zone. */
export const yesterday = (now: Date, timeZone: string): string => addDays(dayKey(now, timeZone), -1);

/** On demand (POST /api/export): one day, yesterday by default. Throws EXPORT_NOT_CONFIGURED. */
export function exportOnDemand(config: HqConfig, db: Db, date?: string) {
  const settings = readExportSettings(config.home);
  if (!settings) {
    throw new HqError("EXPORT_NOT_CONFIGURED", 404, `No "export.dir" in ${path.join(config.home, "myhq.json")}.`);
  }
  const day = date ?? yesterday(new Date(), config.timeZone);
  const { file, data } = writeDailyExport(db, { dir: settings.dir, date: day, timeZone: config.timeZone });
  return { date: day, file, runs: data.runs.length, messages: data.messages.length, approvals: data.approvals.length };
}

/**
 * The scheduled export: once the configured hour has passed, writes the
 * previous day if its file does not exist yet (so a day missed while the app
 * was stopped is written at the next start). Returns the file written, or null.
 */
export function exportIfDue(config: HqConfig, db: Db, now: Date = new Date()): string | null {
  const settings = readExportSettings(config.home);
  if (!settings) return null;
  if (wallTime(now, config.timeZone).hour < settings.hour) return null;
  const date = yesterday(now, config.timeZone);
  if (fs.existsSync(path.join(settings.dir, `${date}.json`))) return null;
  return writeDailyExport(db, { dir: settings.dir, date, timeZone: config.timeZone }).file;
}

const EXPORT_CHECK_MS = 10 * 60_000;
const globalForExport = globalThis as unknown as { __myhqExport?: ReturnType<typeof setInterval> };

/** Checks every ten minutes (and at start) whether the daily export is due. Does nothing without myhq.json. */
export function startDailyExport(config: HqConfig): void {
  if (globalForExport.__myhqExport) return;
  const check = () => {
    try {
      const file = exportIfDue(config, getDbAt(config.dbPath));
      if (file) console.log(`[export] ${file}`);
    } catch (error) {
      console.error(`[export] ${(error as Error).message}`);
    }
  };
  check();
  globalForExport.__myhqExport = setInterval(check, EXPORT_CHECK_MS);
  globalForExport.__myhqExport.unref();
}
