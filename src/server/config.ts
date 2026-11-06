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
/** A plain environment map (NodeJS.ProcessEnv requires NODE_ENV under Next.js types). */
export type Env = Record<string, string | undefined>;

const envSchema = z.object({
  MYHQ_HOME: z.string().trim().min(1).default("home"),
  HQ_MAX_RUNS_PER_DAY: z.coerce.number().int().min(0).default(12),
  HQ_DEFAULT_MAX_BUDGET_USD: z.coerce.number().positive().default(1),
  HQ_RUN_TIMEOUT_MINUTES: z.coerce.number().positive().default(30),
  HQ_RUN_HARD_LIMIT_MINUTES: z.coerce.number().positive().default(180),
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
   * The values of `scheduler`, `timeZone` and `maxRunsPerDay` before the
   * overrides of `myhq.json` (environment, else default). Set by getConfig;
   * liveConfig starts from them to read the file again.
   */
  fromEnv?: Pick<HqConfig, "scheduler" | "timeZone" | "maxRunsPerDay">;
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

const reportedErrors = new Set<string>();

/**
 * Applies the runtime settings of `<home>/myhq.json` (`scheduler`,
 * `timeZone`, `maxRunsPerDay`) over the values taken from the environment.
 * A key that is invalid is logged once and ignored.
 */
function withHomeOverrides(base: HqConfig): HqConfig & { fromEnv: NonNullable<HqConfig["fromEnv"]> } {
  const { overrides, errors } = readRuntimeOverrides(base.home);
  for (const message of errors) {
    if (reportedErrors.has(message)) continue;
    reportedErrors.add(message);
    console.error(`[config] ${message}: the environment applies`);
  }
  return {
    ...base,
    scheduler: overrides.scheduler ?? base.scheduler,
    timeZone: overrides.timeZone ?? base.timeZone,
    maxRunsPerDay: overrides.maxRunsPerDay ?? base.maxRunsPerDay,
    fromEnv: { scheduler: base.scheduler, timeZone: base.timeZone, maxRunsPerDay: base.maxRunsPerDay },
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
