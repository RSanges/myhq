import type { Env } from "./config";
import type { Model } from "./rooms";

export type EngineName = "claude" | "local";

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
};

export const ZERO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

/** Everything an engine needs to execute one run. Paths are absolute. */
export type RunInput = {
  runId: number;
  room: string;
  agentId: string;
  prompt: string;
  model: Model;
  rolePath: string;
  allowedTools: string[];
  /** Per-run MCP config file (the HQ server plus the agent's extra servers). */
  mcpConfigPath: string;
  maxBudgetUsd: number;
  workDir: string;
  /** Full environment of the engine process, already stripped of app secrets. */
  env: Env;
  /** Aborting kills the run. */
  signal: AbortSignal;
  /** Receives every raw line of output, for the run journal. */
  onRawLine?: (line: string) => void;
};

/** Engine-neutral events of a run, stored in the `events` table. */
export type RunEvent =
  | { type: "start"; sessionId: string | null; model: string | null; tools: string[]; mcpServers: { name: string; status: string }[] }
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; isError: boolean; content: string }
  | {
      type: "end";
      status: "done" | "failed";
      /** Engine-specific detail, for example `success` or `error_max_budget_usd`. */
      reason: string;
      summary: string;
      usage: Usage;
      costUsd: number;
    };

export interface Engine {
  readonly name: EngineName;
  run(input: RunInput): AsyncIterable<RunEvent>;
}

/**
 * Planned engine for an OpenAI-compatible endpoint on a machine of the user
 * (Ollama, LM Studio). Not implemented: enabling it is a decision taken on
 * the usage measurements.
 */
export class LocalEngine implements Engine {
  readonly name = "local" as const;

  async *run(input: RunInput): AsyncIterable<RunEvent> {
    void input;
    throw new Error("LocalEngine is not implemented");
  }
}
