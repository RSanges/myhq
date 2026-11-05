export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { app } = await import("./server/app");
    const { config } = app();
    // A stop (pm2 restart) waits for the runs in progress, up to HQ_SHUTDOWN_GRACE_SECONDS, then
    // frees the port and the Telegram long poll (a poll left open makes the next instance's
    // getUpdates fail with a 409) and exits. Next.js does not exit by itself with
    // NEXT_MANUAL_SIG_HANDLE.
    const { installShutdown } = await import("./server/runner");
    const { closeServers, exitProcess } = await import("./server/exit");
    const { startAssistant } = await import("./assistant/bridge");
    installShutdown(config, exitProcess, async () => {
      await Promise.all([closeServers(), startAssistant().then((bridge) => bridge?.stop())]);
    });
    const { startScheduler } = await import("./server/routines");
    startScheduler(config);
    const { startDailyExport } = await import("./server/export");
    startDailyExport(config);
    const { startQuietHours } = await import("./server/notify");
    startQuietHours(config);
    // Not awaited: the server must not wait for Telegram to be ready.
    void startAssistant();
  }
}
