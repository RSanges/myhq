"use client";

import type { SettingsView } from "@/server/settings-schema";
import { formatAge } from "./format";
import { formatSmallUsd } from "./settings-format";
import { strings } from "./strings";

const t = strings.door.settings;

/** The door to the assistant: open or closed, its count and cost over 7 days, its latest requests (agent, question, verdict, answer or reason, cost). */
export function DoorCard({ door }: { door: SettingsView["door"] }) {
  return (
    <div className="min-w-0 space-y-2 rounded-md border border-line p-3">
      <p className="text-sm font-medium">{t.title}</p>
      <p className="text-sm text-muted">{door.enabled ? t.body : t.closed}</p>
      <p className="text-xs text-muted">{t.week(door.week.calls, formatSmallUsd(door.week.costUsd))}</p>
      <details className="settings-details">
        <summary className="cursor-pointer text-sm font-medium">{t.requests}</summary>
        <div className="pt-3">
          {door.requests.length === 0 ? (
            <p className="text-sm text-muted">{t.empty}</p>
          ) : (
            <ul className="divide-y divide-line rounded-md border border-line text-sm">
              {door.requests.map((request) => (
                <li key={request.id} className="min-w-0 space-y-1 px-3 py-2">
                  <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className={`font-medium ${request.verdict === "answered" || request.verdict === "granted" ? "text-accent" : ""}`}>
                      {(request.verdict ? t.verdict[request.verdict] : t.status[request.status]) ?? request.status}
                    </span>
                    <span>
                      {request.room} / {request.agent}
                    </span>
                    <span className="text-muted">{formatAge(request.at)}</span>
                    <span className="text-muted">{t.cost(formatSmallUsd(request.costUsd))}</span>
                  </p>
                  <p className="break-words text-muted">« {request.question} »</p>
                  {request.text && <p className="break-words">{request.text}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>
    </div>
  );
}
