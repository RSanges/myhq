"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { errorText, fetchQueue, moveQueued } from "./api";
import { formatAge } from "./format";
import type { DeskSignal, Queue } from "./schemas";
import { strings } from "./strings";
import { Badge, buttonClass, ErrorNote, Section } from "./ui";

const t = strings.queue;
/** Several signals in a row (the stream opening, then a count) make one request, as for the desk. */
const RELOAD_DEBOUNCE_MS = 250;
const MOVES = ["first", "up", "down", "auto"] as const;
type Move = (typeof MOVES)[number];

/**
 * The queue (GET /api/queue), read on mount and again at each signal of the
 * desk's stream: its counts carry what the queue looks like (desk.ts), so a
 * task that comes, leaves or moves, a run that starts or ends, reads it again.
 */
function useQueue(subscribe: (listener: (signal: DeskSignal) => void) => () => void) {
  const [queue, setQueue] = useState<Queue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const schedule = useRef<() => void>(() => undefined);
  useEffect(() => {
    let closed = false;
    let sequence = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const mine = ++sequence;
      try {
        const next = await fetchQueue();
        if (closed || mine !== sequence) return;
        setQueue(next);
        setError(null);
      } catch (failure) {
        if (!closed && mine === sequence) setError(errorText(failure));
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
  return { queue, setQueue, error };
}

/** What waits for a run, in the order MyHQ serves it, with the owner's controls. Shown only when something waits. */
export function QueuePanel({ subscribe }: { subscribe: (listener: (signal: DeskSignal) => void) => () => void }) {
  const { queue, setQueue, error } = useQueue(subscribe);
  const [moving, setMoving] = useState<number | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const move = useCallback(
    async (taskId: number, how: Move) => {
      setMoving(taskId);
      setMoveError(null);
      try {
        setQueue(await moveQueued(taskId, how));
      } catch (failure) {
        setMoveError(`${t.failed} ${errorText(failure)}`);
      } finally {
        setMoving(null);
      }
    },
    [setQueue],
  );
  if (!queue || queue.tasks.length === 0) return error ? <ErrorNote>{`${t.loadFailed} ${error}`}</ErrorNote> : null;
  const label: Record<Move, string> = { first: t.first, up: t.up, down: t.down, auto: t.auto };
  const { machine } = queue;
  return (
    <Section title={t.title(queue.tasks.length)}>
      <p className="text-xs text-muted">{t.hint}</p>
      {machine && (
        <p className="text-xs text-muted tabular-nums">
          {t.machine({
            ramFree: machine.ramFreeGb,
            vram:
              machine.vramUsedGb === null || machine.vramTotalGb === null
                ? t.vramUnknown
                : t.vram(Math.round((machine.vramTotalGb - machine.vramUsedGb) * 100) / 100),
          })}
        </p>
      )}
      {moveError && <ErrorNote>{moveError}</ErrorNote>}
      <ol className="divide-y divide-line rounded-md border border-line text-sm">
        {queue.tasks.map((task, index) => (
          <li key={task.taskId} className="min-w-0 space-y-1 px-3 py-2">
            <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="font-medium tabular-nums">{index + 1}.</span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ background: task.roomColor ?? "var(--muted)" }} aria-hidden="true" />
                {task.roomLabel ?? task.room} / {task.agentName}
              </span>
              {task.subject && <span className="text-muted">« {task.subject} »</span>}
              <span className="text-muted">{t.since(formatAge(task.since))}</span>
              {task.placed && <Badge tone="accent">{t.placed}</Badge>}
            </p>
            <p className="break-words">{task.summary}</p>
            <p className="break-words text-muted">{task.reason}</p>
            <div className="flex flex-wrap gap-2 pt-1">
              {MOVES.map((how) => (
                <button
                  key={how}
                  type="button"
                  className={buttonClass()}
                  disabled={moving !== null || (how === "auto" && !task.placed) || (how === "first" && index === 0 && task.placed) || (how === "up" && index === 0) || (how === "down" && index === queue.tasks.length - 1)}
                  aria-label={t.moveLabel(label[how], task.taskId)}
                  onClick={() => void move(task.taskId, how)}
                >
                  {label[how]}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ol>
    </Section>
  );
}
