"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { errorText, fetchDesk } from "./api";
import type { Desk, DeskSignal } from "./schemas";

/** Several signals in a row (the stream opening, then a count) make one request. */
const RELOAD_DEBOUNCE_MS = 250;

export type DeskData = {
  desk: Desk | null;
  loadError: string | null;
  /** Reads GET /api/desk again (after an action of the page, or the « Actualiser » button). */
  reload: () => void;
};

/**
 * The objects of the desk (GET /api/desk), read on mount, then again each
 * time the stream opens (`ready`) and each time a count changes (`desk`
 * event): the counts move live, and the items with them.
 */
export function useDesk(subscribe: (listener: (signal: DeskSignal) => void) => () => void): DeskData {
  const [desk, setDesk] = useState<Desk | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const schedule = useRef<() => void>(() => undefined);

  useEffect(() => {
    let closed = false;
    let sequence = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const mine = ++sequence;
      try {
        const next = await fetchDesk();
        if (closed || mine !== sequence) return;
        setDesk(next);
        setLoadError(null);
      } catch (error) {
        if (!closed && mine === sequence) setLoadError(errorText(error));
      }
    };
    schedule.current = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void load(), RELOAD_DEBOUNCE_MS);
    };
    void load();
    const unsubscribe = subscribe(() => schedule.current());
    return () => {
      closed = true;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [subscribe]);

  const reload = useCallback(() => schedule.current(), []);
  return { desk, loadError, reload };
}
