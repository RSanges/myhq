"use client";

import { useMemo, useState } from "react";
import type { SettingsView } from "@/server/settings-schema";
import { saveSettingsGroup } from "./api";
import { isDirty } from "./settings-model";
import { Card, FieldError, TabForm, useSavedForm } from "./settings-parts";
import { strings } from "./strings";
import { buttonClass, fieldClass } from "./ui";

const t = strings.settings.notifications;

/** Same rule as the server: an approval type in snake_case. */
const TYPE_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

/** Same rule as the server: a time HH:MM, 24-hour. */
const CLOCK_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The range offered when quiet hours are switched on for the first time. */
const DEFAULT_QUIET = { start: "21:00", end: "08:00" };

type Props = { settings: SettingsView; onSaved: (settings: SettingsView) => void; onDirtyChange: (dirty: boolean) => void };

type NotificationsForm = {
  selected: string[];
  quietOn: boolean;
  quietStart: string;
  quietEnd: string;
  summaries: Record<string, boolean>;
};

/** The form as saved: the types selected (sorted, so that the order never counts), quiet hours, run summaries. */
function notificationsForm(settings: SettingsView): NotificationsForm {
  return {
    selected: [...settings.notifyTypes.selected].sort(),
    quietOn: settings.quietHours !== null,
    quietStart: settings.quietHours?.start ?? DEFAULT_QUIET.start,
    quietEnd: settings.quietHours?.end ?? DEFAULT_QUIET.end,
    summaries: Object.fromEntries(
      settings.rooms.flatMap((room) => room.agents.map((agent) => [`${room.name}/${agent.id}`, agent.notifySummary])),
    ),
  };
}

/** « Notifications »: informational item types, quiet hours and run summaries sent to Telegram. */
export function Notifications({ settings, onSaved, onDirtyChange }: Props) {
  const saved = useMemo(() => notificationsForm(settings), [settings]);
  const [form, setForm, reset] = useSavedForm(saved);
  // The types on offer: those seen in the home, plus any the user adds (kept even when unticked).
  const [offered, setOffered] = useState<string[]>(() => [
    ...new Set([...settings.notifyTypes.selected, ...settings.notifyTypes.known]),
  ]);
  const [extra, setExtra] = useState("");
  const extraValid = extra === "" || TYPE_PATTERN.test(extra.trim());
  const { quietOn, quietStart, quietEnd, summaries } = form;
  const selected = new Set(form.selected);
  const quietValid = !quietOn || (CLOCK_PATTERN.test(quietStart) && CLOCK_PATTERN.test(quietEnd) && quietStart !== quietEnd);
  const set = (patch: Partial<NotificationsForm>) => setForm((current) => ({ ...current, ...patch }));
  const setQuietOn = (quietOn: boolean) => set({ quietOn });
  const setQuietStart = (quietStart: string) => set({ quietStart });
  const setQuietEnd = (quietEnd: string) => set({ quietEnd });
  const setSummaries = (update: (current: Record<string, boolean>) => Record<string, boolean>) =>
    setForm((current) => ({ ...current, summaries: update(current.summaries) }));

  const toggleType = (type: string, on: boolean) =>
    setForm((current) => {
      const next = new Set(current.selected);
      if (on) next.add(type);
      else next.delete(type);
      return { ...current, selected: [...next].sort() };
    });

  const addType = () => {
    const type = extra.trim();
    if (type === "" || !TYPE_PATTERN.test(type)) return;
    setOffered((current) => (current.includes(type) ? current : [...current, type]));
    toggleType(type, true);
    setExtra("");
  };

  return (
    <TabForm
      id="notifications"
      dirty={isDirty(form, saved)}
      blocked={!quietValid}
      onDirtyChange={onDirtyChange}
      onReset={reset}
      onSave={async () => {
        onSaved(
          await saveSettingsGroup("notifications", {
            notifyTypes: offered.filter((type) => selected.has(type)),
            quietHours: quietOn ? { start: quietStart, end: quietEnd } : null,
            summaries: settings.rooms.flatMap((room) =>
              room.agents.map((agent) => ({
                room: room.name,
                agent: agent.id,
                summary: summaries[`${room.name}/${agent.id}`] ?? false,
              })),
            ),
          }),
        );
      }}
    >
      <Card id="notify-types" title={t.typesTitle} hint={t.typesHint}>
      <fieldset className="min-w-0 space-y-2">
        <legend className="sr-only">{t.typesTitle}</legend>
        {offered.length === 0 ? (
          <p className="text-sm text-muted">{t.typesEmpty}</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {offered.map((type) => (
              <li key={type} className="min-w-0">
                <label className="flex min-h-10 cursor-pointer items-center gap-3 rounded-md border border-line px-3 py-2 text-sm hover:bg-soft">
                  <input
                    type="checkbox"
                    checked={selected.has(type)}
                    onChange={(event) => toggleType(type, event.target.checked)}
                    className="accent-accent"
                  />
                  <span className="min-w-0 break-words">
                    {strings.desk.typeLabels[type] && <span className="mr-2">{strings.desk.typeLabels[type]}</span>}
                    <code className="text-xs text-muted">{type}</code>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-end gap-2 pt-1">
          <div className="min-w-0 flex-1 basis-48 space-y-1.5">
            <label htmlFor="extra-type" className="block text-sm font-medium">
              {t.typeAddLabel}
            </label>
            <input
              id="extra-type"
              className={fieldClass}
              value={extra}
              placeholder={t.typeAddPlaceholder}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={!extraValid}
              aria-describedby={extraValid ? undefined : "extra-type-error"}
              onChange={(event) => setExtra(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addType();
                }
              }}
            />
          </div>
          <button type="button" className={buttonClass()} onClick={addType} disabled={extra.trim() === "" || !extraValid}>
            {t.typeAdd}
          </button>
        </div>
        {!extraValid && <FieldError id="extra-type-error">{t.typeInvalid}</FieldError>}
      </fieldset>
      </Card>

      <Card id="quiet" title={t.quietTitle} hint={t.quietHint}>
      <fieldset className="min-w-0 space-y-2">
        <legend className="sr-only">{t.quietTitle}</legend>
        <label className="flex min-h-10 cursor-pointer items-center gap-3 rounded-md border border-line px-3 py-2 text-sm hover:bg-soft">
          <input
            type="checkbox"
            checked={quietOn}
            onChange={(event) => setQuietOn(event.target.checked)}
            className="accent-accent"
          />
          <span className="min-w-0 break-words">{t.quietEnabled}</span>
        </label>
        {quietOn && (
          <div className="flex flex-wrap gap-3">
            <div className="min-w-0 space-y-1.5">
              <label htmlFor="quiet-start" className="block text-sm font-medium">
                {t.quietStart}
              </label>
              <input
                id="quiet-start"
                type="time"
                className={fieldClass}
                value={quietStart}
                aria-invalid={!quietValid}
                aria-describedby={quietValid ? undefined : "quiet-error"}
                onChange={(event) => setQuietStart(event.target.value)}
              />
            </div>
            <div className="min-w-0 space-y-1.5">
              <label htmlFor="quiet-end" className="block text-sm font-medium">
                {t.quietEnd}
              </label>
              <input
                id="quiet-end"
                type="time"
                className={fieldClass}
                value={quietEnd}
                aria-invalid={!quietValid}
                aria-describedby={quietValid ? undefined : "quiet-error"}
                onChange={(event) => setQuietEnd(event.target.value)}
              />
            </div>
          </div>
        )}
        {!quietValid && <FieldError id="quiet-error">{t.quietInvalid}</FieldError>}
      </fieldset>
      </Card>

      <Card id="run-summaries" title={t.runsTitle} hint={t.runsHint}>
      <fieldset className="min-w-0 space-y-3">
        <legend className="sr-only">{t.runsTitle}</legend>
        {settings.rooms.length === 0 && <p className="text-sm text-muted">{t.runsEmpty}</p>}
        {settings.rooms.map((room) => (
          <div key={room.name} className="min-w-0 space-y-1.5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">{room.label ?? room.name}</p>
            <ul className="grid gap-2 sm:grid-cols-2">
              {room.agents.map((agent) => {
                const key = `${room.name}/${agent.id}`;
                return (
                  <li key={key} className="min-w-0">
                    <label className="flex min-h-10 cursor-pointer items-center gap-3 rounded-md border border-line px-3 py-2 text-sm hover:bg-soft">
                      <input
                        type="checkbox"
                        checked={summaries[key] ?? false}
                        onChange={(event) => setSummaries((current) => ({ ...current, [key]: event.target.checked }))}
                        className="accent-accent"
                      />
                      <span className="min-w-0 break-words">
                        {agent.name} <span className="text-xs text-muted">({t.summary})</span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </fieldset>
      </Card>
    </TabForm>
  );
}
