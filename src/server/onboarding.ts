import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { isAgentModeTask, isStaleRevision, wakeAgentNeed } from "./agent-need";
import { getConfig, type HqConfig } from "./config";
import { getDbAt, now, type ApprovalRow, type Db, type RunRow, type TaskRow } from "./db";
import { HqError } from "./errors";
import { DEFAULT_LANGUAGE, readHomeLanguage } from "./export";
import { homeRosterLines } from "./home-roster";
import { loadHome, toPosix, type Agent, type Model, type Room } from "./rooms";
import { ROOM_PROPOSAL } from "./proposal";
import { launchRun, type RunnerDeps } from "./runner";
import { onboardingTask, RECEPTION_AGENT, RECEPTION_ROOM } from "../ui/reception";
import { strings } from "../ui/strings";
import { listRoleTemplates, roleTemplatesDir, ROLE_PLACEHOLDERS } from "./templates";

/**
 * Onboarding: adding a project is itself an agent run. MyHQ's own onboarding
 * agent reads the target repository and submits a `room_proposal`; on
 * approval, MyHQ writes `rooms/<name>/` in the home and creates the worktrees.
 * Its runs belong to a reserved room, `_hq`, that no folder of the home can
 * take (room names start with a letter or a digit).
 */
export const ONBOARDING_ROOM = RECEPTION_ROOM;
export const ONBOARDING_AGENT = RECEPTION_AGENT;

export const onboardingSchema = z.strictObject({
  path: z.string().trim().min(1).max(1_000),
});

/** The onboarding agent's own role prompt, shipped with MyHQ. */
export function onboardingRolePath(repoRoot: string): string {
  return path.join(repoRoot, "templates", "onboarding.md");
}

/** A room name suggested from a folder name: lowercase, digits and dashes. */
export function suggestRoomName(folder: string): string {
  const slug = folder
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 63);
  return slug || "project";
}

/** The English name of a BCP 47 tag ("fr" gives "French"), or the tag itself when unknown. */
export function languageName(tag: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/** The part of the run prompt that fixes the language of everything the agent writes. */
function languageLines(language: string, roomName: string): string[] {
  const title = strings.onboarding.proposalTitle(language, "<room name>");
  const name = languageName(language);
  if (language.toLowerCase().split("-")[0] === DEFAULT_LANGUAGE) {
    return [
      `Language of this home: ${language} (${name}). Write the proposal title, the body, the role values and the "HQ agents" block in ${name}.`,
      `Title of the hq_submit item: "${title}" (for example "${strings.onboarding.proposalTitle(language, roomName)}").`,
    ];
  }
  return [
    `Language of this home: ${language} (${name}). Write everything the user will read in ${name}: the title and the body of the hq_submit item, the values of the roles, and the "HQ agents" block of claudeMd.`,
    `Title of the hq_submit item: it must be exactly in this form: "${title}" (for example "${strings.onboarding.proposalTitle(language, roomName)}").`,
    `The role templates are in English and stay the structural source. For every role, take its template, fill the placeholders, translate the whole prompt into ${name} keeping its sections, its rules and its tool and type names (hq_submit, hq_task_update, pull_request, ids, branch names) unchanged, and send the result as "content". Put any "notes" inside it. Never leave a {{placeholder}} in it.`,
  ];
}

/** The user's message of the onboarding run: the target, the templates and the payload to submit. */
export function buildOnboardingPrompt(p: {
  runId: number;
  target: string;
  targetRepo: string;
  roomName: string;
  existingRooms: string[];
  /** The rooms and their agents, as the agent mode lists them (see home-roster.ts), so that no agent is proposed twice. */
  roster: string[];
  /** The `rooms/` folder of the home, which the run may read (the role paths of the roster are relative to it), or null when it has none. */
  roomsDir: string | null;
  /** BCP 47 tag of the home (`language` in myhq.json). */
  language?: string;
  templatesDir: string;
  mailbox: TaskRow[];
  /** The proposals the user sent back, for the revision tasks of the mailbox. */
  previous?: PreviousProposal[];
}): string {
  const templates = listRoleTemplates(p.templatesDir);
  const language = p.language ?? DEFAULT_LANGUAGE;
  const lines = [
    `Onboarding run #${p.runId} of MyHQ.`,
    "",
    `Target repository: ${p.target} (your working directory).`,
    `In room.json, write "targetRepo": "${p.targetRepo}" (relative to the home).`,
    `Suggested room name: "${p.roomName}". Rooms that already exist, and cannot be used: ${
      p.existingRooms.length > 0 ? p.existingRooms.map((r) => `"${r}"`).join(", ") : "none"
    }.`,
    "",
    p.roomsDir
      ? `Rooms and agents of the home (you can read ${p.roomsDir}; the role paths below are relative to it):`
      : "Rooms and agents of the home:",
    ...p.roster,
    "Before you propose an agent, check this list. Never propose an agent whose trade already exists in a shared studio (for example design, CAD, video, sound): the agents of the new room order that work from the studio instead, with hq_message (\"room\": the shared room, \"to\": the studio agent). Give them mcp__hq__hq_message and mcp__hq__hq_rooms in allowedTools, and say in the body of the proposal and in their roles (notes) what they order from which studio. Open a role file of the list only when its first line is not enough.",
    "",
    `Role templates (read them in ${p.templatesDir} if you need to):`,
    ...templates.map((t) => `- ${t.name}: ${t.title}`),
    "",
    `Each role is a template plus values for its placeholders: ${ROLE_PLACEHOLDERS.join(", ")}.`,
    "A value is a string, or a list of strings that becomes a Markdown list; autonomy is A, B or C.",
    "",
    ...languageLines(language, p.roomName),
    "",
    "Payload of hq_submit (type room_proposal):",
    "{",
    '  "room": { "name": "<room>", "targetRepo": "<as above>", "agents": [',
    '    { "id": "<agent id>", "name": "<display name>", "model": "haiku|sonnet|opus",',
    '      "allowedTools": ["..."], "cron": "<optional cron>", "maxBudgetUsd": 1,',
    '      "worktree": "<developers only>", "workingDirectory": "<same as worktree>", "disallowedTools": ["..."] }',
    "  ] },",
    '  "roles": { "<agent id>": { "template": "<template name>", "values": { "project": "...", "targets": ["..."],',
    '    "audience": "...", "features": ["..."], "autonomy": "A|B|C", "guardrails": ["..."] }, "notes": "<optional extra Markdown>",',
    '    "content": "<whole role prompt, only when the language is not English>" } },',
    '  "claudeMd": "## HQ agents\\n..."',
    "}",
    "Leave out \"role\" and \"armed\": MyHQ writes roles/<id>.md and leaves every routine disarmed.",
    "Ids are lowercase letters, digits, '-' or '_'.",
  ];
  const previous = p.previous ?? [];
  const revised = new Set(previous.map((r) => r.taskId));
  for (const proposal of previous) {
    lines.push(
      "",
      `REVISION RUN. The user sent your previous proposal #${proposal.approvalId} back (${proposal.status}).`,
      `Previous proposal #${proposal.approvalId}: "${proposal.title}"${proposal.proposed ? `, ${proposal.proposed}` : ""}.`,
      "Summary of what you proposed:",
      ...proposal.summary.split("\n").map((line) => `> ${line}`),
      "",
      `The user's revision of #${proposal.approvalId}:`,
      proposal.revision,
      "",
      `Produce a new room_proposal for this same repository that answers each remark above (the remarks quote passages of your previous proposal). Submit it with hq_submit as a new item: #${proposal.approvalId} cannot be edited. Then call hq_task_update with done. The room name must not be one of the rooms that already exist.`,
    );
  }
  const others = p.mailbox.filter((task) => !revised.has(task.id));
  if (others.length > 0) {
    lines.push("", "Revision requests from the user (apply those about this repository, ignore the others):");
    for (const task of others) lines.push(`- ${task.text}`);
  }
  return lines.join("\n");
}

/** A proposal the user sent back, as the revision run reads it. */
export type PreviousProposal = {
  taskId: number;
  approvalId: number;
  title: string;
  /** The state of the item (`revise`). */
  status: string;
  /** The room and agents it proposed, or null when its payload is unreadable. */
  proposed: string | null;
  /** What the agent wrote of it (its own body, without the files MyHQ appended), cut. */
  summary: string;
  /** The user's revision: the text of the task (remarks then general note). */
  revision: string;
  /** The room name it proposed, to be suggested again. */
  roomName: string | null;
};

const SUMMARY_MAX = 3_000;

/** The room.json part of a stored proposal, read defensively. */
function proposedRoom(payload: string): { name: string | null; targetRepo: string | null; proposed: string | null } {
  try {
    const room = (JSON.parse(payload) as { room?: { name?: unknown; targetRepo?: unknown; agents?: unknown } }).room;
    const name = typeof room?.name === "string" ? room.name : null;
    const targetRepo = typeof room?.targetRepo === "string" ? room.targetRepo : null;
    const agents: string[] = [];
    if (Array.isArray(room?.agents)) {
      for (const a of room.agents as { id?: unknown; model?: unknown }[]) {
        if (typeof a?.id === "string") agents.push(`${a.id} (${String(a.model ?? "?")})`);
      }
    }
    const proposed = name ? `room "${name}"${agents.length > 0 ? ` with agents ${agents.join(", ")}` : ""}` : null;
    return { name, targetRepo, proposed };
  } catch {
    return { name: null, targetRepo: null, proposed: null };
  }
}

/** The room proposal a revision task of the onboarding agent is about, or null. */
function proposalOf(db: Db, task: TaskRow): ApprovalRow | null {
  if (task.source !== "revise" || task.ref_id === null) return null;
  const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(task.ref_id) as ApprovalRow | undefined;
  return row?.type === ROOM_PROPOSAL ? row : null;
}

/**
 * The repository a revision task of the onboarding agent is about, as an
 * absolute path (the `targetRepo` of the proposal, relative to the home), or
 * null for a task that is not a revision of a room proposal.
 */
export function revisionTarget(config: HqConfig, db: Db, task: TaskRow): string | null {
  const row = proposalOf(db, task);
  const targetRepo = row ? proposedRoom(row.payload).targetRepo : null;
  return targetRepo ? path.resolve(config.home, targetRepo) : null;
}

function previousProposal(db: Db, task: TaskRow): PreviousProposal | null {
  const row = proposalOf(db, task);
  if (!row) return null;
  const room = proposedRoom(row.payload);
  // The stored body is the agent's text then the files MyHQ appended ("## room.json" and the rest).
  const own = row.body.split(/\n## room\.json\n/)[0]!.trim();
  return {
    taskId: task.id,
    approvalId: row.id,
    title: row.title,
    status: row.status,
    proposed: room.proposed,
    summary: own.length > SUMMARY_MAX ? `${own.slice(0, SUMMARY_MAX)}...` : own,
    revision: task.text,
    roomName: room.name,
  };
}

/** MyHQ's onboarding agent for one target repository. */
function onboardingAgent(config: HqConfig, target: string, addDirs: string[], model: Model): Agent {
  return {
    id: ONBOARDING_AGENT,
    name: ONBOARDING_AGENT,
    model,
    allowedTools: ["mcp__hq__hq_submit", "mcp__hq__hq_task_update"],
    // Read-only tools exist, without being pre-approved: Claude Code allows
    // reading inside the working directory (the target) and the --add-dir
    // folders (the templates and the rooms of the home), and nothing else in
    // print mode.
    tools: ["Read", "Glob", "Grep"],
    addDirs,
    mcpServers: {},
    rolePath: onboardingRolePath(config.repoRoot),
    workDir: target,
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

export type OnboardingDeps = RunnerDeps & {
  model?: Model;
  /** Stored on the run (`runs.reason`): `revise` for a run that answers a revision. Default: none. */
  reason?: string;
};

/**
 * Starts an onboarding run for a target repository (a path relative to the
 * home, or absolute), with the same lock and daily cap as any run. Throws
 * TARGET_NOT_FOUND when the path is not a directory. The run takes the
 * pending tasks of the onboarding agent that are about this repository (the
 * revisions of its proposals) or about none; those about another repository,
 * and those of the agent mode (needs, revisions of agent proposals), stay in
 * the mailbox for their own run.
 */
export function startOnboarding(request: z.infer<typeof onboardingSchema>, deps: OnboardingDeps = {}): RunRow {
  const config = deps.config ?? getConfig();
  const target = path.resolve(config.home, request.path);
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    throw new HqError("TARGET_NOT_FOUND", 404, `No directory at ${target}.`);
  }
  const language = readHomeLanguage(config.home);
  const home = loadHome(config.home);
  const existingRooms = [...home.rooms.map((r) => r.name), ...home.invalid.map((r) => path.basename(r.dir))];
  const room: Room = { name: ONBOARDING_ROOM, dir: config.home, targetRepo: target, color: null, shared: false, agents: [] };
  const roomsDir = path.join(config.home, "rooms");
  const readableRooms = fs.existsSync(roomsDir) ? roomsDir : null;
  const agent = onboardingAgent(
    config,
    target,
    [roleTemplatesDir(config.repoRoot), ...(readableRooms ? [readableRooms] : [])],
    deps.model ?? "sonnet",
  );
  room.agents.push(agent);
  const targetRepo = toPosix(path.relative(config.home, target)) || ".";
  const task = onboardingTask(targetRepo);
  const db = getDbAt(config.dbPath);
  const claimIds = (
    db
      .prepare("SELECT * FROM tasks WHERE room = ? AND agent_id = ? AND status = 'pending'")
      .all(ONBOARDING_ROOM, ONBOARDING_AGENT) as TaskRow[]
  )
    .filter((t) => {
      if (isStaleRevision(db, t) || isAgentModeTask(db, t)) return false;
      const about = revisionTarget(config, db, t);
      return about === null || about === target;
    })
    .map((t) => t.id);
  return launchRun({
    config,
    deps,
    room,
    agent,
    task,
    reason: deps.reason ?? null,
    claimIds,
    prompt: (runId, mailbox) => {
      const previous = mailbox.flatMap((t) => previousProposal(db, t) ?? []);
      // A revision run proposes the same room name again, unless a room took it since.
      const proposed = previous.find((r) => r.roomName && !existingRooms.includes(r.roomName))?.roomName;
      return buildOnboardingPrompt({
        runId,
        target,
        targetRepo,
        roomName: proposed ?? suggestRoomName(path.basename(target)),
        existingRooms,
        roster: homeRosterLines(home, roomsDir),
        roomsDir: readableRooms,
        language,
        templatesDir: roleTemplatesDir(config.repoRoot),
        mailbox,
        previous,
      });
    },
  });
}

/**
 * Starts the onboarding runs that pending revisions ask for. The onboarding
 * agent is not a room agent (wakeAgents does not know it): a revision of a
 * `room_proposal` gives it a task, and this function runs it, at once, on the
 * repository of that proposal, with reason `revise`. One run per repository, the oldest revision first; it takes the
 * revisions of that repository together. Same lock and daily cap as any run:
 * a busy agent or the cap leave the task pending, and the next wake-up (the
 * end of a run, the next decision, the next start of the app) tries again.
 * A revision whose item is no longer in `revise` (rejected or approved since)
 * is stale and ignored: a rejection ends the matter. A revision whose
 * repository is gone is blocked with a note. As for the other agents, a repository is not woken again by a revision older than its last
 * onboarding run, so that a failing run is not retried in a loop. The agent
 * mode is woken here too, in the same order: a pending need (a `message`
 * task, from `hq_suggest_agent` or a request that had to wait) or a revision
 * of an `agent_proposal` starts an agent-mode run, one per need (see agent-need.ts).
 */
export function wakeOnboarding(config: HqConfig, db: Db, deps: RunnerDeps = {}): RunRow[] {
  const pending = db
    .prepare(
      "SELECT * FROM tasks WHERE room = ? AND agent_id = ? AND source IN ('revise', 'message') AND status = 'pending' ORDER BY id",
    )
    .all(ONBOARDING_ROOM, ONBOARDING_AGENT) as TaskRow[];
  const started: RunRow[] = [];
  const done = new Set<string>();
  for (const task of pending) {
    if (isStaleRevision(db, task)) continue;
    if (isAgentModeTask(db, task)) {
      const run = wakeAgentNeed(config, db, task, done, deps);
      if (run) started.push(run);
      continue;
    }
    const target = revisionTarget(config, db, task);
    if (target === null || done.has(target)) continue;
    done.add(target);
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      db.prepare("UPDATE tasks SET status = 'blocked', note = ?, updated_at = ? WHERE id = ?").run(
        `The repository ${target} is not a directory.`,
        now(),
        task.id,
      );
      continue;
    }
    const targetRepo = toPosix(path.relative(config.home, target)) || ".";
    const last = db
      .prepare("SELECT MAX(started_at) AS at FROM runs WHERE room = ? AND agent_id = ? AND task = ?")
      .get(ONBOARDING_ROOM, ONBOARDING_AGENT, onboardingTask(targetRepo)) as { at: string | null };
    if (last.at !== null && task.created_at <= last.at) continue;
    try {
      started.push(startOnboarding({ path: targetRepo }, { ...deps, config, reason: "revise" }));
    } catch (error) {
      if (error instanceof HqError && (error.code === "AGENT_BUSY" || error.code === "DAILY_CAP_REACHED")) continue;
      console.error(`[onboarding] could not start the revision run for ${targetRepo}`, error);
    }
  }
  return started;
}
