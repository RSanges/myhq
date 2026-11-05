// pm2 process file: `npm run build`, then `pm2 start ecosystem.config.cjs`.
// Next.js is started through its JavaScript entry point (not `npm start`) so
// that the same file works on Windows and Linux.
/* eslint-disable @typescript-eslint/no-require-imports -- a CommonJS file read by pm2 */
const fs = require("node:fs");
const path = require("node:path");

/** HQ_PORT from the environment or `.env.local` (written by `npm run init`), 4242 otherwise. */
function port() {
  let value = process.env.HQ_PORT;
  try {
    const line = fs
      .readFileSync(path.join(__dirname, ".env.local"), "utf8")
      .split(/\r?\n/)
      .find((l) => /^\s*HQ_PORT\s*=/.test(l));
    value ??= line?.split("=")[1]?.trim();
  } catch {
    // No .env.local: the default port.
  }
  return /^\d{2,5}$/.test(value ?? "") ? value : "4242";
}

module.exports = {
  apps: [
    {
      name: "myhq",
      cwd: __dirname,
      script: "node_modules/next/dist/bin/next",
      args: `start -p ${port()} -H 127.0.0.1`,
      // NEXT_MANUAL_SIG_HANDLE: MyHQ, not Next.js, handles the stop signals (it waits for the runs first).
      env: { NODE_ENV: "production", NEXT_MANUAL_SIG_HANDLE: "true" },
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 20,
      // A stop or a restart is sent as a "shutdown" message rather than a signal: on Windows a
      // signal kills the process outright. MyHQ then starts no run, waits up to
      // HQ_SHUTDOWN_GRACE_SECONDS (90 s by default) for the runs in progress, interrupts the
      // others (their tasks are woken again after the restart) and exits.
      shutdown_with_message: true,
      // Must stay above HQ_SHUTDOWN_GRACE_SECONDS plus a few seconds, or pm2 kills the process
      // before the runs are recorded (they are then recovered at the next start).
      kill_timeout: 100000,
    },
  ],
};
