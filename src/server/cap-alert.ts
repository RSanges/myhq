import fs from "node:fs";
import path from "node:path";
import { strings } from "../ui/strings";
import { recordBotMessage } from "./chat-history";
import { liveConfig, type Env, type HqConfig } from "./config";
import type { Db } from "./db";
import { sendAlert, type Send } from "./notify";
import { settingsLinkLine, withLine } from "./public-url";
import { dayKey } from "./time";

/** Folder of `<dataDir>` that holds one empty marker file per day the cap alert was sent. */
const MARKER_DIR = "cap-alerts";

/** Tasks waiting for an agent to take them (any source). */
export function pendingTaskCount(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'pending'").get() as { n: number }).n;
}

/**
 * Claims the cap alert of a day: true for the first caller of the day, false
 * after. The marker is a file created exclusively, so that two processes of
 * the same home never both claim it; the markers of earlier days are removed.
 */
function claimDay(dir: string, day: string): boolean {
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(path.join(dir, day), "", { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  for (const name of fs.readdirSync(dir)) if (name !== day) fs.rmSync(path.join(dir, name), { force: true });
  return true;
}

/**
 * Tells the owner, once per day, that the daily cap of runs is reached: how
 * many tasks wait for it, and where to raise it (the settings page, when
 * HQ_PUBLIC_URL is set). Called when a start is refused for the cap. When
 * nothing could be sent (no Telegram configured, Telegram down), the day is
 * not marked, so that a later refusal tries again. Never throws; resolves to
 * whether the alert was sent.
 */
export async function alertCapReached(params: {
  config: HqConfig;
  db: Db;
  send?: Send;
  env?: Env;
  at?: Date;
}): Promise<boolean> {
  const { config, db } = params;
  const send = params.send ?? sendAlert;
  let day: string | null = null;
  const dir = path.join(config.dataDir, MARKER_DIR);
  try {
    const live = liveConfig(config);
    day = dayKey(params.at ?? new Date(), live.timeZone);
    if (!claimDay(dir, day)) return false;
    const text = withLine(
      strings.notify.capReached({ cap: live.maxRunsPerDay, waiting: pendingTaskCount(db) }),
      settingsLinkLine(params.env),
    );
    if (await send(text)) {
      recordBotMessage(db, text, "alert");
      return true;
    }
    fs.rmSync(path.join(dir, day), { force: true });
    return false;
  } catch (error) {
    console.error(`[cap-alert] not sent: ${error instanceof Error ? error.message : String(error)}`);
    if (day) fs.rmSync(path.join(dir, day), { force: true });
    return false;
  }
}
