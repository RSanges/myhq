// pm2 process file: `npm run build`, then `pm2 start ecosystem.config.cjs`.
// Next.js is started through its JavaScript entry point (not `npm start`) so
// that the same file works on Windows and Linux.
module.exports = {
  apps: [
    {
      name: "myhq",
      cwd: __dirname,
      script: "node_modules/next/dist/bin/next",
      args: "start -p 4242 -H 127.0.0.1",
      env: { NODE_ENV: "production" },
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 20,
      // Leaves time to mark the runs in progress as cancelled.
      kill_timeout: 10000,
    },
  ],
};
