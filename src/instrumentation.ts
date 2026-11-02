export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { app } = await import("./server/app");
    app();
    // Not awaited: the server must not wait for Telegram to be ready.
    const { startAssistant } = await import("./assistant/bridge");
    void startAssistant();
  }
}
