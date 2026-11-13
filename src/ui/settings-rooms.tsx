"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { DeletionCheckView, SettingsView } from "@/server/settings-schema";
import { ApiError, deleteRoom, fetchDeletionCheck, removeRoomAgent, roomGesture, saveSettingsGroup } from "./api";
import { approvalHash, DESK_PATH } from "./deep-link";
import { formatAge, formatClock, formatDay, formatWhen } from "./format";
import { scheduleText } from "./schedule";
import { formatUsd } from "./settings-format";
import {
  filterRooms,
  HEX_COLOR,
  isDirty,
  ROOM_FILTERS,
  roomErrors,
  roomForm,
  roomHasErrors,
  roomInput,
  roomTitle,
  type RoomFilter,
  type RoomForm,
  type SettingsAddress,
} from "./settings-model";
import { FieldError, saveErrorText, Switch, TabForm, useSavedForm } from "./settings-parts";
import { strings } from "./strings";
import { buttonClass, ErrorNote, fieldClass } from "./ui";

// « Salles »: a card per room of the floor, the room proposals waiting on the
// desk, the archived rooms, and the panel of one room (`?salle=<name>`) with
// its settings, its agents and the gestures on it; the deletion asks in a
// dialog of its own (`?supprimer=<name>`).

const t = strings.settings.roomsTab;
const p = strings.settings.roomPanel;
const d = strings.settings.deleteDialog;
const r = strings.settings.rooms;

type Room = SettingsView["rooms"][number];
type Toast = { text: string; tone: "ok" | "error" } | null;
type Gesture = "pause" | "resume" | "archive" | "restore";

const NEUTRAL = "#8a9590";
const MODELS = ["opus", "sonnet", "haiku"] as const;

/** The value of an `<input type="color">` (always #rrggbb) for a #rgb or #rrggbb code. */
function pickerValue(hex: string): string {
  if (!HEX_COLOR.test(hex)) return "#000000";
  if (hex.length === 7) return hex.toLowerCase();
  return `#${[...hex.slice(1)].map((digit) => digit + digit).join("")}`.toLowerCase();
}

const armedCount = (room: Room) => room.agents.filter((agent) => agent.hasRoutines && agent.armed).length;
const routineCount = (room: Room) => room.agents.filter((agent) => agent.hasRoutines).length;

/** A bin, for the deletion button of a card (its name is in its label). */
function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 6h17M8.5 6V4.5A1.5 1.5 0 0 1 10 3h4a1.5 1.5 0 0 1 1.5 1.5V6M18.5 6l-.8 13a2 2 0 0 1-2 1.9H8.3a2 2 0 0 1-2-1.9L5.5 6M10 11v5M14 11v5" />
    </svg>
  );
}

/** The round initial of a room. */
function Avatar({ title }: { title: string }) {
  return (
    <span className="settings-avatar" aria-hidden="true">
      {title.slice(0, 1).toUpperCase()}
    </span>
  );
}

function StateChip({ state }: { state: keyof typeof t.states }) {
  return (
    <span className="settings-chip" data-state={state}>
      {t.states[state]}
    </span>
  );
}

/** A line of a card that says something to act on (a pause, a run, items waiting). */
function Flag({ tone, children }: { tone: "warn" | "ok" | "accent"; children: ReactNode }) {
  const tones = { warn: "bg-warn-soft text-warn", ok: "bg-ok-soft text-ok", accent: "bg-accent-soft text-accent" };
  return <p className={`rounded-md px-3 py-2 text-sm ${tones[tone]}`}>{children}</p>;
}

function RoomCard({
  room,
  busy,
  onOpen,
  onGesture,
  onDelete,
}: {
  room: Room;
  busy: boolean;
  onOpen: () => void;
  onGesture: (gesture: Gesture) => void;
  onDelete: () => void;
}) {
  const title = roomTitle(room);
  const routines = routineCount(room);
  const armed = armedCount(room);
  return (
    <article className="settings-room" data-state={room.state} style={{ "--room": room.color ?? NEUTRAL } as CSSProperties}>
      <button type="button" className="settings-room-head" onClick={onOpen} aria-label={t.open(title)}>
        <Avatar title={title} />
        <span className="min-w-0 flex-1 space-y-1 text-left">
          <span className="block truncate text-base font-semibold">{title}</span>
          <span className="flex flex-wrap gap-1.5">
            <StateChip state={room.state} />
            {room.shared && <span className="settings-tag">{r.shared}</span>}
            {room.label && <code className="settings-tag">{room.name}</code>}
          </span>
        </span>
        <span aria-hidden="true" className="text-muted">
          ›
        </span>
      </button>
      <div className="space-y-3 px-4 pb-3">
        <dl className="grid grid-cols-3 gap-2">
          <div className="settings-stat">
            <dd className="tabular-nums">{room.agents.length}</dd>
            <dt>{t.agents(room.agents.length)}</dt>
          </div>
          <div className="settings-stat">
            <dd className="tabular-nums">
              {armed}
              <small>/{routines}</small>
            </dd>
            <dt>{t.armed}</dt>
            {routines > 0 && (
              <span className="settings-armbar" aria-hidden="true">
                {room.agents
                  .filter((agent) => agent.hasRoutines)
                  .map((agent) => (
                    <i key={agent.id} data-on={agent.armed || undefined} />
                  ))}
              </span>
            )}
          </div>
          <div className="settings-stat">
            <dd className="tabular-nums">
              {formatUsd(room.week.costUsd)}
              <small>$</small>
            </dd>
            <dt>{t.week(room.week.runs)}</dt>
          </div>
        </dl>
        <p className="text-sm text-muted">
          {room.lastRun ? (
            <>
              {t.lastRun} <b className="text-foreground">{room.lastRun.agent}</b>, {formatAge(room.lastRun.at)}
              {room.lastRun.status === "failed" ? ` ${t.failed}` : ""}
            </>
          ) : (
            t.noRun
          )}
        </p>
        {room.state === "paused" && room.pause && <Flag tone="warn">{t.pausedSince(formatWhen(room.pause.pausedAt), room.pause.armed.length)}</Flag>}
        {room.running && <Flag tone="ok">{t.runningSince(room.running.agent, formatClock(room.running.since))}</Flag>}
        {room.pending > 0 && <Flag tone="warn">{t.pending(room.pending)}</Flag>}
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
        {room.state === "paused" ? (
          <button type="button" className={buttonClass()} disabled={busy} onClick={() => onGesture("resume")}>
            {t.resume}
          </button>
        ) : (
          <button
            type="button"
            className={buttonClass()}
            disabled={busy || routines === 0}
            title={routines === 0 ? t.noRoutine : undefined}
            onClick={() => onGesture("pause")}
          >
            {t.pause}
          </button>
        )}
        <button type="button" className={buttonClass()} disabled={busy || room.running !== null} onClick={() => onGesture("archive")}>
          {t.archive}
        </button>
        <span className="flex-1" />
        <button
          type="button"
          className={buttonClass("danger")}
          disabled={busy}
          onClick={onDelete}
          aria-label={t.deleteRoom(title)}
          title={t.deleteRoom(title)}
        >
          <TrashIcon />
        </button>
      </div>
    </article>
  );
}

/** A modal `<dialog>` opened as long as it is mounted; Escape and the backdrop close it through `onClose`. */
function Modal({ className, labelledBy, onClose, children }: { className: string; labelledBy: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    const onCancel = (event: Event) => {
      event.preventDefault();
      close.current();
    };
    dialog.addEventListener("cancel", onCancel);
    return () => {
      dialog.removeEventListener("cancel", onCancel);
      if (dialog.open) dialog.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={className}
      aria-labelledby={labelledBy}
      onClick={(event) => {
        if (event.target === ref.current) close.current();
      }}
    >
      {children}
    </dialog>
  );
}

function AgentRow({
  room,
  agent,
  form,
  budgetInvalid,
  defaultBudget,
  onChange,
  onRemoved,
  onError,
}: {
  room: Room;
  agent: Room["agents"][number];
  form: RoomForm["agents"][string];
  budgetInvalid: boolean;
  defaultBudget: number;
  onChange: (patch: Partial<RoomForm["agents"][string]>) => void;
  onRemoved: (settings: SettingsView) => void;
  onError: (message: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const base = `${room.name}-${agent.id}`;
  return (
    <li className="settings-agent">
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium">
          {agent.name} <code className="text-xs text-muted">{agent.id}</code>
        </p>
        <p className="text-xs text-muted">
          {agent.routines.length > 0 ? p.routines(agent.routines.map((routine) => scheduleText(routine.schedule) ?? routine.cron)) : p.noRoutine}
        </p>
      </div>
      <div className="grid min-w-0 grid-cols-2 gap-2">
        <select
          id={`model-${base}`}
          aria-label={p.modelOf(agent.name)}
          className={fieldClass}
          value={form.model}
          onChange={(event) => onChange({ model: event.target.value as (typeof MODELS)[number] })}
        >
          {MODELS.map((model) => (
            <option key={model} value={model}>
              {r.modelNames[model]}
            </option>
          ))}
        </select>
        <div className="min-w-0">
          <input
            id={`budget-${base}`}
            aria-label={p.budgetOf(agent.name)}
            className={`${fieldClass} tabular-nums`}
            inputMode="decimal"
            value={form.budget}
            placeholder={p.budgetDefault(defaultBudget)}
            aria-invalid={budgetInvalid}
            aria-describedby={budgetInvalid ? `budget-${base}-error` : undefined}
            onChange={(event) => onChange({ budget: event.target.value })}
          />
          {budgetInvalid && <FieldError id={`budget-${base}-error`}>{r.budgetInvalid}</FieldError>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        {agent.hasRoutines ? (
          <>
            <Switch checked={form.armed} onChange={(armed) => onChange({ armed })} label={p.armedOf(agent.name)} />
            <span className="w-20 text-sm">{form.armed ? p.armedOn : p.armedOff}</span>
          </>
        ) : (
          <span className="text-xs text-muted">{r.noRoutine}</span>
        )}
        {room.agents.length > 1 && (
          <button type="button" className={buttonClass("danger")} aria-label={p.removeOf(agent.name)} onClick={() => setConfirming(true)}>
            {p.remove}
          </button>
        )}
      </div>
      {confirming && (
        <div role="group" aria-label={p.removeConfirm(agent.name)} className="col-span-full space-y-2 rounded-md border border-danger bg-danger-soft p-3 text-sm">
          <p>
            <b>{p.removeConfirm(agent.name)}</b> {p.removeBody}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass("danger")}
              disabled={removing}
              onClick={async () => {
                setRemoving(true);
                try {
                  onRemoved(await removeRoomAgent(room.name, agent.id));
                } catch (error) {
                  onError(saveErrorText(error));
                  setRemoving(false);
                  setConfirming(false);
                }
              }}
            >
              {p.removeGo}
            </button>
            <button type="button" className={buttonClass()} onClick={() => setConfirming(false)}>
              {p.keep}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

/** The panel of one room: its name, colour and agents (saved together), and the gestures on it. */
function RoomPanel({
  room,
  settings,
  busy,
  onClose,
  onChanged,
  onGesture,
  onDelete,
  onDirtyChange,
  onToast,
}: {
  room: Room;
  settings: SettingsView;
  busy: boolean;
  onClose: () => void;
  onChanged: (settings: SettingsView) => void;
  onGesture: (gesture: Gesture) => void;
  onDelete: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onToast: (toast: Toast) => void;
}) {
  const saved = useMemo(() => roomForm(room), [room]);
  const [form, setForm, reset] = useSavedForm(saved);
  const errors = roomErrors(form);
  const title = roomTitle(room);
  const set = (patch: Partial<RoomForm>) => setForm((current) => ({ ...current, ...patch }));
  const setAgent = (id: string, patch: Partial<RoomForm["agents"][string]>) =>
    setForm((current) => ({ ...current, agents: { ...current.agents, [id]: { ...current.agents[id]!, ...patch } } }));
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  return (
    <Modal className="settings-drawer" labelledBy="room-panel-title" onClose={onClose}>
      <div className="settings-drawer-head" style={{ "--room": room.color ?? NEUTRAL } as CSSProperties}>
        <Avatar title={title} />
        <div className="min-w-0 flex-1 space-y-1">
          <h2 id="room-panel-title" className="truncate text-lg font-semibold">
            {title}
          </h2>
          <p className="flex flex-wrap gap-1.5">
            <StateChip state={room.state} />
            {room.shared && <span className="settings-tag">{r.shared}</span>}
            <code className="settings-tag">{room.name}</code>
          </p>
        </div>
        <button type="button" className={buttonClass()} onClick={onClose} aria-label={p.close}>
          ✕
        </button>
      </div>
      <div className="settings-drawer-body">
        <TabForm
          id="salles"
          dirty={isDirty(form, saved)}
          blocked={roomHasErrors(form)}
          onDirtyChange={onDirtyChange}
          onReset={reset}
          onSave={async () => onChanged(await saveSettingsGroup("rooms", roomInput(room, form)))}
        >
          {room.state === "paused" && room.pause && <Flag tone="warn">{p.pausedNote(room.pause.armed.length)}</Flag>}
          <section className="space-y-2">
            <label htmlFor="room-label" className="block text-sm font-semibold">
              {p.nameTitle}
            </label>
            <input
              id="room-label"
              className={fieldClass}
              value={form.label}
              placeholder={room.name}
              maxLength={80}
              autoComplete="off"
              aria-invalid={Boolean(errors.label)}
              aria-describedby="room-label-hint"
              onChange={(event) => set({ label: event.target.value })}
            />
            <p id="room-label-hint" className="text-xs text-muted">
              {p.nameHint(room.name)}
            </p>
            {errors.label && <FieldError id="room-label-error">{p.nameInvalid}</FieldError>}
          </section>
          <section className="space-y-2">
            <label htmlFor="room-color" className="block text-sm font-semibold">
              {p.colorTitle} <span className="font-normal text-muted">{p.colorHint}</span>
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="color"
                aria-label={r.colorPicker(title)}
                value={pickerValue(form.color)}
                onChange={(event) => set({ color: event.target.value })}
                className="h-10 w-12 cursor-pointer rounded-md border border-line bg-card p-1"
              />
              <input
                id="room-color"
                className={`${fieldClass} max-w-32`}
                value={form.color}
                placeholder={r.neutral}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={Boolean(errors.color)}
                aria-describedby={errors.color ? "room-color-error" : undefined}
                onChange={(event) => set({ color: event.target.value.trim() })}
              />
              <button type="button" className={buttonClass()} onClick={() => set({ color: "" })} disabled={form.color === ""}>
                {r.colorNone}
              </button>
            </div>
            {errors.color && <FieldError id="room-color-error">{r.colorInvalid}</FieldError>}
          </section>
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">
              {p.agentsTitle} <span className="font-normal text-muted">{p.agentsCount(armedCount(room), routineCount(room))}</span>
            </h3>
            <ul className="divide-y divide-line rounded-md border border-line">
              {room.agents.map((agent) =>
                form.agents[agent.id] ? (
                  <AgentRow
                    key={agent.id}
                    room={room}
                    agent={agent}
                    form={form.agents[agent.id]!}
                    budgetInvalid={errors.budgets.includes(agent.id)}
                    defaultBudget={settings.defaultMaxBudgetUsd}
                    onChange={(patch) => setAgent(agent.id, patch)}
                    onRemoved={(next) => {
                      onChanged(next);
                      onToast({ text: t.toast.removed(agent.name), tone: "ok" });
                    }}
                    onError={(message) => onToast({ text: message, tone: "error" })}
                  />
                ) : null,
              )}
            </ul>
            <p className="text-xs text-muted">{p.agentsHint(settings.defaultMaxBudgetUsd)}</p>
          </section>
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">{p.gesturesTitle}</h3>
            <div className="space-y-2">
              {room.state === "paused" ? (
                <Gesture title={t.resume} body={p.resumeBody}>
                  <button type="button" className={buttonClass()} disabled={busy} onClick={() => onGesture("resume")}>
                    {t.resume}
                  </button>
                </Gesture>
              ) : (
                <Gesture title={t.pause} body={p.pauseBody}>
                  <button type="button" className={buttonClass()} disabled={busy || routineCount(room) === 0} onClick={() => onGesture("pause")}>
                    {t.pause}
                  </button>
                </Gesture>
              )}
              <Gesture title={t.archive} body={p.archiveBody}>
                <button type="button" className={buttonClass()} disabled={busy || room.running !== null} onClick={() => onGesture("archive")}>
                  {t.archive}
                </button>
              </Gesture>
              <Gesture title={t.delete} body={p.deleteBody} danger>
                <button type="button" className={buttonClass("danger")} disabled={busy} onClick={onDelete}>
                  {p.deleteButton}
                </button>
              </Gesture>
            </div>
          </section>
        </TabForm>
      </div>
    </Modal>
  );
}

function Gesture({ title, body, danger, children }: { title: string; body: string; danger?: boolean; children: ReactNode }) {
  return (
    <div className={`flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 ${danger ? "border-dashed border-line" : "border-line"}`}>
      <div className="min-w-0 flex-1 basis-56 space-y-0.5">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted">{body}</p>
      </div>
      {children}
    </div>
  );
}

/** One verification of the deletion dialog: passed, refused, or a note that blocks nothing. */
function Check({ ok, note, title, hint, link }: { ok: boolean; note?: boolean; title: ReactNode; hint: string; link?: ReactNode }) {
  const mark = note ? "!" : ok ? "✓" : "✕";
  const tone = note ? "text-muted" : ok ? "text-ok" : "text-danger";
  return (
    <li className="flex gap-3 px-3 py-2" data-ok={ok || undefined} data-note={note || undefined}>
      <span className={`settings-check ${tone}`} aria-hidden="true">
        {mark}
      </span>
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium break-words">{title}</p>
        <p className="text-xs text-muted">{hint}</p>
        {link}
      </div>
    </li>
  );
}

function problemText(dir: string, problem: NonNullable<DeletionCheckView["workDirs"][number]["problem"]>): string {
  if (problem.kind === "dirty") return d.checks.dirty(dir, problem.files);
  if (problem.kind === "unmerged") return d.checks.unmerged(dir, problem.commits, problem.branch);
  if (problem.kind === "insideRoom") return d.checks.insideRoom(dir);
  return d.checks.unchecked(dir, problem.detail);
}

/** The deletion of a room: what MyHQ checks, what leaves the floor, what stays on disk, and the name to type. */
function DeleteDialog({
  name,
  title,
  onClose,
  onArchive,
  onDeleted,
}: {
  name: string;
  title: string;
  onClose: () => void;
  onArchive: (() => void) | null;
  onDeleted: (settings: SettingsView, destination: string) => void;
}) {
  const [check, setCheck] = useState<DeletionCheckView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [deleting, setDeleting] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const load = () => {
    fetchDeletionCheck(name).then(
      (next) => {
        setCheck(next);
      },
      (failure: unknown) => setError(saveErrorText(failure)),
    );
  };
  useEffect(load, [name]);
  useEffect(() => {
    if (check && check.blocked.length === 0) input.current?.focus();
  }, [check]);

  const blocked = check !== null && check.blocked.length > 0;
  const problems = check?.workDirs.filter((entry) => entry.problem !== null) ?? [];
  const notices = check?.workDirs.filter((entry) => entry.notice !== null) ?? [];

  return (
    <Modal className="settings-dialog" labelledBy="delete-title" onClose={onClose}>
      <div className="space-y-1 border-b border-line p-4">
        <h2 id="delete-title" className="text-lg font-semibold">
          {d.title(title)}
        </h2>
        <p className="text-sm text-muted">{blocked ? d.introBlocked : d.intro}</p>
      </div>
      <div className="max-h-[65vh] space-y-4 overflow-y-auto p-4">
        {error && <ErrorNote>{error}</ErrorNote>}
        {!check && !error && <p className="text-sm text-muted">{d.loading}</p>}
        {check && (
          <>
            {blocked && (
              <div role="alert" className="rounded-md border border-danger bg-danger-soft px-3 py-2 text-sm text-danger">
                <p className="font-medium">{d.refusedTitle}</p>
                <p>{d.refusedBody}</p>
              </div>
            )}
            <ul className="divide-y divide-line rounded-md border border-line" aria-label={d.introBlocked}>
              <Check
                ok={check.running === null}
                title={check.running ? d.checks.running(check.running.agent, formatClock(check.running.since)) : d.checks.runningOk}
                hint={check.running ? d.checks.runningHint : d.checks.runningOkHint}
                link={
                  check.running && (
                    <Link className="text-xs text-accent underline" href="/surveillance">
                      {d.checks.surveillance}
                    </Link>
                  )
                }
              />
              <Check
                ok={check.pending === 0}
                title={check.pending > 0 ? d.checks.pending(check.pending) : d.checks.pendingOk}
                hint={check.pending > 0 ? d.checks.pendingHint : d.checks.pendingOkHint}
                link={
                  check.pending > 0 && (
                    <Link className="text-xs text-accent underline" href={DESK_PATH}>
                      {d.checks.desk}
                    </Link>
                  )
                }
              />
              <Check
                ok={problems.length === 0}
                title={
                  problems.length === 0 ? (
                    d.checks.gitOk
                  ) : (
                    <>
                      {d.checks.git}
                      <span className="block font-normal">
                        {problems.map((entry) => (
                          <span key={entry.dir} className="block break-all text-xs">
                            {problemText(entry.dir, entry.problem!)}
                          </span>
                        ))}
                      </span>
                    </>
                  )
                }
                hint={problems.length === 0 ? d.checks.gitOkHint : d.checks.gitHint}
              />
              {notices.length > 0 && (
                <Check
                  ok
                  note
                  title={
                    <>
                      {d.checks.ownRepo}
                      <span className="block font-normal">
                        {notices.map((entry) => (
                          <span key={entry.dir} className="block break-all text-xs">
                            {d.checks.ownRepoLine(entry.dir)}
                          </span>
                        ))}
                      </span>
                    </>
                  }
                  hint={d.checks.ownRepoHint}
                />
              )}
            </ul>
            {!blocked && (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2 rounded-md border border-line p-3 text-sm">
                    <h3 className="font-semibold text-danger">{d.goneTitle}</h3>
                    <ul className="list-disc space-y-1 pl-5">
                      {d.gone.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                      <li>
                        {d.config(check.configDir, check.agents)} <code className="break-all text-xs">{check.destination}/</code>
                      </li>
                    </ul>
                  </div>
                  <div className="space-y-2 rounded-md border border-line p-3 text-sm">
                    <h3 className="font-semibold text-ok">{d.keptTitle}</h3>
                    <ul className="list-disc space-y-1 pl-5">
                      <li>
                        {d.workDirs}
                        {check.workDirs.map((entry) => (
                          <code key={entry.dir} className="block break-all text-xs">
                            {entry.dir}
                          </code>
                        ))}
                      </li>
                      <li>{d.history(check.history.runs, formatUsd(check.history.costUsd), check.history.items)}</li>
                    </ul>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="confirm-name" className="block text-sm font-medium">
                    {d.confirmLabel} <code>{name}</code>
                  </label>
                  <input
                    ref={input}
                    id="confirm-name"
                    className={fieldClass}
                    value={typed}
                    placeholder={name}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setTyped(event.target.value)}
                  />
                </div>
              </>
            )}
          </>
        )}
      </div>
      <div className="flex flex-wrap justify-end gap-2 border-t border-line p-4">
        <button type="button" className={buttonClass()} onClick={onClose}>
          {blocked ? d.close : d.keepRoom}
        </button>
        {onArchive && (
          <button type="button" className={buttonClass()} onClick={onArchive}>
            {d.archiveInstead}
          </button>
        )}
        {check && !blocked && (
          <button
            type="button"
            className={buttonClass("danger")}
            disabled={typed.trim() !== name || deleting}
            onClick={async () => {
              setDeleting(true);
              try {
                const result = await deleteRoom(name, typed.trim());
                onDeleted(result.settings, result.destination);
              } catch (failure) {
                setDeleting(false);
                if (failure instanceof ApiError && failure.code === "ROOM_DELETE_REFUSED") load();
                setError(saveErrorText(failure));
              }
            }}
          >
            {d.confirm(name)}
          </button>
        )}
      </div>
    </Modal>
  );
}

/**
 * The message of a gesture, at the bottom of the screen. A manual popover, so
 * that it sits in the top layer, over the room's panel (a modal dialog) too.
 */
function ToastHost({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = ref.current;
    if (!host || typeof host.showPopover !== "function") return;
    if (toast) {
      // Shown again after a dialog opened, to stay above it.
      if (host.matches(":popover-open")) host.hidePopover();
      host.showPopover();
    } else if (host.matches(":popover-open")) host.hidePopover();
  }, [toast]);
  return (
    <div ref={ref} popover="manual" aria-live="polite" className="settings-toast-host">
      {toast && (
        <div className="settings-toast" data-tone={toast.tone} role={toast.tone === "error" ? "alert" : "status"}>
          <p className="min-w-0 flex-1">{toast.text}</p>
          <button type="button" className="text-sm underline" onClick={onClose}>
            {t.toast.close}
          </button>
        </div>
      )}
    </div>
  );
}

/** « Salles »: the rooms of the floor, the proposals waiting, the archived rooms; a room's panel; a deletion. */
export function RoomsTab({
  settings,
  onChanged,
  address,
  go,
  onDirtyChange,
}: {
  settings: SettingsView;
  onChanged: (settings: SettingsView) => void;
  address: SettingsAddress;
  go: (next: SettingsAddress, mode?: "push" | "replace") => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [filter, setFilter] = useState<RoomFilter>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const shown = filterRooms(settings.rooms, filter);
  const panelRoom = settings.rooms.find((room) => room.name === address.room) ?? null;
  const deleting =
    settings.rooms.find((room) => room.name === address.deleting) ??
    settings.archivedRooms.find((room) => room.name === address.deleting) ??
    null;

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 9000);
    return () => clearTimeout(timer);
  }, [toast]);

  const open = (room: string) => go({ tab: "salles", room, deleting: null });
  const closeAll = () => go({ tab: "salles", room: null, deleting: null });
  const askDelete = (room: string) => go({ tab: "salles", room: address.room, deleting: room });

  const gesture = async (room: string, kind: Gesture) => {
    setBusy(room);
    try {
      const next = await roomGesture(room, kind);
      onChanged(next);
      const title = roomTitle(
        next.rooms.find((each) => each.name === room) ?? next.archivedRooms.find((each) => each.name === room) ?? { name: room, label: null },
      );
      const paused = next.rooms.find((each) => each.name === room)?.pause?.armed.length ?? 0;
      const texts = { pause: t.toast.paused(title, paused), resume: t.toast.resumed(title), archive: t.toast.archived(title), restore: t.toast.restored(title) };
      setToast({ text: texts[kind], tone: "ok" });
      if (kind === "archive") closeAll();
    } catch (error) {
      setToast({ text: `${t.gestureFailed} ${saveErrorText(error)}`, tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      {settings.roomProposals.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">{t.proposalsTitle}</h3>
          <ul className="grid gap-3 sm:grid-cols-2">
            {settings.roomProposals.map((proposal) => (
              <li key={proposal.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-accent bg-accent-soft p-3 text-sm">
                <span className="min-w-0 flex-1 basis-48">
                  <StateChip state="proposal" /> {t.proposalBody(proposal.room)}
                </span>
                <Link className={buttonClass()} href={`${DESK_PATH}${approvalHash(proposal.id)}`}>
                  {t.proposalLink}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {settings.rooms.length > 0 && (
        <div role="group" aria-label={t.filterLabel} className="settings-segmented">
          {ROOM_FILTERS.map((each) => (
            <button key={each} type="button" aria-pressed={filter === each} onClick={() => setFilter(each)}>
              {t.filters[each]} <span className="tabular-nums text-muted">{filterRooms(settings.rooms, each).length}</span>
            </button>
          ))}
        </div>
      )}

      {settings.rooms.length === 0 ? (
        <div className="space-y-1 rounded-lg border border-dashed border-line p-6 text-center">
          <h3 className="font-semibold">{t.emptyTitle}</h3>
          <p className="text-sm text-muted">{t.emptyBody}</p>
        </div>
      ) : shown.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line p-6 text-center text-sm text-muted">{t.emptyFilter[filter]}</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {shown.map((room) => (
            <RoomCard
              key={room.name}
              room={room}
              busy={busy === room.name}
              onOpen={() => open(room.name)}
              onGesture={(kind) => void gesture(room.name, kind)}
              onDelete={() => askDelete(room.name)}
            />
          ))}
        </div>
      )}

      {settings.invalidRooms.length > 0 && (
        <div className="space-y-1 text-sm">
          <p className="font-medium">{t.invalidTitle}</p>
          <ul className="list-disc space-y-1 pl-5 break-words text-muted">
            {settings.invalidRooms.map((invalid) => (
              <li key={invalid.name}>
                <code>{invalid.name}</code>: {invalid.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      <section className="space-y-2">
        <h3 className="text-base font-semibold">{t.archivedTitle}</h3>
        <p className="text-sm text-muted">{t.archivedHint}</p>
        {settings.archivedRooms.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line p-4 text-sm text-muted">{t.archivedEmpty}</p>
        ) : (
          <ul className="space-y-2">
            {settings.archivedRooms.map((room) => {
              const title = roomTitle(room);
              return (
                <li
                  key={room.name}
                  className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-line p-3"
                  style={{ "--room": room.color ?? NEUTRAL } as CSSProperties}
                >
                  <Avatar title={title} />
                  <div className="min-w-0 flex-1 basis-48">
                    <p className="font-medium">{title}</p>
                    <p className="text-xs text-muted">
                      {t.archivedLine({ at: formatDay(room.archivedAt), agents: room.agents, runs: room.totalRuns, cost: formatUsd(room.totalCostUsd) })}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className={buttonClass("primary")} disabled={busy === room.name} onClick={() => void gesture(room.name, "restore")}>
                      {t.restore}
                    </button>
                    <button type="button" className={buttonClass("danger")} disabled={busy === room.name} onClick={() => askDelete(room.name)}>
                      {t.delete}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {panelRoom && !deleting && (
        <RoomPanel
          key={panelRoom.name}
          room={panelRoom}
          settings={settings}
          busy={busy === panelRoom.name}
          onClose={closeAll}
          onChanged={onChanged}
          onGesture={(kind) => void gesture(panelRoom.name, kind)}
          onDelete={() => askDelete(panelRoom.name)}
          onDirtyChange={onDirtyChange}
          onToast={setToast}
        />
      )}
      {deleting && (
        <DeleteDialog
          key={deleting.name}
          name={deleting.name}
          title={roomTitle(deleting)}
          onClose={() => go({ tab: "salles", room: address.room, deleting: null })}
          onArchive={
            settings.rooms.some((room) => room.name === deleting.name)
              ? () => {
                  go({ tab: "salles", room: null, deleting: null });
                  void gesture(deleting.name, "archive");
                }
              : null
          }
          onDeleted={(next, destination) => {
            onChanged(next);
            closeAll();
            setToast({ text: t.toast.deleted(roomTitle(deleting), destination), tone: "ok" });
          }}
        />
      )}

      <ToastHost toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
