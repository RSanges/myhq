import fs from "node:fs";
import path from "node:path";
import { getConfig, type HqConfig } from "./config";
import { getDbAt, type Db } from "./db";
import { acquireLock } from "./lock";
import { loadHome, syncHome, type Home } from "./rooms";
import { wakeOnboarding } from "./onboarding";
import { purgeLeftoverMcpConfigs } from "./claude-engine";
import { recoverInterruptedRuns } from "./runner";

const globalForApp = globalThis as unknown as {
  __myhqStarted?: Set<string>;
  /** Per database: whether this process owns the home (it holds `data/app.lock`). */
  __myhqOwner?: Map<string, boolean>;
};

/**
 * Whether another live MyHQ process owns the home of this database (it held
 * `data/app.lock` when this process started): this one then leaves its runs
 * alone and wakes nobody at startup. False when this process owns it, or never
 * tried (tests, scripts).
 */
export function homeOwnedElsewhere(dbPath: string): boolean {
  return globalForApp.__myhqOwner?.get(dbPath) === false;
}

/**
 * Takes the home for this process, once: a second app started on the same
 * home (pm2 starting an instance while an earlier one still holds the port)
 * must not close the runs of the first one as interrupted.
 */
function claimHome(config: HqConfig): boolean {
  globalForApp.__myhqOwner ??= new Map();
  const known = globalForApp.__myhqOwner.get(config.dbPath);
  if (known !== undefined) return known;
  const lockFile = path.join(config.dataDir, "app.lock");
  const owner = acquireLock(lockFile) !== null;
  globalForApp.__myhqOwner.set(config.dbPath, owner);
  if (!owner) {
    let pid = "?";
    try {
      pid = fs.readFileSync(lockFile, "utf8").trim();
    } catch {
      // Released in between: the warning stays useful.
    }
    console.error(
      `[myhq] another MyHQ process (pid ${pid}) runs this home: its runs in progress are left alone and nothing is woken at startup`,
    );
  }
  return owner;
}

/**
 * Configuration and database of the app process. The first call (from
 * instrumentation at server start) takes the home for this process
 * (`data/app.lock`), closes the runs a crash or a forced stop left `running`
 * and gives their tasks back (only when it owns the home), loads the home and
 * reports invalid rooms.
 */
export function app(): { config: HqConfig; db: Db } {
  const config = getConfig();
  const db = getDbAt(config.dbPath);
  globalForApp.__myhqStarted ??= new Set();
  if (!globalForApp.__myhqStarted.has(config.dbPath)) {
    globalForApp.__myhqStarted.add(config.dbPath);
    const owner = claimHome(config);
    if (owner) {
      const recovered = recoverInterruptedRuns(db);
      if (recovered.runs > 0) console.warn(`[myhq] ${recovered.runs} interrupted run(s) marked as cancelled`);
      if (recovered.requeued + recovered.blocked > 0) {
        console.warn(
          `[myhq] tasks of runs no longer in progress: ${recovered.requeued} back in the queue, ${recovered.blocked} run instruction(s) blocked`,
        );
      }
    }
    // Earlier versions kept each run's MCP config, with its expanded secrets, on disk.
    const purged = purgeLeftoverMcpConfigs(config.runsDir);
    if (purged > 0) console.warn(`[myhq] ${purged} leftover MCP config file(s) deleted from the runs directory`);
    const home = loadAndSyncHome(config, db);
    console.log(`[myhq] home ${config.home}: ${home.rooms.length} room(s)`);
    // Revisions of room proposals asked while the app was down (or busy) run now.
    try {
      const resumed = owner ? wakeOnboarding(config, db) : [];
      if (resumed.length > 0) console.log(`[myhq] ${resumed.length} onboarding revision run(s) started`);
    } catch (error) {
      console.error("[myhq] onboarding revisions could not be resumed", error);
    }
  }
  return { config, db };
}

export function loadAndSyncHome(config: HqConfig, db: Db): Home {
  const home = loadHome(config.home);
  syncHome(db, home);
  for (const invalid of home.invalid) console.error(`[myhq] invalid room: ${invalid.error}`);
  return home;
}
