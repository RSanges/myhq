"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { errorText, fetchDirs } from "./api";
import { breadcrumbs, chosenPath, groupDirs } from "./browse-model";
import type { DirListing } from "./schemas";
import { strings } from "./strings";
import { Badge, buttonClass, ErrorNote } from "./ui";

const t = strings.team.addRoom.browser;

/** How the request for `path` ended: null while it is under way. */
type Outcome = { path: string; error: string | null };

const FOCUSABLE = "button:not([disabled])";

function FolderIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5 shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The folder explorer behind « Parcourir »: a window over the page that walks
 * the projects root (`GET /api/fs/dirs`), because a browser never gives the
 * path of a folder picked in the system dialog. Clickable trail, projects
 * first, folders that already have a room marked. « Choisir ce dossier » hands
 * back the path `POST /api/onboarding` expects. Keyboard: Tab and Shift+Tab
 * stay inside the window, the arrows move through the folders, Escape closes.
 */
export function DirBrowser({ onChoose, onClose }: { onChoose: (path: string) => void; onClose: () => void }) {
  const [path, setPath] = useState("");
  // The last folder that loaded stays on screen (dimmed) while the next one loads.
  const [last, setLast] = useState<DirListing | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();

  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // Focus goes in when the window opens and back to what opened it when it closes.
  // Escape is caught before the sheet that may hold the form, so that only this window closes.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      opener?.focus();
    };
  }, []);

  useEffect(() => {
    let live = true;
    fetchDirs(path)
      .then((next) => {
        if (!live) return;
        setLast(next);
        setOutcome({ path, error: null });
      })
      .catch((failure: unknown) => live && setOutcome({ path, error: errorText(failure) }));
    return () => {
      live = false;
    };
  }, [path]);

  const ready = outcome !== null && outcome.path === path;
  const error = ready ? outcome.error : null;
  const listing = error === null ? last : null;
  const chosen = ready && listing !== null && listing.path === path ? listing : null;

  // Once a folder has loaded, focus goes to its first row (the row clicked is gone, or focus is still outside);
  // an empty folder keeps it on the window itself. A control inside the window that holds focus keeps it.
  useEffect(() => {
    if (!ready) return;
    const panel = panelRef.current;
    const active = document.activeElement;
    if (!panel || (active !== panel && panel.contains(active))) return;
    (panel.querySelector<HTMLElement>("[data-dir-row]") ?? panel).focus();
  }, [ready, outcome]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    if (!panel) return;
    if (event.key === "Tab") {
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const rows = [...panel.querySelectorAll<HTMLElement>("[data-dir-row]")];
      if (rows.length === 0) return;
      const at = rows.indexOf(document.activeElement as HTMLElement);
      if (at === -1 && event.key === "ArrowUp") return;
      event.preventDefault();
      const next = event.key === "ArrowDown" ? Math.min(at + 1, rows.length - 1) : Math.max(at - 1, 0);
      rows[next]?.focus();
    }
  };

  const groups = listing ? groupDirs(listing.dirs) : null;
  const crumbs = listing ? breadcrumbs({ rootName: listing.rootName, path }) : [];

  const row = (dir: DirListing["dirs"][number]) => (
    <li key={dir.path}>
      <button
        type="button"
        data-dir-row=""
        className={`flex min-h-12 w-full items-center gap-3 rounded-md border px-3 py-2 text-left text-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
          dir.project ? "border-accent bg-accent-soft font-medium" : "border-line bg-card hover:bg-soft"
        }`}
        onClick={() => setPath(dir.path)}
      >
        <FolderIcon />
        <span className="min-w-0 flex-1 break-words">{dir.name}</span>
        {dir.room !== null && <Badge tone="ok">{t.followed(dir.room)}</Badge>}
        {dir.project && dir.room === null && <Badge tone="accent">{t.project}</Badge>}
      </button>
    </li>
  );

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/50 sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground shadow-xl outline-none sm:h-[min(36rem,90dvh)] sm:max-w-lg sm:rounded-xl sm:border sm:border-line"
      >
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 id={titleId} className="min-w-0 break-words text-base font-semibold">
            {t.title}
          </h2>
          <button type="button" className={buttonClass()} onClick={onClose}>
            {t.close}
          </button>
        </div>

        <nav aria-label={t.crumbsLabel} className="border-b border-line bg-soft px-4 py-2">
          <ol className="flex flex-wrap items-center gap-x-1 gap-y-1 text-sm">
            {crumbs.map((crumb, index) => {
              const last = index === crumbs.length - 1;
              return (
                <li key={crumb.path} className="flex min-w-0 items-center gap-1">
                  {index > 0 && (
                    <span aria-hidden="true" className="text-muted">
                      /
                    </span>
                  )}
                  {last ? (
                    <span aria-current="page" className="break-all font-semibold">
                      {crumb.label}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="min-h-8 break-all rounded px-1 text-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-accent pointer-coarse:min-h-10"
                      onClick={() => setPath(crumb.path)}
                    >
                      {crumb.label}
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>

        <div className="min-h-40 flex-1 space-y-4 overflow-y-auto px-4 py-3" aria-busy={!ready}>
          {!ready && (
            <p role="status" className="text-sm text-muted">
              {t.loading}
            </p>
          )}
          {error !== null && (
            <div className="space-y-2">
              <ErrorNote>{error}</ErrorNote>
              {path !== "" && (
                <button type="button" className={buttonClass()} onClick={() => setPath("")}>
                  {t.backToRoot}
                </button>
              )}
            </div>
          )}
          {listing && groups && (
            <div className={`space-y-4 ${ready ? "" : "opacity-60"}`}>
              {listing.dirs.length === 0 && <p className="text-sm text-muted">{t.empty}</p>}
              {groups.projects.length > 0 && (
                <section aria-label={t.projects} className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{t.projects}</h3>
                  <ul className="space-y-2">{groups.projects.map(row)}</ul>
                </section>
              )}
              {groups.others.length > 0 && (
                <section aria-label={t.others} className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{t.others}</h3>
                  <ul className="space-y-2">{groups.others.map(row)}</ul>
                </section>
              )}
            </div>
          )}
        </div>

        <div className="space-y-2 border-t border-line bg-card px-4 py-3">
          {chosen?.room && <p className="text-xs text-warn">{t.followedHere(chosen.room)}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className={buttonClass()} onClick={onClose}>
              {t.cancel}
            </button>
            <button
              type="button"
              className={buttonClass("primary")}
              disabled={chosen === null}
              onClick={() => chosen && onChoose(chosenPath(chosen))}
            >
              {t.choose}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
