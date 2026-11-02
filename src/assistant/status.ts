/** Whether this process is currently reading the bot's updates. */
const globalForStatus = globalThis as unknown as { __myhqAssistant?: { polling: boolean } };

export function setPolling(polling: boolean): void {
  globalForStatus.__myhqAssistant = { polling };
}

/** The assistant's state, as shown by GET /api/state. */
export function assistantStatus(): { polling: boolean } {
  return { polling: globalForStatus.__myhqAssistant?.polling ?? false };
}
