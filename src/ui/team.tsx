"use client";

import { useState } from "react";
import { errorText, startRun } from "./api";
import { formatCost, formatDateTime } from "./format";
import { roleFileName, type Action, type AgentState, type TeamAgent } from "./model";
import { strings } from "./strings";
import { Badge, buttonClass, ErrorNote, fieldClass, Section } from "./ui";

const stateTone: Record<AgentState, "ok" | "danger" | "neutral"> = {
  working: "ok",
  failed: "danger",
  idle: "neutral",
};

function AgentCard({ agent, dispatch }: { agent: TeamAgent; dispatch: (action: Action) => void }) {
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<number | null>(null);
  const run = agent.lastRun;
  const taskId = `task-${agent.key}`;

  const launch = async () => {
    setBusy(true);
    setError(null);
    setStarted(null);
    try {
      const created = await startRun(agent.room, agent.id, task);
      dispatch({ type: "run", run: created });
      setStarted(created.id);
      setTask("");
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="space-y-3 rounded-lg border border-line bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="break-words text-base font-semibold">{agent.name}</h3>
          <p className="text-xs text-muted">{agent.room}</p>
        </div>
        <Badge tone={stateTone[agent.state]}>{strings.team.state[agent.state]}</Badge>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted">{strings.team.role}</dt>
        <dd className="break-all font-mono text-xs leading-5">{roleFileName(agent.role)}</dd>
        <dt className="text-muted">{strings.team.model}</dt>
        <dd>{agent.model}</dd>
      </dl>

      <div className="space-y-1 text-sm">
        <p className="font-medium">{strings.team.lastRun}</p>
        {run ? (
          <>
            <p className="text-xs text-muted">
              {strings.team.runLine({
                id: run.id,
                status: strings.team.runStatus[run.status],
                date: formatDateTime(run.startedAt),
              })}
              {run.status !== "running" && run.costUsd > 0 ? `, ${formatCost(run.costUsd)}` : ""}
            </p>
            {run.summary ? (
              <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-soft px-3 py-2">
                {run.summary}
              </p>
            ) : (
              run.status !== "running" && <p className="text-muted">{strings.team.noSummary}</p>
            )}
          </>
        ) : (
          <p className="text-muted">{strings.team.noRun}</p>
        )}
      </div>

      <div className="space-y-2">
        <label htmlFor={taskId} className="block text-sm font-medium">
          {strings.team.taskLabel}
        </label>
        <textarea
          id={taskId}
          className={fieldClass}
          rows={2}
          value={task}
          maxLength={20000}
          placeholder={strings.team.taskPlaceholder}
          onChange={(event) => setTask(event.target.value)}
        />
        <button
          type="button"
          className={buttonClass("primary")}
          disabled={busy || agent.state === "working"}
          onClick={() => void launch()}
        >
          {busy ? strings.team.starting : strings.team.runButton}
        </button>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      {started !== null && !error && (
        <p role="status" className="text-sm text-ok">
          {strings.team.runStarted(started)}
        </p>
      )}
    </li>
  );
}

export function Team({
  agents,
  invalidRooms,
  dispatch,
}: {
  agents: TeamAgent[];
  invalidRooms: { room: string; error: string }[];
  dispatch: (action: Action) => void;
}) {
  return (
    <Section title={strings.team.title}>
      {invalidRooms.length > 0 && (
        <div className="space-y-1 rounded-md border border-warn bg-warn-soft px-3 py-2 text-sm text-warn">
          <p className="font-medium">{strings.app.invalidRoomsTitle}</p>
          <ul className="space-y-1">
            {invalidRooms.map((room) => (
              <li key={room.room} className="break-words">
                <span className="font-mono text-xs">{room.room}</span> : {room.error}
              </li>
            ))}
          </ul>
        </div>
      )}
      {agents.length === 0 ? (
        <p className="text-sm text-muted">{strings.team.empty}</p>
      ) : (
        <ul className="space-y-3">
          {agents.map((agent) => (
            <AgentCard key={agent.key} agent={agent} dispatch={dispatch} />
          ))}
        </ul>
      )}
    </Section>
  );
}
