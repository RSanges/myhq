"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { SettingsView } from "@/server/settings-schema";
import { errorText, fetchSettings, saveSettingsGroup } from "./api";
import { FLOOR_LAYOUTS, type FloorLayoutMode } from "./floor-mode";
import { formatUsd } from "./settings-format";
import { LimitsTab } from "./settings-limits";
import {
  addressFromParams,
  isDirty,
  searchOf,
  SETTINGS_TABS,
  tabAfterKey,
  type SettingsAddress,
  type SettingsTab,
} from "./settings-model";
import { Notifications } from "./settings-notifications";
import { Card, Field, FieldError, sourceText, TabForm, useSavedForm } from "./settings-parts";
import { RoomsTab } from "./settings-rooms";
import { SecurityTab } from "./settings-security";
import { strings } from "./strings";
import { SiteNav } from "./site-nav";
import { buttonClass, ErrorNote, fieldClass } from "./ui";

const t = strings.settings;

type TabProps = { settings: SettingsView; onSaved: (settings: SettingsView) => void; onDirtyChange: (dirty: boolean) => void };

type LayoutForm = { layout: FloorLayoutMode; language: string; zone: string };

const layoutForm = (settings: SettingsView): LayoutForm => ({
  layout: settings.layout,
  language: settings.language.value,
  zone: settings.timeZone.file ?? "",
});

/** « Général »: floor layout, language of the agents' texts, time zone. */
function GeneralTab({ settings, onSaved, onDirtyChange }: TabProps) {
  const saved = useMemo(() => layoutForm(settings), [settings]);
  const [form, setForm, reset] = useSavedForm(saved);
  const zones = useMemo(() => {
    try {
      return Intl.supportedValuesOf("timeZone");
    } catch {
      return [];
    }
  }, []);
  const zone = form.zone.trim();
  const zoneValid = zone === "" || zones.length === 0 || zones.includes(zone) || zone === "UTC";

  return (
    <TabForm
      id="general"
      dirty={isDirty(form, saved)}
      blocked={!zoneValid}
      onDirtyChange={onDirtyChange}
      onReset={reset}
      onSave={async () => {
        onSaved(await saveSettingsGroup("layout", { layout: form.layout, language: form.language, timeZone: zone === "" ? null : zone }));
      }}
    >
      <Card id="layout" title={t.layout.title} hint={t.layout.hint}>
        <fieldset className="min-w-0 space-y-2">
          <legend className="text-sm font-medium">{t.layout.layoutLegend}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {FLOOR_LAYOUTS.map((option) => (
              <label
                key={option}
                className={`flex min-w-0 cursor-pointer gap-3 rounded-md border p-3 text-sm ${form.layout === option ? "border-accent bg-accent-soft" : "border-line hover:bg-soft"}`}
              >
                <input
                  type="radio"
                  name="layout"
                  value={option}
                  checked={form.layout === option}
                  onChange={() => setForm({ ...form, layout: option })}
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
            <select id="language" className={fieldClass} value={form.language} onChange={(event) => setForm({ ...form, language: event.target.value })}>
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
                {sourceText(settings.timeZone.source, "HQ_TIMEZONE")}
              </>
            }
          >
            <input
              id="time-zone"
              className={fieldClass}
              list="time-zones"
              value={form.zone}
              placeholder={t.layout.timeZonePlaceholder}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={!zoneValid}
              aria-describedby={zoneValid ? undefined : "time-zone-error"}
              onChange={(event) => setForm({ ...form, zone: event.target.value })}
            />
            <datalist id="time-zones">
              {zones.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            {!zoneValid && <FieldError id="time-zone-error">{t.layout.timeZoneInvalid}</FieldError>}
          </Field>
        </div>
      </Card>
    </TabForm>
  );
}

/** The figures of the header: rooms on the floor, agents armed, cost of the week. */
function Figures({ settings }: { settings: SettingsView }) {
  const agents = settings.rooms.reduce((sum, room) => sum + room.agents.length, 0);
  const armed = settings.rooms.reduce((sum, room) => sum + room.agents.filter((agent) => agent.armed).length, 0);
  const figures = [
    { value: String(settings.rooms.length), small: null, label: t.figures.rooms(settings.rooms.length) },
    { value: String(armed), small: `/${agents}`, label: t.figures.armed },
    { value: formatUsd(settings.spend.totalUsd), small: "$", label: t.figures.week },
  ];
  return (
    <dl className="grid grid-cols-3 gap-2 sm:flex sm:gap-3">
      {figures.map((figure) => (
        <div key={figure.label} className="min-w-0 rounded-lg border border-line bg-card px-3 py-2 sm:min-w-28">
          <dd className="text-lg font-semibold tabular-nums">
            {figure.value}
            {figure.small && <small className="text-xs font-medium text-muted">{figure.small}</small>}
          </dd>
          <dt className="text-xs text-muted">{figure.label}</dt>
        </div>
      ))}
    </dl>
  );
}

/** The address of the page, read from the location and written with the history API (back and forward work). */
function useAddress(): [SettingsAddress, (next: SettingsAddress, mode?: "push" | "replace") => void] {
  const params = useSearchParams();
  const address = useMemo(() => addressFromParams(params), [params]);
  const go = useCallback((next: SettingsAddress, mode: "push" | "replace" = "push") => {
    const url = `${window.location.pathname}${searchOf(next)}`;
    if (mode === "push") window.history.pushState(null, "", url);
    else window.history.replaceState(null, "", url);
  }, []);
  return [address, go];
}

export function SettingsPage() {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dirtyTabs, setDirtyTabs] = useState<Partial<Record<SettingsTab, boolean>>>({});
  const [address, go] = useAddress();
  const tabRefs = useRef<Partial<Record<SettingsTab, HTMLButtonElement | null>>>({});

  const load = useCallback(() => {
    fetchSettings().then(setSettings, (error: unknown) => setLoadError(errorText(error)));
  }, []);

  useEffect(() => {
    document.title = t.pageTitle;
    load();
  }, [load]);

  const dirtyHandlers = useMemo(
    () =>
      Object.fromEntries(
        SETTINGS_TABS.map((tab) => [tab, (dirty: boolean) => setDirtyTabs((current) => (current[tab] === dirty ? current : { ...current, [tab]: dirty }))]),
      ) as Record<SettingsTab, (dirty: boolean) => void>,
    [],
  );

  const select = (tab: SettingsTab, focus = false) => {
    if (tab !== address.tab) go({ tab, room: null, deleting: null });
    if (focus) tabRefs.current[tab]?.focus();
  };

  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = tabAfterKey(address.tab, event.key);
    if (!next) return;
    event.preventDefault();
    select(next, true);
  };

  // The selected tab stays in view in a bar that scrolls (a narrow screen).
  useEffect(() => {
    tabRefs.current[address.tab]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [address.tab]);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-4 pb-10 pt-6">
      <header className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h1 className="text-xl font-semibold">{t.title}</h1>
          <SiteNav current="settings" />
        </div>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <p className="max-w-2xl text-sm text-muted">{t.intro}</p>
          {settings && <Figures settings={settings} />}
        </div>
      </header>

      <div className="settings-tabs-bar">
        <div role="tablist" aria-label={t.tabs.listLabel} className="settings-tabs" onKeyDown={onTabKey}>
          {SETTINGS_TABS.map((tab) => (
            <button
              key={tab}
              ref={(element) => {
                tabRefs.current[tab] = element;
              }}
              type="button"
              role="tab"
              id={`tab-${tab}`}
              aria-controls={`panel-${tab}`}
              aria-selected={address.tab === tab}
              tabIndex={address.tab === tab ? 0 : -1}
              className="settings-tab"
              onClick={() => select(tab)}
            >
              {t.tabs.labels[tab]}
              {tab === "salles" && settings && <span className="settings-tab-count">{settings.rooms.length}</span>}
              {dirtyTabs[tab] && (
                <span className="settings-tab-dirty" title={t.tabs.dirty}>
                  <span className="sr-only">{t.tabs.dirty}</span>
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {loadError && (
        <div className="space-y-3">
          <ErrorNote>
            {t.loadFailed} {loadError}
          </ErrorNote>
          <button
            type="button"
            className={buttonClass()}
            onClick={() => {
              setLoadError(null);
              load();
            }}
          >
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
          {SETTINGS_TABS.map((tab) => (
            <section
              key={tab}
              role="tabpanel"
              id={`panel-${tab}`}
              aria-labelledby={`tab-${tab}`}
              hidden={address.tab !== tab}
              tabIndex={0}
              className="min-w-0 space-y-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
            >
              <div className="space-y-1">
                <h2 className="text-lg font-semibold">{t.tabs.labels[tab]}</h2>
                <p className="max-w-3xl text-sm text-muted">{t.tabs.intros[tab]}</p>
              </div>
              {tab === "general" && <GeneralTab settings={settings} onSaved={setSettings} onDirtyChange={dirtyHandlers.general} />}
              {tab === "salles" && (
                <RoomsTab
                  settings={settings}
                  onChanged={setSettings}
                  address={address}
                  go={go}
                  onDirtyChange={dirtyHandlers.salles}
                />
              )}
              {tab === "limites" && <LimitsTab settings={settings} onSaved={setSettings} onDirtyChange={dirtyHandlers.limites} />}
              {tab === "notifications" && (
                <Notifications settings={settings} onSaved={setSettings} onDirtyChange={dirtyHandlers.notifications} />
              )}
              {tab === "securite" && <SecurityTab settings={settings} />}
            </section>
          ))}
        </>
      )}
    </div>
  );
}
