"use client";

import Link from "next/link";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { recentRuns } from "./agent-runs";
import { localDay, sheetState, threadLines, type SheetState, type ThreadLine } from "./agent-thread-model";
import { errorText, startRun } from "./api";
import { approvalHash, DESK_PATH, runHash } from "./deep-link";
import { FeedRow } from "./feed";
import { formatClock, formatCost, formatDateTime, formatDuration, formatShortDay } from "./format";
import { Markdown } from "./markdown-view";
import { roleFileName, type Action, type FeedEntry, type TeamAgent } from "./model";
import { chipStyle } from "./room-color";
import type { AgentQuestion, HqEvent } from "./schemas";
import { strings } from "./strings";
import { Routines } from "./team";
import { buttonClass, ErrorNote } from "./ui";
import { useAgentThread } from "./use-agent-thread";
import { useMediaQuery } from "./use-media-query";

const t = strings.room.sheet;

/** The longest message, as the API takes it (agent-questions.ts QUESTION_MAX_CHARS). */
const MESSAGE_MAX_CHARS = 4_000;

/**
 * Focus for a sheet: what opened it is remembered, `first` gets the focus when
 * it opens, and the focus goes back when it closes. Escape calls `onEscape`.
 */
function useSheetFocus(first: { current: HTMLElement | null }, onEscape: () => void) {
  const onEscapeRef = useRef(onEscape);
  useEffect(() => {
    onEscapeRef.current = onEscape;
  });
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    first.current?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onEscapeRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener?.focus();
    };
    // The element to focus is read once, when the sheet opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/**
 * The shell of a sheet: a side panel on a wide screen, the whole screen on a
 * phone (see .room-sheet), with a title and a close button. Focus goes in when
 * it opens and back to what opened it when it closes; Escape closes.
 */
export function SheetShell({
  label,
  title,
  lead,
  onClose,
  children,
}: {
  label: string;
  title: string;
  /** Shown before the title (a room's logo). */
  lead?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useSheetFocus(closeRef, onClose);

  return (
    <aside className="room-sheet" role="dialog" aria-label={label}>
      <div className="room-sheet-head">
        <div className="flex min-w-0 items-center gap-2">
          {lead}
          <h2 className="wall-display min-w-0 break-words text-lg font-semibold">{title}</h2>
        </div>
        <button ref={closeRef} type="button" className={buttonClass()} onClick={onClose}>
          {t.close}
        </button>
      </div>
      <div className="room-sheet-body">{children}</div>
    </aside>
  );
}

function stateText(state: SheetState): string {
  switch (state.kind) {
    case "working":
      return state.activity ? t.state.workingOn(state.activity) : t.state.working;
    case "waiting":
      return t.state.waiting(state.resources);
    default:
      return t.state[state.kind];
  }
}

/** « Aujourd'hui », « Hier », else the date. */
function dayLabel(day: string, now: number): string {
  const today = localDay(new Date(now).toISOString());
  const yesterday = localDay(new Date(now - 86_400_000).toISOString());
  return day === today ? t.thread.today : day === yesterday ? t.thread.yesterday : formatShortDay(day);
}

const Icon = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" className="agent-icon">
    {children}
  </svg>
);

/** The anchor of a run's line in the thread. */
export const threadRunId = (id: number): string => `agent-thread-run-${id}`;

/** Brings the line of a run into view, unfolded. */
function showRun(id: number) {
  const line = document.getElementById(threadRunId(id));
  if (!line) return;
  const details = line.querySelector("details");
  if (details) details.open = true;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  line.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
  line.querySelector("summary")?.focus();
}

/** What the thread lets the owner do with a proposed run. */
type Decide = {
  onDecide: (questionId: number, action: "launch" | "dismiss") => Promise<void>;
  /** The question whose proposal is being decided, if any. */
  deciding: number | null;
  /** The agent has a run in progress: a new one would be refused. */
  working: boolean;
};

/**
 * The card under an answer that proposes a run: the task, then « Lancer le
 * tour » or « On en parle d'abord ». Once decided it says what became of it,
 * after a reload too.
 */
function ProposalCard({
  questionId,
  proposal,
  name,
  decide,
}: {
  questionId: number;
  proposal: NonNullable<AgentQuestion["proposal"]>;
  name: string;
  decide: Decide;
}) {
  const p = t.thread.proposal;
  const busy = decide.deciding === questionId;
  return (
    <section className="agent-proposal" data-state={proposal.state} aria-label={p.label}>
      <p className="agent-proposal-lead">{p.lead}</p>
      <p className="agent-proposal-task">{proposal.task}</p>
      {proposal.state === "pending" ? (
        <>
          <div className="agent-proposal-actions">
            <button
              type="button"
              className="chat-btn chat-btn-primary"
              disabled={busy || decide.working}
              onClick={() => void decide.onDecide(questionId, "launch")}
            >
              {busy ? p.launching : p.launch}
            </button>
            <button type="button" className="chat-btn" disabled={busy} onClick={() => void decide.onDecide(questionId, "dismiss")}>
              {p.talk}
            </button>
          </div>
          {decide.working && <p className="agent-proposal-note">{p.busy(name)}</p>}
        </>
      ) : proposal.state === "launched" ? (
        <p className="agent-proposal-note" role="status">
          <span className="agent-proposal-done">{p.launched(proposal.runId)}</span>
          {proposal.runId !== null && (
            <>
              {" "}
              <button type="button" className="agent-link" onClick={() => showRun(proposal.runId!)}>
                {p.seeRun}
              </button>
            </>
          )}
        </p>
      ) : (
        <p className="agent-proposal-note" role="status">
          {p.dismissed}
        </p>
      )}
    </section>
  );
}

/** One line of the thread. */
function Line({ line, name, now, decide }: { line: ThreadLine; name: string; now: number; decide: Decide }) {
  switch (line.kind) {
    case "day":
      return (
        <li className="agent-day">
          <span>{dayLabel(line.day, now)}</span>
        </li>
      );
    case "mine":
      return (
        <li className="chat-msg" data-role="user">
          <p className="chat-msg-meta">
            <span className="chat-msg-who">{t.thread.you}</span>
            <span>{formatClock(line.at)}</span>
          </p>
          <p className="chat-msg-text">{line.text}</p>
        </li>
      );
    case "reply":
      return (
        <li className="chat-msg" data-role="assistant">
          <p className="chat-msg-meta">
            <span className="chat-msg-who">{name}</span>
            {line.state !== "thinking" && <span>{formatClock(line.at)}</span>}
            {line.state !== "thinking" && line.costUsd > 0 && <span>{formatCost(line.costUsd)}</span>}
          </p>
          {line.state === "thinking" ? (
            <p className="chat-typing agent-typing" role="status">
              <span className="chat-typing-dots" aria-hidden>
                <i />
                <i />
                <i />
              </span>
              {t.thread.thinking(name)}
            </p>
          ) : line.state === "answer" && line.text !== null ? (
            <>
              {line.text !== "" && (
                <div className="chat-msg-text agent-answer">
                  <Markdown source={line.text} />
                </div>
              )}
              {line.proposal && <ProposalCard questionId={line.questionId} proposal={line.proposal} name={name} decide={decide} />}
            </>
          ) : (
            <p className="chat-error">{t.thread.failed[line.error ?? "error"] ?? t.thread.failed.error}</p>
          )}
        </li>
      );
    case "run": {
      const { run } = line;
      const meta = t.thread.runMeta({
        time: formatClock(run.startedAt),
        duration: line.durationMs === null ? null : formatDuration(line.durationMs),
        cost: run.status !== "running" && run.costUsd > 0 ? formatCost(run.costUsd) : null,
      });
      return (
        <li className="agent-event" data-kind="run" data-status={run.status} id={threadRunId(run.id)}>
          <details>
            <summary>
              <span className="agent-event-mark" aria-hidden />
              <span className="agent-event-main">
                <span className="agent-event-title">
                  {t.thread.run(run.id)} <span className="agent-event-status">{t.thread.runStatus[run.status]}</span>
                </span>
                <span className="agent-event-meta">{meta}</span>
                {line.tail && <span className="agent-event-tail">{line.tail}</span>}
              </span>
            </summary>
            <div className="agent-event-more">
              <p className="agent-event-label">{t.thread.runSummary}</p>
              {run.summary ? (
                <div className="agent-event-summary">
                  <Markdown source={run.summary} />
                </div>
              ) : (
                <p className="text-muted">{t.thread.noSummary}</p>
              )}
              <p className="agent-event-label">{t.thread.runTask}</p>
              <p className="agent-event-task">{run.task}</p>
              <Link className="agent-link" href={`${DESK_PATH}${runHash(run.id)}`}>
                {t.thread.openRun}
              </Link>
            </div>
          </details>
        </li>
      );
    }
    case "item": {
      const { item } = line;
      const href = `${DESK_PATH}${approvalHash(item.id)}`;
      return (
        <li className="agent-event" data-kind={line.waiting ? "ask" : "item"} data-status={item.status}>
          <div className="agent-event-row">
            <span className="agent-event-mark" aria-hidden />
            <span className="agent-event-main">
              <span className="agent-event-title">{line.waiting ? t.thread.askWaiting : t.thread.item}</span>
              <span className="agent-event-item">« {item.title} »</span>
              <span className="agent-event-meta">
                {formatClock(item.createdAt)} · {strings.desk.decision[item.status] ?? item.status}
              </span>
            </span>
            <Link className={line.waiting ? "chat-btn chat-btn-primary agent-event-action" : "agent-link"} href={href}>
              {line.waiting ? t.thread.answer : t.thread.openItem}
            </Link>
          </div>
        </li>
      );
    }
  }
}

/** The technical side of the agent, behind the gear: its run without a task, its card, its routines, its journal. */
function AgentSettings({
  agent,
  events,
  dispatch,
  headingId,
}: {
  agent: TeamAgent;
  events: HqEvent[];
  dispatch: (action: Action) => void;
  headingId: string;
}) {
  const runs = useMemo(() => recentRuns(events, agent.key, agent.lastRun), [events, agent.key, agent.lastRun]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<number | null>(null);

  const launch = async () => {
    setBusy(true);
    setError(null);
    setStarted(null);
    try {
      const created = await startRun(agent.room, agent.id, "");
      dispatch({ type: "run", run: created });
      setStarted(created.id);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="agent-settings" role="region" aria-labelledby={headingId}>
      <h3 id={headingId} className="sr-only">
        {t.settings.label(agent.name)}
      </h3>
      <section className="agent-settings-card">
        <h4 className="agent-settings-title">{t.settings.routine}</h4>
        <p className="text-sm text-muted">{t.settings.routineLead}</p>
        <button
          type="button"
          className={buttonClass()}
          disabled={busy || agent.state === "working"}
          onClick={() => void launch()}
        >
          {busy ? strings.team.starting : t.settings.routineButton}
        </button>
        {error && <ErrorNote>{error}</ErrorNote>}
        {started !== null && !error && (
          <p role="status" className="text-sm text-ok">
            {strings.team.runStarted(started)}
          </p>
        )}
      </section>

      <section className="agent-settings-card">
        <h4 className="agent-settings-title">{t.settings.identity}</h4>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted">{strings.team.role}</dt>
          <dd className="break-all font-mono text-xs leading-5">{roleFileName(agent.role)}</dd>
          <dt className="text-muted">{strings.team.model}</dt>
          <dd>{agent.model}</dd>
          <dt className="text-muted">{t.tools}</dt>
          <dd className="flex flex-wrap gap-1">
            {agent.allowedTools.length === 0 ? (
              <span className="text-muted">{t.noTools}</span>
            ) : (
              agent.allowedTools.map((tool) => (
                <code key={tool} className="rounded bg-soft px-1.5 py-0.5 font-mono text-xs break-all">
                  {tool}
                </code>
              ))
            )}
          </dd>
          {(agent.resources?.length ?? 0) > 0 && (
            <>
              <dt className="text-muted">{strings.studio.resources}</dt>
              <dd>{agent.resources?.join(", ")}</dd>
            </>
          )}
        </dl>
      </section>

      {agent.routines.length > 0 && (
        <section className="agent-settings-card">
          <Routines agent={agent} dispatch={dispatch} />
        </section>
      )}

      <section className="agent-settings-card">
        <h4 className="agent-settings-title">{t.settings.journal}</h4>
        {runs.length === 0 ? (
          <p className="text-sm text-muted">{t.settings.noRuns}</p>
        ) : (
          <ul className="space-y-2">
            {runs.map((run) => (
              <li key={run.runId}>
                <details className="rounded-lg border border-line bg-card px-3 py-2">
                  <summary className="cursor-pointer text-sm">
                    <span className="font-medium">
                      {t.settings.journalRun({
                        id: run.runId,
                        status: strings.team.runStatus[run.status],
                        date: formatDateTime(run.startedAt),
                      })}
                    </span>
                    <span className="text-muted">
                      {run.costUsd !== null && run.costUsd > 0 ? `, ${t.runCost(formatCost(run.costUsd))}` : ""}
                      {`, ${t.settings.events(run.events.length)}`}
                    </span>
                  </summary>
                  <ul className="mt-2 max-h-80 space-y-2 overflow-y-auto pr-1">
                    {run.events.map((event) => {
                      const entry: FeedEntry = {
                        key: `event:${event.id}`,
                        at: event.createdAt,
                        room: event.room,
                        kind: "event",
                        event,
                      };
                      return <FeedRow key={entry.key} entry={entry} />;
                    })}
                  </ul>
                </details>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * The sheet of an agent, opened from its character or its chip under the
 * floor: a conversation with it. The header says who it is and what it is
 * doing; the thread mixes the owner's messages, its answers (a question is
 * answered without a run), its runs in one line and the items it submitted;
 * one field at the bottom writes to it. The gear opens the technical side.
 * A side panel on a wide screen, the whole screen under 48rem.
 */
export function AgentSheet({
  agent,
  events,
  dispatch,
  onClose,
  asleep = false,
  refreshKey = "",
}: {
  agent: TeamAgent;
  events: HqEvent[];
  dispatch: (action: Action) => void;
  onClose: () => void;
  /** The floor shows it asleep. */
  asleep?: boolean;
  /** Changes when something the thread shows may have changed (an item of the agent, for one). */
  refreshKey?: string;
}) {
  const ids = useId();
  const [settings, setSettings] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [resetting, setResetting] = useState(false);
  const wide = useMediaQuery("(min-width: 48rem)");
  const backRef = useRef<HTMLButtonElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const gearRef = useRef<HTMLButtonElement>(null);
  // On a phone the keyboard would cover the thread: the focus goes to the way back instead of the field.
  useSheetFocus(
    {
      get current() {
        return (window.matchMedia("(min-width: 48rem)").matches ? fieldRef.current : backRef.current) ?? null;
      },
    },
    () => {
      if (settings) {
        setSettings(false);
        gearRef.current?.focus();
      } else onClose();
    },
  );

  const runKey = agent.lastRun ? `${agent.lastRun.id}:${agent.lastRun.status}` : "";
  const { thread, readAt, error, busy, send, decide, reset } = useAgentThread(agent.room, agent.id, `${runKey}|${refreshKey}`);
  // The clock of the durations: when the thread was read, and every half minute while a run goes on.
  const [clock, setClock] = useState(0);
  const working = agent.state === "working";
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [working]);
  const now = Math.max(readAt, clock);
  const lines = useMemo(() => (thread ? threadLines(thread.entries, now) : []), [thread, now]);
  const state = sheetState({
    answering: busy,
    working,
    failed: agent.state === "failed",
    asleep,
    activity: null,
    waitingFor: agent.waitingFor ?? [],
  });

  // The thread opens on its latest line, and follows new ones while it is read at the bottom.
  const atBottom = useRef(true);
  useLayoutEffect(() => {
    const log = logRef.current;
    if (log && atBottom.current) log.scrollTop = log.scrollHeight;
  }, [lines.length, busy, settings]);

  const submit = async () => {
    const text = draft.trim();
    if (text === "" || busy || sending) return;
    setSending(true);
    setDraft("");
    const ok = await send(text);
    if (!ok) setDraft((current) => (current === "" ? text : current));
    atBottom.current = true;
    setSending(false);
    fieldRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  // « Lancer le tour »: the run joins the page's model at once, so the floor and the header follow it.
  const [deciding, setDeciding] = useState<number | null>(null);
  const decision: Decide = {
    deciding,
    working,
    onDecide: async (questionId, action) => {
      setDeciding(questionId);
      const run = await decide(questionId, action);
      if (run) dispatch({ type: "run", run });
      setDeciding(null);
    },
  };

  const clear = async () => {
    setResetting(true);
    await reset();
    setResetting(false);
  };

  const tint = chipStyle(agent.color);
  const hasMessages = lines.some((line) => line.kind === "mine");

  return (
    <aside className="room-sheet agent-sheet" role="dialog" aria-label={t.label(agent.name)}>
      <header className="agent-sheet-head">
        <button
          ref={backRef}
          type="button"
          className="agent-head-btn agent-back"
          aria-label={t.backLabel}
          onClick={onClose}
        >
          <Icon>
            <path d="M15 5l-7 7 7 7" />
          </Icon>
          <span>{t.back}</span>
        </button>
        <span className="agent-avatar" data-tint={tint ? "" : undefined} style={tint ?? undefined} aria-hidden>
          {agent.name.slice(0, 1).toUpperCase()}
        </span>
        <div className="agent-who">
          <h2 className="agent-name wall-display">{agent.name}</h2>
          <p className="agent-state" data-state={state.kind} role="status">
            <span className="agent-state-dot" aria-hidden />
            <span className="agent-state-room">{agent.room}</span>
            <span className="agent-state-text">{stateText(state)}</span>
          </p>
        </div>
        <button
          ref={gearRef}
          type="button"
          className="agent-head-btn"
          aria-expanded={settings}
          aria-controls={`${ids}-settings`}
          aria-label={t.settings.label(agent.name)}
          title={t.settings.open}
          onClick={() => setSettings(!settings)}
        >
          <Icon>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
          </Icon>
        </button>
        <button type="button" className="agent-head-btn agent-close" aria-label={t.close} title={t.close} onClick={onClose}>
          <Icon>
            <path d="M6 6l12 12M18 6L6 18" />
          </Icon>
        </button>
      </header>

      {settings ? (
        <div id={`${ids}-settings`} className="agent-settings-wrap">
          <button
            type="button"
            className="agent-link agent-settings-back"
            onClick={() => {
              setSettings(false);
              gearRef.current?.focus();
            }}
          >
            {t.settings.back}
          </button>
          <AgentSettings agent={agent} events={events} dispatch={dispatch} headingId={`${ids}-settings-title`} />
        </div>
      ) : (
        <>
          <div
            ref={logRef}
            className="chat-log agent-log"
            role="log"
            aria-label={t.thread.label(agent.name)}
            onScroll={(event) => {
              const log = event.currentTarget;
              atBottom.current = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
            }}
          >
            {thread === null && !error && <p className="chat-note">{t.thread.loading}</p>}
            {thread !== null && lines.length === 0 && <p className="agent-empty">{t.thread.empty(agent.name)}</p>}
            <ul className="chat-msgs">
              {lines.map((line) => (
                <Line key={line.key} line={line} name={agent.name} now={now} decide={decision} />
              ))}
            </ul>
          </div>

          <form
            className="chat-composer agent-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {error && (
              <p className="chat-error" role="alert">
                {error}
              </p>
            )}
            <label htmlFor={`${ids}-field`} className="sr-only">
              {t.composer.label(agent.name)}
            </label>
            <div className="agent-composer-row">
              <textarea
                ref={fieldRef}
                id={`${ids}-field`}
                className="chat-input"
                rows={1}
                value={draft}
                maxLength={MESSAGE_MAX_CHARS}
                placeholder={t.composer.placeholder(agent.name)}
                aria-describedby={`${ids}-hint`}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={onKeyDown}
              />
              <button
                type="submit"
                className="agent-send"
                disabled={busy || sending || draft.trim() === ""}
                aria-label={sending ? t.composer.sending : t.composer.send}
                title={t.composer.send}
              >
                <Icon>
                  <path d="M5 12h13M13 6l6 6-6 6" />
                </Icon>
              </button>
            </div>
            <div className="chat-composer-foot">
              <p id={`${ids}-hint`} className="chat-hint">
                {busy ? t.composer.busy(agent.name) : wide ? t.composer.hint : ""}
              </p>
              {hasMessages && (
                <button
                  type="button"
                  className="chat-link"
                  title={t.composer.resetTitle}
                  disabled={busy || resetting}
                  onClick={() => void clear()}
                >
                  {t.composer.reset}
                </button>
              )}
            </div>
          </form>
        </>
      )}
    </aside>
  );
}
