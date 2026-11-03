"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { errorText, fetchRoutines, fetchState, fetchUsage } from "./api";
import { initialModel, reducer, type Action, type Model } from "./model";
import { approvalSchema, chatEventSchema, eventSchema, messageSchema, readySchema, runSchema, type ChatSignal } from "./schemas";
import type { HqChange } from "./room-store";

export type Connection = "connecting" | "live" | "reconnecting";

const RECONNECT_MS = 3000;
const USAGE_DEBOUNCE_MS = 400;
/** Skipped firings start no run: the journal is also refreshed on a timer. */
const ROUTINES_REFRESH_MS = 60_000;

export type Hq = {
  model: Model;
  dispatch: (action: Action) => void;
  connection: Connection;
  loadError: string | null;
  usageFailed: boolean;
  retry: () => void;
  /** Calls `listener` with the chat events of the stream, and with `ready` each time it opens. Returns the unsubscribe function. */
  subscribeChat: (listener: (signal: ChatSignal) => void) => () => void;
};

/**
 * Loads GET /api/state once, then follows GET /api/events from the returned
 * cursor. Reconnection is handled here (rather than by EventSource itself) so
 * that it resumes from the last id received: the server gives `since` priority
 * over Last-Event-ID, and the URL of an automatic retry would never change.
 *
 * `onChange`, when given, also receives every entity as it arrives (the room
 * view feeds its animation model with it, outside React's rendering).
 */
export function useHq(onChange?: (change: HqChange) => void): Hq {
  const [model, dispatch] = useReducer(reducer, initialModel);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [usageFailed, setUsageFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const chatListeners = useRef(new Set<(signal: ChatSignal) => void>());
  const subscribeChat = useCallback((listener: (signal: ChatSignal) => void) => {
    const listeners = chatListeners.current;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  const listener = useRef(onChange);
  useEffect(() => {
    listener.current = onChange;
  });

  useEffect(() => {
    let closed = false;
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let usageTimer: ReturnType<typeof setTimeout> | undefined;
    let cursor = 0;
    const tellChat = (signal: ChatSignal) => chatListeners.current.forEach((each) => each(signal));

    const refreshUsage = async () => {
      try {
        const usage = await fetchUsage();
        if (closed) return;
        setUsageFailed(false);
        dispatch({ type: "usage", usage });
      } catch {
        if (!closed) setUsageFailed(true);
      }
    };

    const refreshRoutines = async () => {
      try {
        const routines = await fetchRoutines();
        if (!closed) dispatch({ type: "routines", ...routines });
      } catch {
        // The journal keeps its last state; the next refresh tries again.
      }
    };
    const routinesTimer = setInterval(() => void refreshRoutines(), ROUTINES_REFRESH_MS);

    const connect = () => {
      const stream = new EventSource(`/api/events?since=${cursor}`);
      source = stream;

      const follow = (name: string, handle: (data: unknown) => void) => {
        stream.addEventListener(name, (message) => {
          const event = message as MessageEvent<string>;
          const id = Number(event.lastEventId);
          if (Number.isInteger(id) && id > cursor) cursor = id;
          try {
            handle(JSON.parse(event.data));
          } catch {
            // A malformed message is skipped, the stream goes on.
          }
        });
      };

      follow("ready", (data) => {
        readySchema.parse(data);
        // The chat events are not replayed: the conversation is loaded again.
        tellChat({ type: "ready" });
      });
      follow("chat", (data) => tellChat(chatEventSchema.parse(data)));
      follow("run", (data) => {
        const run = runSchema.parse(data);
        dispatch({ type: "run", run });
        listener.current?.({ kind: "run", run });
        clearTimeout(usageTimer);
        usageTimer = setTimeout(() => {
          void refreshUsage();
          void refreshRoutines();
        }, USAGE_DEBOUNCE_MS);
      });
      follow("event", (data) => {
        const event = eventSchema.parse(data);
        dispatch({ type: "event", event });
        listener.current?.({ kind: "event", event });
      });
      follow("message", (data) => dispatch({ type: "message", message: messageSchema.parse(data) }));
      follow("approval", (data) => {
        const approval = approvalSchema.parse(data);
        dispatch({ type: "approval", approval });
        listener.current?.({ kind: "approval", approval });
      });

      stream.onopen = () => setConnection("live");
      stream.onerror = () => {
        stream.close();
        if (closed) return;
        setConnection("reconnecting");
        reconnectTimer = setTimeout(connect, RECONNECT_MS);
      };
    };

    void (async () => {
      try {
        const state = await fetchState();
        if (closed) return;
        setLoadError(null);
        cursor = state.cursor;
        dispatch({ type: "state", state });
        listener.current?.({ kind: "state", state });
        connect();
      } catch (error) {
        if (!closed) setLoadError(errorText(error));
      }
    })();
    void refreshUsage();

    return () => {
      closed = true;
      source?.close();
      clearTimeout(reconnectTimer);
      clearTimeout(usageTimer);
      clearInterval(routinesTimer);
    };
  }, [attempt]);

  return {
    model,
    dispatch,
    connection,
    loadError,
    usageFailed,
    subscribeChat,
    retry: () => {
      setLoadError(null);
      setConnection("connecting");
      setAttempt((value) => value + 1);
    },
  };
}
