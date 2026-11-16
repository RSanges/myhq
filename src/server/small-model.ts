import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Env } from "./config";

// One call of a small model outside the runs: `claude -p` with no tool, no MCP
// server, no user settings, a minimal system prompt, low effort and a budget
// cap, its cost and tokens read from the result. Shared by the portier
// (portier.ts) and the run summary (run-summary.ts).

/** The input of one call. */
export type SmallModelCallInput = {
  claudeBin: string;
  model: string;
  system: string;
  prompt: string;
  env: Env;
  timeoutMs: number;
  /** `--max-budget-usd`: the cap of the call. */
  maxBudgetUsd: number;
  // The door's call only (door.ts); left out, none of them changes the arguments.
  /** Built-in tools that exist for the call (`--tools`, also allowed); default: none. */
  tools?: string[];
  /** Folders the call may read (`--add-dir`). */
  addDirs?: string[];
  /** `--effort`; default: low. */
  effort?: string;
  /** The working directory, the caller's to create and remove; default: a fresh private folder of the system's temporary directory, removed after the call. */
  cwd?: string;
};

/** What a call gives back: the model's text, and what it cost. */
export type SmallModelAnswer = {
  text: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  durationMs: number;
};

/** The model call itself, replaced in the tests. Rejects on any failure. */
export type SmallModelCall = (input: SmallModelCallInput) => Promise<SmallModelAnswer>;

/** The single result object of `claude -p --output-format json`. */
const resultSchema = z.looseObject({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  total_cost_usd: z.number().optional(),
  duration_ms: z.number().optional(),
  usage: z
    .looseObject({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
    })
    .optional(),
});

/**
 * The arguments of the call: no tool (or only `tools`, for the door), no MCP
 * server, no user settings, low effort, the budget cap.
 */
export function smallModelArgs(
  input: Pick<SmallModelCallInput, "model" | "system" | "prompt" | "maxBudgetUsd" | "tools" | "addDirs" | "effort">,
): string[] {
  const tools = input.tools ?? [];
  return [
    "-p",
    input.prompt,
    "--output-format",
    "json",
    "--model",
    input.model,
    "--system-prompt",
    input.system,
    "--tools",
    ...(tools.length > 0 ? tools : [""]),
    ...(tools.length > 0 ? ["--allowedTools", ...tools] : []),
    ...(input.addDirs ?? []).flatMap((dir) => ["--add-dir", dir]),
    "--strict-mcp-config",
    // `local` alone: the cwd's .claude/settings.local.json (the door's read guard). With `project`, a CLAUDE.md
    // in any parent of the cwd (the system's temporary directory) reaches the call (measured on CLI 2.1.325).
    "--setting-sources",
    "local",
    "--effort",
    input.effort ?? "low",
    "--max-budget-usd",
    String(input.maxBudgetUsd),
  ];
}

/**
 * The real call: `claude -p` in a fresh private folder of the system's
 * temporary directory (no CLAUDE.md of the home is read, and nothing another
 * process left in a shared folder), its JSON result parsed.
 */
export const claudeSmallModelCall: SmallModelCall = (input) =>
  new Promise((resolve, reject) => {
    let cwd: string;
    try {
      cwd = input.cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), "myhq-small-"));
    } catch (error) {
      reject(error as Error);
      return;
    }
    const scratch = input.cwd === undefined ? cwd : null;
    const done = () => {
      try {
        if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
      } catch {
        // Still held (Windows): left to the system's cleaning of its temporary directory.
      }
    };
    const started = Date.now();
    const child = spawn(input.claudeBin, smallModelArgs(input), {
      cwd,
      env: input.env as unknown as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-2_000)));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`no answer after ${Math.round(input.timeoutMs / 1000)} s`));
    }, input.timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      done();
      reject(new Error(`could not start "${input.claudeBin}": ${error.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      done();
      let raw: unknown;
      try {
        raw = JSON.parse(stdout.trim());
      } catch {
        reject(new Error(`claude exited with code ${code} without a JSON result${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
        return;
      }
      const parsed = resultSchema.safeParse(raw);
      if (!parsed.success || parsed.data.is_error || parsed.data.subtype !== "success") {
        reject(new Error(`claude gave no answer (${parsed.success ? parsed.data.subtype : "unreadable result"})`));
        return;
      }
      const usage = parsed.data.usage ?? {};
      resolve({
        text: parsed.data.result ?? "",
        costUsd: parsed.data.total_cost_usd ?? 0,
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
        cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
        durationMs: parsed.data.duration_ms ?? Date.now() - started,
      });
    });
  });
