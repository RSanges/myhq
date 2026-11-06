"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, errorText, runDeskAction } from "./api";
import { formatLongDay, localDayKey } from "./format";
import type { DeskItem, DeskObject } from "./schemas";
import { strings } from "./strings";
import { buttonClass, ErrorNote, fieldClass } from "./ui";

// The post-its: one note per item of the object's list, the late ones marked.
// When the home gives the object actions (myhq.json `desk`, `actions`), the
// page also adds a post-it and checks one off: « Fait » hides the note at
// once and waits a few seconds before it tells the home, so that a slip of the
// finger can be taken back.

const t = strings.deskModules.postits;

/** How long a post-it checked off can still be taken back. */
export const UNDO_MS = 6_000;

const TILTS = ["-rotate-1", "rotate-1", "rotate-0", "-rotate-[0.6deg]", "rotate-[0.8deg]"];

function dueLine(item: DeskItem, today: string): string | null {
  if (!item.at) return null;
  const key = localDayKey(item.at);
  if (!key) return null;
  if (key < today || item.tone === "alert") return t.overdue(formatLongDay(key));
  if (key === today) return t.today;
  return t.due(formatLongDay(key));
}

/** What an action said when it failed: the home's own words when its command refused, ours otherwise. */
function failureText(error: unknown): string {
  return error instanceof ApiError && error.code === "ACTION_FAILED" && error.message ? error.message : errorText(error);
}

type Waiting = { id: string; title: string; timer: ReturnType<typeof setTimeout> };

export function PostitsView({ object, onChange }: { object: DeskObject; onChange: () => void }) {
  const today = localDayKey(new Date()) ?? "";
  const canAdd = object.actions.includes("add");
  const canTick = object.actions.includes("done");

  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [added, setAdded] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** Post-its checked off and hidden, until the list read again no longer has them. */
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  /** The ones still waiting to be sent, with their « Annuler ». */
  const [waiting, setWaiting] = useState<Waiting[]>([]);
  const timers = useRef(new Map<string, Waiting>());
  const input = useRef<HTMLInputElement>(null);

  // Once the list read again no longer has a hidden post-it, forget it (adjusted while rendering, not in an effect).
  const [listed, setListed] = useState(object.items);
  if (listed !== object.items) {
    setListed(object.items);
    const ids = new Set(object.items.map((item) => item.id));
    const kept = [...hidden].filter((id) => ids.has(id));
    if (kept.length !== hidden.size) setHidden(new Set(kept));
  }

  const send = useCallback(
    (id: string, title: string, keepalive = false) => {
      runDeskAction(object.id, "done", { id }, keepalive)
        .catch((error: unknown) => {
          setHidden((current) => new Set([...current].filter((each) => each !== id)));
          setProblem(`${t.done.failed(title)} ${failureText(error)}`);
        })
        .finally(onChange);
    },
    [object.id, onChange],
  );

  // Leaving the page (or the tab) sends what is still waiting: a post-it checked off is not lost.
  useEffect(() => {
    const pending = timers.current;
    const flush = () => {
      for (const each of pending.values()) {
        clearTimeout(each.timer);
        send(each.id, each.title, true);
      }
      pending.clear();
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [send]);

  const tick = (item: DeskItem) => {
    setProblem(null);
    setAdded(false);
    setHidden((current) => new Set(current).add(item.id));
    const entry: Waiting = {
      id: item.id,
      title: item.title,
      timer: setTimeout(() => {
        timers.current.delete(item.id);
        setWaiting((current) => current.filter((each) => each.id !== item.id));
        send(item.id, item.title);
      }, UNDO_MS),
    };
    timers.current.set(item.id, entry);
    setWaiting((current) => [...current, entry]);
  };

  const undo = (id: string) => {
    const entry = timers.current.get(id);
    if (entry) clearTimeout(entry.timer);
    timers.current.delete(id);
    setWaiting((current) => current.filter((each) => each.id !== id));
    setHidden((current) => new Set([...current].filter((each) => each !== id)));
  };

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    setProblem(null);
    setAdded(false);
    try {
      await runDeskAction(object.id, "add", { text: value });
      setText("");
      setAdded(true);
      onChange();
    } catch (error) {
      setProblem(`${t.add.failed} ${failureText(error)}`);
    } finally {
      setSending(false);
      input.current?.focus();
    }
  };

  const visible = object.items.filter((item) => !hidden.has(item.id));
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">{canAdd || canTick ? t.hintActions : t.hint}</p>
      {object.note && <p className="text-xs text-muted">{object.note}</p>}
      {canAdd && (
        <form onSubmit={add} className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <label className="min-w-0 flex-1 space-y-1">
            <span className="text-sm font-medium">{t.add.label}</span>
            <input
              ref={input}
              type="text"
              value={text}
              maxLength={300}
              autoComplete="off"
              enterKeyHint="send"
              placeholder={t.add.placeholder}
              onChange={(event) => {
                setText(event.target.value);
                setAdded(false);
              }}
              className={`${fieldClass} min-h-10 pointer-coarse:min-h-12`}
            />
          </label>
          <button type="submit" disabled={sending || text.trim() === ""} className={buttonClass("primary")}>
            {sending ? t.add.sending : t.add.button}
          </button>
        </form>
      )}
      <div role="status" className="space-y-2 empty:hidden">
        {added && <p className="text-sm text-ok">{t.add.added}</p>}
        {waiting.map((each) => (
          <p key={each.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-soft px-3 py-2 text-sm">
            <span className="min-w-0 break-words">{t.done.gone(each.title)}</span>
            <button type="button" className={buttonClass()} onClick={() => undo(each.id)}>
              {t.done.undo}
            </button>
          </p>
        ))}
      </div>
      {problem && <ErrorNote>{problem}</ErrorNote>}
      {visible.length === 0 ? (
        <p className="text-sm text-muted">{t.empty}</p>
      ) : (
        <ul className="grid grid-cols-1 gap-4 min-[24rem]:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {visible.map((item, index) => {
            const due = dueLine(item, today);
            const late = item.tone === "alert";
            return (
              <li
                key={item.id}
                className={`flex min-h-36 flex-col gap-2 rounded-sm bg-yellow-100 p-4 text-stone-900 shadow-md motion-safe:transition-transform motion-safe:hover:rotate-0 ${TILTS[index % TILTS.length]} ${
                  late ? "border-t-4 border-red-600" : item.tone === "warn" ? "border-t-4 border-amber-500" : "border-t-4 border-yellow-200"
                }`}
              >
                <span className="text-xs font-semibold text-stone-500">{index + 1}</span>
                <span className="font-medium break-words">{item.title}</span>
                {item.body && <span className="text-sm break-words text-stone-700">{item.body}</span>}
                {due && <span className={`mt-auto text-xs font-semibold ${late ? "text-red-700" : "text-stone-600"}`}>{due}</span>}
                {canTick && (
                  <label className={`flex min-h-11 cursor-pointer items-center gap-2 text-sm font-medium ${due ? "" : "mt-auto"}`}>
                    <input
                      type="checkbox"
                      checked={false}
                      aria-label={t.done.labelFor(item.title)}
                      onChange={() => tick(item)}
                      className="size-5 cursor-pointer accent-stone-800"
                    />
                    {t.done.label}
                  </label>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
