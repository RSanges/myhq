import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getConfig, type HqConfig } from "./config";
import type { RunRow, TaskRow } from "./db";
import { HqError } from "./errors";
import { loadHome, toPosix, type Agent, type Model, type Room } from "./rooms";
import { launchRun, type RunnerDeps } from "./runner";
import { listRoleTemplates, roleTemplatesDir, ROLE_PLACEHOLDERS } from "./templates";

/**
 * Onboarding: adding a project is itself an agent run. MyHQ's own onboarding
 * agent reads the target repository and submits a `room_proposal`; on
 * approval, MyHQ writes `rooms/<name>/` in the home and creates the worktrees.
 * Its runs belong to a reserved room, `_hq`, that no folder of the home can
 * take (room names start with a letter or a digit).
 */
export const ONBOARDING_ROOM = "_hq";
export const ONBOARDING_AGENT = "onboarding";

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

/** The user's message of the onboarding run: the target, the templates and the payload to submit. */
export function buildOnboardingPrompt(p: {
  runId: number;
  target: string;
  targetRepo: string;
  roomName: string;
  existingRooms: string[];
  templatesDir: string;
  mailbox: TaskRow[];
}): string {
  const templates = listRoleTemplates(p.templatesDir);
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
    "Payload of hq_submit (type room_proposal):",
    "{",
    '  "room": { "name": "<room>", "targetRepo": "<as above>", "agents": [',
    '    { "id": "<agent id>", "name": "<display name>", "model": "haiku|sonnet|opus",',
    '      "allowedTools": ["..."], "cron": "<optional cron>", "maxBudgetUsd": 1,',
    '      "worktree": "<developers only>", "workingDirectory": "<same as worktree>", "disallowedTools": ["..."] }',
    "  ] },",
    '  "roles": { "<agent id>": { "template": "<template name>", "values": { "project": "...", "targets": ["..."],',
    '    "audience": "...", "features": ["..."], "autonomy": "A|B|C", "guardrails": ["..."] }, "notes": "<optional extra Markdown>" } },',
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
  const home = loadHome(config.home);
  const existingRooms = [...home.rooms.map((r) => r.name), ...home.invalid.map((r) => path.basename(r.dir))];
  const room: Room = { name: ONBOARDING_ROOM, dir: config.home, targetRepo: target, agents: [] };
  const agent = onboardingAgent(config, target, deps.model ?? "sonnet");
  room.agents.push(agent);
  const targetRepo = toPosix(path.relative(config.home, target)) || ".";
  const task = `Propose a room for the repository ${targetRepo}.`;
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
        templatesDir: roleTemplatesDir(config.repoRoot),
        mailbox,
      }),
  });
}
