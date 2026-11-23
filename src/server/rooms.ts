import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ROOM_DECORS, type RoomDecor } from "../ui/floor-mode";
import { isInside } from "./config";
import { cronError } from "./cron";
import { readArchivedRooms, readHomeSettings } from "./home-settings";
import { now, type Db } from "./db";
import { resolveSkillDirs } from "./skills";
import { patternRegExp, resolveReal } from "./write-guard-lib.mjs";

/** Room and agent ids are used in paths, in the database and in messages. */
export const idSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,62}$/, "lowercase letters, digits, '-' or '_' (max 63)");

const stdioServerSchema = z.looseObject({
  type: z.literal("stdio").optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const remoteServerSchema = z.looseObject({
  type: z.enum(["http", "sse"]),
  url: z.url(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const MODELS = ["opus", "sonnet", "haiku"] as const;
export type Model = (typeof MODELS)[number];

/** Reasoning effort levels of the CLI (`claude --effort`). */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** Prompt cache durations the CLI can be asked for (CLAUDE_CODE_PROMPT_CACHE_TTL). */
export const CACHE_TTLS = ["5m", "1h"] as const;
export type CacheTtl = (typeof CACHE_TTLS)[number];

/** The motive of a run (`runs.reason`, or `routine`, `manual`): the key of `modelFor`. */
const motiveSchema = z.string().regex(/^[a-z_]{1,40}$/, "lowercase letters and underscores, 40 at most");

/** How long a prepare command may run by default, in seconds. */
export const PREPARE_TIMEOUT_SECONDS = 60;

const cronSchema = z.string().superRefine((value, ctx) => {
  const error = cronError(value);
  if (error) ctx.addIssue({ code: "custom", message: error });
});

/** One routine: a cron expression and the task given to the run it starts. */
const routineSchema = z.strictObject({
  cron: cronSchema,
  task: z.string().trim().min(1).max(20_000),
});

/** Extensions of a character sheet (docs/home-layout.md). */
export const SPRITE_EXTENSIONS = [".png", ".webp"] as const;

/** A path relative to the home, never absolute and never leaving it, ending in .png or .webp. */
const spriteSchema = z
  .string()
  .min(1)
  .refine((value) => !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value), "must be relative to the home")
  .refine(
    (value) => (SPRITE_EXTENSIONS as readonly string[]).includes(path.extname(value).toLowerCase()),
    "must be a .png or .webp file",
  );

/** `mcpServers` of an agent (room.json) or of the assistant's chat (assistant.json). */
export const mcpServersSchema = z
  .record(z.string().min(1), z.union([stdioServerSchema, remoteServerSchema]))
  .refine((servers) => !("hq" in servers), "the name 'hq' is reserved for the HQ MCP server");

/** A shared resource name: lowercase letters, digits, '-' or '_'. */
export const resourceSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, "lowercase letters, digits, '-' or '_' (max 32)");

/** `needs` of an agent: free RAM and free GPU memory one of its runs needs, in GB, at least one of them. */
export const needsSchema = z
  .strictObject({
    ramGb: z.number().positive().max(4096).optional(),
    vramGb: z.number().positive().max(1024).optional(),
  })
  .refine((needs) => needs.ramGb !== undefined || needs.vramGb !== undefined, "give ramGb, vramGb or both");

export const agentSchema = z.strictObject({
  id: idSchema,
  name: z.string().trim().min(1),
  role: z.string().min(1),
  model: z.enum(MODELS),
  allowedTools: z.array(z.string().min(1)),
  mcpServers: mcpServersSchema.optional(),
  workingDirectory: z.string().min(1).optional(),
  /** A cron expression (the routine work of the role), or several routines with a task each. */
  cron: z.union([cronSchema, z.array(routineSchema).min(1)]).optional(),
  /** Initial armed state of the routines; the database keeps later changes. */
  armed: z.boolean().optional(),
  /** Dedicated Git worktree of the target repository, relative to the home. */
  worktree: z.string().min(1).optional(),
  /** Denied to this agent on top of the global deny list. */
  disallowedTools: z.array(z.string().min(1)).optional(),
  /** Extra directories the agent may read (`--add-dir`), relative to the home. */
  addDirs: z.array(z.string().min(1)).optional(),
  /** The agent's notebook (notebook.ts): one folder it reads and writes, in runs and in questions, relative to the home or absolute. */
  notebook: z.string().trim().min(1).optional(),
  maxBudgetUsd: z.number().positive().optional(),
  /** Claude Code skill folders (each holding a SKILL.md), relative to the room directory: copied into the agent's working directory before each run. */
  skills: z.array(z.string().min(1)).min(1).max(32).optional(),
  /** Old top-down character sheet (4 by 4 cells), relative to the home: still accepted, no longer drawn. */
  sprite: spriteSchema.optional(),
  /** Isometric character sheet of the floor, relative to the home (a neutral person when left out). */
  isoSprite: spriteSchema.optional(),
  /**
   * How the agent lives on the single floor: "desk" (the default) sits at a desk of its room; "roam" has no
   * desk: during its runs it walks the corridors and the rooms and stops to sweep, otherwise it rests by the
   * broom closet of the lobby (the janitor). `always` (with "roam" only) keeps the round going between its
   * runs too.
   */
  floor: z
    .strictObject({ behaviour: z.enum(["desk", "roam"]), always: z.boolean().optional() })
    .refine((floor) => floor.always !== true || floor.behaviour === "roam", {
      message: 'always only applies to behaviour "roam"',
      path: ["always"],
    })
    .optional(),
  /**
   * "task": approving one of its items gives the agent a task to execute it, and wakes it
   * (the default: left out, an approval gives it no task). "queue": the task is created
   * but the agent is not woken, it finds it at its next run. "command": MyHQ runs `approvalCommand`
   * itself, without a model turn (see approvals.ts), and falls back to "task" when it fails.
   */
  onApproval: z.enum(["task", "queue", "command"]).optional(),
  /** A message from another agent (hq_message) wakes it at once ("run", the default); "queue": it waits for the next run. */
  onMessage: z.enum(["run", "queue"]).optional(),
  /** A revise decision wakes the agent at once ("run", the default); "queue": the revision waits for the next run. */
  onRevise: z.enum(["run", "queue"]).optional(),
  /** "summary": the final text of each run that ends well is sent to Telegram. */
  notifyRuns: z.enum(["summary"]).optional(),
  /** Shared resources the agent's runs hold (for example "gpu"): two runs holding a common one never run at once. */
  resources: z
    .array(resourceSchema)
    .max(16)
    .refine((list) => new Set(list).size === list.length, "a resource is listed twice")
    .optional(),
  /**
   * What one run of the agent takes from the machine, in GB (machine.ts): a run starts only when the machine
   * has it free on top of the home's margin and of what the runs in progress still have to take. Left out:
   * the machine is not looked at for this agent.
   */
  needs: needsSchema.optional(),
  /**
   * The supervisor of the Standard: it reads what is stuck (hq_blocked), writes to any agent of any room,
   * relaunches a stuck entry (hq_relaunch), annotates it for the owner (hq_blocked_note) and reads the items
   * of every room. MyHQ wakes it when something new is stuck (docs/architecture.md, "The supervisor").
   */
  supervisor: z.boolean().optional(),
  /**
   * Several runs at once, one per subject (docs/architecture.md, "Several benches"): the lock is one run per
   * subject, and an agent with a `worktree` gets one bench (a Git worktree on its own branch) per subject.
   * Left out or false: one run of the agent at a time, as before.
   */
  parallel: z.boolean().optional(),

  // Run options: how each run of the agent is started (see "Run options" in docs/home-layout.md).
  /** Reasoning effort of its runs, passed as `--effort`. Default: the CLI's own. */
  effort: z.enum(EFFORTS).optional(),
  /** The model of a run by its motive (`{ "message": "sonnet" }`), over `model`. */
  modelFor: z.record(motiveSchema, z.enum(MODELS)).optional(),
  /** A command run before each turn, which may skip it or add context (src/server/prepare.ts). */
  prepare: z
    .strictObject({
      /** The program and its arguments, relative to the home (cwd = the home). */
      command: z.array(z.string().min(1)).min(1),
      timeoutSeconds: z.number().positive().max(600).optional(),
    })
    .optional(),
  /** Prompt cache duration of its runs (CLAUDE_CODE_PROMPT_CACHE_TTL). Default: the CLI's own (1 hour on a subscription). */
  cacheTtl: z.enum(CACHE_TTLS).optional(),
  // --- Wakes and approvals without a model turn (docs/home-layout.md, "Waking an agent") ---
  /**
   * false: a message to this agent never goes through the portier, it wakes the agent as before
   * (the default, left out, is true: the portier decides whether a message is worth a wake).
   */
  portier: z.boolean().optional(),
  /**
   * With `onApproval: "command"`: the command MyHQ runs when one of the agent's items is approved,
   * program then arguments, relative to the home (its cwd). It reads the item as JSON on stdin.
   */
  approvalCommand: z.array(z.string().min(1).max(4_000)).min(1).max(64).optional(),
  /**
   * The piece the agent works on, shown large in the surveillance room: patterns relative to its working
   * directory (`renders/**\/*.mp4`), as the write rules take them (docs/home-layout.md, "The piece").
   */
  pieces: z
    .array(z.string().min(1).max(200).refine((pattern) => patternRegExp(pattern) !== null, "must name a place of the working directory"))
    .min(1)
    .max(8)
    .optional(),
});

/**
 * The tools of a proposed agent, as MyHQ writes them: an agent that submits
 * (hq_submit) also reads its items back (hq_items), since a revision asks it
 * to, and blocks without that tool. A list that has `mcp__hq__*` has both.
 */
export function withItemsTool(allowedTools: string[]): string[] {
  const has = (tool: string) => allowedTools.includes("mcp__hq__*") || allowedTools.includes(tool);
  return has("mcp__hq__hq_submit") && !has("mcp__hq__hq_items") ? [...allowedTools, "mcp__hq__hq_items"] : allowedTools;
}

/** A CSS hex colour, `#rgb` or `#rrggbb`: the colour of a room in the interface. */
export const roomColorSchema = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "must be a hex colour like #ff3d7f");

/** The most reference folders a room brief lists. */
export const BRIEF_REFERENCES_MAX = 16;

/** The name of a room as the owner reads it (room.json `label`); `name` stays its identifier. */
export const roomLabelSchema = z.string().trim().min(1).max(60);

export const roomFileSchema = z.strictObject({
  name: idSchema,
  /** The name shown to the owner (floor, desk, surveillance room, settings); left out, the name itself. */
  label: roomLabelSchema.optional(),
  /** Colour of the room in the interface (chat chips, floor strip, name plates). Without it the room stays neutral. */
  color: roomColorSchema.optional(),
  /** A shared studio: every room of the home may order from it (hq_message with `room`), and it delivers with hq_submit `forRoom`. */
  shared: z.boolean().optional(),
  /** The room serves clients and has orders: one folder per order in its room folder (room-folders.ts), hq_submit `order`. */
  orders: z.boolean().optional(),
  /** The logo of its project, relative to the room directory (.png, .webp or .svg): drawn on its signboard on the floor. */
  logo: z
    .string()
    .min(1)
    .refine((value) => [".png", ".webp", ".svg"].includes(path.extname(value).toLowerCase()), "must be a .png, .webp or .svg file")
    .optional(),
  /** How its suite of the single floor is furnished ("library"); left out, an office. */
  decor: z.enum(ROOM_DECORS).optional(),
  /**
   * The room's brief (docs/home-layout.md, "The room brief"): a markdown file relative to the room directory,
   * reference folders relative to the home, and the agent of the room who keeps it. MyHQ joins it to a run
   * of a shared room that works for this room (runner.ts, runFolders).
   */
  brief: z
    .strictObject({
      file: z
        .string()
        .min(1)
        .refine((value) => path.extname(value).toLowerCase() === ".md", "must be a .md file"),
      references: z.array(z.string().min(1)).max(BRIEF_REFERENCES_MAX).optional(),
      keeper: idSchema.optional(),
    })
    .optional(),
  targetRepo: z.string().min(1),
  agents: z.array(agentSchema).min(1),
});

export type RoomFile = z.infer<typeof roomFileSchema>;
export type McpServerConfig = z.infer<typeof stdioServerSchema> | z.infer<typeof remoteServerSchema>;

export type Agent = {
  id: string;
  name: string;
  model: Model;
  allowedTools: string[];
  mcpServers: Record<string, McpServerConfig>;
  /** Absolute path of the role prompt. */
  rolePath: string;
  /** Absolute path of the working directory, always inside the home. */
  workDir: string;
  /** Scheduled routines; `task` null means the routine work of the role. */
  routines: Routine[];
  /** Armed state given by room.json (the database may override it). */
  armed: boolean;
  /** Absolute path of the agent's Git worktree (its working directory), or null. */
  worktree: string | null;
  /** The agent's own deny list, merged with the global one at run time. */
  disallowedTools: string[];
  /** Absolute paths passed as `--add-dir`. */
  addDirs: string[];
  /** Absolute path of its notebook, the one folder outside its working directory it writes (notebook.ts); null or absent: none. */
  notebook?: string | null;
  /** Built-in tools that exist for the agent when they differ from its whitelist (MyHQ's own agents only). */
  tools?: string[];
  maxBudgetUsd: number | null;
  /** Absolute paths of the skill folders copied into the working directory before each run (see skills.ts). */
  skills?: string[];
  /** Absolute path of the agent's old top-down sheet, always inside the home, or null. No longer drawn. */
  sprite: string | null;
  /** Absolute path of the agent's iso character sheet, always inside the home, or null for a neutral person. */
  isoSprite: string | null;
  /** It roams the single floor instead of sitting at a desk (room.json `floor.behaviour: "roam"`); false for most agents. */
  roam?: boolean;
  /** Its round goes on between its runs too (room.json `floor.always`, with `behaviour: "roam"`). */
  roamAlways?: boolean;
  /**
   * "task": an approved item becomes a task for the agent, and wakes it; "queue": the task waits; "command":
   * MyHQ runs `approvalCommand` (see approvals.ts); null: no task (see wakeAgents).
   */
  onApproval: "task" | "queue" | "command" | null;
  /** A message addressed to the agent wakes it, unless "queue" (null is the default: wake, see wakeAgents). */
  onMessage: "run" | "queue" | null;
  /** A revise decision wakes the agent, unless "queue" (null is the default: wake, see wakeAgents). */
  onRevise: "run" | "queue" | null;
  /** "summary": the summary of each run that ends `done` is sent to Telegram. */
  notifyRuns: "summary" | null;
  /** Shared resources its runs hold (see launchRun); empty for most agents. */
  resources: string[];
  /** What one of its runs takes from the machine, in GB (machine.ts); null or absent: not gated by the machine. */
  needs?: { ramGb: number | null; vramGb: number | null } | null;
  /** The supervisor of the Standard (see supervisor.ts); false for most agents. */
  supervisor?: boolean;
  /** Several runs at once, one per subject (room.json `parallel`, benches.ts); false or absent: one run at a time. */
  parallel?: boolean;
  // Run options (room.json), absent for MyHQ's own agents.
  /** `--effort` of its runs, or null for the CLI's default. */
  effort?: Effort | null;
  /** The model of a run by its motive, over `model`. */
  modelFor?: Partial<Record<string, Model>>;
  /** The command run before each turn (prepare.ts), its arguments relative to the home. */
  prepare?: { command: string[]; timeoutMs: number } | null;
  /** Prompt cache duration of its runs, or null for the CLI's default. */
  cacheTtl?: CacheTtl | null;
  /** false: its messages skip the portier (see portier.ts); left out, true. */
  portier?: boolean;
  /** The command of `onApproval: "command"`, relative to the home; null otherwise. */
  approvalCommand?: string[] | null;
  /** Patterns of its piece, relative to its working directory (room.json `pieces`); empty: no piece followed. */
  pieces: string[];
};

export type Routine = { cron: string; task: string | null };

export type Room = {
  name: string;
  /** The name shown to the owner (room.json `label`), or null to show `name`. */
  label?: string | null;
  dir: string;
  /** Absolute path of the target repository. */
  targetRepo: string;
  /** Hex colour of the room in the interface, or null for the neutral look. */
  color: string | null;
  /** A shared studio that every room may order from. */
  shared: boolean;
  /** It serves clients and has orders (room.json `orders`); left out, false. */
  orders?: boolean;
  /** Absolute path of the logo of its project, always inside the room directory, or null. */
  logo?: string | null;
  /** How its suite of the single floor is furnished (room.json `decor`), or null for an office. */
  decor?: RoomDecor | null;
  /** Its brief (room.json `brief`): absolute paths, the keeper an agent id of the room; null or absent: none. */
  brief?: RoomBrief | null;
  agents: Agent[];
};

export type RoomBrief = {
  /** Absolute path of the brief file, inside the room directory (real path included). */
  file: string;
  /** Absolute paths of its reference folders, as declared (they may not exist yet). */
  references: string[];
  /** The id of the agent of the room who keeps it, or null. */
  keeper: string | null;
};

/** Why a project room shows as without a brief: none declared, an empty file, a file that cannot be read now. */
export type BriefNotice = "none" | "empty" | "missing";

/**
 * Whether a room should show that it has no brief to give a studio (an
 * information, the room works as before), read now. Null for a shared room:
 * it serves the others, its brief would reach no one; null for the
 * supervisor's room (an agent with `supervisor: true`): no studio works for
 * it; null too for a brief with text.
 */
export function briefNotice(room: Room): BriefNotice | null {
  if (room.shared || room.agents.some((agent) => agent.supervisor)) return null;
  if (!room.brief) return "none";
  try {
    return fs.readFileSync(room.brief.file, "utf8").trim() === "" ? "empty" : null;
  } catch {
    return "missing";
  }
}

export type InvalidRoom = { dir: string; error: string };

/** A valid room the owner archived (myhq.json `archivedRooms`): kept on disk, out of the floor and the scheduler. */
export type ArchivedRoom = { room: Room; archivedAt: string };

export type Home = {
  root: string;
  rooms: Room[];
  invalid: InvalidRoom[];
  /** The archived rooms, left out of `rooms` (and so of everything that reads them). */
  archived?: ArchivedRoom[];
};

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
}

const READ_TOOLS = new Set(["Read", "Glob", "Grep"]);

/**
 * An agent that reads files but has no worktree may read the target
 * repository by default (it runs in its own directory of the home).
 */
function defaultAddDirs(agent: RoomFile["agents"][number], targetRepo: string): string[] {
  if (agent.worktree) return [];
  const reads = agent.allowedTools.some((tool) => READ_TOOLS.has(tool.replace(/\(.*$/, "").trim()));
  return reads ? [targetRepo] : [];
}

const overlaps = (a: string, b: string): boolean => isInside(a, b) || isInside(b, a);

/**
 * What is wrong with the notebooks of these agents, or null. A notebook is
 * writable in a question too, where the working directory is not
 * (agent-questions.ts), so it may overlap no working directory (its agent's
 * or another's), no other notebook (`others`: those of the rooms already
 * loaded), nor the home's `rooms/`, `data/` and `assistant/` folders (the
 * roles, the room.json files, the database, the assistant's prompts), nor
 * hold the home (its config files), nor overlap the application's repository
 * (the working directory of the process, as config.ts takes it) unless it
 * sits inside the home. Every path is compared by its real path (links and
 * junctions resolved, the deepest existing part through realpath), as the
 * write guard resolves the writes.
 */
function notebookError(home: string, agents: readonly Agent[], others: readonly { owner: string; dir: string }[] = []): string | null {
  const taken = [...others];
  const real = (dir: string): string => resolveReal(path.resolve(dir)) as string;
  for (const agent of agents) {
    if (!agent.notebook) continue;
    let dir: string;
    try {
      dir = real(agent.notebook);
    } catch (error) {
      return `notebook of "${agent.id}": ${(error as Error).message}`;
    }
    const workDir = agents.find((each) => overlaps(dir, real(each.workDir)));
    if (workDir) return `notebook of "${agent.id}" must not be, hold or sit inside the working directory of "${workDir.id}"`;
    const realHome = real(home);
    for (const folder of ["rooms", "data", "assistant"]) {
      if (overlaps(dir, real(path.join(home, folder)))) return `notebook of "${agent.id}" must not overlap the ${folder}/ folder of the home`;
    }
    if (isInside(dir, realHome)) return `notebook of "${agent.id}" must not be or hold the home`;
    if (overlaps(dir, real(process.cwd())) && !isInside(realHome, dir)) {
      return `notebook of "${agent.id}" must not overlap the repository of MyHQ`;
    }
    const other = taken.find((each) => overlaps(dir, real(each.dir)));
    if (other) return `notebook of "${agent.id}" overlaps the notebook of ${other.owner}`;
    taken.push({ owner: `"${agent.id}"`, dir });
  }
  return null;
}

/**
 * The drop folder of assistant.json (`dropDir`, absolute), null without one.
 * Read here rather than through loadAssistantConfig: src/assistant/home-config.ts
 * imports this module at load time. Throws when the file is invalid (fail closed).
 */
function readDropDir(home: string): string | null {
  const file = path.join(home, "assistant.json");
  if (!fs.existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  const parsed = z.looseObject({ dropDir: z.string().trim().min(1).optional() }).safeParse(raw);
  if (!parsed.success) throw new Error(`${file}: ${formatZodError(parsed.error)}`);
  return parsed.data.dropDir ? path.resolve(home, parsed.data.dropDir) : null;
}

/**
 * The brief of a room, checked: its file inside the room directory (by its
 * real path too) and present, its keeper an agent of the room, and no
 * reference that overlaps, by real path, the home's `data/`, `assistant/` or
 * `rooms/` folders, the root of the room folders or the drop folder of
 * assistant.json. A reference missing on disk is allowed (the run skips it).
 * Throws an explicit Error.
 */
function roomBrief(home: string, roomDir: string, brief: NonNullable<RoomFile["brief"]>, agents: readonly Agent[]): RoomBrief {
  const file = path.resolve(roomDir, brief.file);
  if (!isInside(roomDir, file)) throw new Error("brief file must stay inside the room directory");
  if (!fs.existsSync(file)) throw new Error(`brief file not found (${brief.file})`);
  const real = (dir: string): string => resolveReal(path.resolve(dir)) as string;
  if (!isInside(real(roomDir), real(file))) throw new Error("brief file must stay inside the room directory");
  if (brief.keeper !== undefined && !agents.some((agent) => agent.id === brief.keeper)) {
    throw new Error(`brief keeper "${brief.keeper}" is no agent of the room`);
  }
  const references = (brief.references ?? []).map((dir) => path.resolve(home, dir));
  if (references.length > 0) {
    // The root of the room folders, as room-folders.ts takes it (roomFoldersRoot, not imported: it imports this module).
    const closed: { name: string; dir: string }[] = [
      ...["data", "assistant", "rooms"].map((folder) => ({ name: `the ${folder}/ folder of the home`, dir: path.join(home, folder) })),
      { name: "the room folders", dir: path.resolve(home, readHomeSettings(home)?.folders?.dir ?? "folders") },
    ];
    const drop = readDropDir(home);
    if (drop) closed.push({ name: "the drop folder of assistant.json", dir: drop });
    for (const [index, dir] of references.entries()) {
      let reference: string;
      try {
        reference = real(dir);
      } catch (error) {
        throw new Error(`brief reference "${brief.references![index]}": ${(error as Error).message}`);
      }
      const hit = closed.find((each) => overlaps(reference, real(each.dir)));
      if (hit) throw new Error(`brief reference "${brief.references![index]}" must not overlap ${hit.name}`);
    }
  }
  return { file, references, keeper: brief.keeper ?? null };
}

/** Loads and validates one room directory. Throws an explicit Error when invalid. */
export function loadRoom(home: string, roomDir: string): Room {
  const file = path.join(roomDir, "room.json");
  if (!fs.existsSync(file)) throw new Error(`missing ${file}`);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  const parsed = roomFileSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${file}: ${formatZodError(parsed.error)}`);
  const room = parsed.data;

  const folder = path.basename(roomDir);
  if (room.name !== folder) {
    throw new Error(`${file}: name "${room.name}" must match its folder name "${folder}"`);
  }

  const targetRepo = path.resolve(home, room.targetRepo);
  const seen = new Set<string>();
  const agents = room.agents.map((agent): Agent => {
    if (seen.has(agent.id)) throw new Error(`${file}: duplicate agent id "${agent.id}"`);
    seen.add(agent.id);

    const rolePath = path.resolve(roomDir, agent.role);
    if (!isInside(roomDir, rolePath)) {
      throw new Error(`${file}: role of "${agent.id}" must stay inside the room directory`);
    }
    if (!fs.existsSync(rolePath)) {
      throw new Error(`${file}: role file of "${agent.id}" not found (${agent.role})`);
    }

    const worktree = agent.worktree ? path.resolve(home, agent.worktree) : null;
    if (worktree && !isInside(home, worktree)) {
      throw new Error(`${file}: worktree of "${agent.id}" must stay inside the home`);
    }
    const workDir = path.resolve(
      home,
      agent.workingDirectory ?? agent.worktree ?? path.join("data", "work", room.name, agent.id),
    );
    if (!isInside(home, workDir)) {
      throw new Error(`${file}: workingDirectory of "${agent.id}" must stay inside the home`);
    }
    if (worktree && workDir !== worktree) {
      throw new Error(`${file}: "${agent.id}" works in its worktree: workingDirectory must be left out or equal to it`);
    }

    const sprite = agent.sprite ? path.resolve(home, agent.sprite) : null;
    if (sprite && !isInside(home, sprite)) {
      throw new Error(`${file}: sprite of "${agent.id}" must stay inside the home`);
    }
    const isoSprite = agent.isoSprite ? path.resolve(home, agent.isoSprite) : null;
    if (isoSprite && !isInside(home, isoSprite)) {
      throw new Error(`${file}: isoSprite of "${agent.id}" must stay inside the home`);
    }

    if (agent.onApproval === "command" && !agent.approvalCommand) {
      throw new Error(`${file}: "${agent.id}" has onApproval "command": approvalCommand is required`);
    }

    let skills: string[];
    try {
      skills = resolveSkillDirs(roomDir, agent.id, agent.skills ?? []);
    } catch (error) {
      throw new Error(`${file}: ${(error as Error).message}`);
    }

    return {
      id: agent.id,
      name: agent.name,
      model: agent.model,
      allowedTools: agent.allowedTools,
      mcpServers: agent.mcpServers ?? {},
      rolePath,
      workDir,
      routines:
        agent.cron === undefined
          ? []
          : typeof agent.cron === "string"
            ? [{ cron: agent.cron, task: null }]
            : agent.cron.map((r) => ({ cron: r.cron, task: r.task })),
      armed: agent.armed ?? false,
      worktree,
      disallowedTools: agent.disallowedTools ?? [],
      addDirs: (agent.addDirs ?? defaultAddDirs(agent, targetRepo)).map((dir) => path.resolve(home, dir)),
      notebook: agent.notebook ? path.resolve(home, agent.notebook) : null,
      maxBudgetUsd: agent.maxBudgetUsd ?? null,
      skills,
      sprite,
      isoSprite,
      roam: agent.floor?.behaviour === "roam",
      roamAlways: agent.floor?.behaviour === "roam" && agent.floor.always === true,
      onApproval: agent.onApproval ?? null,
      onMessage: agent.onMessage ?? null,
      onRevise: agent.onRevise ?? null,
      notifyRuns: agent.notifyRuns ?? null,
      resources: agent.resources ?? [],
      needs: agent.needs ? { ramGb: agent.needs.ramGb ?? null, vramGb: agent.needs.vramGb ?? null } : null,
      supervisor: agent.supervisor ?? false,
      parallel: agent.parallel ?? false,
      effort: agent.effort ?? null,
      modelFor: agent.modelFor ?? {},
      prepare: agent.prepare
        ? { command: agent.prepare.command, timeoutMs: (agent.prepare.timeoutSeconds ?? PREPARE_TIMEOUT_SECONDS) * 1000 }
        : null,
      cacheTtl: agent.cacheTtl ?? null,
      portier: agent.portier ?? true,
      approvalCommand: agent.approvalCommand ?? null,
      pieces: agent.pieces ?? [],
    };
  });

  const notebook = notebookError(home, agents);
  if (notebook) throw new Error(`${file}: ${notebook}`);

  const logo = room.logo ? path.resolve(roomDir, room.logo) : null;
  if (logo && !isInside(roomDir, logo)) throw new Error(`${file}: logo must stay inside the room directory`);

  let brief: RoomBrief | null = null;
  if (room.brief) {
    try {
      brief = roomBrief(home, roomDir, room.brief, agents);
    } catch (error) {
      throw new Error(`${file}: ${(error as Error).message}`);
    }
  }

  return {
    name: room.name,
    label: room.label ?? null,
    dir: roomDir,
    targetRepo,
    color: room.color ?? null,
    shared: room.shared ?? false,
    orders: room.orders ?? false,
    logo,
    decor: room.decor ?? null,
    brief,
    agents,
  };
}

/**
 * Loads every room of the home. An invalid room does not stop the others: it
 * is reported in `invalid` with an explicit error, and cannot be run. A valid
 * room named in `archivedRooms` of myhq.json goes to `archived` instead of
 * `rooms`: nothing of it starts, nothing of it is shown as a room.
 */
export function loadHome(home: string): Home {
  const roomsDir = path.join(home, "rooms");
  const archivedAt = new Map(readArchivedRooms(home).rooms.map((entry) => [entry.name, entry.at]));
  const result: Home = { root: home, rooms: [], invalid: [], archived: [] };
  if (!fs.existsSync(roomsDir)) return result;
  const dirs = fs
    .readdirSync(roomsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(roomsDir, entry.name))
    .sort();
  const notebooks: { owner: string; dir: string }[] = [];
  for (const dir of dirs) {
    try {
      const room = loadRoom(home, dir);
      // Two rooms may not share a notebook either: the later room is the invalid one.
      const shared = notebookError(home, room.agents, notebooks);
      if (shared) throw new Error(`${path.join(dir, "room.json")}: ${shared}`);
      for (const agent of room.agents) if (agent.notebook) notebooks.push({ owner: `"${room.name}/${agent.id}"`, dir: agent.notebook });
      const at = archivedAt.get(room.name);
      if (at === undefined) result.rooms.push(room);
      else result.archived!.push({ room, archivedAt: at });
    } catch (error) {
      result.invalid.push({ dir, error: (error as Error).message });
    }
  }
  return result;
}

/** Home-relative paths are stored with forward slashes on every OS. */
export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** Mirrors the valid rooms and agents into the database. */
export function syncHome(db: Db, home: Home): void {
  const at = now();
  const upsertRoom = db.prepare(
    `INSERT INTO rooms (name, target_repo, shared, orders, brief_keeper, synced_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET target_repo = excluded.target_repo, shared = excluded.shared,
       orders = excluded.orders, brief_keeper = excluded.brief_keeper, synced_at = excluded.synced_at`,
  );
  const upsertAgent = db.prepare(
    `INSERT INTO agents (room, id, name, model, role_path, synced_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (room, id) DO UPDATE SET name = excluded.name, model = excluded.model,
       role_path = excluded.role_path, synced_at = excluded.synced_at`,
  );
  const removeStaleAgents = db.prepare("DELETE FROM agents WHERE room = ? AND synced_at <> ?");
  const archive = db.prepare("INSERT OR REPLACE INTO archived_rooms (name, archived_at) VALUES (?, ?)");
  const addSupervisor = db.prepare("INSERT INTO supervisors (room, agent_id, synced_at) VALUES (?, ?, ?)");
  db.transaction(() => {
    // The archived rooms, as myhq.json says now: their items leave the lists (db.ts, liveItem).
    if (home.archived !== undefined) {
      db.prepare("DELETE FROM archived_rooms").run();
      for (const entry of home.archived) archive.run(entry.room.name, entry.archivedAt);
    }
    // The supervisors of the Standard, as room.json says now (see supervisor.ts).
    db.prepare("DELETE FROM supervisors").run();
    for (const room of home.rooms) for (const agent of room.agents) if (agent.supervisor) addSupervisor.run(room.name, agent.id, at);
    for (const room of home.rooms) {
      upsertRoom.run(
        room.name,
        toPosix(path.relative(home.root, room.targetRepo)),
        room.shared ? 1 : 0,
        room.orders ? 1 : 0,
        room.brief?.keeper ?? null,
        at,
      );
      for (const agent of room.agents) {
        upsertAgent.run(
          room.name,
          agent.id,
          agent.name,
          agent.model,
          toPosix(path.relative(home.root, agent.rolePath)),
          at,
        );
      }
      removeStaleAgents.run(room.name, at);
    }
  })();
}
