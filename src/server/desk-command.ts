import { z } from "zod";
import { extensionEnv } from "../assistant/settings";
import { runShell, type ShellResult } from "../assistant/shell";
import type { Env } from "./config";

// The home commands of the desk objects (`desk.objects[].source.command` in
// myhq.json): run in the home with a timeout, their stdout is JSON validated
// below, the result is cached a short while, and a failure is a value, never
// an exception. See docs/home-layout.md, "desk".

/** An instant (`2026-11-04T09:30:00+01:00`, `...Z`) or a calendar date (`2026-11-04`). */
const whenSchema = z.union([z.iso.datetime({ offset: true }), z.iso.date()]);

/** A link the desk may follow: an http(s) URL, or a path of the app (never `//host` nor `javascript:`). */
const hrefSchema = z
  .string()
  .max(2000)
  .refine((value) => /^https?:\/\//i.test(value) || /^\/(?!\/)/.test(value), "an http(s) URL or a path starting with /");

export const DESK_TONES = ["neutral", "info", "warn", "alert", "muted"] as const;
export type DeskTone = (typeof DESK_TONES)[number];

/** One item printed by a home command. Unknown fields are dropped. */
export const commandItemSchema = z.object({
  id: z.string().trim().min(1).max(200).optional(),
  title: z.string().trim().min(1).max(300),
  /** Markdown. */
  body: z.string().max(20_000).optional(),
  at: whenSchema.optional(),
  /** The end of an event (a calendar). */
  end: whenSchema.optional(),
  allDay: z.boolean().optional(),
  href: hrefSchema.optional(),
  tone: z.enum(DESK_TONES).optional(),
});

/** A free stretch of a calendar. */
export const commandSlotSchema = z.object({
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
  label: z.string().trim().min(1).max(200).optional(),
});

/** What a home command prints on stdout. */
export const commandOutputSchema = z.object({
  count: z.number().int().min(0),
  items: z.array(commandItemSchema).max(200),
  slots: z.array(commandSlotSchema).max(200).optional(),
  /** A short note of the command about its own data (« cache de 2 jours seulement »). */
  note: z.string().trim().min(1).max(300).optional(),
});

export type CommandOutput = z.infer<typeof commandOutputSchema>;

export const DESK_COMMAND_ERRORS = ["COMMAND_TIMEOUT", "COMMAND_FAILED", "COMMAND_INVALID_OUTPUT"] as const;
export type DeskCommandErrorCode = (typeof DESK_COMMAND_ERRORS)[number];

export type CommandResult =
  | { ok: true; output: CommandOutput; at: number }
  | { ok: false; code: DeskCommandErrorCode; message: string; at: number };

export type CommandSpec = {
  command: string;
  /** Absolute working directory (inside the home). */
  cwd: string;
  timeoutMs: number;
  cacheMs: number;
};

/** What an action command (`actions` of a command source) prints on stdout. */
export const actionOutputSchema = z
  .object({
    ok: z.boolean(),
    /** One line about what happened, in the language of the home. Required when `ok` is false: the owner is shown it. */
    message: z.string().trim().min(1).max(300).optional(),
  })
  .refine((output) => output.ok || output.message !== undefined, "message is required when ok is false");
export type ActionOutput = z.infer<typeof actionOutputSchema>;

export const DESK_ACTION_ERRORS = ["ACTION_TIMEOUT", "ACTION_FAILED", "ACTION_INVALID_OUTPUT"] as const;
export type DeskActionErrorCode = (typeof DESK_ACTION_ERRORS)[number];

export type ActionResult =
  | { ok: true; message: string | null }
  | { ok: false; code: DeskActionErrorCode; message: string };

export type ActionSpec = {
  command: string;
  /** Absolute working directory (inside the home). */
  cwd: string;
  timeoutMs: number;
};

type Run = (command: string, options: { cwd: string; env: Env; timeoutMs: number; input?: string }) => Promise<ShellResult>;

/** Reads the stdout of a command: JSON (a leading BOM is allowed) that matches `commandOutputSchema`. */
export function parseCommandOutput(stdout: string): { ok: true; output: CommandOutput } | { ok: false; message: string } {
  const text = stdout.charCodeAt(0) === 0xfeff ? stdout.slice(1) : stdout;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { ok: false, message: `stdout is not JSON: ${(error as Error).message}` };
  }
  const parsed = commandOutputSchema.safeParse(json);
  if (!parsed.success) {
    const details = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: `stdout does not match the desk contract: ${details}` };
  }
  return { ok: true, output: parsed.data };
}

/** Reads the stdout of an action command: JSON (a leading BOM is allowed) `{ ok, message? }`. */
export function parseActionOutput(stdout: string): { ok: true; output: ActionOutput } | { ok: false; message: string } {
  const text = stdout.charCodeAt(0) === 0xfeff ? stdout.slice(1) : stdout;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { ok: false, message: `stdout is not JSON: ${(error as Error).message}` };
  }
  const parsed = actionOutputSchema.safeParse(json);
  if (!parsed.success) return { ok: false, message: "stdout does not match { ok: boolean, message?: string } (a message when ok is false)" };
  return { ok: true, output: parsed.data };
}

/**
 * Runs the home commands of the desk, one cache entry per command and
 * working directory. Two callers asking at once share the same run. A
 * failure (timeout, exit code, output that is not the contract) is cached
 * like a success, so that a broken command is not run again at every request.
 */
export class DeskCommands {
  private readonly cache = new Map<string, CommandResult>();
  private readonly inflight = new Map<string, Promise<CommandResult>>();
  /** Bumped by `invalidate`: a run that started before it does not fill the cache. */
  private readonly generations = new Map<string, number>();
  /** The actions run one at a time: two of them never write the same file together. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly deps: {
      env: Env;
      log?: (message: string) => void;
      run?: Run;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** The cached result when still fresh, null otherwise. Never runs anything. */
  peek(spec: CommandSpec): CommandResult | null {
    const cached = this.cache.get(keyOf(spec));
    return cached && this.now() - cached.at < spec.cacheMs ? cached : null;
  }

  async get(spec: CommandSpec): Promise<CommandResult> {
    const fresh = this.peek(spec);
    if (fresh) return fresh;
    const key = keyOf(spec);
    const running = this.inflight.get(key);
    if (running) return running;
    const promise: Promise<CommandResult> = this.execute(spec).finally(() => {
      if (this.inflight.get(key) === promise) this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return promise;
  }

  /** Forgets what a command printed: the next `get` runs it again (after an action changed its data). */
  invalidate(spec: CommandSpec): void {
    const key = keyOf(spec);
    this.cache.delete(key);
    this.inflight.delete(key);
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
  }

  /**
   * Runs an action command of the home with `input` as JSON on its standard
   * input (never in the command line), then invalidates the data command of
   * the object, whatever the outcome (a failed action may have written). The
   * command prints `{ ok, message? }`; it may exit with an error code as long
   * as it says why in that JSON. Actions are queued, one at a time.
   */
  act(spec: ActionSpec, input: unknown, data: CommandSpec): Promise<ActionResult> {
    const result = this.queue.then(() => this.runAction(spec, input, data));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async runAction(spec: ActionSpec, input: unknown, data: CommandSpec): Promise<ActionResult> {
    const shell = await this.shell(spec.command, spec.cwd, spec.timeoutMs, JSON.stringify(input));
    this.invalidate(data);
    const said = parseActionOutput(shell.stdout);
    let result: ActionResult;
    if (shell.timedOut) {
      result = { ok: false, code: "ACTION_TIMEOUT", message: `timed out after ${spec.timeoutMs} ms` };
    } else if (said.ok && !said.output.ok) {
      // The command refused and said why, in its own words (whatever its exit code).
      result = { ok: false, code: "ACTION_FAILED", message: said.output.message ?? "" };
    } else if (shell.code !== 0) {
      result = { ok: false, code: "ACTION_INVALID_OUTPUT", message: `exited with code ${shell.code ?? "none"}` };
    } else if (!said.ok) {
      result = { ok: false, code: "ACTION_INVALID_OUTPUT", message: said.message };
    } else {
      result = { ok: true, message: said.output.message ?? null };
    }
    if (!result.ok) {
      const stderr = shell.stderr.trim().slice(-300);
      this.deps.log?.(`[desk] action "${spec.command}" ${result.code}: ${result.message}${stderr ? `: ${stderr}` : ""}`);
    }
    return result;
  }

  /** One run of a command line through the shell: never throws, never waits past the timeout. */
  private async shell(command: string, cwd: string, timeoutMs: number, input?: string): Promise<ShellResult> {
    const run = this.deps.run ?? runShell;
    // The shell is killed at the timeout, but a program it started may keep
    // the output open (Windows): the desk does not wait for it.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<ShellResult>((resolve) => {
      timer = setTimeout(() => resolve({ code: null, stdout: "", stderr: "", timedOut: true }), timeoutMs + 200);
    });
    try {
      return await Promise.race([
        run(command, { cwd, env: extensionEnv(this.deps.env), timeoutMs, ...(input === undefined ? {} : { input }) }),
        late,
      ]);
    } catch (error) {
      return { code: null, stdout: "", stderr: error instanceof Error ? error.message : String(error), timedOut: false };
    } finally {
      clearTimeout(timer);
    }
  }

  private async execute(spec: CommandSpec): Promise<CommandResult> {
    const generation = this.generations.get(keyOf(spec)) ?? 0;
    const shell = await this.shell(spec.command, spec.cwd, spec.timeoutMs);
    const at = this.now();
    let result: CommandResult;
    if (shell.timedOut) {
      result = { ok: false, code: "COMMAND_TIMEOUT", message: `timed out after ${spec.timeoutMs} ms`, at };
    } else if (shell.code !== 0) {
      result = { ok: false, code: "COMMAND_FAILED", message: `exited with code ${shell.code ?? "none"}`, at };
    } else {
      const parsed = parseCommandOutput(shell.stdout);
      result = parsed.ok
        ? { ok: true, output: parsed.output, at }
        : { ok: false, code: "COMMAND_INVALID_OUTPUT", message: parsed.message, at };
    }
    if (!result.ok) {
      // stderr goes to the log only: the API and the page show the code and a short reason.
      const stderr = shell.stderr.trim().slice(-300);
      this.deps.log?.(`[desk] command "${spec.command}" ${result.message}${stderr ? `: ${stderr}` : ""}`);
    }
    // An action may have changed the data while this run was reading it: do not keep a stale answer.
    if ((this.generations.get(keyOf(spec)) ?? 0) === generation) this.cache.set(keyOf(spec), result);
    return result;
  }
}

const keyOf = (spec: CommandSpec): string => `${spec.cwd}\u0000${spec.command}`;
