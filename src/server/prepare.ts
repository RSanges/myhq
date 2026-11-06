import { spawn } from "node:child_process";
import { z } from "zod";
import type { Env } from "./config";
import { EFFORTS, MODELS, type Effort, type Model } from "./rooms";

/**
 * The prepare command of an agent (room.json `prepare`): a script of the home
 * that MyHQ runs before each turn of the agent. It reads what the turn is
 * about on stdin and answers on stdout whether the turn is worth a model call,
 * with context for it. It fails open: whatever goes wrong, the turn runs as if
 * there were no command (docs/home-layout.md, "Run options").
 */

/** What the command reads on stdin, one JSON object. */
export type PrepareInput = {
  room: string;
  agent: string;
  /** The motive of the run: `runs.reason`, `routine` or `manual`. */
  motive: string;
  /** The run's own instruction, null when the run only takes its mailbox. */
  task: { id: number; title: string; body: string } | null;
  /** The tasks of the mailbox taken by the run: messages, approved items, revisions, chat requests. */
  messages: { from: string; text: string; expects: string | null }[];
  /** Start of the agent's last run that ended well (a skipped one included), ISO, or null. */
  lastRunAt: string | null;
  now: string;
};

const outputSchema = z.union([
  z.looseObject({ run: z.literal(false), reason: z.string().trim().min(1).max(2_000) }),
  z.looseObject({
    run: z.literal(true),
    context: z.string().optional(),
    model: z.enum(MODELS).optional(),
    effort: z.enum(EFFORTS).optional(),
  }),
]);

export type PrepareOutcome =
  | { kind: "skip"; reason: string }
  | { kind: "run"; context: string | null; model: Model | null; effort: Effort | null }
  /** The command failed: the turn runs normally (fail open). */
  | { kind: "error"; error: string };

const STDERR_LIMIT = 2_000;

/** Reads the answer of a prepare command; an error when it is not one of the two shapes. */
export function parsePrepareOutput(stdout: string): PrepareOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim());
  } catch {
    return { kind: "error", error: `stdout is not one JSON object: ${JSON.stringify(stdout.trim().slice(0, 200))}` };
  }
  const parsed = outputSchema.safeParse(raw);
  if (!parsed.success) {
    return { kind: "error", error: `stdout is not { run: false, reason } or { run: true, context?, model?, effort? }` };
  }
  const out = parsed.data;
  if (!out.run) return { kind: "skip", reason: out.reason };
  return { kind: "run", context: out.context?.trim() || null, model: out.model ?? null, effort: out.effort ?? null };
}

/** Runs a prepare command and reads its answer. Never throws: a failure is an `error` outcome. */
export function runPrepare(params: {
  command: string[];
  /** The home: the command's working directory, its paths are relative to it. */
  cwd: string;
  env: Env;
  input: PrepareInput;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<PrepareOutcome> {
  const [program, ...args] = params.command;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const done = (outcome: PrepareOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      params.signal?.removeEventListener("abort", kill);
      resolve(outcome);
    };
    const child = spawn(program!, args, {
      cwd: params.cwd,
      env: params.env as unknown as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const kill = () => child.kill();
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, params.timeoutMs);
    if (params.signal?.aborted) kill();
    params.signal?.addEventListener("abort", kill, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_LIMIT);
    });
    // A command that exits without reading its stdin must not crash the app (EPIPE).
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify(params.input));
    child.once("error", (error) => done({ kind: "error", error: `could not start "${program}": ${error.message}` }));
    child.once("close", (code) => {
      const tail = stderr.trim() ? ` (stderr: ${stderr.trim()})` : "";
      if (timedOut) return done({ kind: "error", error: `timed out after ${Math.round(params.timeoutMs / 1000)} s${tail}` });
      if (params.signal?.aborted) return done({ kind: "error", error: "the run was stopped" });
      if (code !== 0) return done({ kind: "error", error: `exited with code ${code}${tail}` });
      done(parsePrepareOutput(stdout));
    });
  });
}
