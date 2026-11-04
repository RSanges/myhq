"use client";

import Link from "next/link";
import { SheetShell } from "./agent-sheet";
import { formatCost, formatWhen } from "./format";
import { chipStyle } from "./room-color";
import type { RoomDigest, SheetAgent, SheetAgentLine, SheetAgentState } from "./room-sheet-model";
import { scheduleText } from "./schedule";
import { strings } from "./strings";
import { Badge, buttonClass } from "./ui";

const t = strings.room.roomSheet;

const stateTone: Record<SheetAgentState["kind"], "ok" | "warn" | "danger" | "accent" | "neutral"> = {
  working: "ok",
  resource: "warn",
  deciding: "accent",
  stuck: "warn",
  failed: "danger",
  asleep: "neutral",
};

function stateText(state: SheetAgentState): string {
  switch (state.kind) {
    case "resource":
      return strings.studio.waitingFor(state.resources);
    case "deciding":
      return t.state.deciding(state.count);
    default:
      return t.state[state.kind];
  }
}

function lineText(line: SheetAgentLine): string {
  switch (line.kind) {
    case "thought":
    case "summary":
      return line.text;
    case "running":
      return t.runningSince(formatWhen(line.since));
    case "noSummary":
      return t.noSummary;
    case "noRun":
      return t.noRun;
  }
}

/** One agent of the room: a button that opens its own sheet, then its routines. */
function AgentEntry({ agent, onOpen }: { agent: SheetAgent; onOpen: () => void }) {
  return (
    <li className="room-sheet-agent">
      <button type="button" className="room-sheet-agent-open" aria-haspopup="dialog" title={t.openAgent(agent.name)} onClick={onOpen}>
        <span className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <span className="font-semibold">{agent.name}</span>
          <Badge tone={stateTone[agent.state.kind]}>{stateText(agent.state)}</Badge>
        </span>
        <span className="room-sheet-agent-line">{lineText(agent.line)}</span>
        {agent.lastAt && <span className="text-xs text-muted">{t.lastRun(formatWhen(agent.lastAt))}</span>}
      </button>
      {agent.routines.length > 0 && (
        <ul className="room-sheet-routines" aria-label={t.routines}>
          {agent.routines.map((routine, index) => {
            const words = scheduleText(routine.schedule);
            return (
              <li key={index}>
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  {words ?? <code className="font-mono text-xs">{routine.cron}</code>}
                  <Badge tone={agent.armed ? "ok" : "neutral"}>{agent.armed ? t.armed : t.disarmed}</Badge>
                </span>
                {routine.task && <span className="room-sheet-agent-line">{routine.task}</span>}
                <span className="text-xs text-muted">{routine.nextAt ? t.next(formatWhen(routine.nextAt)) : t.never}</span>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

/**
 * The sheet of a room of the single floor, opened by a click on the room or
 * its button at the top: its name, colour and logo, what waits for the user's
 * decision (a link to « À signer » filtered to the room), the cost of the day,
 * and each agent with its state, what it does or last did, and its routines.
 * A click on an agent opens the agent's own sheet. Rebuilt from the page's
 * model, so it follows the stream.
 */
export function RoomSheet({
  name,
  color,
  logo,
  digest,
  pileHref,
  schedulerEnabled,
  onOpenAgent,
  onClose,
}: {
  /** The name shown (the reception's for the lobby). */
  name: string;
  color: string | null;
  logo: string | null;
  digest: RoomDigest;
  /** The page of the pile of decisions filtered to the room. */
  pileHref: string;
  schedulerEnabled: boolean;
  onOpenAgent: (key: string) => void;
  onClose: () => void;
}) {
  const tint = chipStyle(color);
  const hasRoutines = digest.agents.some((agent) => agent.routines.length > 0);
  const lead =
    logo || tint ? (
      <span className="room-sheet-mark" data-tint={tint ? "" : undefined} style={tint ?? undefined} aria-hidden>
        {logo ? (
          // eslint-disable-next-line @next/next/no-img-element -- a small logo of the home, served by the API, any size
          <img src={logo} alt="" />
        ) : null}
      </span>
    ) : null;

  return (
    <SheetShell label={t.label(name)} title={name} lead={lead} onClose={onClose}>
      <dl className="room-sheet-figures">
        <div>
          <dt>{t.decisions}</dt>
          <dd>
            <p>{t.pending(digest.pending)}</p>
            <Link href={pileHref} className={buttonClass(digest.pending > 0 ? "primary" : undefined)}>
              {t.openPile(digest.pending)}
            </Link>
          </dd>
        </div>
        {digest.today && (
          <div>
            <dt>{t.today}</dt>
            <dd>{t.cost(digest.today.runs, formatCost(digest.today.costUsd))}</dd>
          </div>
        )}
      </dl>
      <section className="space-y-2" aria-labelledby="room-sheet-team">
        <h3 id="room-sheet-team" className="text-sm font-semibold">
          {t.team}
        </h3>
        {hasRoutines && !schedulerEnabled && <p className="text-xs text-muted">{t.schedulerOff}</p>}
        {digest.agents.length === 0 ? (
          <p className="text-sm text-muted">{t.noAgents}</p>
        ) : (
          <ul className="space-y-2">
            {digest.agents.map((agent) => (
              <AgentEntry key={agent.key} agent={agent} onOpen={() => onOpenAgent(agent.key)} />
            ))}
          </ul>
        )}
      </section>
    </SheetShell>
  );
}
