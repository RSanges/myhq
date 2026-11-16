"use client";

import { useMemo, type ReactNode } from "react";
import type { SettingsView } from "@/server/settings-schema";
import { saveSettingsGroup } from "./api";
import { formatSmallUsd, formatUsd } from "./settings-format";
import { isDirty, limitsErrors, limitsForm, limitsInput, type LimitsForm } from "./settings-model";
import { Card, Field, FieldError, sourceText, Switch, TabForm, useSavedForm } from "./settings-parts";
import { DoorCard } from "./settings-door";
import { PortierVerdicts } from "./settings-portier";
import { strings } from "./strings";
import { fieldClass } from "./ui";

const t = strings.settings;
const l = t.limitsTab;

type Props = { settings: SettingsView; onSaved: (settings: SettingsView) => void; onDirtyChange: (dirty: boolean) => void };

/** A number field with its unit after it. */
function NumberField({
  id,
  label,
  unit,
  value,
  placeholder,
  invalid,
  error,
  hint,
  onChange,
}: {
  id: string;
  label: string;
  unit: string;
  value: string;
  placeholder: string;
  invalid: boolean;
  error: string;
  hint: ReactNode;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <div className="flex items-center gap-2">
        <input
          id={id}
          className={`${fieldClass} tabular-nums`}
          inputMode="decimal"
          value={value}
          placeholder={placeholder}
          autoComplete="off"
          aria-invalid={invalid}
          aria-describedby={invalid ? `${id}-error` : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
        <span className="shrink-0 text-sm text-muted">{unit}</span>
      </div>
      {invalid && <FieldError id={`${id}-error`}>{error}</FieldError>}
    </Field>
  );
}

/** The spending of the week since Monday, by room, against the weekly budget when there is one. */
function SpendGauge({ settings }: { settings: SettingsView }) {
  const { spend } = settings;
  const budget = settings.budgets.weeklyBudgetUsd.effective;
  const scale = Math.max(budget ?? 0, spend.totalUsd) || 1;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span>
          <b className="tabular-nums">{l.spent(formatUsd(spend.totalUsd))}</b> <span className="text-muted">{l.spentSince}</span>
        </span>
        {budget !== null && <span className="text-muted tabular-nums">{l.weekCap(formatUsd(budget))}</span>}
      </div>
      <div
        className="flex h-3 overflow-hidden rounded-full bg-soft"
        role="img"
        aria-label={l.spendByRoom(formatUsd(spend.totalUsd), budget === null ? null : formatUsd(budget))}
      >
        {spend.byRoom.map((room) => (
          <i
            key={room.room}
            className="block h-full border-r border-card"
            style={{ width: `${(room.costUsd / scale) * 100}%`, background: room.color ?? "var(--muted)" }}
          />
        ))}
      </div>
      {spend.byRoom.length === 0 ? (
        <p className="text-xs text-muted">{l.spendEmpty}</p>
      ) : (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {spend.byRoom.map((room) => (
            <li key={room.room} className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: room.color ?? "var(--muted)" }} aria-hidden="true" />
              {room.label ?? room.room} <b className="tabular-nums">{formatUsd(room.costUsd)} $</b>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One small model call outside runs, with its switch and its figures. */
function SmallCall({ title, body, figures, children }: { title: string; body: string; figures: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-2 rounded-md border border-line p-3 sm:grid-cols-[1fr_auto] sm:items-start">
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm text-muted">{body}</p>
        <p className="text-xs text-muted">{figures}</p>
      </div>
      <div className="flex items-center gap-2 sm:justify-end">{children}</div>
    </div>
  );
}

/** « Limites et coûts »: scheduler and daily cap, budgets, run durations, the small model calls. */
export function LimitsTab({ settings, onSaved, onDirtyChange }: Props) {
  const saved = useMemo(() => limitsForm(settings), [settings]);
  const [form, setForm, reset] = useSavedForm<LimitsForm>(saved);
  const errors = limitsErrors(form, settings);
  const set = (patch: Partial<LimitsForm>) => setForm((current) => ({ ...current, ...patch }));
  const { scheduler, maxRunsPerDay, budgets, portier, summaries } = settings;
  const fallback = (value: number | null) => l.fallback(value === null ? l.none : String(value).replace(".", ","));

  return (
    <TabForm
      id="limites"
      dirty={isDirty(form, saved)}
      blocked={Object.keys(errors).length > 0}
      onDirtyChange={onDirtyChange}
      onReset={reset}
      onSave={async () => onSaved(await saveSettingsGroup("limits", limitsInput(form)))}
    >
      <Card id="limits" title={t.limits.title} hint={t.limits.hint}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={t.limits.scheduler}
            htmlFor="scheduler"
            hint={
              <>
                {t.limits.schedulerHint} {t.limits.schedulerState({ enabled: scheduler.effective, running: scheduler.running })}{" "}
                {sourceText(scheduler.source, "HQ_SCHEDULER")}
              </>
            }
          >
            <select
              id="scheduler"
              className={fieldClass}
              value={form.scheduler}
              onChange={(event) => set({ scheduler: event.target.value as LimitsForm["scheduler"] })}
            >
              <option value="env">{t.limits.schedulerEnv(scheduler.fallback)}</option>
              <option value="on">{t.limits.schedulerOn}</option>
              <option value="off">{t.limits.schedulerOff}</option>
            </select>
          </Field>
          <NumberField
            id="cap"
            label={t.limits.cap}
            unit={l.runs}
            value={form.cap}
            placeholder={String(maxRunsPerDay.fallback)}
            invalid={Boolean(errors.cap)}
            error={t.limits.capInvalid}
            onChange={(cap) => set({ cap })}
            hint={
              <>
                {t.limits.capHint} {l.capToday(settings.runsToday, maxRunsPerDay.effective)} {t.limits.capFallback(maxRunsPerDay.fallback)}.{" "}
                {sourceText(maxRunsPerDay.source, "HQ_MAX_RUNS_PER_DAY")}
              </>
            }
          />
        </div>
      </Card>

      <Card id="budgets" title={l.budgetsTitle} hint={l.budgetsHint}>
        <SpendGauge settings={settings} />
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField
            id="default-budget"
            label={l.defaultBudget}
            unit={l.usd}
            value={form.defaultBudget}
            placeholder={String(budgets.defaultMaxBudgetUsd.fallback)}
            invalid={Boolean(errors.defaultBudget)}
            error={l.positiveInvalid}
            onChange={(defaultBudget) => set({ defaultBudget })}
            hint={
              <>
                {l.defaultBudgetHint} {fallback(budgets.defaultMaxBudgetUsd.fallback)}.{" "}
                {sourceText(budgets.defaultMaxBudgetUsd.source, "HQ_DEFAULT_MAX_BUDGET_USD")}
              </>
            }
          />
          <NumberField
            id="week-budget"
            label={l.weeklyBudget}
            unit={l.usd}
            value={form.weeklyBudget}
            placeholder={budgets.weeklyBudgetUsd.fallback === null ? l.none : String(budgets.weeklyBudgetUsd.fallback)}
            invalid={Boolean(errors.weeklyBudget)}
            error={l.positiveInvalid}
            onChange={(weeklyBudget) => set({ weeklyBudget })}
            hint={
              <>
                {l.weeklyBudgetHint} {fallback(budgets.weeklyBudgetUsd.fallback)}.{" "}
                {sourceText(budgets.weeklyBudgetUsd.source, "HQ_WEEKLY_BUDGET_USD")}
              </>
            }
          />
        </div>
      </Card>

      <Card id="durations" title={l.durationTitle} hint={l.durationHint}>
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField
            id="run-timeout"
            label={l.timeout}
            unit={l.minutes}
            value={form.timeout}
            placeholder={String(budgets.runTimeoutMinutes.fallback)}
            invalid={Boolean(errors.timeout)}
            error={l.timeoutInvalid}
            onChange={(timeout) => set({ timeout })}
            hint={
              <>
                {fallback(budgets.runTimeoutMinutes.fallback)}. {sourceText(budgets.runTimeoutMinutes.source, "HQ_RUN_TIMEOUT_MINUTES")}
              </>
            }
          />
          <NumberField
            id="run-hard-limit"
            label={l.hardLimit}
            unit={l.minutes}
            value={form.hardLimit}
            placeholder={String(budgets.runHardLimitMinutes.fallback)}
            invalid={Boolean(errors.hardLimit)}
            error={l.hardLimitInvalid}
            onChange={(hardLimit) => set({ hardLimit })}
            hint={
              <>
                {fallback(budgets.runHardLimitMinutes.fallback)}. {sourceText(budgets.runHardLimitMinutes.source, "HQ_RUN_HARD_LIMIT_MINUTES")}
              </>
            }
          />
        </div>
      </Card>

      <Card id="calls" title={l.callsTitle} hint={l.callsHint}>
        <div className="space-y-3">
          <SmallCall
            title={l.portierTitle}
            body={l.portierBody(portier.model)}
            figures={t.portier.week({ calls: portier.week.calls, skips: portier.week.skips, cost: formatSmallUsd(portier.week.costUsd) })}
          >
            <Switch id="switch-portier" checked={form.portier} onChange={(on) => set({ portier: on })} label={l.portierTitle} />
            <span className="text-sm">{form.portier ? t.limits.schedulerOn : t.limits.schedulerOff}</span>
          </SmallCall>
          <SmallCall title={l.summariesTitle} body={l.summariesBody} figures={l.summariesWeek(summaries.week.calls, formatSmallUsd(summaries.week.costUsd))}>
            <Switch id="switch-summaries" checked={form.summaries} onChange={(on) => set({ summaries: on })} label={l.summariesTitle} />
            <span className="text-sm">{form.summaries ? t.limits.schedulerOn : t.limits.schedulerOff}</span>
          </SmallCall>
          <details className="settings-details">
            <summary className="cursor-pointer text-sm font-medium">{l.verdicts}</summary>
            <div className="pt-3">
              <PortierVerdicts verdicts={portier.verdicts} />
            </div>
          </details>
          <DoorCard door={settings.door} />
        </div>
      </Card>
    </TabForm>
  );
}
