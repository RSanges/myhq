import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { liveConfig, type HqConfig } from "../server/config";
import { now, type Db, type RunRow } from "../server/db";
import { HqError } from "../server/errors";
import { resourceHolder } from "../server/resources";
import { findAgent, reasonSchema, startRun as defaultStartRun, WAKE_TASK, WAITS, type StartRunRequest } from "../server/runner";

/** Run reason when a request does not give one. */
export const CHAT_REASON = "chat";

/** One request file written by the chat (`chat.requests.dir` of assistant.json). */
const requestSchema = z.strictObject({
  room: z.string().min(1),
  agent: z.string().min(1),
  task: z.string().trim().min(1).max(20_000),
  reason: reasonSchema.optional(),
});

export const REJECTED_DIR = "rejected";

/** Why the run of a request did not start: the task waits. */
export type WaitCause = "cap" | "busy" | "resource";

/** A request whose task was created but whose run could not start now. */
export type WaitingRequest = {
  taskId: number;
  room: string;
  agentId: string;
  agentName: string;
  cause: WaitCause;
  /** The daily cap, for `cap`. */
  cap?: number;
  /** The shared resource another run holds, for `resource`. */
  resource?: string;
};

export type RequestsDeps = {
  config: HqConfig;
  db: Db;
  startRun?: (request: StartRunRequest) => RunRow;
  log: (message: string) => void;
  /** Called for each request whose task waits (busy agent, busy resource, daily cap), so that the caller can say so. */
  onWait?: (waiting: WaitingRequest) => void;
};

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What the wait of a request is made of, read from the error that refused its start. */
function waitingOf(deps: RequestsDeps, taskId: number, request: { room: string; agent: string }, error: HqError): WaitingRequest {
  const { agent } = findAgent(deps.config, request.room, request.agent);
  const base = { taskId, room: request.room, agentId: agent.id, agentName: agent.name };
  if (error.code === "DAILY_CAP_REACHED") return { ...base, cause: "cap", cap: liveConfig(deps.config).maxRunsPerDay };
  if (error.code === "RESOURCE_BUSY") {
    const holder = resourceHolder(deps.db, agent.resources);
    return { ...base, cause: "resource", ...(holder ? { resource: holder.resource } : {}) };
  }
  return { ...base, cause: "busy" };
}

/** `name`, or `base (2).ext`... so that a rejected file never overwrites another. */
function freeName(dir: string, name: string): string {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let n = 2; fs.existsSync(path.join(dir, candidate)); n++) candidate = `${base} (${n})${ext}`;
  return candidate;
}

/** Checks the file and the agent it names; throws with the reason when it cannot be honored. */
function readRequest(config: HqConfig, file: string): z.infer<typeof requestSchema> {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`not valid JSON: ${describe(error)}`);
  }
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues
        .map((issue) => `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`)
        .join("; "),
    );
  }
  findAgent(config, parsed.data.room, parsed.data.agent);
  return parsed.data;
}

/**
 * Hands the chat's requests to the agents. Each `*.json` file of `dir` holds
 * `{ room, agent, task, reason? }`: MyHQ creates a pending task for that agent
 * with the text, starts a run at once (reason `chat`, or the given one) that
 * takes it from the mailbox, then deletes the file. A busy agent, a busy
 * resource or the daily cap leave the task for the agent's next run, and
 * `onWait` is told so (the chat then says it to the owner). A file that cannot be read,
 * does not match the shape or names an unknown agent is logged and moved to
 * `<dir>/rejected/`. Never throws. Returns the number of tasks created.
 */
export function processChatRequests(dir: string, deps: RequestsDeps): number {
  let names: string[];
  try {
    names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return 0;
  }
  const start = deps.startRun ?? ((request: StartRunRequest) => defaultStartRun(request, { config: deps.config }));
  let created = 0;
  for (const name of names) {
    const file = path.join(dir, name);
    let request: z.infer<typeof requestSchema>;
    try {
      request = readRequest(deps.config, file);
    } catch (error) {
      const reason = error instanceof HqError ? error.message : describe(error);
      deps.log(`chat request ${name} rejected: ${reason}`);
      try {
        const rejected = path.join(dir, REJECTED_DIR);
        fs.mkdirSync(rejected, { recursive: true });
        fs.renameSync(file, path.join(rejected, freeName(rejected, name)));
      } catch (moveError) {
        deps.log(`chat request ${name} not moved to ${REJECTED_DIR}/: ${describe(moveError)}`);
      }
      continue;
    }
    const at = now();
    const taskId = Number(
      deps.db
        .prepare(
          `INSERT INTO tasks (room, agent_id, source, text, status, created_at, updated_at)
           VALUES (?, ?, 'chat', ?, 'pending', ?, ?)`,
        )
        .run(request.room, request.agent, request.task, at, at).lastInsertRowid,
    );
    created++;
    try {
      fs.rmSync(file, { force: true });
    } catch (error) {
      deps.log(`chat request ${name} handled but not deleted: ${describe(error)}`);
    }
    try {
      const run = start({
        room: request.room,
        agent: request.agent,
        task: WAKE_TASK,
        reason: request.reason ?? CHAT_REASON,
      });
      deps.log(`chat request ${name}: task #${taskId} for ${request.room}/${request.agent}, run #${run.id} started`);
    } catch (error) {
      const waits = error instanceof HqError && WAITS.has(error.code);
      if (waits) {
        try {
          deps.onWait?.(waitingOf(deps, taskId, request, error));
        } catch (waitError) {
          deps.log(`chat request ${name}: wait not reported: ${describe(waitError)}`);
        }
      }
      deps.log(
        `chat request ${name}: task #${taskId} for ${request.room}/${request.agent} ${
          waits ? "waits for the agent's next run" : "created, run not started"
        } (${describe(error)})`,
      );
    }
  }
  return created;
}
