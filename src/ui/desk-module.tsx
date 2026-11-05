"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo } from "react";
import { ChatPanel } from "./chat-panel";
import { Desk, WatchDesk } from "./desk";
import { markDeskSeen } from "./api";
import { AgendaView, ItemsView, JournalView, PostitsView, StandardView } from "./desk-module-views";
import { formatClock } from "./format";
import { selectAgents, selectHistory, selectPending, selectUnseen } from "./model";
import { RECEPTION_ROOM } from "./reception";
import type { Approval, DeskObject } from "./schemas";
import { strings } from "./strings";
import { SiteNav } from "./site-nav";
import { buttonClass, ErrorNote } from "./ui";
import { useDeepLink } from "./use-deep-link";
import { useDesk } from "./use-desk";
import { useHq } from "./use-hq";
import { useMediaQuery } from "./use-media-query";

const t = strings.deskModules;

/** The core sources of an object, as GET /api/desk names them (`watch:brief+summaries`). */
const coreSources = (object: DeskObject): string[] => (object.source === "command" ? [] : object.source.split("+"));

/** The types of the watch sources of an object; `null` in the list stands for `watch:*`. */
function watchTypes(object: DeskObject): (string | null)[] {
  return coreSources(object)
    .filter((source) => source.startsWith("watch:"))
    .map((source) => (source === "watch:*" ? null : source.slice("watch:".length)));
}

const matchesTypes = (types: (string | null)[]) => (approval: Approval) => types.some((type) => type === null || type === approval.type);

/** A command of the home that failed: what happened, in French, and a way to try again. */
export function CommandError({ object, onRetry }: { object: DeskObject; onRetry: () => void }) {
  if (object.status !== "error") return null;
  return (
    <div className="space-y-3">
      <ErrorNote>
        {(object.error && t.commandError[object.error.code]) ?? strings.errors.generic} {t.commandErrorHint}
      </ErrorNote>
      <button type="button" className={buttonClass()} onClick={onRetry}>
        {t.refresh}
      </button>
    </div>
  );
}

/**
 * The page of one object of the desk, `/bureau/<id>`: a back link to the
 * desk, the object's label and count, and its own interface, chosen by the
 * object and its source (the approval cards for a pile of decisions, the
 * watch items for a tray, a reading view for the newspaper, the week for a
 * calendar, notes for the post-its, what is stuck for the Standard, the
 * conversation for a phone on the chat). Opening the page marks the object
 * seen on the server, which sets its unread count back to zero.
 */
export function DeskModulePage({ id }: { id: string }) {
  const hq = useHq();
  const { desk, loadError, reload } = useDesk(hq.subscribeDesk);
  const router = useRouter();
  const target = useDeepLink();
  const wide = useMediaQuery("(min-width: 40rem)");
  const { model } = hq;
  const agents = useMemo(() => selectAgents(model), [model]);
  const object = desk?.objects.find((each) => each.id === id) ?? null;

  useEffect(() => {
    if (object) document.title = t.pageTitle(object.label, object.count);
  }, [object]);

  // Seen once per opening: what the unread sources (summaries, chat) counted until now is read.
  useEffect(() => {
    let closed = false;
    markDeskSeen(id)
      .then(() => {
        if (!closed) reload();
      })
      .catch(() => undefined);
    return () => {
      closed = true;
    };
  }, [id, reload]);

  if (object?.object === "phone" && coreSources(object).includes("chat")) {
    return (
      <div className="flex min-h-dvh flex-col">
        <ChatPanel open onClose={() => router.push("/bureau")} subscribe={hq.subscribeChat} agents={agents} narrow={!wide} page />
      </div>
    );
  }

  const connectionTone = hq.connection === "live" ? "bg-ok" : hq.connection === "reconnecting" ? "bg-warn" : "bg-muted";
  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <SiteNav current="desk" />
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="min-w-0 truncate text-xl font-semibold">{object?.label ?? strings.app.title}</h1>
          {object && object.count > 0 && (
            <span className="rounded-full bg-accent-soft px-2 py-0.5 text-sm font-semibold text-accent">{object.count}</span>
          )}
        </div>
        <p role="status" className="flex items-center gap-2 text-sm text-muted">
          <span aria-hidden className={`inline-block size-2 rounded-full ${connectionTone}`} />
          {strings.app.connection[hq.connection]}
        </p>
      </header>

      {desk?.configError && <p className="rounded-md bg-warn-soft px-3 py-2 text-sm text-warn">{t.configError}</p>}
      {(loadError || hq.loadError) && (
        <div className="space-y-3">
          <ErrorNote>
            {t.loadFailed} {loadError ?? hq.loadError}
          </ErrorNote>
          <button
            type="button"
            className={buttonClass()}
            onClick={() => {
              reload();
              hq.retry();
            }}
          >
            {strings.app.retry}
          </button>
        </div>
      )}
      {!desk && !loadError && <p className="text-sm text-muted">{t.loading}</p>}
      {desk && !object && <p className="text-sm text-muted">{t.unknown}</p>}
      {object && <ModuleBody object={object} hq={hq} agents={agents} target={target} reload={reload} />}
      {object && object.status === "ok" && object.source === "command" && (
        <p className="text-xs text-muted">{t.updatedAt(formatClock(object.updatedAt))}</p>
      )}
    </div>
  );
}

function ModuleBody({
  object,
  hq,
  agents,
  target,
  reload,
}: {
  object: DeskObject;
  hq: ReturnType<typeof useHq>;
  agents: ReturnType<typeof selectAgents>;
  target: ReturnType<typeof useDeepLink>;
  reload: () => void;
}) {
  const { model, dispatch } = hq;
  // `?room=<room>`: the pile of one room only (the user's desk of that room on the single floor of /room).
  const roomFilter = useSearchParams().get("room");
  const sources = coreSources(object);
  const types = useMemo(() => watchTypes(object), [object]);
  const pending = useMemo(() => selectPending(model), [model]);
  const unseen = useMemo(() => selectUnseen(model).filter(matchesTypes(types)), [model, types]);
  const history = useMemo(() => selectHistory(model), [model]);

  if (object.status === "error") return <CommandError object={object} onRetry={reload} />;

  if (object.object === "pile" && sources.includes("approvals")) {
    if (!model.loaded) return <p className="text-sm text-muted">{t.loading}</p>;
    if (roomFilter) {
      const label = roomFilter === RECEPTION_ROOM ? strings.room.reception.name : roomFilter;
      // An item a shared room delivered belongs to the pile of the room that ordered it.
      const mine = (approval: Approval) => (approval.forRoom ?? approval.room) === roomFilter;
      return (
        <div className="space-y-4">
          <p className="flex flex-wrap items-center gap-2">
            <span className="inline-flex min-h-8 items-center gap-1 rounded-full border border-line bg-soft py-0.5 pr-1 pl-3 text-sm font-medium">
              {t.signer.filter.chip(label)}
              <Link
                href={`/bureau/${object.id}`}
                replace
                aria-label={t.signer.filter.clear(label)}
                title={t.signer.filter.clear(label)}
                className="inline-flex size-7 items-center justify-center rounded-full text-muted hover:bg-background hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent pointer-coarse:size-9"
              >
                <svg aria-hidden viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
              </Link>
            </span>
          </p>
          <Desk
            title={t.signer.filter.section(label)}
            pending={pending.filter(mine)}
            unseen={[]}
            history={history.filter(mine)}
            agents={agents}
            dispatch={dispatch}
            target={target}
          />
        </div>
      );
    }
    return <Desk title={t.signer.section} pending={pending} unseen={[]} history={history} agents={agents} dispatch={dispatch} target={target} />;
  }
  if (object.object === "tray" && types.length > 0 && sources.every((source) => source.startsWith("watch:"))) {
    if (!model.loaded) return <p className="text-sm text-muted">{t.loading}</p>;
    const seen = history.filter((approval) => approval.informational && matchesTypes(types)(approval));
    return <WatchDesk unseen={unseen} seen={seen} agents={agents} dispatch={dispatch} target={target} />;
  }
  if (sources.includes("blocked")) return <StandardView object={object} onChange={reload} />;
  if (object.object === "newspaper") return <JournalView object={object} agents={agents} onChange={reload} />;
  if (object.object === "calendar") return <AgendaView object={object} />;
  if (object.object === "postits") return <PostitsView object={object} />;
  return <ItemsView object={object} />;
}

/** `/bureau/<id>`: the page of the object named by the address. */
export function DeskModuleRoute() {
  const { id } = useParams<{ id: string }>();
  return <DeskModulePage id={id} />;
}
