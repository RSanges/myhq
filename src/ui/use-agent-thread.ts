"use client";

import { useCallback, useEffect, useState } from "react";
import { askAgent, errorText, fetchThread, resetDiscussion } from "./api";
import type { Thread } from "./schemas";

/** How often the thread is read again while the agent answers a question. */
const POLL_MS = 2_000;

/**
 * The thread of an agent's sheet: read when the sheet opens and whenever
 * `refreshKey` changes (a run started or ended, an item came, the agent said
 * what it is doing), then every few seconds while a question waits for its
 * answer. `send` asks a question, `reset` starts a new discussion.
 */
export function useAgentThread(room: string, agentId: string, refreshKey: string) {
  const [thread, setThread] = useState<Thread | null>(null);
  /** When the thread was last read (epoch milliseconds): the clock of its durations. */
  const [readAt, setReadAt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const busy = thread?.busy ?? false;

  useEffect(() => {
    let closed = false;
    const load = async () => {
      try {
        const next = await fetchThread(room, agentId);
        if (closed) return;
        setThread(next);
        setReadAt(Date.now());
      } catch (failure) {
        if (!closed) setError(errorText(failure));
      }
    };
    void load();
    const timer = busy ? setInterval(() => void load(), POLL_MS) : null;
    return () => {
      closed = true;
      if (timer) clearInterval(timer);
    };
  }, [room, agentId, refreshKey, busy, tick]);

  const reload = useCallback(() => setTick((value) => value + 1), []);

  /** Asks the question; the thread shows it at once, its answer when it comes. False when it was not taken. */
  const send = useCallback(
    async (text: string): Promise<boolean> => {
      setError(null);
      try {
        const question = await askAgent(room, agentId, text);
        setThread((current) =>
          current
            ? { ...current, busy: true, entries: [...current.entries, { kind: "question", at: question.askedAt, question }] }
            : current,
        );
        return true;
      } catch (failure) {
        setError(errorText(failure));
        return false;
      }
    },
    [room, agentId],
  );

  const reset = useCallback(async () => {
    setError(null);
    try {
      await resetDiscussion(room, agentId);
      reload();
    } catch (failure) {
      setError(errorText(failure));
    }
  }, [room, agentId, reload]);

  return { thread, readAt, error, setError, busy, send, reset, reload };
}
