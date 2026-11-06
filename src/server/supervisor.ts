import fs from "node:fs";
import path from "node:path";
import { strings } from "../ui/strings";
import { attachmentPath } from "./attachments";
import { listBlocked, MYHQ_NOTE_AGENT, MYHQ_NOTE_ROOM, targetTasks, type BlockedEntry, type BlockedTarget } from "./blocked";
import { liveConfig, type HqConfig } from "./config";
import { now, type ApprovalRow, type Db, type RunRow } from "./db";
import { HqError } from "./errors";
import { recordExpects, type MessageExpects } from "./portier";
import { startRelaunchRequests } from "./relaunch-requests";
import { resourceHolder } from "./resources";
import { loadHome, type Home } from "./rooms";
import { runsToday, startRun, WAITS, type RunnerDeps } from "./runner";

// The supervisor of the Standard: an agent with `supervisor: true` in its
// room.json. It does for the owner what the owner did by hand: read what is
// stuck, check the facts, write to the agent concerned, relaunch what failed
// for a passing reason, and hand to the owner, with one sentence, what needs
// a decision. It never approves, rejects or closes anything. MyHQ wakes it
// when a new entry appears on the Standard, and every 30 minutes at most
// while entries remain that were not handed to the owner. See
// docs/architecture.md, "The supervisor".

/** Why MyHQ started a run of the supervisor (`runs.reason`). */
export const STANDARD_REASON = "standard";
/** While entries remain open, the supervisor is woken again at most this often. */
export const STANDARD_REVIEW_MS = 30 * 60_000;
/** The only item a supervisor may submit: a note to the owner, informational (it never waits for a decision). */
export const OWNER_NOTE = "owner_note";
/** The most characters of a task text given in a wake-up task or by hq_blocked. */
const TEXT_MAX = 1_500;
/** The most entries a wake-up task lists; hq_blocked gives the others. */
const TASK_ENTRIES_MAX = 20;

export type SupervisorRef = { room: string; agentId: string };
/** Who acts: the supervisor and its run. */
export type SupervisorActor = SupervisorRef & { runId: number | null };

/** The supervisors of the home, in room then agent order. MyHQ wakes the first one. */
export function supervisorsOf(home: Home): SupervisorRef[] {
  return home.rooms.flatMap((room) => room.agents.filter((agent) => agent.supervisor).map((agent) => ({ room: room.name, agentId: agent.id })));
}

/** Whether this agent is a supervisor, as last synced (the `supervisors` table): what the HQ MCP server knows. */
export function isSupervisor(db: Db, room: string, agentId: string): boolean {
  return db.prepare("SELECT 1 FROM supervisors WHERE room = ? AND agent_id = ?").get(room, agentId) !== undefined;
}

/**
 * MyHQ itself, when it relaunches an entry of the Standard by its rules or writes a note there (`entryRule`).
 * A function: blocked.ts, which holds the names, may not be loaded yet when this module is (they import each other).
 */
export const myhqActor = (): SupervisorActor => ({ room: MYHQ_NOTE_ROOM, agentId: MYHQ_NOTE_AGENT, runId: null });

/** The task ids a relaunch (a supervisor's, or MyHQ's own by its rules) already covers, with the request that did. */
function relaunchedTasks(db: Db): Map<number, { id: number; handled: boolean; runId: number | null; byMyhq: boolean }> {
  const rows = db
    .prepare(
      "SELECT s.id, s.handled_at, s.run_id, s.by_room, s.by_agent, j.value AS task_id FROM supervisor_relaunches s, json_each(s.task_ids) j ORDER BY s.id",
    )
    .all() as { id: number; handled_at: string | null; run_id: number | null; by_room: string; by_agent: string; task_id: number }[];
  return new Map(
    rows.map((row) => [
      row.task_id,
      {
        id: row.id,
        handled: row.handled_at !== null,
        runId: row.run_id,
        byMyhq: row.by_room === MYHQ_NOTE_ROOM && row.by_agent === MYHQ_NOTE_AGENT,
      },
    ]),
  );
}

/** An entry of the Standard as a supervisor reads it (hq_blocked). */
export type SupervisedEntry = {
  /** What hq_relaunch and hq_blocked_note take for it. */
  target: BlockedTarget;
  entry: BlockedEntry["entry"];
  room: string;
  agent: string;
  agentName: string;
  state: BlockedEntry["state"];
  since: string;
  reason: string;
  text: string;
  textTruncated: boolean;
  taskIds: number[];
  note: { text: string; by: string; at: string } | null;
  handedOff: boolean;
  /** A supervisor already relaunched one of its tasks: it is never relaunched a second time. */
  relaunched: boolean;
};

export const entryTarget = (entry: BlockedEntry): BlockedTarget => ({ kind: entry.entry === "run" ? "run" : "task", id: entry.id });

/** The Standard as a supervisor reads it: every entry but its own. */
export function supervisedEntries(db: Db, home: Home, config: HqConfig, self: SupervisorRef, at: Date = new Date()): SupervisedEntry[] {
  const relaunched = relaunchedTasks(db);
  return listBlocked(db, home, config, at)
    .filter((entry) => !(entry.room === self.room && entry.agentId === self.agentId))
    .map((entry) => ({
      target: entryTarget(entry),
      entry: entry.entry,
      room: entry.room,
      agent: entry.agentId,
      agentName: entry.agentName,
      state: entry.state,
      since: entry.since,
      reason: entry.reason,
      text: entry.text.slice(0, TEXT_MAX),
      textTruncated: entry.text.length > TEXT_MAX,
      taskIds: entry.taskIds,
      note: entry.note ? { text: entry.note.text, by: `${entry.note.room}/${entry.note.agentId}`, at: entry.note.at } : null,
      handedOff: entry.handedOff,
      relaunched: entry.taskIds.some((id) => relaunched.has(id)),
    }));
}

/**
 * What would hold back a run of this agent now: unknown agent, busy agent,
 * a shared resource held, the daily cap. The same guards as `launchRun`
 * (the HQ MCP server cannot know that the app is stopping: the app checks it
 * when it starts the run). Null when the run can start.
 */
export function relaunchGuard(db: Db, config: HqConfig, home: Home, room: string, agentId: string): { code: string; message: string } | null {
  const agent = home.rooms.find((each) => each.name === room)?.agents.find((each) => each.id === agentId);
  if (!agent) return { code: "AGENT_NOT_FOUND", message: `No agent "${agentId}" in room "${room}" of the home: nobody would take the tasks.` };
  const busy = db.prepare("SELECT id FROM runs WHERE room = ? AND agent_id = ? AND status = 'running'").get(room, agentId) as { id: number } | undefined;
  if (busy) return { code: "AGENT_BUSY", message: `${room}/${agentId} already has a run in progress (#${busy.id}): wait for its end.` };
  const holder = resourceHolder(db, agent.resources);
  if (holder) {
    return {
      code: "RESOURCE_BUSY",
      message: `Resource "${holder.resource}" is held by run #${holder.runId} of ${holder.room}/${holder.agentId}: wait for its end.`,
    };
  }
  const today = runsToday(db);
  const cap = liveConfig(config).maxRunsPerDay;
  if (today >= cap) return { code: "DAILY_CAP_REACHED", message: `Daily cap reached (${today} of ${cap} runs today): the owner decides.` };
  return null;
}

/**
 * Writes a message from an agent to another (`messages` and a `message` task of
 * the recipient, which wakes it per its `onMessage`, under the anti ping-pong
 * window and the portier): hq_message, the message given with a relaunch, and
 * the messages of an approved item (`deliverRelays`). `expects` is what the
 * sender expects (hq_message `expects`, see portier.ts). To call within a
 * transaction.
 */
export function writeMessage(db: Db, from: SupervisorActor, to: SupervisorRef, text: string, expects?: MessageExpects): number {
  const elsewhere = to.room !== from.room;
  const body = elsewhere
    ? `Message from ${from.agentId} of room "${from.room}" (answer with hq_message to "${from.agentId}", room "${from.room}"): ${text}`
    : `Message from ${from.agentId}: ${text}`;
  const at = now();
  const message = db
    .prepare("INSERT INTO messages (room, from_agent, to_agent, to_room, text, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(from.room, from.agentId, to.agentId, elsewhere ? to.room : null, text, from.runId, at);
  const messageId = Number(message.lastInsertRowid);
  const task = db.prepare(
    `INSERT INTO tasks (room, agent_id, source, ref_id, text, status, from_room, from_agent, created_at, updated_at)
     VALUES (?, ?, 'message', ?, ?, 'pending', ?, ?, ?, ?)`,
  ).run(to.room, to.agentId, messageId, body, from.room, from.agentId, at, at).lastInsertRowid;
  if (expects) recordExpects(db, Number(task), expects);
  return messageId;
}

// --- The messages of an approved item (hq_submit `onApprove`) ---------------------------

/** One message an item asks MyHQ to deliver once it is approved. */
export type RelayMessage = { room: string; agent: string; text: string };

/** Records the messages of an item (hq_submit `onApprove`). To call within the transaction that stores it. */
export function recordRelays(db: Db, approvalId: number, messages: readonly RelayMessage[]): void {
  if (messages.length === 0) return;
  db.prepare("INSERT OR REPLACE INTO approval_relays (approval_id, messages) VALUES (?, ?)").run(approvalId, JSON.stringify(messages));
}

/** Whether an item has messages MyHQ still has to deliver on its approval. */
export function hasRelays(db: Db, approvalId: number): boolean {
  return db.prepare("SELECT 1 FROM approval_relays WHERE approval_id = ? AND delivered_at IS NULL").get(approvalId) !== undefined;
}

/** The text MyHQ appends to a relayed message: the approved item, its body and its files. */
export function relayAppendix(db: Db, row: ApprovalRow): string {
  const files = db.prepare("SELECT id, name FROM approval_files WHERE approval_id = ? ORDER BY id").all(row.id) as { id: number; name: string }[];
  const dataDir = path.dirname(path.resolve(db.name));
  const lines = files.map((file) => {
    const copy = attachmentPath(dataDir, row.id, file.id, file.name);
    return `- ${file.name}${fs.existsSync(copy) ? ` (${copy})` : ""}`;
  });
  return [
    "",
    "",
    `--- Approved item #${row.id} (${row.type}): ${row.title}`,
    "",
    row.body.trim(),
    ...(lines.length > 0 ? ["", "Files (read-only copies kept by MyHQ):", ...lines] : []),
  ].join("\n");
}

/**
 * Delivers the messages of an item just approved, in the name of the agent
 * that submitted it, each with the item's title, body and files appended and
 * `expects: "action"` (the recipient is woken, the portier is skipped). An
 * item's messages are delivered once. To call within the transaction of the
 * decision. Returns the message ids.
 */
export function deliverRelays(db: Db, row: ApprovalRow): number[] {
  const stored = db.prepare("SELECT messages FROM approval_relays WHERE approval_id = ? AND delivered_at IS NULL").get(row.id) as
    | { messages: string }
    | undefined;
  if (!stored) return [];
  let messages: RelayMessage[] = [];
  try {
    messages = JSON.parse(stored.messages) as RelayMessage[];
  } catch {
    messages = [];
  }
  const appendix = relayAppendix(db, row);
  const from: SupervisorActor = { room: row.room, agentId: row.agent_id, runId: row.run_id };
  const ids = messages.map((message) => writeMessage(db, from, { room: message.room, agentId: message.agent }, `${message.text}${appendix}`, "action"));
  db.prepare("UPDATE approval_relays SET delivered_at = ? WHERE approval_id = ?").run(now(), row.id);
  return ids;
}

export type RelaunchRequestResult =
  | { relaunched: true; request: number; tasks: number[]; message: number | null }
  | { relaunched: false; tasks: number[]; waiting: { code: string; message: string } };

/**
 * hq_relaunch: « Relancer » for a supervisor. When a guard holds the agent
 * now (busy, resource, cap), nothing changes and the answer says why, so the
 * supervisor relaunches later. Otherwise the tasks of the entry go back to
 * pending, the message (the proof, the missing text) joins them as a message
 * of the supervisor, and the request is recorded: the app starts the run at
 * once (`startRelaunchRequests`), and that run takes the whole mailbox. A task
 * a supervisor relaunched once is never relaunched by one again
 * (`ALREADY_RELAUNCHED`): its entry goes to the owner.
 */
export function requestRelaunch(
  db: Db,
  config: HqConfig,
  home: Home,
  by: SupervisorActor,
  target: BlockedTarget,
  message?: string,
): RelaunchRequestResult {
  return db
    .transaction((): RelaunchRequestResult => {
      const found = targetTasks(db, target);
      if (found.room === by.room && found.agentId === by.agentId) {
        throw new HqError("OWN_ENTRY", 409, "This entry is yours: a supervisor never relaunches itself.");
      }
      const relaunched = relaunchedTasks(db);
      const earlier = found.ids.map((id) => relaunched.get(id)).find((each) => each !== undefined);
      if (earlier) {
        throw new HqError(
          "ALREADY_RELAUNCHED",
          409,
          `Already relaunched once by a supervisor (request #${earlier.id}${earlier.runId ? `, run #${earlier.runId}` : ""}): never relaunch it a second time. Hand the entry to the owner with hq_blocked_note and handOff: true.`,
        );
      }
      const waiting = relaunchGuard(db, config, home, found.room, found.agentId);
      if (waiting) return { relaunched: false, tasks: found.ids, waiting };
      const at = now();
      db.prepare(
        `UPDATE tasks SET status = 'pending', run_id = NULL, updated_at = ? WHERE id IN (SELECT value FROM json_each(?)) AND status IN ('blocked', 'pending')`,
      ).run(at, JSON.stringify(found.ids));
      const messageId = message ? writeMessage(db, by, { room: found.room, agentId: found.agentId }, message) : null;
      const request = Number(
        db
          .prepare(
            `INSERT INTO supervisor_relaunches (target_kind, target_id, room, agent_id, task_ids, by_room, by_agent, by_run, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(target.kind, target.id, found.room, found.agentId, JSON.stringify(found.ids), by.room, by.agentId, by.runId, at)
          .lastInsertRowid,
      );
      return { relaunched: true, request, tasks: found.ids, message: messageId };
    })
    .immediate();
}

/** hq_blocked_note: a sentence for the owner on the tasks of an entry; `handOff` hands the entry to the owner. */
export function noteBlocked(db: Db, by: SupervisorActor, target: BlockedTarget, text: string, handOff: boolean): { tasks: number[]; handedOff: boolean } {
  return db
    .transaction(() => {
      const found = targetTasks(db, target);
      const insert = db.prepare(
        "INSERT INTO blocked_notes (task_id, room, agent_id, run_id, text, handed_off, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      const at = now();
      for (const id of found.ids) insert.run(id, by.room, by.agentId, by.runId, text, handOff ? 1 : 0, at);
      return { tasks: found.ids, handedOff: handOff };
    })
    .immediate();
}

/** One entry in a wake-up task: what hq_relaunch and hq_blocked_note take, who, since when, why, and the text. */
function entryLine(entry: BlockedEntry): string {
  const target = entryTarget(entry);
  const text = entry.text.replace(/\s+/g, " ").trim();
  const note = entry.note ? ` Your last note: "${entry.note.text}"` : "";
  return `- [${target.kind} ${target.id}] ${entry.room}/${entry.agentId} (${entry.agentName}), ${entry.state} since ${entry.since}: ${entry.reason}${note} Text: ${text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX)}...` : text}`;
}

const entries = (count: number) => `${count} entr${count === 1 ? "y" : "ies"}`;

/** The lines of at most TASK_ENTRIES_MAX entries, then how many more hq_blocked gives. */
function entryLines(list: readonly BlockedEntry[]): string[] {
  const more = list.length - TASK_ENTRIES_MAX;
  return [...list.slice(0, TASK_ENTRIES_MAX).map(entryLine), ...(more > 0 ? [`And ${entries(more)} more: hq_blocked lists them.`] : [])];
}

/** The task of a wake-up for new entries. */
export function newEntriesTask(fresh: readonly BlockedEntry[], open: number): string {
  const others = open - fresh.length;
  return [
    `New on the Standard: ${entries(fresh.length)}. Check the facts of each one with hq_blocked and hq_items, then act as your role says.`,
    ...entryLines(fresh),
    ...(others > 0 ? [`Also open, already given to you: ${entries(others)} (hq_blocked lists them).`] : []),
  ].join("\n");
}

/** The task of the review wake-up, while entries remain open. */
export function reviewTask(open: readonly BlockedEntry[]): string {
  return [
    `Review of the Standard: ${entries(open.length)} still open (not handed to the owner). Check where each one stands with hq_blocked and hq_items; hand to the owner what you cannot move.`,
    ...entryLines(open),
  ].join("\n");
}

/**
 * The second failure of an entry goes to the owner: an open entry with a task
 * that a supervisor, or MyHQ by its rules, already relaunched (the request was
 * handled, so the relaunch was tried) is handed to the owner with a note of
 * MyHQ's, in the supervisor's name (in MyHQ's own for its own relaunch).
 * Returns the entries handed off.
 */
function handOffRelaunched(db: Db, supervisor: SupervisorRef, supervisorName: string, entries: readonly BlockedEntry[]): BlockedEntry[] {
  const relaunched = relaunchedTasks(db);
  const handed: BlockedEntry[] = [];
  for (const entry of entries) {
    if (entry.handedOff) continue;
    const earlier = entry.taskIds.map((id) => relaunched.get(id)).find((each) => each?.handled);
    if (!earlier) continue;
    if (earlier.byMyhq) noteBlocked(db, myhqActor(), entryTarget(entry), strings.deskModules.standard.secondFailureMyhq, true);
    else noteBlocked(db, { ...supervisor, runId: null }, entryTarget(entry), strings.deskModules.standard.secondFailure(supervisorName), true);
    handed.push(entry);
  }
  return handed;
}

// --- The rules of the Standard ---------------------------------------------------------

/** What MyHQ does with an open entry before it wakes the supervisor. */
export type EntryRule =
  /** A passing technical failure never relaunched: MyHQ relaunches it once (`why`: a key of `strings...transient`). */
  | { kind: "relaunch"; why: string }
  /** It will start again on its own (the cap, a resource, the anti ping-pong window, a stop of MyHQ): nothing to do. */
  | { kind: "wait" }
  /** A block in free text, or a state no rule covers: the supervisor reads it. */
  | { kind: "supervisor" };

/** The passing technical failures, as the summary of a run or the note of a blocked task says them. */
const TRANSIENT: readonly { why: string; pattern: RegExp }[] = [
  { why: "mcp", pattern: /mcp server not connected|mcp_not_connected|serveur mcp[^.]{0,40}(non connecté|pas connecté|failed)|mcp[^.]{0,40}not connected/i },
  { why: "database", pattern: /sqlite_busy|sqlite_locked|database is locked|base de données[^.]{0,20}occupée/i },
  { why: "gpu", pattern: /resource_busy|\bgpu\b[^.]{0,30}(busy|occupé|pris|in use)|ressource[^.]{0,40}occupée/i },
  { why: "cap", pattern: /daily_cap_reached|daily cap|plafond du jour/i },
  { why: "interrupted", pattern: /\binterrupted\b|interrompu/i },
];

/**
 * The rule MyHQ applies to an entry (`entry.cause`, `entry.detail`): an
 * interrupted run, a busy agent whose task nothing takes, two interruptions in
 * a row, or a failed run or a blocked task whose words name a passing failure
 * (an MCP server not connected, the GPU busy, an interruption, SQLITE_BUSY,
 * the daily cap) is relaunched once; the cap, a resource, the anti ping-pong
 * window and a stop of MyHQ resolve themselves; everything else is the
 * supervisor's.
 */
export function entryRule(entry: Pick<BlockedEntry, "cause" | "detail">): EntryRule {
  switch (entry.cause) {
    case "cancelled":
    case "interruptedTwice":
      return { kind: "relaunch", why: "interrupted" };
    case "busy":
      return { kind: "relaunch", why: "busy" };
    case "cap":
    case "resource":
    case "pingPong":
    case "stopping":
      return { kind: "wait" };
    case "failed":
    case "blocked": {
      const found = TRANSIENT.find((each) => each.pattern.test(entry.detail ?? ""));
      return found ? { kind: "relaunch", why: found.why } : { kind: "supervisor" };
    }
    default:
      return { kind: "supervisor" };
  }
}

/** Guards of a relaunch that pass on their own: MyHQ tries again at a later tick. */
const PASSING_GUARDS = new Set(["AGENT_BUSY", "RESOURCE_BUSY", "DAILY_CAP_REACHED"]);

/**
 * Applies the rules of the Standard to the open entries: relaunches once, in
 * MyHQ's name, what failed for a passing reason (with a note on the entry),
 * leaves alone what starts again on its own, and returns what is left for the
 * supervisor. A relaunch held back by a guard that passes (busy, resource,
 * cap) changes nothing and is tried again at the next tick. The runs are
 * started at once (`startRelaunchRequests`).
 */
export function settleByRule(config: HqConfig, db: Db, home: Home, open: readonly BlockedEntry[], deps: RunnerDeps = {}): BlockedEntry[] {
  const relaunched = relaunchedTasks(db);
  const left: BlockedEntry[] = [];
  let started = false;
  for (const entry of open) {
    const rule = entryRule(entry);
    if (rule.kind === "wait") continue;
    if (rule.kind === "supervisor") {
      left.push(entry);
      continue;
    }
    // Relaunched once already, and not handled yet: its run starts, or handOffRelaunched hands it to the owner.
    if (entry.taskIds.some((id) => relaunched.has(id))) continue;
    try {
      const result = requestRelaunch(db, config, home, myhqActor(), entryTarget(entry));
      if (result.relaunched) {
        // On its tasks, now pending again: a run entry no longer has any blocked or given back.
        const text = strings.deskModules.standard.autoRelaunched(strings.deskModules.standard.transient[rule.why] ?? rule.why);
        for (const id of result.tasks) noteBlocked(db, myhqActor(), { kind: "task", id }, text, false);
        started = true;
      } else if (!PASSING_GUARDS.has(result.waiting.code)) {
        left.push(entry);
      }
    } catch (error) {
      if (!(error instanceof HqError)) throw error;
      left.push(entry);
    }
  }
  if (started) startRelaunchRequests(config, db, deps);
  return left;
}

/**
 * Wakes the supervisor (the first one of the home) for the Standard: at once
 * when an open entry has a task it was never given (a new entry), with a task
 * that lists the new entries; otherwise, while open entries remain, at most
 * every STANDARD_REVIEW_MS since its last such run, with a task that lists
 * them all. An open entry is one not handed to the owner and not the
 * supervisor's own; before anything, an entry that a relaunch did not
 * unblock is handed to the owner (`handOffRelaunched`), then MyHQ settles
 * what follows a rule (`settleByRule`): the supervisor is woken only for the
 * entries left, the blocks in free text. A busy
 * supervisor, a busy resource or the cap: nothing is recorded, the next tick
 * tries again. Called at each tick of the scheduler's timer. Never throws for
 * those waits; returns the run started, or null.
 */
export function watchStandard(config: HqConfig, db: Db, deps: RunnerDeps = {}, at: Date = new Date()): RunRow | null {
  if (!db.prepare("SELECT 1 FROM supervisors LIMIT 1").get()) return null;
  const home = loadHome(config.home);
  const supervisor = supervisorsOf(home)[0];
  if (!supervisor) return null;
  const name = home.rooms.find((room) => room.name === supervisor.room)?.agents.find((agent) => agent.id === supervisor.agentId)?.name ?? supervisor.agentId;
  const own = (entry: BlockedEntry) => entry.room === supervisor.room && entry.agentId === supervisor.agentId;
  const entries = listBlocked(db, home, config, at).filter((entry) => !own(entry));
  const handed = new Set(handOffRelaunched(db, supervisor, name, entries));
  const open = settleByRule(
    config,
    db,
    home,
    entries.filter((entry) => !entry.handedOff && !handed.has(entry)),
    deps,
  );
  if (open.length === 0) return null;

  const announced = db.prepare("SELECT 1 FROM standard_announced WHERE task_id = ?");
  const fresh = open.filter((entry) => entry.taskIds.some((id) => !announced.get(id)));
  let task: string;
  if (fresh.length > 0) {
    task = newEntriesTask(fresh, open.length);
  } else {
    const last = db
      .prepare("SELECT MAX(started_at) AS at FROM runs WHERE room = ? AND agent_id = ? AND reason = ?")
      .get(supervisor.room, supervisor.agentId, STANDARD_REASON) as { at: string | null };
    if (last.at && at.getTime() - Date.parse(last.at) < STANDARD_REVIEW_MS) return null;
    task = reviewTask(open);
  }

  let run: RunRow;
  try {
    run = startRun({ room: supervisor.room, agent: supervisor.agentId, task, reason: STANDARD_REASON }, { ...deps, config });
  } catch (error) {
    if (error instanceof HqError && WAITS.has(error.code)) return null;
    throw error;
  }
  const mark = db.prepare("INSERT OR IGNORE INTO standard_announced (task_id, run_id, announced_at) VALUES (?, ?, ?)");
  const stamp = now();
  db.transaction(() => {
    for (const entry of open) for (const id of entry.taskIds) mark.run(id, run.id, stamp);
  })();
  return run;
}
