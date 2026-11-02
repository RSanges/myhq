"use client";

import { useEffect, useState } from "react";
import type { Roadmap } from "@/server/roadmap-schema";
import { ApiError, errorText, fetchRoadmap } from "./api";

export type RoadmapState =
  | { status: "loading" }
  | { status: "ready"; roadmap: Roadmap }
  | { status: "missing" }
  | { status: "error"; message: string };

/**
 * Loads GET /api/roadmap once, then again on every `roadmap` event of
 * GET /api/events (and when the stream comes back after a drop, since a change
 * may have been missed). A failed reload replaces the page with its reason.
 */
export function useRoadmap(): { state: RoadmapState; retry: () => void } {
  const [state, setState] = useState<RoadmapState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let closed = false;
    let sequence = 0;
    let dropped = false;

    const load = async () => {
      const mine = ++sequence;
      try {
        const roadmap = await fetchRoadmap();
        if (!closed && mine === sequence) setState({ status: "ready", roadmap });
      } catch (error) {
        if (closed || mine !== sequence) return;
        if (error instanceof ApiError && error.code === "ROADMAP_NOT_FOUND") setState({ status: "missing" });
        else setState({ status: "error", message: errorText(error) });
      }
    };

    void load();
    const source = new EventSource("/api/events");
    source.addEventListener("roadmap", () => void load());
    source.onerror = () => {
      dropped = true;
    };
    source.onopen = () => {
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

  return {
    state,
    retry: () => {
      setState({ status: "loading" });
      setAttempt((value) => value + 1);
    },
  };
}
