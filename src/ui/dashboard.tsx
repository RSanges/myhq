"use client";

import Link from "next/link";
import { useEffect, useMemo } from "react";
import { ChatPanel, ChatToggle, useChatToggle } from "./chat-panel";
import { Desk } from "./desk";
import { Feed } from "./feed";
import { DeskHub } from "./hub";
import { Meter } from "./meter";
import { RoutineJournal } from "./routine-journal";
import { pendingTitle, selectAgents, selectHistory, selectPending, selectUnseen } from "./model";
import { strings } from "./strings";
import { Team } from "./team";
import { buttonClass, ErrorNote } from "./ui";
import { useDeepLink } from "./use-deep-link";
import { useDesk } from "./use-desk";
import { useHq } from "./use-hq";
import { useMediaQuery } from "./use-media-query";

export function Dashboard() {
  const { model, dispatch, connection, loadError, usageFailed, retry, subscribeChat, subscribeDesk } = useHq();
  const desk = useDesk(subscribeDesk);
  const chat = useChatToggle();
  const target = useDeepLink();
  const wide = useMediaQuery("(min-width: 40rem)");
  const pending = useMemo(() => selectPending(model), [model]);
  const unseen = useMemo(() => selectUnseen(model), [model]);
  const history = useMemo(() => selectHistory(model), [model]);
  const agents = useMemo(() => selectAgents(model), [model]);

  useEffect(() => {
    document.title = pendingTitle(strings.app.title, pending.length, unseen.length);
  }, [pending.length, unseen.length]);

  const connectionTone =
    connection === "live" ? "bg-ok" : connection === "reconnecting" ? "bg-warn" : "bg-muted";

  return (
    <div className="chat-shell">
    <div className="chat-main" inert={chat.open && !wide}>
    <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6">
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h1 className="text-xl font-semibold">{strings.app.title}</h1>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Link
            href="/room"
            className="text-sm whitespace-nowrap text-muted underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {strings.app.roomLink}
          </Link>
          <Link
            href="/roadmap"
            className="text-sm whitespace-nowrap text-muted underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {strings.app.roadmapLink}
          </Link>
          <Link
            href="/reglages"
            className="text-sm whitespace-nowrap text-muted underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {strings.app.settingsLink}
          </Link>
          <p role="status" className="flex items-center gap-2 text-sm text-muted">
            <span aria-hidden className={`inline-block size-2 rounded-full ${connectionTone}`} />
            {strings.app.connection[connection]}
          </p>
          <ChatToggle open={chat.open} onClick={chat.toggle} buttonRef={chat.toggleRef} />
        </div>
      </header>

      <DeskHub desk={desk.desk} narrow={!wide} />

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
          <div className="order-2 min-w-0 lg:order-last lg:col-span-2">
            <Meter usage={model.usage} failed={usageFailed} />
          </div>
          <div className="order-1 min-w-0">
            <Desk
              pending={pending}
              unseen={unseen}
              history={history}
              agents={agents}
              dispatch={dispatch}
              target={target}
            />
          </div>
          <div className="order-3 min-w-0 space-y-6">
            <Team agents={agents} invalidRooms={model.invalidRooms} scheduler={model.scheduler} dispatch={dispatch} />
            <RoutineJournal firings={model.firings} agents={agents} />
            <Feed events={model.events} messages={model.messages} agents={agents} target={target} />
          </div>
        </div>
      )}
    </div>
    </div>
    {chat.mounted && (
      <ChatPanel open={chat.open} onClose={chat.close} subscribe={subscribeChat} agents={agents} narrow={!wide} />
    )}
    </div>
  );
}
