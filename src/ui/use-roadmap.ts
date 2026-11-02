"use client";

import { useEffect, useState } from "react";
import type { Roadmap } from "@/server/roadmap-schema";
import { ApiError, errorText, fetchRoadmap } from "./api";
import { diffRoadmap } from "./roadmap-model";

export type RoadmapState =
  | { status: "loading" }
  /** `changed` holds the keys (see roadmap-model) that differ from the previous load, for a few seconds. */
  | { status: "ready"; roadmap: Roadmap; changed: ReadonlySet<string> }
  | { status: "missing" }
  | { status: "error"; message: string };

/** How long a changed row or number stays highlighted. */
const highlightMs = 3_200;

const nothingChanged: ReadonlySet<string> = new Set();

/**
 * Loads GET /api/roadmap once, then again on every `roadmap` event of
 * GET /api/events (and when the stream comes back after a drop, since a change
 * may have been missed). A failed reload replaces the page with its reason.
 *
 * `pulse` counts the `roadmap` events received (it drives the live indicator),
 * `connected` tells whether the stream is open.
 */
export function useRoadmap(): { state: RoadmapState; retry: () => void; pulse: number; connected: boolean } {
  const [state, setState] = useState<RoadmapState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [pulse, setPulse] = useState(0);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let closed = false;
    let sequence = 0;
    let dropped = false;

    const load = async () => {
      const mine = ++sequence;
      try {
        const roadmap = await fetchRoadmap();
        if (closed || mine !== sequence) return;
        setState((previous) => ({
          status: "ready",
          roadmap,
          changed: previous.status === "ready" ? diffRoadmap(previous.roadmap, roadmap) : nothingChanged,
        }));
      } catch (error) {
        if (closed || mine !== sequence) return;
        if (error instanceof ApiError && error.code === "ROADMAP_NOT_FOUND") setState({ status: "missing" });
        else setState({ status: "error", message: errorText(error) });
      }
    };

    void load();
    const source = new EventSource("/api/events");
    source.addEventListener("roadmap", () => {
      setPulse((value) => value + 1);
      void load();
    });
    source.onerror = () => {
      dropped = true;
      setConnected(false);
    };
    source.onopen = () => {
      setConnected(true);
      if (dropped) {
        dropped = false;
        void load();
      }
    };

    return () => {
      closed = true;
      source.close();
    };
  }, [attempt]);

  // Highlights fade on their own: clear them after a moment so that the next
  // change can play the animation again.
  useEffect(() => {
    if (state.status !== "ready" || state.changed.size === 0) return;
    const changed = state.changed;
    const timer = setTimeout(() => {
      setState((current) =>
        current.status === "ready" && current.changed === changed
          ? { ...current, changed: nothingChanged }
          : current,
      );
    }, highlightMs);
    return () => clearTimeout(timer);
  }, [state]);

  return {
    state,
    pulse,
    connected,
    retry: () => {
      setState({ status: "loading" });
      setAttempt((value) => value + 1);
    },
  };
}
