import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { strings } from "../ui/strings";
import { RECEPTION_AGENT, RECEPTION_ROOM } from "../ui/reception";
import { AGENT_PROPOSAL, agentProposalSummaryHeading, NEED_SOURCE, needSchema, queueAgentNeed } from "./agent-proposal";
import { buildCatalog, readCatalogDirs } from "./catalog";
import { getConfig, type HqConfig } from "./config";
import { getDbAt, now, type ApprovalRow, type Db, type RunRow, type TaskRow } from "./db";
import { HqError } from "./errors";
import { DEFAULT_LANGUAGE, readHomeLanguage } from "./export";
import { idSchema, loadHome, toPosix, type Agent, type Home, type Model, type Room } from "./rooms";
import { launchRun, WAITS, type RunnerDeps } from "./runner";
import { listRoleTemplates, roleTemplatesDir } from "./templates";

/**
 * The receptionist's agent mode: proposing a missing agent. A need no agent
 * covers (the owner's, from the desk or the chat, or a room agent's, through
 * `hq_suggest_agent`) becomes a need task of `_hq/onboarding` (`NEED_SOURCE`);
 * a run of the receptionist reads the home (its rooms, agents and role prompts), the role
 * templates and the technology catalogue (see catalog.ts), and submits one
 * `agent_proposal`. Same agent, so same lock and daily cap as the room
 * proposals; a revision relaunches it, a rejection does not.
 */

/** Run reason of an agent-mode run started for a need (a revision run has `revise`). */
export const AGENT_NEED_REASON = "agent_need";

/** `POST /api/agents/propose`. */
export const proposeAgentSchema = z.strictObject({ need: needSchema, room: idSchema.optional() });

const TASK_PREFIX = "Propose an agent for the need: ";

/** The task of an agent-mode run: also the key that keeps a failing need from being retried in a loop. */
export function agentNeedTask(need: string): string {
  return `${TASK_PREFIX}${need.trim().replace(/\s+/g, " ")}`;
}

/** The receptionist's role prompt in agent mode, shipped with MyHQ. */
export function agentProposalRolePath(repoRoot: string): string {
  return path.join(repoRoot, "templates", "agent-proposal.md");
}

/** Who asked a need task, as the prompt and the payload say it. */
export function requestedByOf(task: Pick<TaskRow, "from_room" | "from_agent">): string {
  return task.from_agent ? `agent ${task.from_agent} of room ${task.from_room ?? "?"}` : "the owner";
}

function approvalOf(db: Db, task: TaskRow): ApprovalRow | null {
  if (task.source !== "revise" || task.ref_id === null) return null;
  return (db.prepare("SELECT * FROM approvals WHERE id = ?").get(task.ref_id) as ApprovalRow | undefined) ?? null;
}

/**
 * Whether a pending revision task no longer matches its item: the item is not
 * in `revise` any more (it was rejected or approved since, or the task dates
 * from the time a rejection also relaunched the receptionist). Such a task
 * wakes nothing and no run takes it.
 */
export function isStaleRevision(db: Db, task: TaskRow): boolean {
  if (task.source !== "revise" || task.ref_id === null) return false;
  const row = approvalOf(db, task);
  return row !== null && row.status !== "revise";
}

/** Whether a task of the receptionist is about an agent proposal (a need, or the revision of one), not a room. */
export function isAgentModeTask(db: Db, task: TaskRow): boolean {
  return task.source === NEED_SOURCE || approvalOf(db, task)?.type === AGENT_PROPOSAL;
}

/** A proposal the user sent back, as the revision run reads it. */
type PreviousAgentProposal = {
  approvalId: number;
  title: string;
  status: string;
  /** The room and the agent it proposed. */
  proposed: string;
  /** The receptionist's own text, without what MyHQ appended, cut. */
  summary: string;
  revision: string;
};

type NeedContext = {
  need: string;
  requestedBy: string;
  /** The room the need comes from, or the one the owner suggests; null when none. */
  room: string | null;
  previous: PreviousAgentProposal | null;
};

const SUMMARY_MAX = 3_000;

/** What a receptionist task asks for, or null when it cannot be read (a revision of an unreadable proposal). */
function needContext(db: Db, task: TaskRow): NeedContext | null {
  if (task.source === NEED_SOURCE) return { need: task.text, requestedBy: requestedByOf(task), room: task.from_room, previous: null };
  const row = approvalOf(db, task);
  if (row?.type !== AGENT_PROPOSAL) return null;
  let payload: { need?: unknown; requestedBy?: unknown; room?: unknown; agent?: { id?: unknown; model?: unknown } };
  try {
    payload = JSON.parse(row.payload) as typeof payload;
  } catch {
    return null;
  }
  if (typeof payload.need !== "string" || payload.need.trim() === "") return null;
  const room = typeof payload.room === "string" ? payload.room : null;
  const own = row.body.split(`\n${agentProposalSummaryHeading()}\n`)[0]!.trim();
  return {
    need: payload.need,
    requestedBy: typeof payload.requestedBy === "string" ? payload.requestedBy : "the owner",
    room,
    previous: {
      approvalId: row.id,
      title: row.title,
      status: row.status,
      proposed: `agent "${String(payload.agent?.id ?? "?")}" (${String(payload.agent?.model ?? "?")}) in room "${room ?? "?"}"`,
      summary: own.length > SUMMARY_MAX ? `${own.slice(0, SUMMARY_MAX)}...` : own,
      revision: task.text,
    },
  };
}

/** The English name of a BCP 47 tag ("fr" gives "French"), or the tag itself when unknown. */
function languageName(tag: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/** The rooms and agents of the home, one line each, for the prompt. */
function homeLines(home: Home, roomsDir: string): string[] {
  if (home.rooms.length === 0) return ["(no room yet)"];
  const rel = (p: string) => toPosix(path.relative(roomsDir, p));
  return home.rooms.flatMap((room) => [
    `- "${room.name}" (${room.shared ? "shared studio" : "project room"}), target repository ${toPosix(path.relative(home.root, room.targetRepo)) || "."}:`,
    ...room.agents.map((a) => {
      const routines = a.routines.map((r) => r.cron);
      return `  - ${a.id} "${a.name}": ${a.model}, tools ${a.allowedTools.join(", ") || "none"}${
        routines.length > 0 ? `, routines ${routines.join(" | ")}` : ""
      }, role ${rel(a.rolePath)}`;
    }),
  ]);
}

/** The user's message of an agent-mode run: the need, the home, the templates, the catalogue and the payload. */
export function buildAgentProposalPrompt(p: {
  runId: number;
  context: NeedContext;
  home: Home;
  roomsDir: string;
  templatesDir: string;
  catalog: string;
  language?: string;
}): string {
  const language = p.language ?? DEFAULT_LANGUAGE;
  const name = languageName(language);
  const english = language.toLowerCase().split("-")[0] === DEFAULT_LANGUAGE;
  const { need, requestedBy, room, previous } = p.context;
  const title = strings.agentProposal.title(language, "<agent id>", "<room>");
  const lines = [
    `Agent proposal run #${p.runId} of MyHQ.`,
    "",
    "The need no agent covers:",
    ...need.split("\n").map((line) => `> ${line}`),
    `Asked by: ${requestedBy}.`,
    room ? `It comes from room "${room}" (a hint for the room, not a rule).` : "No room is given: pick the right one.",
    "",
    `Rooms and agents of the home (your working directory is ${p.roomsDir}: read rooms' room.json and roles there):`,
    ...homeLines(p.home, p.roomsDir),
    "",
    `Role templates (in ${p.templatesDir}; examples of structure for the role prompt):`,
    ...listRoleTemplates(p.templatesDir).map((t) => `- ${t.name}: ${t.title}`),
    "",
    "Technology catalogue (read-only; read further in these folders when you need to):",
    p.catalog || "(empty)",
    "",
    english
      ? `Language of this home: ${language} (${name}).`
      : `Language of this home: ${language} (${name}). Write the title, the body, the reason and the whole role prompt in ${name}; tool names, item types, ids and JSON keys stay as they are.`,
    `Title of the hq_submit item: exactly in this form: "${title}".`,
    "",
    "Payload of hq_submit (type agent_proposal):",
    "{",
    '  "room": "<name of an existing room>",',
    '  "agent": { "id": "<new id>", "name": "<display name>", "model": "haiku|sonnet|opus",',
    '    "allowedTools": ["..."], "maxBudgetUsd": 1, "cron": "<optional cron>",',
    '    "worktree": "<developers only>", "workingDirectory": "<same as worktree>", "disallowedTools": ["..."] },',
    '  "rolePrompt": "<the whole role prompt, in Markdown>",',
    '  "reason": "<why this agent: the technologies it uses, its tools, its model and its budget>",',
    '  "need": "<the need, exactly as above>",',
    `  "requestedBy": "${requestedBy}"`,
    "}",
    'Leave out "role" and "armed": MyHQ writes roles/<id>.md and leaves every routine disarmed.',
    "The id must not be one of the room's agents. Ids are lowercase letters, digits, '-' or '_'.",
  ];
  if (previous) {
    lines.push(
      "",
      `REVISION RUN. The user sent your previous proposal #${previous.approvalId} back (${previous.status}).`,
      `Previous proposal #${previous.approvalId}: "${previous.title}", ${previous.proposed}.`,
      "Summary of what you proposed:",
      ...previous.summary.split("\n").map((line) => `> ${line}`),
      "",
      `The user's revision of #${previous.approvalId}:`,
      previous.revision,
      "",
      `Produce a new agent_proposal for this same need that answers each remark above. Submit it with hq_submit as a new item: #${previous.approvalId} cannot be edited. Then call hq_task_update with done.`,
    );
  }
  return lines.join("\n");
}

/** The receptionist in agent mode: it reads the home's rooms, the templates and the catalogue, and submits. */
function agentModeAgent(config: HqConfig, workDir: string, addDirs: string[], model: Model): Agent {
  return {
    id: RECEPTION_AGENT,
    name: RECEPTION_AGENT,
    model,
    allowedTools: ["mcp__hq__hq_submit", "mcp__hq__hq_task_update"],
    // Read-only tools exist without being pre-approved: print mode reads the working directory and the --add-dir folders only.
    tools: ["Read", "Glob", "Grep"],
    addDirs,
    mcpServers: {},
    rolePath: agentProposalRolePath(config.repoRoot),
    workDir,
    routines: [],
    armed: false,
    worktree: null,
    disallowedTools: [],
    maxBudgetUsd: config.onboardingMaxBudgetUsd,
    sprite: null,
    isoSprite: null,
    onApproval: null,
    onMessage: null,
    onRevise: null,
    notifyRuns: null,
    resources: [],
  };
}

export type AgentNeedDeps = RunnerDeps & { model?: Model };

/**
 * Starts the agent-mode run of one receptionist task (a need, or the revision
 * of an agent proposal), which takes that task alone. Same lock and daily cap
 * as any run: throws AGENT_BUSY, RESOURCE_BUSY or DAILY_CAP_REACHED, the task
 * then stays pending. Throws AGENT_PROPOSAL_INVALID when the task cannot be
 * read (a revision of an unreadable proposal).
 */
export function startAgentNeedRun(config: HqConfig, db: Db, task: TaskRow, deps: AgentNeedDeps = {}): RunRow {
  const context = needContext(db, task);
  if (!context) throw new HqError("AGENT_PROPOSAL_INVALID", 422, `Task #${task.id} names no readable need.`);
  const home = loadHome(config.home);
  const roomsDir = path.join(config.home, "rooms");
  const workDir = fs.existsSync(roomsDir) ? roomsDir : config.home;
  const catalogDirs = readCatalogDirs(config.home);
  if (catalogDirs.error) console.error(`[catalog] ${catalogDirs.error}`);
  const catalog = buildCatalog(config.home, home.rooms, catalogDirs.dirs);
  const templatesDir = roleTemplatesDir(config.repoRoot);
  const agent = agentModeAgent(config, workDir, [templatesDir, ...catalog.dirs], deps.model ?? "sonnet");
  const room: Room = { name: RECEPTION_ROOM, dir: config.home, targetRepo: workDir, color: null, shared: false, agents: [agent] };
  const language = readHomeLanguage(config.home);
  return launchRun({
    config,
    deps,
    room,
    agent,
    task: agentNeedTask(context.need),
    reason: context.previous ? "revise" : AGENT_NEED_REASON,
    claimIds: [task.id],
    prompt: (runId) =>
      buildAgentProposalPrompt({ runId, context, home, roomsDir: workDir, templatesDir, catalog: catalog.text, language }),
  });
}

/**
 * The owner asks for an agent (`POST /api/agents/propose`, or the chat's
 * `propose_agent` action): a need task of the receptionist, and its run at
 * once. Throws ROOM_NOT_FOUND for a room the home does not have. When the run
 * cannot start (busy receptionist, daily cap), `queue` decides: the task
 * waits for `wakeOnboarding` and `run` is null, or (the default) the task is
 * removed and the error thrown, as `POST /api/onboarding` does.
 */
export function proposeAgent(
  request: z.input<typeof proposeAgentSchema>,
  deps: AgentNeedDeps & { queue?: boolean } = {},
): { run: RunRow | null; taskId: number } {
  const { need, room } = proposeAgentSchema.parse(request);
  const config = deps.config ?? getConfig();
  if (room !== undefined && !loadHome(config.home).rooms.some((r) => r.name === room)) {
    throw new HqError("ROOM_NOT_FOUND", 404, `No room "${room}" in the home.`);
  }
  const db = getDbAt(config.dbPath);
  const taskId = queueAgentNeed(db, { room: RECEPTION_ROOM, agent: RECEPTION_AGENT, need, fromRoom: room ?? null, fromAgent: null });
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow;
  try {
    return { run: startAgentNeedRun(config, db, task, { ...deps, config }), taskId };
  } catch (error) {
    if (deps.queue && error instanceof HqError && WAITS.has(error.code)) return { run: null, taskId };
    db.prepare("DELETE FROM tasks WHERE id = ? AND status = 'pending'").run(taskId);
    throw error;
  }
}

/**
 * Part of `wakeOnboarding`: starts the agent-mode run of a pending
 * receptionist task, unless a run for the same need started since the task
 * was created (a failing run is not retried in a loop) or one already started
 * in this sweep. A task that names no readable need is blocked with a note.
 * Returns the run, or null.
 */
export function wakeAgentNeed(config: HqConfig, db: Db, task: TaskRow, done: Set<string>, deps: RunnerDeps): RunRow | null {
  const context = needContext(db, task);
  if (!context) {
    db.prepare("UPDATE tasks SET status = 'blocked', note = ?, updated_at = ? WHERE id = ?").run(
      "The agent proposal this revision is about cannot be read.",
      now(),
      task.id,
    );
    return null;
  }
  const key = agentNeedTask(context.need);
  if (done.has(key)) return null;
  done.add(key);
  const last = db
    .prepare("SELECT MAX(started_at) AS at FROM runs WHERE room = ? AND agent_id = ? AND task = ?")
    .get(RECEPTION_ROOM, RECEPTION_AGENT, key) as { at: string | null };
  if (last.at !== null && task.created_at <= last.at) return null;
  try {
    return startAgentNeedRun(config, db, task, { ...deps, config });
  } catch (error) {
    if (error instanceof HqError && WAITS.has(error.code)) return null;
    console.error(`[onboarding] could not start the agent proposal run of task #${task.id}`, error);
    return null;
  }
}
