"use client";

import { useState, type FormEvent } from "react";
import { errorText, setArmed, startOnboarding, startRun } from "./api";
import { formatCost, formatDateTime } from "./format";
import { roleFileName, type Action, type AgentState, type TeamAgent } from "./model";
import type { Scheduler } from "./schemas";
import { strings } from "./strings";
import { Badge, buttonClass, ErrorNote, fieldClass, Section } from "./ui";

const stateTone: Record<AgentState, "ok" | "danger" | "neutral"> = {
  working: "ok",
  failed: "danger",
  idle: "neutral",
};

/** Starts the onboarding agent on a repository; its room proposal arrives on the desk. */
function AddRoom({ dispatch }: { dispatch: (action: Action) => void }) {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<number | null>(null);
  const t = strings.team.addRoom;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (path.trim() === "") return;
    setBusy(true);
    setError(null);
    setStarted(null);
    try {
      const run = await startOnboarding(path);
      dispatch({ type: "run", run });
      setStarted(run.id);
      setPath("");
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="rounded-lg border border-line bg-card p-4">
      <summary className="cursor-pointer text-sm font-medium">{t.title}</summary>
      <form className="mt-3 space-y-2" onSubmit={(event) => void submit(event)}>
        <label htmlFor="add-room-path" className="block text-sm font-medium">
          {t.label}
        </label>
        <input
          id="add-room-path"
          className={fieldClass}
          value={path}
          maxLength={1000}
          required
          onChange={(event) => setPath(event.target.value)}
          aria-describedby="add-room-hint"
        />
        <p id="add-room-hint" className="text-xs text-muted">
          {t.hint}
        </p>
        <button type="submit" className={buttonClass("primary")} disabled={busy || path.trim() === ""}>
          {busy ? t.starting : t.submit}
        </button>
        {error && <ErrorNote>{error}</ErrorNote>}
        {started !== null && !error && (
          <p role="status" className="text-sm text-ok">
            {t.started(started)}
          </p>
        )}
      </form>
    </details>
  );
}

/** The agent's routines, with their next fire, and the switch that arms them. */
function Routines({ agent, dispatch }: { agent: TeamAgent; dispatch: (action: Action) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const switchId = `armed-${agent.key}`;

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      const armed = await setArmed(agent.room, agent.id, !agent.armed);
      dispatch({ type: "armed", room: agent.room, agentId: agent.id, armed });
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">{strings.team.routinesTitle}</p>
        <div className="flex items-center gap-2">
          <span id={switchId} className="text-xs text-muted">
            {strings.team.armedLabel}
          </span>
          <button
            aria-labelledby={switchId}
            type="button"
            role="switch"
            aria-checked={agent.armed}
            disabled={busy}
            onClick={() => void toggle()}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50 ${
              agent.armed ? "border-accent bg-accent" : "border-line bg-soft"
            }`}
          >
            <span
              aria-hidden
              className={`inline-block size-4 rounded-full bg-card shadow transition-transform ${
                agent.armed ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
          <Badge tone={agent.armed ? "ok" : "neutral"}>{agent.armed ? strings.team.armedOn : strings.team.armedOff}</Badge>
        </div>
      </div>
      <ul className="space-y-1">
        {agent.routines.map((routine, index) => (
          <li key={index} className="rounded-md bg-soft px-3 py-2">
            <p className="flex flex-wrap items-baseline gap-x-2">
              <code className="font-mono text-xs">{routine.cron}</code>
              <span className="break-words">{routine.task ?? strings.team.routineDefaultTask}</span>
            </p>
            <p className="text-xs text-muted">
              {routine.nextAt ? strings.team.routineNext(formatDateTime(routine.nextAt)) : strings.team.routineNever}
            </p>
          </li>
        ))}
      </ul>
      {!agent.armed && <p className="text-xs text-muted">{strings.team.armedHint}</p>}
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}

/** One agent: its state, its routines and the last run, with the button that starts a run. */
export function AgentCard({
  agent,
  dispatch,
  showTools = false,
}: {
  agent: TeamAgent;
  dispatch: (action: Action) => void;
  /** Also list the tools the agent may use (the room view shows them). */
  showTools?: boolean;
}) {
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
        {showTools && (
          <>
            <dt className="text-muted">{strings.room.sheet.tools}</dt>
            <dd className="flex flex-wrap gap-1">
              {agent.allowedTools.length === 0 ? (
                <span className="text-muted">{strings.room.sheet.noTools}</span>
              ) : (
                agent.allowedTools.map((tool) => (
                  <code key={tool} className="rounded bg-soft px-1.5 py-0.5 font-mono text-xs break-all">
                    {tool}
                  </code>
                ))
              )}
            </dd>
          </>
        )}
      </dl>

      {agent.routines.length > 0 && <Routines agent={agent} dispatch={dispatch} />}

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
  scheduler,
  dispatch,
}: {
  agents: TeamAgent[];
  invalidRooms: { room: string; error: string }[];
  scheduler: Scheduler;
  dispatch: (action: Action) => void;
}) {
  return (
    <Section title={strings.team.title}>
      <p role="status" className="text-sm text-muted">
        {strings.team.scheduler(scheduler)}
      </p>
      <AddRoom dispatch={dispatch} />
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
