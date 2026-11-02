import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { isInside } from "./config";
import { now, type Db } from "./db";

/** Room and agent ids are used in paths, in the database and in messages. */
const idSchema = z
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

const agentSchema = z.strictObject({
  id: idSchema,
  name: z.string().trim().min(1),
  role: z.string().min(1),
  model: z.enum(MODELS),
  allowedTools: z.array(z.string().min(1)),
  mcpServers: z
    .record(z.string().min(1), z.union([stdioServerSchema, remoteServerSchema]))
    .refine((servers) => !("hq" in servers), "the name 'hq' is reserved for the HQ MCP server")
    .optional(),
  workingDirectory: z.string().min(1).optional(),
  cron: z
    .string()
    .regex(/^\S+(\s+\S+){4}$/, "a cron expression has five fields")
    .optional(),
  maxBudgetUsd: z.number().positive().optional(),
});

export const roomFileSchema = z.strictObject({
  name: idSchema,
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
  cron: string | null;
  maxBudgetUsd: number | null;
};

export type Room = {
  name: string;
  dir: string;
  /** Absolute path of the target repository. */
  targetRepo: string;
  agents: Agent[];
};

export type InvalidRoom = { dir: string; error: string };

export type Home = { root: string; rooms: Room[]; invalid: InvalidRoom[] };

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
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

    const workDir = path.resolve(
      home,
      agent.workingDirectory ?? path.join("data", "work", room.name, agent.id),
    );
    if (!isInside(home, workDir)) {
      throw new Error(`${file}: workingDirectory of "${agent.id}" must stay inside the home`);
    }

    return {
      id: agent.id,
      name: agent.name,
      model: agent.model,
      allowedTools: agent.allowedTools,
      mcpServers: agent.mcpServers ?? {},
      rolePath,
      workDir,
      cron: agent.cron ?? null,
      maxBudgetUsd: agent.maxBudgetUsd ?? null,
    };
  });

  return {
    name: room.name,
    dir: roomDir,
    targetRepo: path.resolve(home, room.targetRepo),
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
    `INSERT INTO rooms (name, target_repo, synced_at) VALUES (?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET target_repo = excluded.target_repo, synced_at = excluded.synced_at`,
  );
  const upsertAgent = db.prepare(
    `INSERT INTO agents (room, id, name, model, role_path, synced_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (room, id) DO UPDATE SET name = excluded.name, model = excluded.model,
       role_path = excluded.role_path, synced_at = excluded.synced_at`,
  );
  const removeStaleAgents = db.prepare("DELETE FROM agents WHERE room = ? AND synced_at <> ?");
  db.transaction(() => {
    for (const room of home.rooms) {
      upsertRoom.run(room.name, toPosix(path.relative(home.root, room.targetRepo)), at);
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
