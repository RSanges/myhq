"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { clearChat, errorText, fetchChatHistory, sendChat } from "./api";
import type { ChatMessage, ChatSignal, ChatTurn } from "./schemas";

/** Messages kept in the panel (the server keeps 500, the panel loads 50). */
const KEPT = 200;

const IDLE_TURN: ChatTurn = { running: false, queued: 0, pendingConfirmation: null };

/** A message sent and not answered yet, shown at once. */
export type Outgoing = { key: number; text: string; to: { room: string; agent: string } | null };

/** Adds messages to the list by id (a message may arrive by the stream and by the reply), oldest first. */
export function mergeMessages(list: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map(list.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  const merged = [...byId.values()].sort((a, b) => a.id - b.id);
  return merged.length > KEPT ? merged.slice(merged.length - KEPT) : merged;
}

export type Chat = {
  loaded: boolean;
  loadFailed: boolean;
  messages: ChatMessage[];
  outgoing: Outgoing[];
  turn: ChatTurn;
  /** Messages of this page to the chat waiting for their answer (a task for an agent is not one). */
  inflight: number;
  error: string | null;
  /** Sends a message; false when it was not taken (the caller keeps the text). */
  send: (text: string, to: { room: string; agent: string } | null) => Promise<boolean>;
  /** `/new`. */
  clear: () => Promise<void>;
};

/**
 * The conversation of the panel: loaded once, then kept in step by the `chat`
 * events of the stream (any channel), and again after each reconnection since
 * those events are not replayed.
 */
export function useChat(subscribe: (listener: (signal: ChatSignal) => void) => () => void): Chat {
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [outgoing, setOutgoing] = useState<Outgoing[]>([]);
  const [turn, setTurn] = useState<ChatTurn>(IDLE_TURN);
  const [inflight, setInflight] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const counter = useRef(0);

  useEffect(() => {
    let closed = false;
    const load = async () => {
      try {
        const history = await fetchChatHistory();
        if (closed) return;
        setMessages(history.messages);
        setTurn(history.turn);
        setLoadFailed(false);
        setLoaded(true);
      } catch {
        if (!closed) setLoadFailed(true);
      }
    };
    const unsubscribe = subscribe((signal) => {
      if (signal.type === "ready") void load();
      else if (signal.type === "message") setMessages((list) => mergeMessages(list, [signal.message]));
      else if (signal.type === "cleared") setMessages([]);
      else setTurn(signal.turn);
    });
    void load();
    return () => {
      closed = true;
      unsubscribe();
    };
  }, [subscribe]);

  const send = useCallback<Chat["send"]>(async (text, to) => {
    const key = ++counter.current;
    setOutgoing((list) => [...list, { key, text, to }]);
    if (!to) setInflight((count) => count + 1);
    setError(null);
    try {
      const reply = await sendChat(text, to ?? undefined);
      setMessages((list) => mergeMessages(list, reply.messages));
      if (!to) setTurn((current) => ({ ...current, pendingConfirmation: reply.pendingConfirmation ?? null }));
      if (!reply.ok) {
        setError(reply.reply);
        return false;
      }
      return true;
    } catch (failure) {
      setError(errorText(failure));
      return false;
    } finally {
      setOutgoing((list) => list.filter((each) => each.key !== key));
      if (!to) setInflight((count) => count - 1);
    }
  }, []);

  const clear = useCallback(async () => {
    setError(null);
    try {
      await clearChat();
      setMessages([]);
      setTurn((current) => ({ ...current, pendingConfirmation: null }));
    } catch (failure) {
      setError(errorText(failure));
    }
  }, []);

  return { loaded, loadFailed, messages, outgoing, turn, inflight, error, send, clear };
}
