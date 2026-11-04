import { getConfig, type HqConfig } from "./config";
import { getDbAt, type Db } from "./db";
import { loadHome, syncHome, type Home } from "./rooms";
import { wakeOnboarding } from "./onboarding";
import { recoverInterruptedRuns } from "./runner";

const globalForApp = globalThis as unknown as { __myhqStarted?: Set<string> };

/**
 * Configuration and database of the app process. The first call (from
 * instrumentation at server start) closes the runs a crash left `running`,
 * loads the home and reports invalid rooms.
 */
export function app(): { config: HqConfig; db: Db } {
  const config = getConfig();
  const db = getDbAt(config.dbPath);
  globalForApp.__myhqStarted ??= new Set();
  if (!globalForApp.__myhqStarted.has(config.dbPath)) {
    globalForApp.__myhqStarted.add(config.dbPath);
    const recovered = recoverInterruptedRuns(db);
    if (recovered > 0) console.warn(`[myhq] ${recovered} interrupted run(s) marked as failed`);
    const home = loadAndSyncHome(config, db);
    console.log(`[myhq] home ${config.home}: ${home.rooms.length} room(s)`);
    // Revisions of room proposals asked while the app was down (or busy) run now.
    try {
      const resumed = wakeOnboarding(config, db);
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
