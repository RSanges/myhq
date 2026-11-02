import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HqConfig } from "../src/server/config";
import type { Db, RunRow } from "../src/server/db";

/** Creates a temporary home with one room ("demo") and returns a config for it. */
export function makeHome(overrides: Partial<HqConfig> = {}, roomJson?: unknown): HqConfig {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-home-"));
  const roomDir = path.join(home, "rooms", "demo");
  fs.mkdirSync(path.join(roomDir, "roles"), { recursive: true });
  fs.writeFileSync(path.join(roomDir, "roles", "scout.md"), "You are a test agent.\n");
  fs.writeFileSync(
    path.join(roomDir, "room.json"),
    JSON.stringify(
      roomJson ?? {
        name: "demo",
        targetRepo: "../demo-project",
        agents: [
          {
            id: "scout",
            name: "Scout",
            role: "roles/scout.md",
            model: "haiku",
            allowedTools: ["mcp__hq__*"],
          },
        ],
      },
    ),
  );
  const dataDir = path.join(home, "data");
  return {
    repoRoot: process.cwd(),
    home,
    dataDir,
    dbPath: path.join(dataDir, "hq.db"),
    runsDir: path.join(dataDir, "runs"),
    maxRunsPerDay: 12,
    defaultMaxBudgetUsd: 1,
    runTimeoutMs: 60_000,
    claudeBin: "claude",
    scheduler: false,
    timeZone: "Europe/Paris",
    weeklyBudgetUsd: null,
    onboardingMaxBudgetUsd: 0.3,
    ...overrides,
  };
}

export async function waitForRun(db: Db, runId: number, timeoutMs = 5_000): Promise<RunRow> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow;
    if (run.status !== "running") return run;
    if (Date.now() > deadline) throw new Error(`run #${runId} still running after ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A temporary Git repository with one commit. */
export function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "myhq-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "README.md"), "# Test project\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return repo;
}
