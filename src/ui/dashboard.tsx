"use client";

import Link from "next/link";
import { useEffect, useMemo } from "react";
import { Desk } from "./desk";
import { Feed } from "./feed";
import { Meter } from "./meter";
import { RoutineJournal } from "./routine-journal";
import { pendingTitle, selectAgents, selectHistory, selectPending } from "./model";
import { strings } from "./strings";
import { Team } from "./team";
import { buttonClass, ErrorNote } from "./ui";
import { useHq } from "./use-hq";

export function Dashboard() {
  const { model, dispatch, connection, loadError, usageFailed, retry } = useHq();
  const pending = useMemo(() => selectPending(model), [model]);
  const history = useMemo(() => selectHistory(model), [model]);
  const agents = useMemo(() => selectAgents(model), [model]);

  useEffect(() => {
    document.title = pendingTitle(strings.app.title, pending.length);
  }, [pending.length]);

  const connectionTone =
    connection === "live" ? "bg-ok" : connection === "reconnecting" ? "bg-warn" : "bg-muted";

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{strings.app.title}</h1>
        <div className="flex items-center gap-4">
          <Link
            href="/room"
            className="text-sm text-muted underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {strings.app.roomLink}
          </Link>
          <Link
            href="/roadmap"
            className="text-sm text-muted underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {strings.app.roadmapLink}
          </Link>
          <p role="status" className="flex items-center gap-2 text-sm text-muted">
            <span aria-hidden className={`inline-block size-2 rounded-full ${connectionTone}`} />
            {strings.app.connection[connection]}
          </p>
        </div>
      </header>

      {loadError && (
        <div className="space-y-3">
          <ErrorNote>
            {strings.app.loadFailed} {loadError}
          </ErrorNote>
          <button type="button" className={buttonClass()} onClick={retry}>
            {strings.app.retry}
          </button>
        </div>
      )}

      {!model.loaded && !loadError && <p className="text-sm text-muted">{strings.app.loading}</p>}

      {model.loaded && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="order-2 min-w-0 lg:order-first lg:col-span-2">
            <Meter usage={model.usage} failed={usageFailed} />
          </div>
          <div className="order-1 min-w-0">
            <Desk pending={pending} history={history} dispatch={dispatch} />
          </div>
          <div className="order-3 min-w-0 space-y-6">
            <Team agents={agents} invalidRooms={model.invalidRooms} scheduler={model.scheduler} dispatch={dispatch} />
            <RoutineJournal firings={model.firings} agents={agents} />
            <Feed events={model.events} messages={model.messages} agents={agents} />
          </div>
        </div>
      )}
    </div>
  );
}
