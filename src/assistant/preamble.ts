import fs from "node:fs";
import type { Env, HqConfig } from "../server/config";
import type { Db } from "../server/db";
import { runsToday } from "../server/runner";
import { strings } from "../ui/strings";
import { runShell, type ShellResult } from "./shell";

/** Facts of the core the preamble can give. */
export const PREAMBLE_FIELDS = ["datetime", "lastExchange", "pending", "runs"] as const;
export type PreambleField = (typeof PREAMBLE_FIELDS)[number];

export type PreambleConfig = {
  fields: PreambleField[];
  /** Shell command of the home whose stdout ends the preamble, or null. */
  command: string | null;
  /** Absolute path of a text file of the home whose content ends the preamble, or null. */
  file: string | null;
  maxChars: number;
  timeoutMs: number;
};

/** The home's part is computed at most once a minute. */
export const PREAMBLE_CACHE_MS = 60_000;
/** Pending items listed by name; the others are counted. */
export const PREAMBLE_PENDING_ITEMS = 5;
const TITLE_LIMIT = 50;

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

/** The parts of a date in a time zone (hour on 24 hours). */
function zonedParts(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

/**
 * How long ago the user last wrote to the chat, worded for the preamble: so
 * that the chat knows whether to greet. Only messages to the chat count (not
 * the tasks given to an agent), and the message of the turn in progress is
 * not recorded yet.
 */
export function lastExchangeText(db: Db, timeZone: string, at: Date): string {
  const t = strings.assistant.preamble;
  const row = db
    .prepare("SELECT created_at FROM chat_messages WHERE role = 'user' AND target IS NULL ORDER BY id DESC LIMIT 1")
    .get() as { created_at: string } | undefined;
  const last = row ? new Date(row.created_at) : null;
  if (!last || Number.isNaN(last.getTime()) || last.getTime() > at.getTime()) return t.lastExchange(t.lastExchangeFirst);
  const from = zonedParts(last, timeZone);
  const to = zonedParts(at, timeZone);
  const days = Math.round(
    (Date.UTC(to.year, to.month - 1, to.day) - Date.UTC(from.year, from.month - 1, from.day)) / 86_400_000,
  );
  const clock = `${from.hour} h ${String(from.minute).padStart(2, "0")}`;
  if (days === 0) {
    const minutes = Math.floor((at.getTime() - last.getTime()) / 60_000);
    if (minutes < 1) return t.lastExchange(t.lastExchangeNow);
    if (minutes < 60) return t.lastExchange(t.lastExchangeMinutes(minutes));
    return t.lastExchange(t.lastExchangeHours(Math.floor(minutes / 60), minutes % 60));
  }
  if (days === 1) return t.lastExchange(t.lastExchangeYesterday(clock));
  const day = new Intl.DateTimeFormat(strings.locale, { timeZone, weekday: "long", day: "numeric", month: "long" }).format(last);
  return t.lastExchange(t.lastExchangeEarlier(day, clock));
}

/** The lines of the core's own facts, in the order of `fields`. */
export function corePreamble(
  db: Db,
  config: Pick<HqConfig, "timeZone" | "maxRunsPerDay">,
  fields: PreambleField[],
  at: Date,
): string[] {
  const t = strings.assistant.preamble;
  const lines: string[] = [];
  for (const field of fields) {
    if (field === "datetime") {
      const text = new Intl.DateTimeFormat(strings.locale, {
        timeZone: config.timeZone,
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(at);
      lines.push(t.datetime(text, config.timeZone));
    } else if (field === "lastExchange") {
      lines.push(lastExchangeText(db, config.timeZone, at));
    } else if (field === "pending") {
      const rows = db
        .prepare(
          `SELECT a.id, a.type, a.title, COALESCE(g.name, a.agent_id) AS agent
           FROM approvals a LEFT JOIN agents g ON g.room = a.room AND g.id = a.agent_id
           WHERE a.status = 'pending' ORDER BY a.id`,
        )
        .all() as { id: number; type: string; title: string; agent: string }[];
      if (rows.length === 0) {
        lines.push(t.pendingNone);
        continue;
      }
      lines.push(t.pendingTitle(rows.length));
      for (const row of rows.slice(0, PREAMBLE_PENDING_ITEMS)) {
        lines.push(t.pendingItem({ ...row, title: cut(row.title.replace(/\s+/g, " ").trim(), TITLE_LIMIT) }));
      }
      if (rows.length > PREAMBLE_PENDING_ITEMS) lines.push(t.pendingMore(rows.length - PREAMBLE_PENDING_ITEMS));
    } else {
      lines.push(t.runs(runsToday(db), config.maxRunsPerDay));
    }
  }
  return lines;
}

/**
 * The delimited block: the core's lines, then the home's text, within
 * `maxChars` characters marks included. The home's text is cut first; the
 * core's lines are cut only when they alone do not fit.
 */
export function fitPreamble(core: string[], home: string | null, maxChars: number): string {
  const t = strings.assistant.preamble;
  const frame = t.head.length + t.end.length + 2;
  let body = cut(core.join("\n"), Math.max(0, maxChars - frame));
  const extra = home?.trim();
  if (extra) {
    const room = maxChars - frame - body.length - (body ? 1 : 0);
    if (room >= 20) body = body ? `${body}\n${cut(extra, room)}` : cut(extra, room);
  }
  return [t.head, ...(body ? [body] : []), t.end].join("\n");
}

/**
 * Builds the preamble of each chat turn. The home's command (or file) is
 * read at most once a minute; a command that fails or runs past its timeout
 * leaves the core's facts alone, and the chat never waits longer.
 */
export class Preamble {
  private cache: { key: string; at: number; text: string | null } | null = null;

  constructor(
    private readonly deps: { db: Db; config: HqConfig; env: Env; log: (message: string) => void },
    private readonly cacheMs = PREAMBLE_CACHE_MS,
  ) {}

  async build(preamble: PreambleConfig, at = new Date()): Promise<string> {
    let core: string[] = [];
    try {
      core = corePreamble(this.deps.db, this.deps.config, preamble.fields, at);
    } catch (error) {
      this.deps.log(`preamble: core facts not read: ${error instanceof Error ? error.message : String(error)}`);
    }
    return fitPreamble(core, await this.homeText(preamble, at.getTime()), preamble.maxChars);
  }

  private async homeText(preamble: PreambleConfig, now: number): Promise<string | null> {
    const key = preamble.command ? `command:${preamble.command}` : preamble.file ? `file:${preamble.file}` : null;
    if (!key) return null;
    if (this.cache && this.cache.key === key && now - this.cache.at < this.cacheMs) return this.cache.text;
    let text: string | null = null;
    if (preamble.command) {
      // The shell is killed at the timeout, but a program it started may keep
      // the output open (Windows): the chat does not wait for it.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<ShellResult>((resolve) => {
        timer = setTimeout(() => resolve({ code: null, stdout: "", stderr: "", timedOut: true }), preamble.timeoutMs + 100);
      });
      const result = await Promise.race([
        runShell(preamble.command, { cwd: this.deps.config.home, env: this.deps.env, timeoutMs: preamble.timeoutMs }),
        late,
      ]);
      clearTimeout(timer);
      if (result.timedOut || result.code !== 0) {
        const why = result.timedOut ? "timed out" : `exited with ${result.code}`;
        this.deps.log(`preamble command ${why}: ${result.stderr.trim().slice(0, 300)}`);
      } else {
        text = result.stdout.trim() || null;
      }
    } else if (preamble.file) {
      try {
        text = fs.readFileSync(preamble.file, "utf8").trim() || null;
      } catch (error) {
        this.deps.log(`preamble file not read: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.cache = { key, at: now, text };
    return text;
  }
}
