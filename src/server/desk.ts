import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { strings } from "../ui/strings";
import { app } from "./app";
import { isInside, type Env, type HqConfig } from "./config";
import type { ApprovalRow, Db, RunRow } from "./db";
import {
  DeskCommands,
  type CommandResult,
  type CommandSpec,
  type DeskCommandErrorCode,
  type DeskTone,
} from "./desk-command";
import { errorResponse } from "./errors";
import { NOTIFICATION_NOTE } from "./home-settings";
import { loadHome, type Home } from "./rooms";
import { dayKey, dayRange } from "./time";

// The desk as a set of objects (myhq.json `desk`): each object of the scene
// (a pile, a tray, a newspaper...) is a module with a source of data, a count
// and items. GET /api/desk returns them, the `desk` event of GET /api/events
// says when a count changes. See docs/home-layout.md and docs/api.md.

/** The objects the scene of the desk can draw. */
export const DESK_OBJECTS = ["pile", "tray", "newspaper", "postits", "calendar", "phone"] as const;
export type DeskObjectKind = (typeof DESK_OBJECTS)[number];

const WATCH_SOURCE = /^watch:(\*|[a-z][a-z0-9_]{0,62})$/;

/** A source of the core: pending decisions, unseen items of a type, run summaries, the conversation. */
export const coreSourceSchema = z.union([
  z.literal("approvals"),
  z.literal("summaries"),
  z.literal("chat"),
  z.string().regex(WATCH_SOURCE, "watch:<type> (snake_case) or watch:*"),
]);
export type CoreSource = z.infer<typeof coreSourceSchema>;

/** A command of the home, whose stdout is the data of the object. */
export const commandSourceSchema = z.strictObject({
  command: z.string().trim().min(1).max(2000),
  /** Working directory, relative to the home (the home by default), never outside it. */
  cwd: z.string().trim().min(1).optional(),
  timeoutSeconds: z.number().int().min(1).max(60).default(10),
  cacheSeconds: z.number().int().min(0).max(3600).default(60),
});
export type CommandSource = z.infer<typeof commandSourceSchema>;

export const deskSourceSchema = z.union([
  coreSourceSchema,
  z.array(coreSourceSchema).min(1).max(6),
  commandSourceSchema,
]);
export type DeskSource = z.infer<typeof deskSourceSchema>;

export const deskObjectSchema = z.strictObject({
  /** The address of its page, `/bureau/<id>`. */
  id: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, "lowercase letters, digits and hyphens, starting with a letter"),
  object: z.enum(DESK_OBJECTS),
  label: z.string().trim().min(1).max(40),
  source: deskSourceSchema,
});
export type DeskObjectConfig = z.infer<typeof deskObjectSchema>;

export const deskConfigSchema = z
  .strictObject({ objects: z.array(deskObjectSchema).max(DESK_OBJECTS.length) })
  .superRefine((desk, ctx) => {
    const ids = new Set<string>();
    const kinds = new Set<string>();
    desk.objects.forEach((object, index) => {
      if (ids.has(object.id)) ctx.addIssue({ code: "custom", path: ["objects", index, "id"], message: `id "${object.id}" is used twice` });
      if (kinds.has(object.object)) {
        ctx.addIssue({ code: "custom", path: ["objects", index, "object"], message: `the scene has one ${object.object}` });
      }
      ids.add(object.id);
      kinds.add(object.object);
    });
  });
export type DeskConfig = z.infer<typeof deskConfigSchema>;

/** The desk of a home without a `desk` block: the pile, the tray, the newspaper and the phone. */
export function defaultDesk(): DeskConfig {
  const labels = strings.deskModules.defaults;
  return {
    objects: [
      { id: "signer", object: "pile", label: labels.pile, source: "approvals" },
      { id: "courrier", object: "tray", label: labels.tray, source: "watch:mail_alert" },
      { id: "journal", object: "newspaper", label: labels.newspaper, source: ["watch:brief", "summaries"] },
      { id: "telephone", object: "phone", label: labels.phone, source: "chat" },
    ],
  };
}

/**
 * The desk of the home: its `desk` block of myhq.json, or the default one
 * when the file or the block is absent. An invalid block falls back to the
 * default too, with the reason (the rest of myhq.json is not affected).
 */
export function readDeskConfig(home: string): { desk: DeskConfig; error: string | null } {
  const file = path.join(home, "myhq.json");
  let raw: unknown;
  try {
    if (!fs.existsSync(file)) return { desk: defaultDesk(), error: null };
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return { desk: defaultDesk(), error: `myhq.json is not valid JSON: ${(error as Error).message}` };
  }
  const block = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).desk : undefined;
  if (block === undefined) return { desk: defaultDesk(), error: null };
  const parsed = deskConfigSchema.safeParse(block);
  if (!parsed.success) {
    const details = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `desk.${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    return { desk: defaultDesk(), error: `myhq.json: ${details}` };
  }
  return { desk: parsed.data, error: null };
}

// --- Shapes of the API ---------------------------------------------------------------

/** What an item of the core is. */
export type DeskRef =
  | { kind: "approval"; id: number; room: string; agentId: string; type: string; status: string }
  | { kind: "run"; id: number; room: string; agentId: string }
  | { kind: "chat"; id: number; role: string };

export type DeskItemDto = {
  /** Unique in the object: `approval-12`, `run-30`, `chat-4`, or the command's own id. */
  id: string;
  title: string;
  /** Markdown, null when there is none. */
  body: string | null;
  at: string | null;
  end: string | null;
  allDay: boolean;
  href: string | null;
  tone: DeskTone | null;
  /** The room colour of an item of the core (room.json), null otherwise. */
  color: string | null;
  ref: DeskRef | null;
};

export type DeskObjectDto = {
  id: string;
  object: DeskObjectKind;
  label: string;
  /** `approvals`, `watch:mail_alert`, `watch:brief+summaries`, `chat` or `command`. */
  source: string;
  status: "ok" | "error";
  error: { code: DeskCommandErrorCode; message: string } | null;
  count: number;
  items: DeskItemDto[];
  /** Free stretches given by a command (a calendar), null otherwise. */
  slots: { start: string; end: string; label: string | null }[] | null;
  /** The command's own note about its data, null otherwise. */
  note: string | null;
  /** For a source with `approvals`: the room colour of each pending item, oldest first (the spines of the pile). */
  spines: { approvalId: number; room: string; color: string | null }[] | null;
  /** When the data was read (for a command, when it ran). */
  updatedAt: string;
};

export type DeskDto = {
  objects: DeskObjectDto[];
  /** Why the `desk` block of myhq.json was not used, null when it was (or is absent). */
  configError: string | null;
};

/** The count and the state of each object, as the `desk` event carries them. */
export type DeskCountsDto = { objects: { id: string; count: number; status: "ok" | "error" }[] };

// --- Reading the sources -------------------------------------------------------------

/** Seen informational items kept after the unseen ones (the history of a tray or a newspaper). */
export const WATCH_HISTORY = 20;
export const SUMMARY_ITEMS = 20;
export const CHAT_ITEMS = 10;

const sourceName = (source: DeskSource): string =>
  typeof source === "string" ? source : Array.isArray(source) ? source.join("+") : "command";

export const deskHref = (objectId: string, ref?: string): string => `/bureau/${objectId}${ref ? `#${ref}` : ""}`;

function roomColors(home: Home): Map<string, string | null> {
  return new Map(home.rooms.map((room) => [room.name, room.color]));
}

function approvalItem(row: ApprovalRow, objectId: string, colors: Map<string, string | null>, tone: DeskTone | null): DeskItemDto {
  return {
    id: `approval-${row.id}`,
    title: row.title,
    body: row.body,
    at: row.created_at,
    end: null,
    allDay: false,
    href: deskHref(objectId, `approval-${row.id}`),
    tone,
    color: colors.get(row.room) ?? null,
    ref: { kind: "approval", id: row.id, room: row.room, agentId: row.agent_id, type: row.type, status: row.status },
  };
}

/** The type filter of a watch source, null for `watch:*`. */
const watchType = (source: string): string | null => {
  const type = source.slice("watch:".length);
  return type === "*" ? null : type;
};

/** A seen informational item: `seen`, or one stored before that status existed (approved with the note). */
const SEEN_WHERE = `(status = 'seen' OR (status = 'approved' AND decision_note = '${NOTIFICATION_NOTE}'))`;

function notifyRunAgents(home: Home): { room: string; agent: string; name: string }[] {
  return home.rooms.flatMap((room) =>
    room.agents.filter((agent) => agent.notifyRuns === "summary").map((agent) => ({ room: room.name, agent: agent.id, name: agent.name })),
  );
}

function summaryWhere(agents: { room: string; agent: string }[]): { sql: string; params: string[] } | null {
  if (agents.length === 0) return null;
  return {
    sql: `status = 'done' AND summary IS NOT NULL AND trim(summary) <> '' AND (${agents.map(() => "(room = ? AND agent_id = ?)").join(" OR ")})`,
    params: agents.flatMap((each) => [each.room, each.agent]),
  };
}

type CoreRead = { count: number; items: DeskItemDto[] };

/** The count of a core source, without its items (the `desk` event). */
export function coreCount(db: Db, home: Home, source: CoreSource, config: Pick<HqConfig, "timeZone">, at: Date): number {
  if (source === "approvals") {
    return (db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'").get() as { n: number }).n;
  }
  if (source === "summaries") {
    const where = summaryWhere(notifyRunAgents(home));
    if (!where) return 0;
    const { start } = dayRange(dayKey(at, config.timeZone), config.timeZone);
    return (
      db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE ${where.sql} AND COALESCE(ended_at, started_at) >= ?`).get(...where.params, start.toISOString()) as {
        n: number;
      }
    ).n;
  }
  if (source === "chat") return chatCount(db);
  const type = watchType(source);
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM approvals WHERE status = 'unseen'${type ? " AND type = ?" : ""}`)
      .get(...(type ? [type] : [])) as { n: number }
  ).n;
}

/** Replies and messages of the bot since the user last wrote. */
function chatCount(db: Db): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM chat_messages WHERE role <> 'user' AND id > COALESCE((SELECT MAX(id) FROM chat_messages WHERE role = 'user'), 0)",
      )
      .get() as { n: number }
  ).n;
}

function readCore(db: Db, home: Home, source: CoreSource, objectId: string, config: Pick<HqConfig, "timeZone">, at: Date): CoreRead {
  const colors = roomColors(home);
  const count = coreCount(db, home, source, config, at);
  if (source === "approvals") {
    const rows = db.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at, id").all() as ApprovalRow[];
    return { count, items: rows.map((row) => approvalItem(row, objectId, colors, null)) };
  }
  if (source === "summaries") {
    const agents = notifyRunAgents(home);
    const where = summaryWhere(agents);
    if (!where) return { count, items: [] };
    const names = new Map(agents.map((each) => [`${each.room}/${each.agent}`, each.name]));
    const rows = db
      .prepare(`SELECT * FROM runs WHERE ${where.sql} ORDER BY COALESCE(ended_at, started_at) DESC, id DESC LIMIT ?`)
      .all(...where.params, SUMMARY_ITEMS) as RunRow[];
    return {
      count,
      items: rows.map((row) => ({
        id: `run-${row.id}`,
        title: names.get(`${row.room}/${row.agent_id}`) ?? row.agent_id,
        body: row.summary,
        at: row.ended_at ?? row.started_at,
        end: null,
        allDay: false,
        href: deskHref(objectId, `run-${row.id}`),
        tone: null,
        color: colors.get(row.room) ?? null,
        ref: { kind: "run", id: row.id, room: row.room, agentId: row.agent_id },
      })),
    };
  }
  if (source === "chat") {
    const rows = (
      db.prepare("SELECT id, role, kind, text, created_at FROM chat_messages ORDER BY id DESC LIMIT ?").all(CHAT_ITEMS) as {
        id: number;
        role: string;
        kind: string | null;
        text: string;
        created_at: string;
      }[]
    ).reverse();
    const who = strings.deskModules.chatWho;
    return {
      count,
      items: rows.map((row) => ({
        id: `chat-${row.id}`,
        title: row.role === "user" ? who.user : row.role === "assistant" ? who.assistant(strings.chat.assistantName) : who.bot,
        body: row.text,
        at: row.created_at,
        end: null,
        allDay: false,
        href: deskHref(objectId),
        tone: null,
        color: null,
        ref: { kind: "chat", id: row.id, role: row.role },
      })),
    };
  }
  const type = watchType(source);
  const filter = type ? " AND type = ?" : "";
  const params = type ? [type] : [];
  const unseen = db.prepare(`SELECT * FROM approvals WHERE status = 'unseen'${filter} ORDER BY created_at, id`).all(...params) as ApprovalRow[];
  const seen = db
    .prepare(`SELECT * FROM approvals WHERE ${SEEN_WHERE}${filter} ORDER BY COALESCE(decided_at, created_at) DESC, id DESC LIMIT ?`)
    .all(...params, WATCH_HISTORY) as ApprovalRow[];
  return {
    count,
    items: [
      ...unseen.map((row) => approvalItem(row, objectId, colors, null)),
      ...seen.map((row) => approvalItem(row, objectId, colors, "muted")),
    ],
  };
}

/** The spines of the pile: the room colour of each pending item, oldest first. */
function spines(db: Db, home: Home): DeskObjectDto["spines"] {
  const colors = roomColors(home);
  return (db.prepare("SELECT id, room FROM approvals WHERE status = 'pending' ORDER BY created_at, id").all() as { id: number; room: string }[]).map(
    (row) => ({ approvalId: row.id, room: row.room, color: colors.get(row.room) ?? null }),
  );
}

const itemTime = (item: DeskItemDto): number => (item.at ? Date.parse(item.at) : 0) || 0;

/** The command of an object, with its working directory resolved inside the home. */
export function commandSpec(home: string, source: CommandSource): CommandSpec | { error: string } {
  const cwd = path.resolve(home, source.cwd ?? ".");
  if (!isInside(home, cwd)) return { error: `cwd "${source.cwd}" is outside the home` };
  return { command: source.command, cwd, timeoutMs: source.timeoutSeconds * 1000, cacheMs: source.cacheSeconds * 1000 };
}

function fromCommand(result: CommandResult): Omit<DeskObjectDto, "id" | "object" | "label" | "source"> {
  const updatedAt = new Date(result.at).toISOString();
  if (!result.ok) {
    return { status: "error", error: { code: result.code, message: result.message }, count: 0, items: [], slots: null, note: null, spines: null, updatedAt };
  }
  const seen = new Set<string>();
  const items = result.output.items.map((item, index): DeskItemDto => {
    let id = item.id ?? `item-${index + 1}`;
    if (seen.has(id)) id = `${id}-${index + 1}`;
    seen.add(id);
    return {
      id,
      title: item.title,
      body: item.body ?? null,
      at: item.at ?? null,
      end: item.end ?? null,
      allDay: item.allDay ?? false,
      href: item.href ?? null,
      tone: item.tone ?? null,
      color: null,
      ref: null,
    };
  });
  return {
    status: "ok",
    error: null,
    count: result.output.count,
    items,
    slots: result.output.slots?.map((slot) => ({ start: slot.start, end: slot.end, label: slot.label ?? null })) ?? null,
    note: result.output.note ?? null,
    spines: null,
    updatedAt,
  };
}

export type DeskDeps = {
  config: Pick<HqConfig, "home" | "timeZone">;
  db: Db;
  commands: DeskCommands;
  /** The loaded home (rooms, colours, agents); read from the disk when absent. */
  home?: Home;
  at?: Date;
};

async function resolveObject(object: DeskObjectConfig, deps: DeskDeps & { home: Home; at: Date }): Promise<DeskObjectDto> {
  const head = { id: object.id, object: object.object, label: object.label, source: sourceName(object.source) };
  const { source } = object;
  if (typeof source === "object" && !Array.isArray(source)) {
    const spec = commandSpec(deps.config.home, source);
    if ("error" in spec) {
      const result: CommandResult = { ok: false, code: "COMMAND_FAILED", message: spec.error, at: deps.at.getTime() };
      return { ...head, ...fromCommand(result) };
    }
    return { ...head, ...fromCommand(await deps.commands.get(spec)) };
  }
  const list = Array.isArray(source) ? source : [source];
  const reads = list.map((each) => readCore(deps.db, deps.home, each, object.id, deps.config, deps.at));
  // A single source keeps its own order (the pile oldest first); several are merged, newest first.
  const items = reads.length === 1 ? reads[0]!.items : reads.flatMap((read) => read.items).sort((a, b) => itemTime(b) - itemTime(a));
  return {
    ...head,
    status: "ok",
    error: null,
    count: reads.reduce((sum, read) => sum + read.count, 0),
    items,
    slots: null,
    note: null,
    spines: list.includes("approvals") ? spines(deps.db, deps.home) : null,
    updatedAt: deps.at.toISOString(),
  };
}

/** Every object of the desk with its count and items (GET /api/desk). Never throws for a failing command. */
export async function resolveDesk(deps: DeskDeps): Promise<DeskDto> {
  const { desk, error } = readDeskConfig(deps.config.home);
  const home = deps.home ?? loadHome(deps.config.home);
  const at = deps.at ?? new Date();
  const objects = await Promise.all(desk.objects.map((object) => resolveObject(object, { ...deps, home, at })));
  return { objects, configError: error };
}

/**
 * The counts only (the `desk` event): the core's are read from the database,
 * a command's from its cache, run again only when the cache is stale.
 */
export async function deskCounts(deps: DeskDeps): Promise<DeskCountsDto> {
  const { desk } = readDeskConfig(deps.config.home);
  const at = deps.at ?? new Date();
  const needsHome = desk.objects.some((object) => object.source === "summaries" || (Array.isArray(object.source) && object.source.includes("summaries")));
  const home = deps.home ?? (needsHome ? loadHome(deps.config.home) : { root: deps.config.home, rooms: [], invalid: [] });
  const objects = await Promise.all(
    desk.objects.map(async (object) => {
      const { source } = object;
      if (typeof source === "object" && !Array.isArray(source)) {
        const spec = commandSpec(deps.config.home, source);
        if ("error" in spec) return { id: object.id, count: 0, status: "error" as const };
        const result = await deps.commands.get(spec);
        return { id: object.id, count: result.ok ? result.output.count : 0, status: result.ok ? ("ok" as const) : ("error" as const) };
      }
      const list = Array.isArray(source) ? source : [source];
      return {
        id: object.id,
        count: list.reduce((sum, each) => sum + coreCount(deps.db, home, each, deps.config, at), 0),
        status: "ok" as const,
      };
    }),
  );
  return { objects };
}

// --- The command runner and the live counts, one per home ------------------------------

const globalForDesk = globalThis as unknown as {
  __myhqDeskCommands?: Map<string, DeskCommands>;
  __myhqDeskHubs?: Map<string, DeskHub>;
};

/** The command runner of a home, shared by the routes and the stream (so that they share its cache). */
export function deskCommands(home: string, env: Env = process.env): DeskCommands {
  const all = (globalForDesk.__myhqDeskCommands ??= new Map());
  let commands = all.get(home);
  if (!commands) {
    commands = new DeskCommands({ env, log: (message) => console.warn(message) });
    all.set(home, commands);
  }
  return commands;
}

/** How often the counts are read while a stream is open. */
export const DESK_POLL_MS = 3_000;

type DeskListener = (counts: DeskCountsDto) => void;
type DeskHub = { listeners: Set<DeskListener>; stop: () => void };

const signature = (counts: DeskCountsDto): string => JSON.stringify(counts.objects);

/**
 * Calls `onChange` with the counts each time one of them (or the state of an
 * object) changes, read every `pollMs`. The first reading is the baseline and
 * is not announced. Returns the function that stops.
 */
export function watchDesk(read: () => Promise<DeskCountsDto>, onChange: DeskListener, pollMs = DESK_POLL_MS): () => void {
  let last: string | null = null;
  let stopped = false;
  let busy = false;
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const counts = await read();
      const next = signature(counts);
      if (last !== null && next !== last && !stopped) onChange(counts);
      last = next;
    } catch (error) {
      console.error(`[desk] counts not read: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      busy = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), pollMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * Subscribes to the count changes of a home's desk. One watcher per home is
 * shared by all subscribers; it starts with the first and stops with the last.
 */
export function subscribeDesk(deps: DeskDeps, listener: DeskListener, pollMs = DESK_POLL_MS): () => void {
  const hubs = (globalForDesk.__myhqDeskHubs ??= new Map());
  const key = deps.config.home;
  let hub = hubs.get(key);
  if (!hub) {
    const listeners = new Set<DeskListener>();
    hub = {
      listeners,
      stop: watchDesk(
        () => deskCounts({ ...deps, at: new Date() }),
        (counts) => {
          for (const each of [...listeners]) {
            try {
              each(counts);
            } catch {
              // A closed stream must not stop the others.
            }
          }
        },
        pollMs,
      ),
    };
    hubs.set(key, hub);
  }
  const current = hub;
  current.listeners.add(listener);
  return () => {
    current.listeners.delete(listener);
    if (current.listeners.size === 0 && hubs.get(key) === current) {
      current.stop();
      hubs.delete(key);
    }
  };
}

/** Response of GET /api/desk, for the home of the environment. */
export async function deskResponse(): Promise<Response> {
  try {
    const { config, db } = app();
    return Response.json(await resolveDesk({ config, db, commands: deskCommands(config.home) }));
  } catch (error) {
    return errorResponse(error);
  }
}
