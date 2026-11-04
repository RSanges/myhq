"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo } from "react";
import { ChatPanel } from "./chat-panel";
import { Desk, WatchDesk } from "./desk";
import { AgendaView, ItemsView, JournalView, PostitsView } from "./desk-module-views";
import { formatClock } from "./format";
import { selectAgents, selectHistory, selectPending, selectUnseen } from "./model";
import type { Approval, DeskObject } from "./schemas";
import { strings } from "./strings";
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

/** The row of links to the objects of the desk, at the top of `/` until the scene replaces it. */
export function DeskNav({ objects }: { objects: DeskObject[] }) {
  if (objects.length === 0) return null;
  return (
    <nav aria-label={t.navLabel}>
      <ul className="flex flex-wrap gap-x-1 gap-y-1 text-sm">
        {objects.map((object) => (
          <li key={object.id}>
            <Link
              href={`/bureau/${object.id}`}
              aria-label={object.count > 0 ? t.navCount(object.label, object.count) : object.label}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 py-1 text-muted hover:bg-soft hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent pointer-coarse:min-h-11"
            >
              {object.label}
              {object.status === "error" ? (
                <span aria-hidden className="size-1.5 rounded-full bg-danger" />
              ) : (
                object.count > 0 && (
                  <span aria-hidden className="rounded-full bg-accent-soft px-1.5 text-xs font-semibold text-accent">
                    {object.count}
                  </span>
                )
              )}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

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
 * calendar, notes for the post-its, the conversation for the phone).
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

  if (object?.object === "phone" && coreSources(object).includes("chat")) {
    return (
      <div className="flex min-h-dvh flex-col">
        <ChatPanel open onClose={() => router.push("/")} subscribe={hq.subscribeChat} agents={agents} narrow={!wide} page />
      </div>
    );
  }

  const connectionTone = hq.connection === "live" ? "bg-ok" : hq.connection === "reconnecting" ? "bg-warn" : "bg-muted";
  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href="/"
            aria-label={t.backLabel}
            className="inline-flex min-h-10 items-center gap-1 rounded-md px-2 text-sm text-muted hover:bg-soft hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent pointer-coarse:min-h-12"
          >
            <svg aria-hidden viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 3L5 8l5 5" />
            </svg>
            {t.back}
          </Link>
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
  const sources = coreSources(object);
  const types = useMemo(() => watchTypes(object), [object]);
  const pending = useMemo(() => selectPending(model), [model]);
  const unseen = useMemo(() => selectUnseen(model).filter(matchesTypes(types)), [model, types]);
  const history = useMemo(() => selectHistory(model), [model]);

  if (object.status === "error") return <CommandError object={object} onRetry={reload} />;

  if (object.object === "pile" && sources.includes("approvals")) {
    if (!model.loaded) return <p className="text-sm text-muted">{t.loading}</p>;
    return <Desk title={t.signer.section} pending={pending} unseen={[]} history={history} agents={agents} dispatch={dispatch} target={target} />;
  }
  if (object.object === "tray" && types.length > 0 && sources.every((source) => source.startsWith("watch:"))) {
    if (!model.loaded) return <p className="text-sm text-muted">{t.loading}</p>;
    const seen = history.filter((approval) => approval.informational && matchesTypes(types)(approval));
    return <WatchDesk unseen={unseen} seen={seen} agents={agents} dispatch={dispatch} target={target} />;
  }
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
