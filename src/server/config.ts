import path from "node:path";
import { z } from "zod";
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
  runTimeoutMs: number;
  claudeBin: string;
  /** HQ_SCHEDULER=on: routines start runs on their own. */
  scheduler: boolean;
  /** Time zone of the routines and of the daily export. */
  timeZone: string;
  /** The user's weekly budget, to show the share consumed. Null when not set. */
  weeklyBudgetUsd: number | null;
  /** --max-budget-usd of an onboarding run. */
  onboardingMaxBudgetUsd: number;
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
  return {
    repoRoot,
    home,
    dataDir,
    dbPath: path.join(dataDir, "hq.db"),
    runsDir: path.join(dataDir, "runs"),
    maxRunsPerDay: vars.HQ_MAX_RUNS_PER_DAY,
    defaultMaxBudgetUsd: vars.HQ_DEFAULT_MAX_BUDGET_USD,
    runTimeoutMs: vars.HQ_RUN_TIMEOUT_MINUTES * 60_000,
    claudeBin: vars.HQ_CLAUDE_BIN,
    scheduler: vars.HQ_SCHEDULER === "on",
    timeZone: vars.HQ_TIMEZONE ?? systemTimeZone(),
    weeklyBudgetUsd: vars.HQ_WEEKLY_BUDGET_USD ?? null,
    onboardingMaxBudgetUsd: vars.HQ_ONBOARDING_MAX_BUDGET_USD,
  };
}

/** True when `target` is `base` itself or a path inside it. */
export function isInside(base: string, target: string): boolean {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  );
}
