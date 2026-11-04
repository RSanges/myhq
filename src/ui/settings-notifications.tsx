"use client";

import { useState } from "react";
import type { SettingsView } from "@/server/settings-schema";
import { saveSettingsGroup } from "./api";
import { FieldError, GroupCard } from "./settings-parts";
import { strings } from "./strings";
import { buttonClass, fieldClass } from "./ui";

const t = strings.settings.notifications;

/** Same rule as the server: an approval type in snake_case. */
const TYPE_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

type Props = { settings: SettingsView; onSaved: (settings: SettingsView) => void };

/** « Notifications »: informational item types and run summaries sent to Telegram. */
export function Notifications({ settings, onSaved }: Props) {
  // The types on offer: those seen in the home, plus any the user adds (kept even when unticked).
  const [offered, setOffered] = useState<string[]>(() => [
    ...new Set([...settings.notifyTypes.selected, ...settings.notifyTypes.known]),
  ]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(settings.notifyTypes.selected));
  const [extra, setExtra] = useState("");
  const [summaries, setSummaries] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      settings.rooms.flatMap((room) => room.agents.map((agent) => [`${room.name}/${agent.id}`, agent.notifySummary])),
    ),
  );
  const extraValid = extra === "" || TYPE_PATTERN.test(extra.trim());

  const toggleType = (type: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(type);
      else next.delete(type);
      return next;
    });

  const addType = () => {
    const type = extra.trim();
    if (type === "" || !TYPE_PATTERN.test(type)) return;
    setOffered((current) => (current.includes(type) ? current : [...current, type]));
    toggleType(type, true);
    setExtra("");
  };

  return (
    <GroupCard
      id="notifications"
      title={t.title}
      hint={t.hint}
      blocked={!extraValid}
      onSave={async () => {
        onSaved(
          await saveSettingsGroup("notifications", {
            notifyTypes: offered.filter((type) => selected.has(type)),
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
      <fieldset className="min-w-0 space-y-2">
        <legend className="text-sm font-medium">{t.typesTitle}</legend>
        <p className="text-xs text-muted">{t.typesHint}</p>
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

      <fieldset className="min-w-0 space-y-3">
        <legend className="text-sm font-medium">{t.runsTitle}</legend>
        <p className="text-xs text-muted">{t.runsHint}</p>
        {settings.rooms.length === 0 && <p className="text-sm text-muted">{t.runsEmpty}</p>}
        {settings.rooms.map((room) => (
          <div key={room.name} className="min-w-0 space-y-1.5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">{room.name}</p>
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
    </GroupCard>
  );
}
