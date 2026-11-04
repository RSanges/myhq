"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { SettingsView } from "@/server/settings-schema";
import { errorText, fetchSettings, saveSettingsGroup } from "./api";
import { FLOOR_LAYOUTS, type FloorLayoutMode } from "./floor-mode";
import { Notifications } from "./settings-notifications";
import { Field, FieldError, GroupCard } from "./settings-parts";
import { RoomsAndAgents } from "./settings-rooms";
import { strings } from "./strings";
import { buttonClass, ErrorNote, fieldClass } from "./ui";

const t = strings.settings;

type GroupProps = { settings: SettingsView; onSaved: (settings: SettingsView) => void };

const linkClass =
  "text-sm text-muted underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/** « Disposition et langue »: floor layout, language of the agents' texts, time zone. */
function LayoutGroup({ settings, onSaved }: GroupProps) {
  const [layout, setLayout] = useState<FloorLayoutMode>(settings.layout);
  const [language, setLanguage] = useState(settings.language.value);
  const [zone, setZone] = useState(settings.timeZone.file ?? "");
  const zones = useMemo(() => {
    try {
      return Intl.supportedValuesOf("timeZone");
    } catch {
      return [];
    }
  }, []);
  const zoneValid = zone.trim() === "" || zones.length === 0 || zones.includes(zone.trim()) || zone.trim() === "UTC";
  const source = settings.timeZone.source;

  return (
    <GroupCard
      id="layout"
      title={t.layout.title}
      hint={t.layout.hint}
      blocked={!zoneValid}
      onSave={async () => {
        onSaved(
          await saveSettingsGroup("layout", { layout, language, timeZone: zone.trim() === "" ? null : zone.trim() }),
        );
      }}
    >
      <fieldset className="min-w-0 space-y-2">
        <legend className="text-sm font-medium">{t.layout.layoutLegend}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {FLOOR_LAYOUTS.map((option) => (
            <label
              key={option}
              className={`flex min-w-0 cursor-pointer gap-3 rounded-md border p-3 text-sm ${layout === option ? "border-accent bg-accent-soft" : "border-line hover:bg-soft"}`}
            >
              <input
                type="radio"
                name="layout"
                value={option}
                checked={layout === option}
                onChange={() => setLayout(option)}
                className="mt-0.5 accent-accent"
              />
              <span className="min-w-0 space-y-0.5">
                <span className="block font-medium">{t.layout.options[option].label}</span>
                <span className="block text-xs text-muted">{t.layout.options[option].hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t.layout.language} htmlFor="language" hint={t.layout.languageHint}>
          <select id="language" className={fieldClass} value={language} onChange={(event) => setLanguage(event.target.value)}>
            {settings.language.options.map((tag) => (
              <option key={tag} value={tag}>
                {t.layout.languageNames[tag] ?? tag}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label={t.layout.timeZone}
          htmlFor="time-zone"
          hint={
            <>
              {t.layout.timeZoneHint} {t.layout.timeZoneFallback(settings.timeZone.fallback)}.{" "}
              {source === "file" ? t.sources.file : source === "env" ? t.sources.env("HQ_TIMEZONE") : t.sources.system}
            </>
          }
        >
          <input
            id="time-zone"
            className={fieldClass}
            list="time-zones"
            value={zone}
            placeholder={t.layout.timeZonePlaceholder}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={!zoneValid}
            aria-describedby={zoneValid ? undefined : "time-zone-error"}
            onChange={(event) => setZone(event.target.value)}
          />
          <datalist id="time-zones">
            {zones.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
          {!zoneValid && <FieldError id="time-zone-error">{t.layout.timeZoneInvalid}</FieldError>}
        </Field>
      </div>
    </GroupCard>
  );
}

/** « Planificateur et plafonds »: scheduler on or off, daily cap of runs. */
function LimitsGroup({ settings, onSaved }: GroupProps) {
  const { scheduler, maxRunsPerDay } = settings;
  const [mode, setMode] = useState<"env" | "on" | "off">(scheduler.file === null ? "env" : scheduler.file ? "on" : "off");
  const [cap, setCap] = useState(maxRunsPerDay.file === null ? "" : String(maxRunsPerDay.file));
  const capValid = cap.trim() === "" || /^\d{1,6}$/.test(cap.trim());

  return (
    <GroupCard
      id="limits"
      title={t.limits.title}
      hint={t.limits.hint}
      blocked={!capValid}
      onSave={async () => {
        onSaved(
          await saveSettingsGroup("limits", {
            scheduler: mode === "env" ? null : mode === "on",
            maxRunsPerDay: cap.trim() === "" ? null : Number(cap.trim()),
          }),
        );
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={t.limits.scheduler}
          htmlFor="scheduler"
          hint={
            <>
              {t.limits.schedulerHint} {t.limits.schedulerState({ enabled: scheduler.effective, running: scheduler.running })}{" "}
              {scheduler.source === "file"
                ? t.sources.file
                : scheduler.source === "env"
                  ? t.sources.env("HQ_SCHEDULER")
                  : t.sources.default}
            </>
          }
        >
          <select
            id="scheduler"
            className={fieldClass}
            value={mode}
            onChange={(event) => setMode(event.target.value as "env" | "on" | "off")}
          >
            <option value="env">{t.limits.schedulerEnv(scheduler.fallback)}</option>
            <option value="on">{t.limits.schedulerOn}</option>
            <option value="off">{t.limits.schedulerOff}</option>
          </select>
        </Field>
        <Field
          label={t.limits.cap}
          htmlFor="cap"
          hint={
            <>
              {t.limits.capHint} {t.limits.capFallback(maxRunsPerDay.fallback)}.{" "}
              {maxRunsPerDay.source === "file"
                ? t.sources.file
                : maxRunsPerDay.source === "env"
                  ? t.sources.env("HQ_MAX_RUNS_PER_DAY")
                  : t.sources.default}
            </>
          }
        >
          <input
            id="cap"
            className={fieldClass}
            inputMode="numeric"
            value={cap}
            placeholder={String(maxRunsPerDay.fallback)}
            aria-invalid={!capValid}
            aria-describedby={capValid ? undefined : "cap-error"}
            onChange={(event) => setCap(event.target.value)}
          />
          {!capValid && <FieldError id="cap-error">{t.limits.capInvalid}</FieldError>}
        </Field>
      </div>
    </GroupCard>
  );
}

export function SettingsPage() {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchSettings().then(setSettings, (error: unknown) => setLoadError(errorText(error)));
  }, []);

  useEffect(() => {
    document.title = t.pageTitle;
    load();
  }, [load]);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h1 className="text-xl font-semibold">{t.title}</h1>
        <Link href="/" className={linkClass}>
          {t.back}
        </Link>
      </header>
      <p className="text-sm text-muted">{t.intro}</p>

      {loadError && (
        <div className="space-y-3">
          <ErrorNote>
            {t.loadFailed} {loadError}
          </ErrorNote>
          <button type="button" className={buttonClass()} onClick={() => {
              setLoadError(null);
              load();
            }}>
            {t.retry}
          </button>
        </div>
      )}
      {!settings && !loadError && <p className="text-sm text-muted">{t.loading}</p>}

      {settings && (
        <>
          {settings.errors.length > 0 && (
            <div role="alert" className="space-y-2 rounded-md border border-warn bg-warn-soft px-3 py-2 text-sm text-warn">
              <p className="font-medium">{t.problemsTitle}</p>
              <ul className="list-disc space-y-1 pl-5 break-words">
                {settings.errors.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <p>{t.problemsHint}</p>
            </div>
          )}
          <LayoutGroup settings={settings} onSaved={setSettings} />
          <LimitsGroup settings={settings} onSaved={setSettings} />
          <Notifications settings={settings} onSaved={setSettings} />
          <RoomsAndAgents settings={settings} onSaved={setSettings} />
          <section className="space-y-1 rounded-lg border border-dashed border-line p-4 text-sm sm:p-5">
            <h2 className="font-semibold">{t.secrets.title}</h2>
            <p className="text-muted">{t.secrets.body}</p>
          </section>
        </>
      )}
    </div>
  );
}
