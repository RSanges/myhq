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

type Run = (command: string, options: { cwd: string; env: Env; timeoutMs: number }) => Promise<ShellResult>;

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

/**
 * Runs the home commands of the desk, one cache entry per command and
 * working directory. Two callers asking at once share the same run. A
 * failure (timeout, exit code, output that is not the contract) is cached
 * like a success, so that a broken command is not run again at every request.
 */
export class DeskCommands {
  private readonly cache = new Map<string, CommandResult>();
  private readonly inflight = new Map<string, Promise<CommandResult>>();

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
    const promise = this.execute(spec).finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  private async execute(spec: CommandSpec): Promise<CommandResult> {
    const run = this.deps.run ?? runShell;
    // The shell is killed at the timeout, but a program it started may keep
    // the output open (Windows): the desk does not wait for it.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<ShellResult>((resolve) => {
      timer = setTimeout(() => resolve({ code: null, stdout: "", stderr: "", timedOut: true }), spec.timeoutMs + 200);
    });
    let shell: ShellResult;
    try {
      shell = await Promise.race([
        run(spec.command, { cwd: spec.cwd, env: extensionEnv(this.deps.env), timeoutMs: spec.timeoutMs }),
        late,
      ]);
    } catch (error) {
      shell = { code: null, stdout: "", stderr: error instanceof Error ? error.message : String(error), timedOut: false };
    } finally {
      clearTimeout(timer);
    }
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
    this.cache.set(keyOf(spec), result);
    return result;
  }
}

const keyOf = (spec: CommandSpec): string => `${spec.cwd}\u0000${spec.command}`;
