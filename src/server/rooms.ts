import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ROOM_DECORS, type RoomDecor } from "../ui/floor-mode";
import { isInside } from "./config";
import { cronError } from "./cron";
import { now, type Db } from "./db";
import { resolveSkillDirs } from "./skills";

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
   * The supervisor of the Standard: it reads what is stuck (hq_blocked), writes to any agent of any room,
   * relaunches a stuck entry (hq_relaunch), annotates it for the owner (hq_blocked_note) and reads the items
   * of every room. MyHQ wakes it when something new is stuck (docs/architecture.md, "The supervisor").
   */
  supervisor: z.boolean().optional(),

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
});

/** A CSS hex colour, `#rgb` or `#rrggbb`: the colour of a room in the interface. */
export const roomColorSchema = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "must be a hex colour like #ff3d7f");

export const roomFileSchema = z.strictObject({
  name: idSchema,
  /** Colour of the room in the interface (chat chips, floor strip, name plates). Without it the room stays neutral. */
  color: roomColorSchema.optional(),
  /** A shared studio: every room of the home may order from it (hq_message with `room`), and it delivers with hq_submit `forRoom`. */
  shared: z.boolean().optional(),
  /** The logo of its project, relative to the room directory (.png, .webp or .svg): drawn on its signboard on the floor. */
  logo: z
    .string()
    .min(1)
    .refine((value) => [".png", ".webp", ".svg"].includes(path.extname(value).toLowerCase()), "must be a .png, .webp or .svg file")
    .optional(),
  /** How its suite of the single floor is furnished ("library"); left out, an office. */
  decor: z.enum(ROOM_DECORS).optional(),
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
  /** The supervisor of the Standard (see supervisor.ts); false for most agents. */
  supervisor?: boolean;
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
};

export type Routine = { cron: string; task: string | null };

export type Room = {
  name: string;
  dir: string;
  /** Absolute path of the target repository. */
  targetRepo: string;
  /** Hex colour of the room in the interface, or null for the neutral look. */
  color: string | null;
  /** A shared studio that every room may order from. */
  shared: boolean;
  /** Absolute path of the logo of its project, always inside the room directory, or null. */
  logo?: string | null;
  /** How its suite of the single floor is furnished (room.json `decor`), or null for an office. */
  decor?: RoomDecor | null;
  agents: Agent[];
};

export type InvalidRoom = { dir: string; error: string };

export type Home = { root: string; rooms: Room[]; invalid: InvalidRoom[] };

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
      supervisor: agent.supervisor ?? false,
      effort: agent.effort ?? null,
      modelFor: agent.modelFor ?? {},
      prepare: agent.prepare
        ? { command: agent.prepare.command, timeoutMs: (agent.prepare.timeoutSeconds ?? PREPARE_TIMEOUT_SECONDS) * 1000 }
        : null,
      cacheTtl: agent.cacheTtl ?? null,
      portier: agent.portier ?? true,
      approvalCommand: agent.approvalCommand ?? null,
    };
  });

  const logo = room.logo ? path.resolve(roomDir, room.logo) : null;
  if (logo && !isInside(roomDir, logo)) throw new Error(`${file}: logo must stay inside the room directory`);

  return {
    name: room.name,
    dir: roomDir,
    targetRepo,
    color: room.color ?? null,
    shared: room.shared ?? false,
    logo,
    decor: room.decor ?? null,
    agents,
  };
}

/**
 * Loads every room of the home. An invalid room does not stop the others: it
 * is reported in `invalid` with an explicit error, and cannot be run.
 */
export function loadHome(home: string): Home {
  const roomsDir = path.join(home, "rooms");
  const result: Home = { root: home, rooms: [], invalid: [] };
  if (!fs.existsSync(roomsDir)) return result;
  const dirs = fs
    .readdirSync(roomsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(roomsDir, entry.name))
    .sort();
  for (const dir of dirs) {
    try {
      result.rooms.push(loadRoom(home, dir));
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
    `INSERT INTO rooms (name, target_repo, shared, synced_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET target_repo = excluded.target_repo, shared = excluded.shared,
       synced_at = excluded.synced_at`,
  );
  const upsertAgent = db.prepare(
    `INSERT INTO agents (room, id, name, model, role_path, synced_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (room, id) DO UPDATE SET name = excluded.name, model = excluded.model,
       role_path = excluded.role_path, synced_at = excluded.synced_at`,
  );
  const removeStaleAgents = db.prepare("DELETE FROM agents WHERE room = ? AND synced_at <> ?");
  const addSupervisor = db.prepare("INSERT INTO supervisors (room, agent_id, synced_at) VALUES (?, ?, ?)");
  db.transaction(() => {
    // The supervisors of the Standard, as room.json says now (see supervisor.ts).
    db.prepare("DELETE FROM supervisors").run();
    for (const room of home.rooms) for (const agent of room.agents) if (agent.supervisor) addSupervisor.run(room.name, agent.id, at);
    for (const room of home.rooms) {
      upsertRoom.run(room.name, toPosix(path.relative(home.root, room.targetRepo)), room.shared ? 1 : 0, at);
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
