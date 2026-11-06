"use client";

import { useState, type ReactNode } from "react";
import { closeBlocked, errorText, markSeen, relaunchBlocked, type BlockedTarget } from "./api";
import { addDayKey, formatFullDay, formatHour, formatLongDay, formatDateTime, localDayKey } from "./format";
import { Markdown } from "./markdown-view";
import type { TeamAgent } from "./model";
import { RECEPTION_ROOM } from "./reception";
import { chipStyle } from "./room-color";
import type { DeskItem, DeskObject } from "./schemas";
import { strings } from "./strings";
import { Badge, buttonClass, ErrorNote } from "./ui";

// The interfaces of the desk objects whose data comes from GET /api/desk
// rather than from the state of the desk: the newspaper, the calendar, the
// Standard (what is stuck at the agents), and a plain list for
// anything else.

const t = strings.deskModules;

const linkClass =
  "text-sm text-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/** A link of an item: an address of the app opens here, an outside one in a new tab. */
function ItemLink({ href, children }: { href: string; children: ReactNode }) {
  const outside = /^https?:\/\//i.test(href);
  return (
    <a href={href} className={linkClass} {...(outside ? { target: "_blank", rel: "noreferrer" } : {})}>
      {children}
    </a>
  );
}

function Empty({ text = t.empty }: { text?: string }) {
  return <p className="text-sm text-muted">{text}</p>;
}

function CommandNote({ object }: { object: DeskObject }) {
  return object.note ? <p className="text-xs text-muted">{object.note}</p> : null;
}

// --- The newspaper ---------------------------------------------------------------------

/** A lead story longer than this is set in two columns on a wide screen; a short one stays one readable column. */
const LONG_LEAD = 700;

/** Who wrote an article of the newspaper: the agent of an item, the agent of a run summary. */
function byline(item: DeskItem, agents: readonly TeamAgent[]): string {
  const ref = item.ref;
  if (ref && (ref.kind === "approval" || ref.kind === "run")) {
    return agents.find((agent) => agent.room === ref.room && agent.id === ref.agentId)?.name ?? ref.agentId;
  }
  return item.title;
}

function Article({
  item,
  agents,
  lead,
  onChange,
}: {
  item: DeskItem;
  agents: readonly TeamAgent[];
  lead: boolean;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = item.ref;
  const unread = ref?.kind === "approval" && ref.status === "unseen";
  const who = byline(item, agents);
  // A run summary is titled by its agent: its byline is then only the time.
  const title = ref?.kind === "run" ? `${item.title}, ${item.at ? formatLongDay(item.at) : ""}`.replace(/, $/, "") : item.title;
  const markRead = async () => {
    if (ref?.kind !== "approval") return;
    setBusy(true);
    setError(null);
    try {
      await markSeen(ref.id);
      onChange();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <article
      id={item.id}
      className={`deep-target break-inside-avoid space-y-2 ${lead ? "pb-6" : "mb-6 border-t border-line pt-4"}`}
    >
      {lead && <p className="text-xs font-semibold tracking-widest text-accent uppercase">{t.journal.lead}</p>}
      <h2 className={`font-serif leading-tight font-semibold ${lead ? "text-2xl sm:text-3xl" : "text-lg"}`}>{title}</h2>
      <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>{t.journal.byline(who, item.at ? formatDateTime(item.at) : "")}</span>
        {unread && <Badge tone="accent">{t.journal.unread}</Badge>}
      </p>
      {item.body && (
        <div
          className={`font-serif [&_.prose]:leading-relaxed ${lead ? `[&_.prose]:text-[1.0625rem] ${item.body.length > LONG_LEAD ? "sm:columns-2 sm:gap-8" : "max-w-2xl"}` : "[&_.prose]:text-[0.975rem]"}`}
        >
          <Markdown source={item.body} />
        </div>
      )}
      {unread && (
        <button type="button" className={buttonClass()} disabled={busy} onClick={() => void markRead()}>
          {busy ? strings.desk.sending : t.journal.markRead}
        </button>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
    </article>
  );
}

/**
 * The newspaper: the briefs and the recaps, latest first. A masthead with the
 * day, the latest one as the lead story across the page, then the others in
 * columns on a wide screen (one column on a phone). An unseen item can be
 * marked read from here.
 */
export function JournalView({ object, agents, onChange }: { object: DeskObject; agents: readonly TeamAgent[]; onChange: () => void }) {
  const items = [...object.items].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  const [lead, ...rest] = items;
  return (
    <div className="mx-auto max-w-4xl">
      <header className="mb-6 border-y-4 border-double border-foreground py-3 text-center">
        <p className="font-serif text-3xl font-bold tracking-tight sm:text-5xl">{t.journal.masthead}</p>
        <p className="mt-1 text-xs tracking-widest text-muted uppercase">{t.journal.edition(formatFullDay(new Date()))}</p>
      </header>
      <CommandNote object={object} />
      {!lead ? (
        <Empty text={t.journal.empty} />
      ) : (
        <>
          <Article item={lead} agents={agents} lead onChange={onChange} />
          {rest.length > 0 && (
            <div className="gap-8 border-t-2 border-foreground pt-2 md:columns-2 xl:columns-3">
              {rest.map((item) => (
                <Article key={item.id} item={item} agents={agents} lead={false} onChange={onChange} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// --- The calendar ----------------------------------------------------------------------

/** The days shown: today and the next 7. */
export const AGENDA_DAYS = 8;

type Day = { key: string; events: DeskItem[]; slots: NonNullable<DeskObject["slots"]> };

/** Groups the events and the free slots by local day, today and the next days first, any other day after. */
export function agendaDays(object: DeskObject, today: string, days = AGENDA_DAYS): Day[] {
  const byDay = new Map<string, Day>();
  const day = (key: string): Day => {
    let entry = byDay.get(key);
    if (!entry) {
      entry = { key, events: [], slots: [] };
      byDay.set(key, entry);
    }
    return entry;
  };
  for (let i = 0; i < days; i++) day(addDayKey(today, i));
  for (const item of object.items) {
    const key = item.at ? localDayKey(item.at) : null;
    if (key && key >= today) day(key).events.push(item);
  }
  for (const slot of object.slots ?? []) {
    const key = localDayKey(slot.start);
    if (key && key >= today) day(key).slots.push(slot);
  }
  const at = (item: DeskItem) => (item.allDay ? "" : (item.at ?? ""));
  return [...byDay.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((entry) => ({ ...entry, events: entry.events.sort((a, b) => at(a).localeCompare(at(b))) }));
}

function dayTitle(key: string, today: string): string {
  const prefix = key === today ? t.agenda.today : key === addDayKey(today, 1) ? t.agenda.tomorrow : null;
  return t.agenda.dayTitle(prefix, formatLongDay(key));
}

function AgendaDay({ day, today, big }: { day: Day; today: string; big: boolean }) {
  return (
    <section
      aria-labelledby={`day-${day.key}`}
      className={`rounded-lg border border-line bg-card ${big ? "self-start p-4 sm:p-5" : "p-3"} ${day.key === today ? "border-l-4 border-l-accent" : ""}`}
    >
      <h2 id={`day-${day.key}`} className={`font-semibold first-letter:uppercase ${big ? "text-lg" : "text-sm"}`}>
        {dayTitle(day.key, today)}
      </h2>
      {day.events.length === 0 ? (
        <p className="mt-1 text-sm text-muted">{t.agenda.noEvent}</p>
      ) : (
        <ul className={`mt-2 ${big ? "space-y-3" : "space-y-1.5"}`}>
          {day.events.map((event) => (
            <li key={event.id} className={`flex gap-3 ${event.tone === "warn" || event.tone === "alert" ? "-mx-2 rounded-md bg-warn-soft px-2 py-1" : ""}`}>
              <span className={`w-28 shrink-0 text-sm tabular-nums text-muted ${big ? "sm:w-32" : ""}`}>
                {event.allDay || !event.at
                  ? t.agenda.allDay
                  : event.end
                    ? t.agenda.span(formatHour(event.at), formatHour(event.end))
                    : formatHour(event.at)}
              </span>
              <span className="min-w-0 flex-1">
                <span className={`block break-words ${big ? "font-semibold" : "text-sm font-medium"}`}>{event.title}</span>
                {event.body && <span className="block break-words text-xs text-muted">{event.body}</span>}
                {event.href && (
                  <ItemLink href={event.href}>{t.openLink}</ItemLink>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {day.slots.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-semibold text-muted">{t.agenda.free}</p>
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {day.slots.map((slot) => (
              <li key={slot.start} className="rounded-full bg-ok-soft px-2 py-0.5 text-xs font-medium text-ok">
                {slot.label ?? t.agenda.freeSlot(formatHour(slot.start), formatHour(slot.end))}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** The calendar: today in large on the left (on top on a phone), the week beside it. Read-only. */
export function AgendaView({ object }: { object: DeskObject }) {
  const today = localDayKey(new Date()) ?? "";
  const [first, ...week] = agendaDays(object, today);
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted">{t.agenda.readOnly}</p>
      <CommandNote object={object} />
      <div className="grid gap-4 md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        {first && <AgendaDay day={first} today={today} big />}
        <div className="space-y-2">
          {week.map((day) => (
            <AgendaDay key={day.key} day={day} today={today} big={false} />
          ))}
        </div>
      </div>
    </div>
  );
}

// --- The Standard ----------------------------------------------------------------------

type BlockedRef = Extract<NonNullable<DeskItem["ref"]>, { kind: "blocked" }>;

/** Since when something is stuck, as « depuis 2 h ». */
export function formatSince(iso: string, at: number = Date.now()): string {
  const since = t.standard.since;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  const minutes = Math.floor((at - time) / 60_000);
  if (minutes < 1) return since.now;
  if (minutes < 60) return since.minutes(minutes);
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? since.hours(hours) : since.days(Math.floor(hours / 24));
}

const STATE_TONE: Record<BlockedRef["state"], "danger" | "warn"> = {
  blocked: "danger",
  pending: "warn",
  failed: "danger",
  cancelled: "warn",
};

type Outcome = { tone: "ok" | "warn"; text: string };

/** What an action said, in French: the run started, or why the agent could not be woken. */
function relaunchOutcome(result: Awaited<ReturnType<typeof relaunchBlocked>>): Outcome {
  if (result.run) return { tone: "ok", text: t.standard.relaunched(result.run.id) };
  const code = result.waiting?.code ?? "";
  return { tone: "warn", text: t.standard.waiting[code] ?? t.standard.waitingOther };
}

function StandardEntry({ item, refData, onDone }: { item: DeskItem; refData: BlockedRef; onDone: (outcome: Outcome) => void }) {
  const [confirm, setConfirm] = useState<"relaunch" | "close" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tint = chipStyle(item.color);
  const run = refData.entry === "run";
  const target: BlockedTarget = { kind: run ? "run" : "task", id: refData.id };
  const room = refData.room === RECEPTION_ROOM ? strings.room.reception.name : refData.room;
  const act = async (action: "relaunch" | "close") => {
    setBusy(true);
    setError(null);
    try {
      if (action === "relaunch") {
        const said = relaunchOutcome(await relaunchBlocked(target));
        onDone({ ...said, text: t.standard.outcome(item.title, said.text) });
      } else {
        await closeBlocked(target);
        onDone({ tone: "ok", text: t.standard.outcome(item.title, t.standard.closed) });
      }
      setConfirm(null);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  const question =
    confirm === "relaunch"
      ? run
        ? t.standard.confirm.relaunchRun(refData.tasks)
        : t.standard.confirm.relaunch
      : run
        ? t.standard.confirm.closeRun(refData.tasks)
        : t.standard.confirm.close;
  return (
    <li
      id={item.id}
      style={tint ?? undefined}
      className={`deep-target space-y-3 rounded-lg border bg-card p-4 ${refData.handedOff ? "border-warn ring-1 ring-warn" : "border-line"} ${tint ? "border-l-4 border-l-[var(--room-color)]" : ""}`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-xs font-medium">
          <span aria-hidden className={`size-2 rounded-full ${tint ? "bg-[var(--room-color)]" : "bg-muted"}`} />
          {room}
        </span>
        <span className="font-semibold break-words">{item.title}</span>
        <Badge tone={STATE_TONE[refData.state]}>{t.standard.state[refData.state]}</Badge>
        {refData.handedOff && <Badge tone="warn">{t.standard.handedOff}</Badge>}
        {item.at && (
          <span className="text-xs text-muted sm:ml-auto" title={formatDateTime(item.at)}>
            {formatSince(item.at)}
          </span>
        )}
      </div>
      <p className="text-sm break-words">{refData.reason}</p>
      {refData.note && (
        <p className={`rounded-md px-3 py-2 text-sm break-words ${refData.handedOff ? "bg-warn-soft" : "bg-soft"}`}>
          <span className="font-medium" title={formatDateTime(refData.note.at)}>
            {t.standard.noteBy(refData.note.by)}
          </span>
          {" "}
          {refData.note.text}
        </p>
      )}
      {item.body && (
        <details className="rounded-md bg-soft">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
            {run ? t.standard.runText(refData.id) : t.standard.taskText}
            {refData.tasks > 1 ? `, ${t.standard.tasks(refData.tasks)}` : ""}
          </summary>
          <div className="px-3 pb-3 text-sm">
            <Markdown source={item.body} />
          </div>
        </details>
      )}
      {confirm ? (
        <div className="space-y-2 rounded-md border border-line p-3">
          <p className="text-sm">{question}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass(confirm === "close" ? "danger" : "primary")}
              disabled={busy}
              onClick={() => void act(confirm)}
            >
              {busy ? t.standard.sending : confirm === "relaunch" ? t.standard.confirm.yesRelaunch : t.standard.confirm.yesClose}
            </button>
            <button type="button" className={buttonClass()} disabled={busy} onClick={() => setConfirm(null)}>
              {t.standard.confirm.cancel}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonClass("primary")} onClick={() => setConfirm("relaunch")}>
            {t.standard.relaunch}
          </button>
          <button type="button" className={buttonClass()} onClick={() => setConfirm("close")}>
            {t.standard.close}
          </button>
        </div>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
    </li>
  );
}

/**
 * The Standard: what is stuck at the agents, newest first. Each entry says
 * its room, its agent, since when and why, with the text of the task folded,
 * and two actions behind a light confirmation: « Relancer » and « Clore ».
 */
export function StandardView({ object, onChange }: { object: DeskObject; onChange: () => void }) {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const entries = object.items.flatMap((item) => (item.ref?.kind === "blocked" ? [{ item, ref: item.ref }] : []));
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">{t.standard.hint}</p>
      {outcome && (
        <p
          role="status"
          className={`rounded-md px-3 py-2 text-sm ${outcome.tone === "ok" ? "bg-ok-soft text-ok" : "bg-warn-soft text-warn"}`}
        >
          {outcome.text}
        </p>
      )}
      {entries.length === 0 ? (
        <Empty text={t.standard.empty} />
      ) : (
        <ul className="space-y-3">
          {entries.map(({ item, ref }) => (
            <StandardEntry
              key={item.id}
              item={item}
              refData={ref}
              onDone={(next) => {
                setOutcome(next);
                onChange();
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// --- Anything else ---------------------------------------------------------------------

/** A plain list of the items, for an object without an interface of its own for its source. */
export function ItemsView({ object }: { object: DeskObject }) {
  return (
    <div className="space-y-3">
      <CommandNote object={object} />
      {object.items.length === 0 ? (
        <Empty />
      ) : (
        <ul className="space-y-2">
          {object.items.map((item) => {
            const tint = chipStyle(item.color);
            return (
              <li
                key={item.id}
                id={item.id}
                style={tint ?? undefined}
                className={`deep-target space-y-1 rounded-lg border border-line bg-card p-3 ${tint ? "border-l-4 border-l-[var(--room-color)]" : ""} ${item.tone === "muted" ? "opacity-70" : ""}`}
              >
                <p className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-semibold break-words">{item.title}</span>
                  {item.at && <span className="text-xs text-muted">{formatDateTime(item.at)}</span>}
                </p>
                {item.body && <Markdown source={item.body} />}
                {item.href && <ItemLink href={item.href}>{t.openLink}</ItemLink>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
