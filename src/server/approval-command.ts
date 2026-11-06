import { spawn } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import { strings } from "../ui/strings";
import type { Env, HqConfig } from "./config";
import { now, type ApprovalRow, type Db } from "./db";
import type { Agent } from "./rooms";

// An approved item executed without a model turn: an agent with
// `onApproval: "command"` names a command of its home (`approvalCommand`,
// for example the script that sends an approved mail), and MyHQ runs it the
// moment the item is approved, with the item on stdin. When it says it did
// the work, the item is executed (its task is written done, with the
// command's note); otherwise MyHQ falls back to `onApproval: "task"`: the
// agent gets the task, with the error, and is woken. This module imports
// nothing that reads the runner: approvals.ts gives it what it needs. See
// docs/architecture.md, "Executing an approved item".

/** How long an approval command may run before MyHQ gives the item to the agent. */
export const APPROVAL_COMMAND_TIMEOUT_MS = 120_000;
/** The most characters of an error kept on the task the agent gets. */
const ERROR_MAX = 2_000;

/** What the command must print on success. */
const outputSchema = z.object({ ok: z.literal(true), note: z.string().trim().max(2_000).optional() });

/** What the command reads on stdin: the item, and the owner's note of the approval. */
export function approvalCommandInput(row: ApprovalRow, note: string | null): string {
  let payload: unknown = {};
  try {
    payload = JSON.parse(row.payload);
  } catch {
    payload = {};
  }
  return JSON.stringify({
    item: { id: row.id, room: row.room, agent: row.agent_id, kind: row.type, title: row.title, body: row.body, payload, note },
  });
}

/** The program and its arguments; a program given as a path is relative to the home, like the arguments' cwd. */
export function approvalCommandLine(home: string, command: readonly string[]): { program: string; args: string[] } {
  const [first, ...args] = command;
  const program = first!.includes("/") || first!.includes("\\") ? path.resolve(home, first!) : first!;
  return { program, args };
}

type CommandOutcome = { ok: true; note: string | null } | { ok: false; error: string };

/** Runs the command once: exit 0 and `{ "ok": true }` on stdout is a success, anything else an error. Never rejects. */
export function runCommand(p: { home: string; command: readonly string[]; input: string; env: Env; timeoutMs: number }): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    const { program, args } = approvalCommandLine(p.home, p.command);
    let settled = false;
    // Set once the command started: the timeout of a command that could not start is never armed.
    const timer: { id?: ReturnType<typeof setTimeout> } = {};
    const done = (outcome: CommandOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer.id);
      resolve(outcome);
    };
    let stdout = "";
    let stderr = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(program, args, {
        cwd: p.home,
        env: p.env as unknown as NodeJS.ProcessEnv,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      return done({ ok: false, error: `could not start "${p.command[0]}": ${(error as Error).message}` });
    }
    timer.id = setTimeout(() => {
      child.kill();
      done({ ok: false, error: `no answer after ${Math.round(p.timeoutMs / 1000)} s` });
    }, p.timeoutMs);
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => (stdout = (stdout + chunk).slice(-20_000)));
    child.stderr!.on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-ERROR_MAX)));
    child.once("error", (error) => done({ ok: false, error: `could not start "${p.command[0]}": ${error.message}` }));
    child.once("close", (code) => {
      const tail = stderr.trim() ? `: ${stderr.trim()}` : "";
      if (code !== 0) return done({ ok: false, error: `exited with code ${code}${tail}` });
      let raw: unknown;
      try {
        raw = JSON.parse(stdout.trim());
      } catch {
        return done({ ok: false, error: `exited 0 without the JSON { "ok": true } on stdout${tail}` });
      }
      const parsed = outputSchema.safeParse(raw);
      if (!parsed.success) return done({ ok: false, error: `did not answer { "ok": true }: ${stdout.trim().slice(0, 500)}` });
      done({ ok: true, note: parsed.data.note ?? null });
    });
    // A command that does not read its stdin closes it early: that is not an error.
    child.stdin!.on("error", () => undefined);
    child.stdin!.end(p.input);
  });
}

/** The commands in progress, shared by every copy of this module in the process (the tests wait for them). */
const globalForCommands = globalThis as unknown as { __myhqApprovalCommands?: Set<Promise<void>> };
const pending = () => (globalForCommands.__myhqApprovalCommands ??= new Set());

/** Resolves once every approval command in progress has ended and its outcome is stored. */
export async function approvalCommandsIdle(): Promise<void> {
  while (pending().size > 0) await Promise.allSettled([...pending()]);
}

/**
 * Runs the agent's approval command for an item just approved, in the
 * background. Success: the item's task is written done with the command's
 * note (the desk shows the item executed), nobody is woken. Failure: the
 * task is written pending with the error and `wake` runs, as `"task"` does.
 * Every run is recorded in `approval_commands`. Never throws.
 */
export function startApprovalCommand(p: {
  config: HqConfig;
  db: Db;
  row: ApprovalRow;
  agent: Agent;
  note: string | null;
  env: Env;
  wake: () => void;
  timeoutMs?: number;
}): void {
  const { config, db, row } = p;
  const command = p.agent.approvalCommand ?? [];
  const started = now();
  try {
    db.prepare("INSERT OR REPLACE INTO approval_commands (approval_id, started_at) VALUES (?, ?)").run(row.id, started);
  } catch (error) {
    console.error(`[approvals] the command of item #${row.id} could not be recorded`, error);
  }
  const outcome: Promise<CommandOutcome> =
    command.length === 0
      ? Promise.resolve({ ok: false, error: "no approvalCommand" })
      : runCommand({
          home: config.home,
          command,
          input: approvalCommandInput(row, p.note),
          env: { ...p.env, MYHQ_HOME: config.home },
          timeoutMs: p.timeoutMs ?? APPROVAL_COMMAND_TIMEOUT_MS,
        });
  const settled = outcome
    .then((result) => {
      const at = now();
      const text = strings.tasks.executeApproved(row.id, row.title);
      if (result.ok) {
        const note = result.note ?? strings.tasks.commandDone;
        db.transaction(() => {
          db.prepare(
            `INSERT INTO tasks (room, agent_id, source, ref_id, text, status, note, created_at, updated_at)
             VALUES (?, ?, 'approval', ?, ?, 'done', ?, ?, ?)`,
          ).run(row.room, row.agent_id, row.id, text, note, at, at);
          db.prepare("UPDATE approval_commands SET ok = 1, note = ?, ended_at = ? WHERE approval_id = ?").run(note, at, row.id);
        }).immediate();
        return;
      }
      const error = result.error.slice(0, ERROR_MAX);
      console.error(`[approvals] the approval command of item #${row.id} failed: ${error}; the agent executes it`);
      db.transaction(() => {
        db.prepare(
          `INSERT INTO tasks (room, agent_id, source, ref_id, text, status, created_at, updated_at)
           VALUES (?, ?, 'approval', ?, ?, 'pending', ?, ?)`,
        ).run(row.room, row.agent_id, row.id, strings.tasks.executeAfterCommand(row.id, row.title, error), at, at);
        db.prepare("UPDATE approval_commands SET ok = 0, error = ?, ended_at = ? WHERE approval_id = ?").run(error, at, row.id);
      }).immediate();
      p.wake();
    })
    .catch((error: unknown) => {
      console.error(`[approvals] the outcome of the command of item #${row.id} could not be stored`, error);
    })
    .finally(() => pending().delete(settled));
  pending().add(settled);
}
