"use client";

import { useEffect, useReducer, useState } from "react";
import { errorText, fetchRoutines, fetchState, fetchUsage } from "./api";
import { initialModel, reducer, type Action, type Model } from "./model";
import { approvalSchema, eventSchema, messageSchema, readySchema, runSchema } from "./schemas";

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
};

/**
 * Loads GET /api/state once, then follows GET /api/events from the returned
 * cursor. Reconnection is handled here (rather than by EventSource itself) so
 * that it resumes from the last id received: the server gives `since` priority
 * over Last-Event-ID, and the URL of an automatic retry would never change.
 */
export function useHq(): Hq {
  const [model, dispatch] = useReducer(reducer, initialModel);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [usageFailed, setUsageFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let closed = false;
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let usageTimer: ReturnType<typeof setTimeout> | undefined;
    let cursor = 0;

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
      });
      follow("run", (data) => {
        const run = runSchema.parse(data);
        dispatch({ type: "run", run });
        clearTimeout(usageTimer);
        usageTimer = setTimeout(() => {
          void refreshUsage();
          void refreshRoutines();
        }, USAGE_DEBOUNCE_MS);
      });
      follow("event", (data) => dispatch({ type: "event", event: eventSchema.parse(data) }));
      follow("message", (data) => dispatch({ type: "message", message: messageSchema.parse(data) }));
      follow("approval", (data) => dispatch({ type: "approval", approval: approvalSchema.parse(data) }));

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
    retry: () => {
      setLoadError(null);
      setConnection("connecting");
      setAttempt((value) => value + 1);
    },
  };
}
