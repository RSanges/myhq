"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { askAgent, decideProposal, errorText, fetchThread, resetDiscussion } from "./api";
import type { Run, Thread } from "./schemas";

/** How often the thread is read again while the agent answers a question. */
const POLL_MS = 2_000;
/**
 * A change of `refreshKey` is read after this: a status reaches the page with
 * its tool call, a moment before the HQ server has stored it.
 */
const SETTLE_MS = 700;

/**
 * The thread of an agent's sheet in one subject (null: the general one): read
 * when the sheet opens or the subject changes, and whenever `refreshKey`
 * changes (a run started or ended, an item came, the agent said what it is
 * doing), then every few seconds while a question waits for its answer. The
 * thread of another subject is never shown while this one loads. `send` asks
 * a question in the subject, `reset` starts a new discussion (general subject).
 */
export function useAgentThread(room: string, agentId: string, subject: number | null, refreshKey: string) {
  /** The thread read, with the subject it belongs to. */
  const [read, setRead] = useState<{ subject: number | null; thread: Thread } | null>(null);
  const thread = read !== null && read.subject === subject ? read.thread : null;
  /** When the thread was last read (epoch milliseconds): the clock of its durations. */
  const [readAt, setReadAt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const busy = thread?.busy ?? false;
  /** The subject read last: a new subject is read at once, a refresh of the same one after SETTLE_MS. */
  const opened = useRef<string | null>(null);

  useEffect(() => {
    let closed = false;
    const load = async () => {
      try {
        const next = await fetchThread(room, agentId, subject);
        if (closed) return;
        setRead({ subject, thread: next });
        setReadAt(Date.now());
      } catch (failure) {
        if (!closed) setError(errorText(failure));
      }
    };
    const key = `${room}/${agentId}/${subject}`;
    const first = setTimeout(() => void load(), opened.current === key ? SETTLE_MS : 0);
    opened.current = key;
    const timer = busy ? setInterval(() => void load(), POLL_MS) : null;
    return () => {
      closed = true;
      clearTimeout(first);
      if (timer) clearInterval(timer);
    };
  }, [room, agentId, subject, refreshKey, busy, tick]);

  const reload = useCallback(() => setTick((value) => value + 1), []);

  /** Changes the thread shown, if it is still the one of this subject. */
  const update = useCallback(
    (change: (current: Thread) => Thread) =>
      setRead((current) => (current && current.subject === subject ? { subject, thread: change(current.thread) } : current)),
    [subject],
  );

  /** Asks the question; the thread shows it at once, its answer when it comes. False when it was not taken. */
  const send = useCallback(
    async (text: string): Promise<boolean> => {
      setError(null);
      try {
        const question = await askAgent(room, agentId, text, subject);
        update((current) => ({ ...current, busy: true, entries: [...current.entries, { kind: "question", at: question.askedAt, question }] }));
        return true;
      } catch (failure) {
        setError(errorText(failure));
        return false;
      }
    },
    [room, agentId, subject, update],
  );

  /**
   * « Lancer le tour » or « On en parle d'abord » on a proposed run (or revision): the card shows what became of it.
   * Returns the run it started, or null (set aside, waiting, or refused: the error says why).
   */
  const decide = useCallback(
    async (questionId: number, action: "launch" | "dismiss"): Promise<Run | null> => {
      setError(null);
      try {
        const { question, run } = await decideProposal(room, agentId, questionId, action);
        update((current) => ({
          ...current,
          entries: current.entries.map((entry) =>
            entry.kind === "question" && entry.question.id === questionId ? { ...entry, question } : entry,
          ),
        }));
        return run;
      } catch (failure) {
        setError(errorText(failure));
        return null;
      }
    },
    [room, agentId, update],
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

  /** The tabs, from the last thread read whatever its subject: they stay while another subject loads. */
  const subjects = read?.thread.subjects ?? [];

  return { thread, subjects, readAt, error, setError, busy, send, decide, reset, reload };
}
