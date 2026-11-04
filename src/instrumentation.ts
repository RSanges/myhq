export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { app } = await import("./server/app");
    const { config } = app();
    const { startScheduler } = await import("./server/routines");
    startScheduler(config);
    const { startDailyExport } = await import("./server/export");
    startDailyExport(config);
    const { startQuietHours } = await import("./server/notify");
    startQuietHours(config);
    // Not awaited: the server must not wait for Telegram to be ready.
    const { startAssistant } = await import("./assistant/bridge");
    void startAssistant();
  }
}
