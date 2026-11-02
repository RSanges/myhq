export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { app } = await import("./server/app");
    app();
  }
}
