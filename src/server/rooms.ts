import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { isInside } from "./config";
import { cronError } from "./cron";
import { now, type Db } from "./db";

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
  /** Old top-down character sheet (4 by 4 cells), relative to the home: still accepted, no longer drawn. */
  sprite: spriteSchema.optional(),
  /** Isometric character sheet of the floor, relative to the home (a neutral person when left out). */
  isoSprite: spriteSchema.optional(),
  /**
   * "task": approving one of its items gives the agent a task to execute it, and wakes it
   * (the default: left out, an approval gives it no task). "queue": the task is created
   * but the agent is not woken, it finds it at its next run.
   */
  onApproval: z.enum(["task", "queue"]).optional(),
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
});

/** A CSS hex colour, `#rgb` or `#rrggbb`: the colour of a room in the interface. */
export const roomColorSchema = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "must be a hex colour like #ff3d7f");

export const roomFileSchema = z.strictObject({
  name: idSchema,
  /** Colour of the room in the interface (chat chips, floor strip, name plates). Without it the room stays neutral. */
  color: roomColorSchema.optional(),
  /** A shared studio: every room of the home may order from it (hq_message with `room`), and it delivers with hq_submit `forRoom`. */
  shared: z.boolean().optional(),
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
  /** Absolute path of the agent's old top-down sheet, always inside the home, or null. No longer drawn. */
  sprite: string | null;
  /** Absolute path of the agent's iso character sheet, always inside the home, or null for a neutral person. */
  isoSprite: string | null;
  /** "task": an approved item becomes a task for the agent, and wakes it; "queue": the task waits; null: no task (see wakeAgents). */
  onApproval: "task" | "queue" | null;
  /** A message addressed to the agent wakes it, unless "queue" (null is the default: wake, see wakeAgents). */
  onMessage: "run" | "queue" | null;
  /** A revise decision wakes the agent, unless "queue" (null is the default: wake, see wakeAgents). */
  onRevise: "run" | "queue" | null;
  /** "summary": the summary of each run that ends `done` is sent to Telegram. */
  notifyRuns: "summary" | null;
  /** Shared resources its runs hold (see launchRun); empty for most agents. */
  resources: string[];
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
      sprite,
      isoSprite,
      onApproval: agent.onApproval ?? null,
      onMessage: agent.onMessage ?? null,
      onRevise: agent.onRevise ?? null,
      notifyRuns: agent.notifyRuns ?? null,
      resources: agent.resources ?? [],
    };
  });

  return {
    name: room.name,
    dir: roomDir,
    targetRepo,
    color: room.color ?? null,
    shared: room.shared ?? false,
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
  db.transaction(() => {
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
