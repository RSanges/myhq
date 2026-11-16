"use client";

import type { SettingsView } from "@/server/settings-schema";
import { formatAge } from "./format";
import { Card } from "./settings-parts";
import { strings } from "./strings";

const t = strings.settings.machine;

/** The machine (myhq.json `machine`): the reading, the margins, the veto command, and per agent with needs what it declares, measures and reserves. Read only. */
export function MachineCard({ machine }: { machine: SettingsView["machine"] }) {
  const { reading } = machine;
  return (
    <Card id="machine" title={t.title} hint={t.hint}>
      <div className="space-y-2 text-sm">
        {reading && (
          <p className="tabular-nums">
            {t.reading({
              ramFree: reading.ramFreeGb,
              ramTotal: reading.ramTotalGb,
              vram:
                reading.vramUsedGb === null || reading.vramTotalGb === null
                  ? t.vramUnknown
                  : t.vram(Math.round((reading.vramTotalGb - reading.vramUsedGb) * 100) / 100, reading.vramTotalGb),
            })}
          </p>
        )}
        <p className="text-muted">{t.margins(machine.keepFreeRamGb, machine.keepFreeVramGb)}</p>
        <p className="text-muted">{machine.veto ? t.veto(machine.veto.command, machine.veto.timeoutSeconds) : t.noVeto}</p>
        {machine.agents.length === 0 ? (
          <p className="text-muted">{t.agentsEmpty}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] text-left text-sm tabular-nums">
              <caption className="pb-2 text-left text-muted">{t.agentsCaption}</caption>
              <thead className="text-xs text-muted">
                <tr>
                  <th scope="col" className="py-1 pr-3 font-medium">{t.columns.agent}</th>
                  <th scope="col" className="py-1 pr-3 font-medium">{t.columns.kind}</th>
                  <th scope="col" className="py-1 pr-3 font-medium">{t.columns.declared}</th>
                  <th scope="col" className="py-1 pr-3 font-medium">{t.columns.median}</th>
                  <th scope="col" className="py-1 pr-3 font-medium">{t.columns.max}</th>
                  <th scope="col" className="py-1 font-medium">{t.columns.effective}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {machine.agents.map((row) => (
                  <tr key={`${row.room}/${row.agent}/${row.kind}`}>
                    <td className="py-1 pr-3">
                      {row.room} / {row.name}
                      <span className="block text-xs text-muted">{t.runs(row.runs)}</span>
                    </td>
                    <td className="py-1 pr-3">{t.kinds[row.kind]}</td>
                    <td className="py-1 pr-3">{t.gb(row.declaredGb)}</td>
                    <td className="py-1 pr-3">{t.gb(row.medianGb)}</td>
                    <td className="py-1 pr-3">{t.gb(row.maxGb)}</td>
                    <td className="py-1 font-medium">{t.gb(row.effectiveGb)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {machine.vetoes.length > 0 && (
          <ul className="space-y-1 text-xs text-muted">
            {machine.vetoes.map((veto) => (
              <li key={`${veto.room}/${veto.agent}`}>
                {veto.room} / {veto.agent} : {t.lastVeto({ verdict: veto.verdict, reason: veto.reason, error: veto.error, at: formatAge(veto.at) })}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
