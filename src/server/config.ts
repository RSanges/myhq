import path from "node:path";
import { z } from "zod";
import { DEFAULT_PORTIER, type PortierSetting } from "./home-settings";
import { readRuntimeOverrides } from "./runtime-settings";
import { isValidTimeZone, systemTimeZone } from "./time";

/**
 * Runtime configuration, read from the environment (Next.js loads `.env.local`).
 * Every variable the app reads is prefixed with `MYHQ_` or `HQ_`, and none of
 * them is ever passed on to an agent process.
 */
/** The run durations without myhq.json nor environment, in minutes. */
export const DEFAULT_RUN_TIMEOUT_MINUTES = 30;
export const DEFAULT_RUN_HARD_LIMIT_MINUTES = 180;

/** A plain environment map (NodeJS.ProcessEnv requires NODE_ENV under Next.js types). */
export type Env = Record<string, string | undefined>;

const envSchema = z.object({
  MYHQ_HOME: z.string().trim().min(1).default("home"),
  HQ_MAX_RUNS_PER_DAY: z.coerce.number().int().min(0).default(12),
  HQ_DEFAULT_MAX_BUDGET_USD: z.coerce.number().positive().default(1),
  HQ_RUN_TIMEOUT_MINUTES: z.coerce.number().positive().default(DEFAULT_RUN_TIMEOUT_MINUTES),
  HQ_RUN_HARD_LIMIT_MINUTES: z.coerce.number().positive().default(DEFAULT_RUN_HARD_LIMIT_MINUTES),
  HQ_SHUTDOWN_GRACE_SECONDS: z.coerce.number().min(0).default(90),
  HQ_MESSAGE_WAKE_MINUTES: z.coerce.number().min(0).default(10),
  HQ_CLAUDE_BIN: z.string().trim().min(1).default("claude"),
  HQ_SCHEDULER: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.enum(["on", "off"]))
    .default("off"),
  HQ_TIMEZONE: z.string().trim().refine(isValidTimeZone, "an IANA time zone such as Europe/Paris").optional(),
  HQ_WEEKLY_BUDGET_USD: z.coerce.number().positive().optional(),
  HQ_ONBOARDING_MAX_BUDGET_USD: z.coerce.number().positive().default(0.5),
  HQ_TRIGGER_TOKEN: z.string().trim().min(1).optional(),
});

export type HqConfig = {
  /** Root of the MyHQ repository (the process working directory). */
  repoRoot: string;
  /** Absolute path of the home directory. */
  home: string;
  dataDir: string;
  dbPath: string;
  /** Raw stream logs and per-run MCP configs. */
  runsDir: string;
  maxRunsPerDay: number;
  defaultMaxBudgetUsd: number;
  /**
   * The soft deadline of a run (HQ_RUN_TIMEOUT_MINUTES): past it, a home with
   * a supervisor has the run checked instead of interrupted (long-runs.ts).
   */
  runTimeoutMs: number;
  /** A run still going this long after its start is always interrupted (HQ_RUN_HARD_LIMIT_MINUTES). */
  runHardLimitMs: number;
  /**
   * When the app is asked to stop, how long it waits for the runs in progress
   * to end before it interrupts them (HQ_SHUTDOWN_GRACE_SECONDS).
   */
  shutdownGraceMs: number;
  /**
   * A message from one agent to another wakes the recipient at most once in
   * this window per pair of agents; the next ones wait for its next run
   * (HQ_MESSAGE_WAKE_MINUTES, 0: every message wakes).
   */
  messageWakeIntervalMs: number;
  claudeBin: string;
  /** HQ_SCHEDULER=on: routines start runs on their own. */
  scheduler: boolean;
  /** Time zone of the routines and of the daily export. */
  timeZone: string;
  /** The user's weekly budget, to show the share consumed. Null when not set. */
  weeklyBudgetUsd: number | null;
  /** --max-budget-usd of an onboarding run. */
  onboardingMaxBudgetUsd: number;
  /** HQ_TRIGGER_TOKEN: required by POST /api/runs for a request that carries a `reason`. Null when not set. */
  triggerToken: string | null;
  /**
   * The portier when myhq.json has no `portier` block (the file wins, read at each wake-up, see
   * portier.ts). Left out: on, on Haiku.
   */
  portier?: PortierSetting;
  /**
   * The values of the runtime settings before the overrides of `myhq.json`
   * (environment, else default). Set by getConfig; liveConfig starts from
   * them to read the file again.
   */
  fromEnv?: Pick<HqConfig, RuntimeField>;
  /**
   * Why the run durations in force are not the ones of myhq.json and the
   * environment (a timeout not shorter than the hard limit), null when they
   * are. Set by getConfig and liveConfig.
   */
  durationsError?: string | null;
};

function emptyToUndefined(env: Env): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const key of Object.keys(envSchema.shape)) {
    const value = env[key];
    out[key] = value === undefined || value.trim() === "" ? undefined : value;
  }
  return out;
}

export function getConfig(env: Env = process.env): HqConfig {
  const parsed = envSchema.safeParse(emptyToUndefined(env));
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid MyHQ environment: ${details}`);
  }
  const vars = parsed.data;
  const repoRoot = process.cwd();
  // The home is read at runtime, never bundled: keep it out of output tracing.
  const home = path.resolve(/* turbopackIgnore: true */ repoRoot, vars.MYHQ_HOME);
  const dataDir = path.join(home, "data");
  return withHomeOverrides({
    repoRoot,
    home,
    dataDir,
    dbPath: path.join(dataDir, "hq.db"),
    runsDir: path.join(dataDir, "runs"),
    maxRunsPerDay: vars.HQ_MAX_RUNS_PER_DAY,
    defaultMaxBudgetUsd: vars.HQ_DEFAULT_MAX_BUDGET_USD,
    runTimeoutMs: vars.HQ_RUN_TIMEOUT_MINUTES * 60_000,
    runHardLimitMs: vars.HQ_RUN_HARD_LIMIT_MINUTES * 60_000,
    shutdownGraceMs: vars.HQ_SHUTDOWN_GRACE_SECONDS * 1000,
    messageWakeIntervalMs: vars.HQ_MESSAGE_WAKE_MINUTES * 60_000,
    claudeBin: vars.HQ_CLAUDE_BIN,
    scheduler: vars.HQ_SCHEDULER === "on",
    timeZone: vars.HQ_TIMEZONE ?? systemTimeZone(),
    weeklyBudgetUsd: vars.HQ_WEEKLY_BUDGET_USD ?? null,
    onboardingMaxBudgetUsd: vars.HQ_ONBOARDING_MAX_BUDGET_USD,
    triggerToken: vars.HQ_TRIGGER_TOKEN ?? null,
    portier: DEFAULT_PORTIER,
  });
}

/** The fields of the configuration that `myhq.json` may override (runtime-settings.ts). */
type RuntimeField =
  | "scheduler"
  | "timeZone"
  | "maxRunsPerDay"
  | "defaultMaxBudgetUsd"
  | "weeklyBudgetUsd"
  | "runTimeoutMs"
  | "runHardLimitMs";

const reportedErrors = new Set<string>();

/**
 * The run durations in force: myhq.json over the environment, as a pair. A
 * soft deadline that is not strictly shorter than the hard limit makes the
 * pair invalid: the environment's pair applies instead, or the defaults when
 * it is no better, and `error` says why.
 */
export function runDurations(
  file: { timeoutMinutes?: number; hardMinutes?: number },
  env: { timeoutMs: number; hardMs: number },
): { timeoutMs: number; hardMs: number; error: string | null } {
  const timeoutMs = file.timeoutMinutes !== undefined ? file.timeoutMinutes * 60_000 : env.timeoutMs;
  const hardMs = file.hardMinutes !== undefined ? file.hardMinutes * 60_000 : env.hardMs;
  if (timeoutMs < hardMs) return { timeoutMs, hardMs, error: null };
  const error = `run timeout (${timeoutMs / 60_000} min) must be shorter than the hard limit (${hardMs / 60_000} min)`;
  if (env.timeoutMs < env.hardMs && (file.timeoutMinutes !== undefined || file.hardMinutes !== undefined)) {
    return { timeoutMs: env.timeoutMs, hardMs: env.hardMs, error: `${error}: the environment applies` };
  }
  return {
    timeoutMs: DEFAULT_RUN_TIMEOUT_MINUTES * 60_000,
    hardMs: DEFAULT_RUN_HARD_LIMIT_MINUTES * 60_000,
    error: `${error}: the defaults apply (${DEFAULT_RUN_TIMEOUT_MINUTES} and ${DEFAULT_RUN_HARD_LIMIT_MINUTES} min)`,
  };
}

/**
 * Applies the runtime settings of `<home>/myhq.json` (`scheduler`,
 * `timeZone`, `maxRunsPerDay`, the budgets and the run durations) over the
 * values taken from the environment. A key that is invalid is logged once and
 * ignored.
 */
function withHomeOverrides(base: HqConfig): HqConfig & { fromEnv: NonNullable<HqConfig["fromEnv"]> } {
  const { overrides, errors } = readRuntimeOverrides(base.home);
  for (const message of errors) {
    if (reportedErrors.has(message)) continue;
    reportedErrors.add(message);
    console.error(`[config] ${message}: the environment applies`);
  }
  const durations = runDurations(
    { timeoutMinutes: overrides.runTimeoutMinutes, hardMinutes: overrides.runHardLimitMinutes },
    { timeoutMs: base.runTimeoutMs, hardMs: base.runHardLimitMs },
  );
  if (durations.error && !reportedErrors.has(durations.error)) {
    reportedErrors.add(durations.error);
    console.error(`[config] ${durations.error}`);
  }
  return {
    ...base,
    scheduler: overrides.scheduler ?? base.scheduler,
    timeZone: overrides.timeZone ?? base.timeZone,
    maxRunsPerDay: overrides.maxRunsPerDay ?? base.maxRunsPerDay,
    defaultMaxBudgetUsd: overrides.defaultMaxBudgetUsd ?? base.defaultMaxBudgetUsd,
    weeklyBudgetUsd: overrides.weeklyBudgetUsd ?? base.weeklyBudgetUsd,
    runTimeoutMs: durations.timeoutMs,
    runHardLimitMs: durations.hardMs,
    durationsError: durations.error,
    fromEnv: {
      scheduler: base.scheduler,
      timeZone: base.timeZone,
      maxRunsPerDay: base.maxRunsPerDay,
      defaultMaxBudgetUsd: base.defaultMaxBudgetUsd,
      weeklyBudgetUsd: base.weeklyBudgetUsd,
      runTimeoutMs: base.runTimeoutMs,
      runHardLimitMs: base.runHardLimitMs,
    },
  };
}

/**
 * The same configuration with `myhq.json` read again, for what lives longer
 * than a request (the scheduler, the export timer, the Telegram assistant):
 * a setting changed in the file or on /reglages applies without a restart.
 * Without `fromEnv` (a hand-made configuration), its own values are the
 * fallback.
 */
export function liveConfig(config: HqConfig): HqConfig & { fromEnv: NonNullable<HqConfig["fromEnv"]> } {
  return withHomeOverrides({ ...config, ...config.fromEnv });
}

/** True when `target` is `base` itself or a path inside it. */
export function isInside(base: string, target: string): boolean {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  );
}
