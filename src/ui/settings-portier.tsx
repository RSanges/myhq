"use client";

import type { SettingsView } from "@/server/settings-schema";
import { formatAge } from "./format";
import { formatSmallUsd } from "./settings-format";
import { strings } from "./strings";

const t = strings.settings.portier;

/** The portier's latest verdicts, newest first: who, from whom, what it read, why, and what it cost. */
export function PortierVerdicts({ verdicts }: { verdicts: SettingsView["portier"]["verdicts"] }) {
  if (verdicts.length === 0) return <p className="text-sm text-muted">{t.empty}</p>;
  return (
    <ul className="divide-y divide-line rounded-md border border-line text-sm">
      {verdicts.map((verdict) => (
        <li key={verdict.id} className="min-w-0 space-y-1 px-3 py-2">
          <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className={`font-medium ${verdict.verdict === "skip" ? "text-accent" : ""}`}>{t.verdict[verdict.verdict]}</span>
            <span>
              {verdict.room} / {verdict.agent}
            </span>
            {verdict.from && <span className="text-muted">{t.from(verdict.from)}</span>}
            {verdict.messages > 1 && <span className="text-muted">{t.messages(verdict.messages)}</span>}
            <span className="text-muted">{formatAge(verdict.at)}</span>
            <span className="text-muted">{t.cost(formatSmallUsd(verdict.costUsd))}</span>
            {verdict.failed && <span className="text-warn">{t.failed}</span>}
          </p>
          {verdict.excerpt && <p className="break-words text-muted">« {verdict.excerpt} »</p>}
          <p className="break-words">{verdict.reason}</p>
        </li>
      ))}
    </ul>
  );
}
