"use client";

import type { SettingsView } from "@/server/settings-schema";
import { formatAge } from "./format";
import { strings } from "./strings";

const t = strings.settings.portier;

/** A cost in dollars, to the cent below a dollar's hundredth (a verdict costs a fraction of a cent). */
const usd = (value: number) => (value === 0 ? "0" : value < 0.01 ? value.toFixed(4) : value.toFixed(2));

/**
 * « Portier »: whether the portier is on and on which model (myhq.json, read
 * only here), what it did over 7 days, and its latest verdicts.
 */
export function PortierVerdicts({ settings }: { settings: SettingsView }) {
  const { portier } = settings;
  return (
    <section aria-labelledby="portier-title" className="min-w-0 space-y-4 rounded-lg border border-line bg-card p-4 sm:p-5">
      <div className="space-y-1">
        <h2 id="portier-title" className="text-base font-semibold">
          {t.title}
        </h2>
        <p className="text-sm text-muted">{t.hint}</p>
      </div>
      <p className="text-sm">
        {t.state(portier.enabled, portier.model)}{" "}
        <span className="text-muted">{portier.source === "file" ? strings.settings.sources.file : strings.settings.sources.default}</span>
      </p>
      <p className="text-sm text-muted">
        {t.week({ calls: portier.week.calls, skips: portier.week.skips, cost: usd(portier.week.costUsd) })}
      </p>
      <div className="space-y-2">
        <h3 className="text-sm font-medium">{t.latest}</h3>
        {portier.verdicts.length === 0 ? (
          <p className="text-sm text-muted">{t.empty}</p>
        ) : (
          <ul className="divide-y divide-line rounded-md border border-line text-sm">
            {portier.verdicts.map((verdict) => (
              <li key={verdict.id} className="min-w-0 space-y-1 px-3 py-2">
                <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className={`font-medium ${verdict.verdict === "skip" ? "text-accent" : ""}`}>{t.verdict[verdict.verdict]}</span>
                  <span>
                    {verdict.room} / {verdict.agent}
                  </span>
                  {verdict.from && <span className="text-muted">{t.from(verdict.from)}</span>}
                  {verdict.messages > 1 && <span className="text-muted">{t.messages(verdict.messages)}</span>}
                  <span className="text-muted">{formatAge(verdict.at)}</span>
                  <span className="text-muted">{t.cost(usd(verdict.costUsd))}</span>
                  {verdict.failed && <span className="text-warn">{t.failed}</span>}
                </p>
                {verdict.excerpt && <p className="break-words text-muted">« {verdict.excerpt} »</p>}
                <p className="break-words">{verdict.reason}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
