import { approvalKeyboard } from "../assistant/approval-buttons";
import { DEFAULT_TELEGRAM_API_BASE, pollingEnabled } from "../assistant/settings";
import { splitMessage } from "../assistant/text";
import { strings } from "../ui/strings";
import type { Env } from "./config";
import type { Db } from "./db";

type Fetch = typeof fetch;

export type SendOptions = {
  /** The alert is about this pending approval: it gets the decision buttons. */
  approvalId?: number;
};

/** Sends an alert. Resolves to false when nothing was sent; never throws. */
export type Send = (text: string, options?: SendOptions) => Promise<boolean>;

/**
 * Sends a plain text Telegram message through the Bot API. A pending-approval
 * alert carries Approve, Reject and Revise buttons, but only when MyHQ reads
 * the bot's updates (HQ_TELEGRAM_POLLING=true): otherwise nobody would receive
 * the button presses. Does nothing when HQ_TELEGRAM_BOT_TOKEN or
 * HQ_TELEGRAM_CHAT_ID is missing, and never throws. The token is never logged.
 */
export async function notify(
  text: string,
  env: Env = process.env,
  fetchImpl: Fetch = fetch,
  options: SendOptions = {},
): Promise<boolean> {
  const token = env.HQ_TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.HQ_TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return false;
  const apiBase = (env.HQ_TELEGRAM_API_BASE?.trim() || DEFAULT_TELEGRAM_API_BASE).replace(/\/+$/, "");
  const buttons = options.approvalId !== undefined && pollingEnabled(env);
  try {
    const response = await fetchImpl(`${apiBase}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 4000),
        disable_web_page_preview: true,
        ...(buttons ? { reply_markup: approvalKeyboard(options.approvalId!) } : {}),
      }),
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

/** The app's alert sender, reading the Telegram variables of the process. */
export const sendAlert: Send = (text, options) => notify(text, process.env, fetch, options);

/**
 * Notifies every pending approval not notified yet. Approvals are created by
 * the HQ MCP server, which runs without the Telegram variables, so the app
 * process sweeps them (during and after each run). An item whose type is in
 * `notifyTypes` (myhq.json) is sent in full: the alert, then its body as is,
 * cut in messages of 4000 characters, the buttons under the last one.
 */
export async function notifyPendingApprovals(
  db: Db,
  send: Send = sendAlert,
  notifyTypes: readonly string[] = [],
): Promise<void> {
  const rows = db
    .prepare(
      `SELECT a.id, a.room, a.type, a.title, a.body, COALESCE(g.name, a.agent_id) AS agent
       FROM approvals a LEFT JOIN agents g ON g.room = a.room AND g.id = a.agent_id
       WHERE a.status = 'pending' AND a.notified_at IS NULL ORDER BY a.id`,
    )
    .all() as { id: number; room: string; type: string; title: string; body: string; agent: string }[];
  const mark = db.prepare("UPDATE approvals SET notified_at = ? WHERE id = ? AND notified_at IS NULL");
  for (const row of rows) {
    // Marked first so that two concurrent sweeps never send the same item twice.
    if (mark.run(new Date().toISOString(), row.id).changes === 0) continue;
    const alert = strings.notify.approvalPending(row);
    if (!notifyTypes.includes(row.type)) {
      await send(alert, { approvalId: row.id });
      continue;
    }
    const parts = splitMessage(`${alert}\n\n${row.body}`);
    for (const [index, part] of parts.entries()) {
      await send(part, index === parts.length - 1 ? { approvalId: row.id } : {});
    }
  }
}
