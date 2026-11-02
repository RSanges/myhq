import { spawn } from "node:child_process";
import type { Env } from "../server/config";

export type ShellResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

/** Quotes a path for the platform's shell (cmd.exe on Windows, sh elsewhere). */
export function quoteForShell(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return `"${value.replace(/"/g, '""')}"`;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Replaces `{file}` in a command template with the quoted path. */
export function fillTemplate(template: string, file: string, platform: NodeJS.Platform = process.platform): string {
  return template.split("{file}").join(quoteForShell(file, platform));
}

/** Runs a command line of the home's configuration through the system shell. */
export function runShell(command: string, options: { cwd: string; env: Env; timeoutMs: number }): Promise<ShellResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-4000)));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: error.message, timedOut });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}
