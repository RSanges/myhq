import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getConfig, type HqConfig } from "./config";
import type { RunRow, TaskRow } from "./db";
import { HqError } from "./errors";
import { DEFAULT_LANGUAGE, readHomeLanguage } from "./export";
import { loadHome, toPosix, type Agent, type Model, type Room } from "./rooms";
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
function languageName(tag: string): string {
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
  /** BCP 47 tag of the home (`language` in myhq.json). */
  language?: string;
  templatesDir: string;
  mailbox: TaskRow[];
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
  if (p.mailbox.length > 0) {
    lines.push("", "Revision requests from the user (apply those about this repository, ignore the others):");
    for (const task of p.mailbox) lines.push(`- ${task.text}`);
  }
  return lines.join("\n");
}

/** MyHQ's onboarding agent for one target repository. */
function onboardingAgent(config: HqConfig, target: string, model: Model): Agent {
  return {
    id: ONBOARDING_AGENT,
    name: ONBOARDING_AGENT,
    model,
    allowedTools: ["mcp__hq__hq_submit", "mcp__hq__hq_task_update"],
    // Read-only tools exist, without being pre-approved: Claude Code allows
    // reading inside the working directory (the target) and the --add-dir
    // folders (the templates), and nothing else in print mode.
    tools: ["Read", "Glob", "Grep"],
    addDirs: [roleTemplatesDir(config.repoRoot)],
    mcpServers: {},
    rolePath: onboardingRolePath(config.repoRoot),
    workDir: target,
    routines: [],
    armed: false,
    worktree: null,
    disallowedTools: [],
    maxBudgetUsd: config.onboardingMaxBudgetUsd,
    sprite: null,
    onApproval: null,
    onMessage: null,
    onRevise: null,
    notifyRuns: null,
  };
}

export type OnboardingDeps = RunnerDeps & { model?: Model };

/**
 * Starts an onboarding run for a target repository (a path relative to the
 * home, or absolute), with the same lock and daily cap as any run. Throws
 * TARGET_NOT_FOUND when the path is not a directory.
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
  const room: Room = { name: ONBOARDING_ROOM, dir: config.home, targetRepo: target, color: null, agents: [] };
  const agent = onboardingAgent(config, target, deps.model ?? "sonnet");
  room.agents.push(agent);
  const targetRepo = toPosix(path.relative(config.home, target)) || ".";
  const task = onboardingTask(targetRepo);
  return launchRun({
    config,
    deps,
    room,
    agent,
    task,
    prompt: (runId, mailbox) =>
      buildOnboardingPrompt({
        runId,
        target,
        targetRepo,
        roomName: suggestRoomName(path.basename(target)),
        existingRooms,
        language,
        templatesDir: roleTemplatesDir(config.repoRoot),
        mailbox,
      }),
  });
}
