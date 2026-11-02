import { formatCompact, formatCost, formatInteger } from "./format";
import type { Usage } from "./schemas";
import { strings } from "./strings";
import { ErrorNote, Section } from "./ui";

type Totals = Usage["today"];

function Period({ label, totals }: { label: string; totals: Totals }) {
  const cache = totals.cacheCreationInputTokens + totals.cacheReadInputTokens;
  const all = totals.inputTokens + totals.outputTokens + cache;
  return (
    <div className="min-w-0 space-y-1 rounded-lg border border-line bg-card p-4">
      <p className="text-sm font-medium">{label}</p>
      <p className="text-xl font-semibold">{formatCost(totals.costUsd)}</p>
      <p className="text-sm">
        <span className="text-muted">{strings.meter.tokensLabel} </span>
        <span title={formatInteger(all)}>{formatCompact(all)}</span>
        <span className="text-muted"> ({strings.meter.runs(totals.runs)})</span>
      </p>
      <p className="break-words text-xs text-muted">
        {strings.meter.detail({
          input: formatCompact(totals.inputTokens),
          output: formatCompact(totals.outputTokens),
          cache: formatCompact(cache),
        })}
      </p>
    </div>
  );
}

/** Share of the user's weekly budget spent this week (HQ_WEEKLY_BUDGET_USD). */
function Budget({ budget }: { budget: NonNullable<Usage["budget"]> }) {
  const percent = Math.round(budget.share * 100);
  const over = budget.share >= 1;
  return (
    <div className="min-w-0 space-y-2 rounded-lg border border-line bg-card p-4">
      <p className="text-sm font-medium">{strings.meter.budget}</p>
      <p className="text-xl font-semibold">{strings.meter.budgetShare(percent)}</p>
      <div
        className="h-2 overflow-hidden rounded-full bg-soft"
        role="progressbar"
        aria-label={strings.meter.budget}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(100, percent)}
      >
        <div className={`h-full ${over ? "bg-danger" : "bg-accent"}`} style={{ width: `${Math.min(100, percent)}%` }} />
      </div>
      <p className="text-xs text-muted">
        {strings.meter.budgetDetail(formatCost(budget.spentUsd), formatCost(budget.weeklyUsd))}
      </p>
      {over && <p className="text-xs text-danger">{strings.meter.budgetOver}</p>}
    </div>
  );
}

export function Meter({ usage, failed }: { usage: Usage | null; failed: boolean }) {
  const cap = usage?.cap;
  const share = cap && cap.maxRunsPerDay > 0 ? Math.min(100, (cap.runsToday / cap.maxRunsPerDay) * 100) : 100;
  return (
    <Section title={strings.meter.title}>
      {usage === null ? (
        failed ? (
          <ErrorNote>{strings.meter.unavailable}</ErrorNote>
        ) : (
          <p className="text-sm text-muted">{strings.app.loading}</p>
        )
      ) : (
        <div className={`grid gap-3 sm:grid-cols-2 ${usage.budget ? "lg:grid-cols-4" : "lg:grid-cols-3"}`}>
          <Period label={strings.meter.today} totals={usage.today} />
          <Period label={strings.meter.week} totals={usage.week} />
          <div className="min-w-0 space-y-2 rounded-lg border border-line bg-card p-4">
            <p className="text-sm font-medium">{strings.meter.cap}</p>
            <p className="text-xl font-semibold">{strings.meter.capValue(usage.cap.remaining, usage.cap.maxRunsPerDay)}</p>
            <div
              className="h-2 overflow-hidden rounded-full bg-soft"
              role="progressbar"
              aria-label={strings.meter.cap}
              aria-valuemin={0}
              aria-valuemax={usage.cap.maxRunsPerDay}
              aria-valuenow={usage.cap.runsToday}
            >
              <div className={`h-full ${usage.cap.remaining === 0 ? "bg-danger" : "bg-accent"}`} style={{ width: `${share}%` }} />
            </div>
            {usage.cap.remaining === 0 && <p className="text-xs text-danger">{strings.meter.capReached}</p>}
          </div>
          {usage.budget && <Budget budget={usage.budget} />}
        </div>
      )}
    </Section>
  );
}
