import fs from "node:fs";
import path from "node:path";
import { approvalKeyboard, seenKeyboard } from "../assistant/approval-buttons";
import { DEFAULT_TELEGRAM_API_BASE, pollingEnabled } from "../assistant/settings";
import { splitMessage } from "../assistant/text";
import { recordBotMessage } from "./chat-history";
import { NOTIFICATION_NOTE } from "./home-settings";
import { appendLine, approvalLinkLine, withLine } from "./public-url";
import { isQuiet, isUrgentPayload, lastQuietEnd, readQuietHours } from "./quiet-hours";
import { readRuntimeOverrides } from "./runtime-settings";
import { telegramMediaFor, type TelegramMedia } from "./telegram-media";
import { isValidTimeZone, systemTimeZone } from "./time";
import { strings } from "../ui/strings";
import type { Env, HqConfig } from "./config";
import { getDbAt, type Db } from "./db";

type Fetch = typeof fetch;

export type SendOptions = {
  /** The alert is about this pending approval: it gets the decision buttons. */
  approvalId?: number;
  /** The alert is about this informational item (« À regarder »): it gets the one « Vu » button. */
  seenId?: number;
  /** A file the alert carries (a video, a photo, a sound), the text becoming its caption. */
  media?: TelegramMedia;
};

/** Sends an alert. Resolves to false when nothing was sent; never throws. */
export type Send = (text: string, options?: SendOptions) => Promise<boolean>;

/** Longest caption of a photo, a video or a sound for the Bot API. */
const CAPTION_LIMIT = 1024;

/** The form field of each media method. */
const MEDIA_FIELD = { sendVideo: "video", sendPhoto: "photo", sendAudio: "audio" } as const;

/** Uploads a file with its caption and buttons (multipart). Resolves to whether Telegram took it. */
async function sendMedia(
  url: string,
  chatId: string,
  text: string,
  media: TelegramMedia,
  keyboard: unknown,
  fetchImpl: Fetch,
): Promise<boolean> {
  const form = new FormData();
  form.set("chat_id", chatId);
  form.set("caption", text.slice(0, CAPTION_LIMIT));
  if (keyboard) form.set("reply_markup", JSON.stringify(keyboard));
  if (media.method === "sendVideo") form.set("supports_streaming", "true");
  const bytes = fs.readFileSync(media.file);
  form.set(MEDIA_FIELD[media.method], new Blob([new Uint8Array(bytes)], { type: media.mime }), media.name);
  const response = await fetchImpl(`${url}/${media.method}`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) console.warn(`[notify] Telegram ${media.method} answered HTTP ${response.status}`);
  return response.ok;
}

/**
 * Sends a plain text Telegram message through the Bot API. A pending-approval
 * alert carries Approve, Reject and Revise buttons, an informational one a
 * single « Vu » button, but only when MyHQ reads the bot's updates
 * (HQ_TELEGRAM_POLLING=true): otherwise nobody would receive the button presses. Does nothing when HQ_TELEGRAM_BOT_TOKEN or
 * HQ_TELEGRAM_CHAT_ID is missing, and never throws. The token is never logged.
 * With `media`, the file goes with `sendVideo`, `sendPhoto` or `sendAudio`
 * and the text as its caption (cut at 1024 characters), buttons included; when
 * Telegram refuses the upload, the text is sent alone as usual.
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
  const keyboard = !pollingEnabled(env)
    ? null
    : options.approvalId !== undefined
      ? approvalKeyboard(options.approvalId)
      : options.seenId !== undefined
        ? seenKeyboard(options.seenId)
        : null;
  try {
    if (options.media) {
      try {
        if (await sendMedia(`${apiBase}/bot${token}`, chatId, text, options.media, keyboard, fetchImpl)) return true;
      } catch (error) {
        console.warn(`[notify] Telegram upload failed (${error instanceof Error ? error.name : "unknown error"})`);
      }
    }
    const response = await fetchImpl(`${apiBase}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 4000),
        disable_web_page_preview: true,
        ...(keyboard ? { reply_markup: keyboard } : {}),
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

/** An item the sweep may send: a pending approval or an informational item. */
type SweptRow = {
  id: number;
  room: string;
  for_room: string | null;
  type: string;
  title: string;
  body: string;
  payload: string;
  status: string;
  created_at: string;
  agent: string;
};

/**
 * The quiet hours in force for the home of `db` at `at`: null without
 * `quietHours` in myhq.json. The database lives in `<home>/data/hq.db`, and
 * the time zone is the home's (`timeZone` of myhq.json, then HQ_TIMEZONE, then
 * the machine's).
 */
function quietHoursAt(db: Db, env: Env, at: Date): { quiet: boolean; lastEnd: Date; range: { start: string; end: string } } | null {
  const home = path.dirname(path.dirname(db.name));
  const { quietHours, error } = readQuietHours(home);
  if (error) console.error(`[notify] ${error}: alerts are not held`);
  if (!quietHours) return null;
  const fromEnv = env.HQ_TIMEZONE?.trim();
  const timeZone =
    readRuntimeOverrides(home).overrides.timeZone ?? (fromEnv && isValidTimeZone(fromEnv) ? fromEnv : systemTimeZone());
  return { quiet: isQuiet(at, quietHours, timeZone), lastEnd: lastQuietEnd(at, quietHours, timeZone), range: quietHours };
}

/**
 * Notifies every pending approval not notified yet, and every informational
 * item (a type of `notifyTypes`, born `unseen` by hq_submit; the ones stored
 * as approved before that status existed are swept the same way). Approvals are
 * created by the HQ MCP server, which runs without the Telegram variables, so
 * the app process sweeps them (during and after each run). A pending item gets
 * the short alert with the buttons; an informational one is sent in full, its
 * alert line then its body as is, cut in messages of 4000 characters, with a
 * single « Vu » button on the last one when it is still unseen. When
 * HQ_PUBLIC_URL is set (read from `env`), each one ends with the line
 * « Ouvrir : <url>/bureau#approval-<id> ». A pending item with files lists them, and
 * its alert carries the first video, image or sound Telegram takes (see
 * telegram-media.ts); otherwise it stays text, with its link.
 *
 * With `quietHours` in myhq.json, an informational item that is not marked
 * urgent (`"urgent": true` in its payload) is left unsent while the range
 * lasts; the first sweep after its end sends the items held together as one
 * text (several messages only past 4000 characters, without « Vu » buttons:
 * they stay under « À regarder »), or a single item the usual way. Pending
 * approvals are never held. The app process also sweeps every minute while
 * quiet hours are set (see `startQuietHours`), so that the held items leave
 * at the end of the range without waiting for a run.
 */
export async function notifyPendingApprovals(
  db: Db,
  send: Send = sendAlert,
  env: Env = process.env,
  at: Date = new Date(),
): Promise<void> {
  const rows = db
    .prepare(
      `SELECT a.id, a.room, a.for_room, a.type, a.title, a.body, a.payload, a.status, a.created_at,
         COALESCE(g.name, a.agent_id) AS agent
       FROM approvals a LEFT JOIN agents g ON g.room = a.room AND g.id = a.agent_id
       WHERE a.notified_at IS NULL AND (a.status IN ('pending', 'unseen')
         OR (a.status = 'approved' AND a.decision_note = ? AND a.decided_at = a.created_at))
       ORDER BY a.id`,
    )
    .all(NOTIFICATION_NOTE) as SweptRow[];
  const quiet = quietHoursAt(db, env, at);
  const due: SweptRow[] = [];
  const held: SweptRow[] = [];
  for (const row of rows) {
    if (quiet && row.status !== "pending" && !isUrgentPayload(row.payload)) {
      // Left unmarked during the range: a later sweep sends it.
      if (quiet.quiet) continue;
      if (Date.parse(row.created_at) < quiet.lastEnd.getTime()) {
        held.push(row);
        continue;
      }
    }
    due.push(row);
  }
  // A single item held is sent the usual way, with its « Vu » button.
  if (held.length === 1) due.push(...held.splice(0));
  due.sort((a, b) => a.id - b.id);
  const mark = db.prepare("UPDATE approvals SET notified_at = ? WHERE id = ? AND notified_at IS NULL");
  const filesOf = db.prepare("SELECT id, name, mime, size FROM approval_files WHERE approval_id = ? ORDER BY id");
  // MyHQ keeps the copies of the files in the data directory, next to the database.
  const dataDir = path.dirname(db.name);
  for (const found of due) {
    // Marked first so that two concurrent sweeps never send the same item twice.
    if (mark.run(new Date().toISOString(), found.id).changes === 0) continue;
    // A delivery of a shared room says where it goes: « creation pour planygo ».
    const row = { ...found, room: found.for_room ? strings.studio.forRoom(found.room, found.for_room) : found.room };
    if (row.status === "pending") {
      const files = filesOf.all(row.id) as { id: number; name: string; mime: string; size: number }[];
      const head = strings.notify.approvalPending(row);
      const listed = files.length > 0 ? `${head}
${strings.attachments.telegramLine(files.map((file) => file.name))}` : head;
      const text = withLine(listed, approvalLinkLine(row.id, env));
      const media = files.length > 0 ? await telegramMediaFor(dataDir, row.id, files, env) : null;
      if (await send(text, { approvalId: row.id, ...(media ? { media } : {}) })) recordBotMessage(db, text, "alert");
      continue;
    }
    const link = approvalLinkLine(row.id, env);
    const full = `${strings.notify.notification(row)}\n\n${row.body}`;
    let sent = false;
    const parts = appendLine(splitMessage(full), link);
    for (const [index, part] of parts.entries()) {
      const last = index === parts.length - 1;
      sent = (await send(part, row.status === "unseen" && last ? { seenId: row.id } : undefined)) || sent;
    }
    if (sent) recordBotMessage(db, withLine(full, link), "notification");
  }
  if (held.length > 0 && quiet) await sendHeld(db, held, quiet.range, send, env);
}

/** The informational items held during the quiet hours, as one text: a heading, then each item in full with its link. */
async function sendHeld(db: Db, rows: SweptRow[], range: { start: string; end: string }, send: Send, env: Env): Promise<void> {
  const mark = db.prepare("UPDATE approvals SET notified_at = ? WHERE id = ? AND notified_at IS NULL");
  const at = new Date().toISOString();
  const mine = rows.filter((row) => mark.run(at, row.id).changes > 0);
  if (mine.length === 0) return;
  const sections = mine.map((found) => {
    const row = { ...found, room: found.for_room ? strings.studio.forRoom(found.room, found.for_room) : found.room };
    return withLine(`${strings.notify.notification(row)}\n\n${row.body}`, approvalLinkLine(row.id, env));
  });
  const full = [strings.notify.quietDigest({ count: mine.length, ...range }), ...sections].join("\n\n");
  let sent = false;
  for (const part of splitMessage(full)) sent = (await send(part)) || sent;
  if (sent) recordBotMessage(db, full, "notification");
}

/** How often the app sweeps while `quietHours` is set, so that the items held leave at the end of the range. */
export const QUIET_SWEEP_MS = 60_000;

const globalForQuiet = globalThis as unknown as { __myhqQuietHours?: ReturnType<typeof setInterval> };

/**
 * Starts the quiet-hours sweep once per process: every minute, when myhq.json
 * sets `quietHours` (read again each time, so no restart is needed), the
 * notification sweep runs, which sends the items held once the range is over.
 * Without the key it does nothing.
 */
export function startQuietHours(config: HqConfig): void {
  if (globalForQuiet.__myhqQuietHours) return;
  const check = () => {
    try {
      if (!readQuietHours(config.home).quietHours) return;
      notifyPendingApprovals(getDbAt(config.dbPath)).catch((error: unknown) => console.error("[notify] quiet-hours sweep failed", error));
    } catch (error) {
      console.error("[notify] quiet-hours sweep failed", error);
    }
  };
  globalForQuiet.__myhqQuietHours = setInterval(check, QUIET_SWEEP_MS);
  globalForQuiet.__myhqQuietHours.unref();
}
