"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { errorText, fetchLiveRoom } from "./api";
import { wantsReload } from "./live-room-model";
import type { LiveRoom } from "./schemas";

/**
 * A change is read after this: a status or a shown piece reaches the page with
 * its tool call, a moment before the HQ server has stored it (as the agent's
 * sheet does, use-agent-thread.ts).
 */
const SETTLE_MS = 700;
/** The room is read again this often anyway (a file written by the agent sends no event), while the tab is visible. */
const BACKSTOP_MS = 10_000;
const RECONNECT_MS = 3_000;

export type LiveRoomState =
  | { status: "loading" }
  | { status: "ready"; room: LiveRoom }
  | { status: "error"; message: string };

/**
 * Loads GET /api/live, then reads it again after the settle delay on the run
 * events of GET /api/events (a run starts or ends, a call to hq_status or
 * hq_show, and their results), every 10 seconds while the tab is visible, and
 * when the tab comes back. `version` counts the reads (the detail panel
 * follows it), `now` is a clock ticking every second, `connected` tells
 * whether the stream is open.
 */
export function useLiveRoom(): { state: LiveRoomState; version: number; now: number; connected: boolean; retry: () => void } {
  const [state, setState] = useState<LiveRoomState>({ status: "loading" });
  const [version, setVersion] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [connected, setConnected] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const sequence = useRef(0);

  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(clock);
  }, []);

  useEffect(() => {
    let closed = false;
    let source: EventSource | null = null;
    let settle: ReturnType<typeof setTimeout> | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    const tracked = new Set<string>();

    const load = async () => {
      const mine = ++sequence.current;
      try {
        const room = await fetchLiveRoom();
        if (closed || mine !== sequence.current) return;
        setState({ status: "ready", room });
        setVersion((value) => value + 1);
      } catch (error) {
        if (closed || mine !== sequence.current) return;
        setState((current) => (current.status === "ready" ? current : { status: "error", message: errorText(error) }));
      }
    };
    const soon = () => {
      clearTimeout(settle);
      settle = setTimeout(() => void load(), SETTLE_MS);
    };

    const connect = () => {
      const stream = new EventSource("/api/events");
      source = stream;
      stream.addEventListener("run", soon);
      stream.addEventListener("event", (message) => {
        try {
          const event = JSON.parse((message as MessageEvent<string>).data) as { type?: unknown; data?: unknown };
          if (typeof event.type !== "string" || !event.data || typeof event.data !== "object") return;
          if (wantsReload({ type: event.type, data: event.data as Record<string, unknown> }, tracked)) soon();
        } catch {
          // A malformed message is skipped, the stream goes on.
        }
      });
      stream.onopen = () => setConnected(true);
      stream.onerror = () => {
        stream.close();
        setConnected(false);
        if (closed) return;
        // Something may have changed while the stream was down.
        reconnect = setTimeout(() => {
          connect();
          void load();
        }, RECONNECT_MS);
      };
    };

    void load();
    connect();
    const backstop = setInterval(() => {
      if (!document.hidden) void load();
    }, BACKSTOP_MS);
    const onVisible = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      closed = true;
      source?.close();
      clearTimeout(settle);
      clearTimeout(reconnect);
      clearInterval(backstop);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((value) => value + 1);
  }, []);

  return { state, version, now, connected, retry };
}
