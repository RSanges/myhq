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
      env: { NODE_ENV: "production" },
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 20,
      // Leaves time to mark the runs in progress as cancelled.
      kill_timeout: 10000,
    },
  ],
};
