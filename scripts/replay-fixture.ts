/**
 * `npx tsx scripts/replay-fixture.ts <fixture.jsonl>`: plays a recorded run
 * into a throwaway home, one event per second, so that the real SSE stream of
 * a MyHQ pointed at that home animates the room view (/room) without a real
 * run and without spending anything.
 *
 * It creates (or reuses) a demo home with a neutral room of three agents,
 * inserts a run for one of them, then stores the events of the fixture one at
 * a time the way the runner does, plus what the HQ MCP server would have
 * written: an approval when `hq_submit` answers, a message when `hq_message`
 * answers. The run is closed on the `end` event with its status, summary and
 * cost. Nothing here starts `claude`, and a home that this script did not
 * create is refused, so the real home is never touched.
 *
 *   npx tsx scripts/replay-fixture.ts test/fixtures/stream-json-onboarding.jsonl
 *   MYHQ_HOME=<printed home> HQ_TELEGRAM_POLLING=false npm run dev -- -p 4343
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseStreamLine } from "../src/server/claude-engine";
import { now, openDb, type Db } from "../src/server/db";
import type { RunEvent } from "../src/server/engine";
import { loadHome, syncHome } from "../src/server/rooms";
import { strings } from "../src/ui/strings";

const t = strings.replay;

/** Marks a home as made by this script. */
const MARKER = ".myhq-replay-home";
const ROOM = "demo";

const baseAgents: { id: string; name: string; cron?: string; armed: boolean }[] = [
  { id: "scout", name: "Scout", cron: "0 7 * * 1-5", armed: true },
  { id: "writer", name: "Writer", armed: false },
  { id: "analyst", name: "Analyst", cron: "0 17 * * 5", armed: true },
];

/** The demo agents: the three named ones, then generic ones when the floor should be bigger. */
function demoAgents(count: number) {
  return Array.from({ length: count }, (_, index) => baseAgents[index] ?? { id: `agent${index + 1}`, name: `Agent ${index + 1}`, armed: false });
}

/** Writes the demo room unless the home already has it (or when a number of agents is asked for). */
function ensureDemoHome(home: string, agents: ReturnType<typeof demoAgents>, force: boolean): void {
  const marker = path.join(home, MARKER);
  if (fs.existsSync(home) && fs.readdirSync(home).length > 0 && !fs.existsSync(marker)) {
    throw new Error(t.notAReplayHome(home));
  }
  fs.mkdirSync(path.join(home, "rooms", ROOM, "roles"), { recursive: true });
  fs.writeFileSync(marker, "Created by scripts/replay-fixture.ts. Safe to delete.\n");
  const roomFile = path.join(home, "rooms", ROOM, "room.json");
  if (fs.existsSync(roomFile) && !force) return;
  for (const agent of agents) {
    fs.writeFileSync(
      path.join(home, "rooms", ROOM, "roles", `${agent.id}.md`),
      `You are ${agent.name}, a demonstration agent. Nothing here ever runs.\n`,
    );
  }
  fs.writeFileSync(
    roomFile,
    JSON.stringify(
      {
        name: ROOM,
        targetRepo: "../demo-project",
        agents: agents.map((agent) => ({
          id: agent.id,
          name: agent.name,
          role: `roles/${agent.id}.md`,
          model: "haiku",
          allowedTools: ["WebSearch", "mcp__hq__*"],
          ...(agent.cron ? { cron: agent.cron } : {}),
          armed: agent.armed,
        })),
      },
      null,
      2,
    ),
  );
}

type Options = { fixture: string; home: string; agent: string; intervalMs: number; delayS: number; agents: number | null };

function parseArgs(argv: string[]): Options | null {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) flags.set(arg.slice(2), argv[++i] ?? "");
    else positional.push(arg);
  }
  const fixture = positional[0];
  if (!fixture) return null;
  const number = (name: string, fallback: number) => {
    const value = Number(flags.get(name) ?? fallback);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  return {
    fixture: path.resolve(fixture),
    home: path.resolve(flags.get("home") || path.join(os.tmpdir(), "myhq-replay-home")),
    agent: flags.get("agent") || "scout",
    intervalMs: number("interval", 1000),
    delayS: number("delay", 8),
    agents: flags.has("agents") ? Math.min(12, Math.max(2, Math.round(number("agents", 3)))) : null,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function storeEvent(db: Db, runId: number, agentId: string, event: RunEvent): void {
  const { type, ...data } = event;
  db.prepare("INSERT INTO events (run_id, room, agent_id, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    runId,
    ROOM,
    agentId,
    type,
    JSON.stringify(data),
    now(),
  );
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

/** What the HQ MCP server writes when a tool call goes through, so that the desk and the tray follow. */
function mcpSideEffect(db: Db, runId: number, agentId: string, call: { name: string; input: unknown }): string {
  const input = asRecord(call.input);
  if (call.name === "mcp__hq__hq_submit") {
    const result = db
      .prepare(
        `INSERT INTO approvals (room, agent_id, run_id, type, title, body, payload, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        ROOM,
        agentId,
        runId,
        String(input.type ?? "replayed_item"),
        String(input.title ?? "Replayed item").slice(0, 300),
        String(input.body ?? "(replayed)"),
        JSON.stringify(asRecord(input.payload)),
        now(),
      );
    return t.approval(Number(result.lastInsertRowid));
  }
  if (call.name === "mcp__hq__hq_message" && typeof input.to === "string") {
    db.prepare("INSERT INTO messages (room, from_agent, to_agent, text, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      ROOM,
      agentId,
      input.to,
      String(input.text ?? ""),
      runId,
      now(),
    );
    return t.message(input.to);
  }
  return "";
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    console.log(t.usage);
    process.exit(2);
  }
  if (!fs.existsSync(options.fixture)) throw new Error(t.fixtureMissing(options.fixture));
  const events = fs.readFileSync(options.fixture, "utf8").split("\n").flatMap(parseStreamLine);
  if (events.length === 0) throw new Error(t.fixtureEmpty(options.fixture));

  const agents = demoAgents(options.agents ?? 3);
  ensureDemoHome(options.home, agents, options.agents !== null);
  // The room of an existing demo home is the truth (it may have more agents than the default three).
  const known = loadHome(options.home).rooms.find((room) => room.name === ROOM)?.agents.map((agent) => agent.id) ?? agents.map((agent) => agent.id);
  if (!known.includes(options.agent)) throw new Error(t.unknownAgent(options.agent, known.join(", ")));
  const db = openDb(path.join(options.home, "data", "hq.db"));
  syncHome(db, loadHome(options.home));

  console.log(
    t.ready({ home: options.home, room: ROOM, agents: known.join(", "), delay: options.delayS, events: events.length }),
  );
  await sleep(options.delayS * 1000);

  const runId = Number(
    db
      .prepare(
        "INSERT INTO runs (room, agent_id, engine, task, status, started_at) VALUES (?, ?, 'claude', ?, 'running', ?)",
      )
      .run(ROOM, options.agent, `Replay of ${path.basename(options.fixture)}`, now()).lastInsertRowid,
  );
  console.log(t.started(runId, options.agent));

  const calls = new Map<string, { name: string; input: unknown }>();
  let end: Extract<RunEvent, { type: "end" }> | null = null;
  for (const [index, event] of events.entries()) {
    await sleep(options.intervalMs);
    storeEvent(db, runId, options.agent, event);
    let detail = "";
    if (event.type === "tool_call") {
      calls.set(event.id, { name: event.name, input: event.input });
      detail = event.name;
    } else if (event.type === "tool_result") {
      const call = calls.get(event.toolUseId);
      if (call) detail = mcpSideEffect(db, runId, options.agent, call);
    } else if (event.type === "end") {
      end = event;
      detail = event.status;
    }
    console.log(t.event(index + 1, events.length, event.type, detail));
  }

  // Like the runner at the end of a run: status, summary, usage and cost.
  const status = end?.status ?? "failed";
  db.prepare(
    `UPDATE runs SET status = ?, ended_at = ?, summary = ?, input_tokens = ?, output_tokens = ?,
       cache_creation_input_tokens = ?, cache_read_input_tokens = ?, cost_usd = ? WHERE id = ?`,
  ).run(
    status,
    now(),
    end?.summary ?? "The replay ended without a result.",
    end?.usage.inputTokens ?? 0,
    end?.usage.outputTokens ?? 0,
    end?.usage.cacheCreationInputTokens ?? 0,
    end?.usage.cacheReadInputTokens ?? 0,
    end?.costUsd ?? 0,
    runId,
  );
  console.log(t.finished(runId, status));
  db.close();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
