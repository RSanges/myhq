import { strings } from "../ui/strings";
import type { Env } from "./config";
import type { Db } from "./db";

type Fetch = typeof fetch;

/**
 * Sends a plain text Telegram message through the Bot API. Send only: no
 * buttons and no reading of updates (another process is the bot's reader).
 * Does nothing when HQ_TELEGRAM_BOT_TOKEN or HQ_TELEGRAM_CHAT_ID is missing,
 * and never throws. The token is never logged.
 */
export async function notify(
  text: string,
  env: Env = process.env,
  fetchImpl: Fetch = fetch,
): Promise<boolean> {
  const token = env.HQ_TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.HQ_TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return false;
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.warn(`[notify] Telegram answered HTTP ${response.status}`);
      return false;
    }
    return true;
  } catch (error) {
    console.warn(`[notify] Telegram send failed (${error instanceof Error ? error.name : "unknown error"})`);
    return false;
  }
}

/**
 * Notifies every pending approval not notified yet. Approvals are created by
 * the HQ MCP server, which runs without the Telegram variables, so the app
 * process sweeps them (during and after each run).
 */
export async function notifyPendingApprovals(
  db: Db,
  send: (text: string) => Promise<boolean> = notify,
): Promise<void> {
  const rows = db
    .prepare(
      `SELECT a.id, a.room, a.type, a.title, COALESCE(g.name, a.agent_id) AS agent
       FROM approvals a LEFT JOIN agents g ON g.room = a.room AND g.id = a.agent_id
       WHERE a.status = 'pending' AND a.notified_at IS NULL ORDER BY a.id`,
    )
    .all() as { id: number; room: string; type: string; title: string; agent: string }[];
  const mark = db.prepare("UPDATE approvals SET notified_at = ? WHERE id = ? AND notified_at IS NULL");
  for (const row of rows) {
    // Marked first so that two concurrent sweeps never send the same item twice.
    if (mark.run(new Date().toISOString(), row.id).changes === 0) continue;
    await send(strings.notify.approvalPending(row));
  }
}
