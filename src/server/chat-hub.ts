import type { ChatMessageDto } from "./chat-history";

/** What the next chat turn is waiting for: the user's yes to actions held after an untrusted read. */
export type PendingConfirmation = { summary: string };

/** The state of the conversation's turns: one at a time, whatever the channel. */
export type ChatTurnState = {
  /** A turn is in progress. */
  running: boolean;
  /** Messages waiting for the turn in progress to end. */
  queued: number;
  pendingConfirmation: PendingConfirmation | null;
};

/** What the live stream (`chat` event of GET /api/events) carries. */
export type ChatEvent =
  | { type: "message"; message: ChatMessageDto }
  | { type: "cleared" }
  | { type: "turn"; turn: ChatTurnState };

type Listener = (event: ChatEvent) => void;

// Shared across module instances (instrumentation, route bundles, dev reloads).
const globalForHub = globalThis as unknown as { __myhqChatListeners?: Set<Listener> };

/** Calls `listener` with every chat event of this process. Returns the unsubscribe function. */
export function subscribeChat(listener: Listener): () => void {
  const listeners = (globalForHub.__myhqChatListeners ??= new Set());
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tells the live streams. Never throws: a broken stream must not fail a message. */
export function publishChat(event: ChatEvent): void {
  for (const listener of [...(globalForHub.__myhqChatListeners ?? [])]) {
    try {
      listener(event);
    } catch {
      // That stream is gone; it unsubscribes itself.
    }
  }
}
