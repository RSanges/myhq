"use client";

import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from "react";
import { errorText, fetchFolder, fetchState, openFolderOrder, uploadReceived } from "./api";
import { MODEL_FRAME_CLASS, modelFormat } from "./attachments-model";
import { CopyButton } from "./copy-button";
import {
  addressFromParams,
  depositProblem,
  depositTarget,
  emptyText,
  folderCrumbs,
  folderFileUrl,
  foldersHref,
  formatSize,
  groupEntries,
  orderPreview,
  previewKind,
  type FoldersAddress,
} from "./folders-model";
import { formatDateTime } from "./format";
import { chipStyle } from "./room-color";
import type { FolderEntry, FolderListing } from "./schemas";
import { Card, Field } from "./settings-parts";
import { SiteNav } from "./site-nav";
import { strings } from "./strings";
import { buttonClass, ErrorNote, fieldClass } from "./ui";

// The room folders page (/dossiers): the rooms of the home, the folder of the
// one chosen (its orders, its drawers, the rest), a preview of a file, a
// deposit into a `recu/` drawer and « Nouvelle commande ». The address keeps
// the room and the place (`?salle=&chemin=`), so that a link of the desk opens
// the place where MyHQ filed an item. The logic lives in folders-model.ts.

const t = strings.folders;

type RoomChoice = { name: string; label: string; color: string | null };

const ROW_CLASS =
  "flex min-h-12 w-full min-w-0 items-center gap-3 rounded-md border border-line bg-card px-3 py-2 text-left text-sm hover:bg-soft focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent pointer-coarse:min-h-14";

/** three.js and the viewer, fetched only when a 3D part is previewed, never rendered on the server. */
const ModelViewer = dynamic(() => import("./model-viewer"), {
  ssr: false,
  loading: () => <div className={`${MODEL_FRAME_CLASS} flex items-center justify-center text-sm text-muted`}>{strings.attachments.loading3d}</div>,
});

function FolderIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5 shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" strokeLinejoin="round" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5 shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M6 3h8l4 4v14H6V3Z" strokeLinejoin="round" />
      <path d="M14 3v4h4" strokeLinejoin="round" />
    </svg>
  );
}

/** The address of the page, read from the location and written with the history API (back and forward work). */
function useAddress(): [FoldersAddress, (next: FoldersAddress, mode?: "push" | "replace") => void] {
  const params = useSearchParams();
  const address = useMemo(() => addressFromParams(params), [params]);
  const go = useCallback((next: FoldersAddress, mode: "push" | "replace" = "push") => {
    const url = foldersHref(next);
    if (mode === "push") window.history.pushState(null, "", url);
    else window.history.replaceState(null, "", url);
  }, []);
  return [address, go];
}

/** A titled group of entries, titled as the folder explorer titles its groups. */
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
      <ul className="space-y-2">{children}</ul>
    </section>
  );
}

/** A folder: a drawer by its French name and hint, an order with its line, any other by its name. */
function DirRow({ entry, onOpen }: { entry: FolderEntry; onOpen: (path: string) => void }) {
  const drawer = entry.role === "drawer" ? t.drawers[entry.name] : undefined;
  return (
    <li>
      <button type="button" className={ROW_CLASS} onClick={() => onOpen(entry.path)}>
        <FolderIcon />
        <span className="min-w-0 flex-1 space-y-0.5">
          <span className={`block break-words ${entry.role === null ? "" : "font-medium"}`}>{drawer ? drawer.label : entry.name}</span>
          {drawer && <span className="block text-xs text-muted">{drawer.hint}</span>}
          {entry.role === "order" && <span className="block text-xs text-muted">{t.orderHint}</span>}
        </span>
      </button>
    </li>
  );
}

/** A file: a button that previews a kind MyHQ shows, a new tab for a PDF, a download for anything else. */
function FileRow({
  room,
  entry,
  selected,
  flash,
  onPreview,
}: {
  room: string;
  entry: FolderEntry;
  selected: boolean;
  flash: boolean;
  onPreview: (entry: FolderEntry) => void;
}) {
  const kind = previewKind(entry);
  const body = (
    <>
      <FileIcon />
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="block break-all font-medium">{entry.name}</span>
        <span className="block text-xs text-muted">
          {kind === "download" ? "" : `${strings.attachments.kind[kind]}, `}
          {formatSize(entry.size)}, {t.modified(formatDateTime(entry.modifiedAt))}
        </span>
      </span>
      <span className="shrink-0 text-sm text-accent underline underline-offset-2">
        {kind === "download" ? t.preview.download : kind === "pdf" ? strings.attachments.open : t.preview.show}
      </span>
    </>
  );
  const className = `${ROW_CLASS} deep-target ${selected ? "border-accent bg-accent-soft" : ""} ${flash ? "deep-flash" : ""}`;
  return (
    <li>
      {kind === "download" ? (
        <a href={folderFileUrl(room, entry.path, true)} download={entry.name} className={className}>
          {body}
        </a>
      ) : kind === "pdf" ? (
        <a href={folderFileUrl(room, entry.path)} target="_blank" rel="noopener" className={className}>
          {body}
        </a>
      ) : (
        <button type="button" aria-pressed={selected} className={className} onClick={() => onPreview(entry)}>
          {body}
        </button>
      )}
    </li>
  );
}

/** The preview of one file: an image, a player, or the 3D viewer, with « Ouvrir dans un onglet » and « Télécharger ». */
function Preview({ room, entry, onClose }: { room: string; entry: FolderEntry; onClose: () => void }) {
  const ref = useRef<HTMLElement>(null);
  const url = folderFileUrl(room, entry.path);
  const format = modelFormat(entry.name);
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    ref.current?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [entry.path]);
  return (
    <figure ref={ref} aria-label={t.preview.title(entry.name)} className="space-y-3 rounded-lg border border-line bg-soft p-3">
      {entry.kind === "image" && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={entry.name} className="mx-auto block max-h-[70vh] max-w-full rounded-md object-contain" />
      )}
      {entry.kind === "video" && <video src={url} controls playsInline preload="metadata" className="block max-h-[70vh] w-full rounded-md bg-black" />}
      {entry.kind === "audio" && <audio src={url} controls preload="metadata" className="block w-full" />}
      {entry.kind === "model" && format && (
        <ModelViewer url={url} name={entry.name} fileId={0} format={format} poster={null} pins={[]} picking={false} onPick={() => {}} onPin={() => {}} />
      )}
      <figcaption className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 break-all text-sm font-medium">{entry.name}</span>
        <span className="flex flex-wrap gap-2">
          <a href={url} target="_blank" rel="noopener" className={buttonClass()}>
            {t.preview.open}
          </a>
          <a href={folderFileUrl(room, entry.path, true)} download={entry.name} className={buttonClass()}>
            {t.preview.download}
          </a>
          <button type="button" className={buttonClass()} onClick={onClose}>
            {t.preview.close}
          </button>
        </span>
      </figcaption>
    </figure>
  );
}

type DepositState = { kind: "idle" } | { kind: "sending"; share: number } | { kind: "done"; count: number } | { kind: "error"; message: string };

/** « Déposer des fichiers » in a `recu/` drawer: a file picker, or files dropped on the zone, with the progress of the upload. */
function Deposit({
  room,
  order,
  caps,
  onDone,
}: {
  room: string;
  order: string | null;
  caps: FolderListing["deposit"];
  onDone: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<DepositState>({ kind: "idle" });
  const [over, setOver] = useState(false);
  const sending = state.kind === "sending";

  const send = (list: FileList | null) => {
    const files = list ? Array.from(list) : [];
    if (files.length === 0 || sending) return;
    const problem = depositProblem(files, caps);
    if (problem) {
      setState({ kind: "error", message: problem });
      return;
    }
    setState({ kind: "sending", share: 0 });
    uploadReceived(room, order, files, (share) => setState({ kind: "sending", share })).then(
      (result) => {
        setState({ kind: "done", count: result.saved.length });
        onDone();
      },
      (error: unknown) => setState({ kind: "error", message: `${t.deposit.failed} ${errorText(error)}` }),
    );
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setOver(false);
    send(event.dataTransfer.files);
  };
  const percent = sending ? Math.round(state.share * 100) : 0;

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        if (!sending) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      aria-busy={sending}
      className={`space-y-3 rounded-lg border-2 border-dashed p-4 ${over ? "border-accent bg-accent-soft" : "border-line bg-soft"}`}
    >
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{t.deposit.title}</h3>
        <p className="text-xs text-muted">{t.deposit.hint(caps.maxFiles, formatSize(caps.maxFileBytes))}</p>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <input
          ref={input}
          type="file"
          multiple
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            send(event.currentTarget.files);
            event.currentTarget.value = "";
          }}
        />
        <button type="button" className={`${buttonClass("primary")} w-full sm:w-auto`} disabled={sending} onClick={() => input.current?.click()}>
          {t.deposit.choose}
        </button>
        <span className="hidden text-sm text-muted pointer-fine:inline">{over ? t.deposit.dropActive : t.deposit.drop}</span>
      </div>
      <div aria-live="polite" className="space-y-2">
        {sending && (
          <>
            <p className="text-sm">{t.deposit.sending(percent)}</p>
            <div className="h-1.5 overflow-hidden rounded-full bg-line" aria-hidden="true">
              <div className="h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
            </div>
          </>
        )}
        {state.kind === "done" && <p className="text-sm text-ok">{t.deposit.done(state.count)}</p>}
      </div>
      {state.kind === "error" && <ErrorNote>{state.message}</ErrorNote>}
    </div>
  );
}

/** « Nouvelle commande »: client and subject, with the name MyHQ will give the order. */
function NewOrder({ room, onOpened, onCancel }: { room: string; onOpened: (order: string, created: boolean) => void; onCancel: () => void }) {
  const [client, setClient] = useState("");
  const [subject, setSubject] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  const name = orderPreview(client, subject, new Date());

  useEffect(() => first.current?.focus(), []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || name === null) return;
    setBusy(true);
    setError(null);
    try {
      const opened = await openFolderOrder(room, client, subject);
      onOpened(opened.order, opened.created);
    } catch (failure) {
      setError(`${t.newOrder.failed} ${errorText(failure)}`);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} aria-labelledby="new-order-title" className="space-y-4 rounded-lg border border-line bg-soft p-4">
      <div className="space-y-1">
        <h3 id="new-order-title" className="text-sm font-semibold">
          {t.newOrder.title}
        </h3>
        <p className="text-xs text-muted">{t.newOrder.hint}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t.newOrder.client} htmlFor="order-client">
          <input
            ref={first}
            id="order-client"
            className={fieldClass}
            value={client}
            maxLength={200}
            autoComplete="off"
            placeholder={t.newOrder.clientPlaceholder}
            onChange={(event) => setClient(event.target.value)}
          />
        </Field>
        <Field label={t.newOrder.subject} htmlFor="order-subject">
          <input
            id="order-subject"
            className={fieldClass}
            value={subject}
            maxLength={200}
            autoComplete="off"
            placeholder={t.newOrder.subjectPlaceholder}
            onChange={(event) => setSubject(event.target.value)}
          />
        </Field>
      </div>
      <p aria-live="polite" className="min-w-0 text-sm">
        <span className="text-muted">{t.newOrder.preview} : </span>
        {name ? <code className="break-all font-medium">{name}</code> : <span className="text-muted">{t.newOrder.previewEmpty}</span>}
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={buttonClass()} onClick={onCancel} disabled={busy}>
          {t.newOrder.cancel}
        </button>
        <button type="submit" className={buttonClass("primary")} disabled={busy || name === null}>
          {busy ? t.newOrder.submitting : t.newOrder.submit}
        </button>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
    </form>
  );
}

/** The trail of the place listed: the room folder, then each folder, every crumb but the last a button. */
function Crumbs({ roomLabel, path, onOpen }: { roomLabel: string; path: string; onOpen: (path: string) => void }) {
  const crumbs = folderCrumbs(roomLabel, path);
  return (
    <nav aria-label={t.crumbsLabel}>
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
                  onClick={() => onOpen(crumb.path)}
                >
                  {crumb.label}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** The folder of one room at one place: the trail, « Copier le chemin », then the entries (or why there are none). */
function RoomFolder({ room, address, go }: { room: RoomChoice; address: FoldersAddress; go: (next: FoldersAddress) => void }) {
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [preview, setPreview] = useState<FolderEntry | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [ordering, setOrdering] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const key = `${room.name}\n${address.path}\n${reload}`;
  const ready = loaded === key;

  useEffect(() => {
    let live = true;
    fetchFolder(room.name, address.path).then(
      (next) => {
        if (!live) return;
        setListing(next);
        setError(null);
        setLoaded(key);
        // A link to a file opens its folder with the file previewed and ringed for a moment.
        const pointed = next.file === null ? null : (next.entries.find((each) => each.path === next.file) ?? null);
        if (pointed) {
          setPreview(previewKind(pointed) === "download" || pointed.kind === "pdf" ? null : pointed);
          setFlash(pointed.path);
        }
      },
      (failure: unknown) => {
        if (!live) return;
        setError(`${t.loadFailed} ${errorText(failure)}`);
        setLoaded(key);
      },
    );
    return () => {
      live = false;
    };
  }, [room.name, address.path, key]);

  const open = (path: string) => {
    setPreview(null);
    setFlash(null);
    setOrdering(false);
    setNotice(null);
    go({ room: room.name, path });
  };

  const shown = listing && listing.room === room.name ? listing : null;
  const groups = useMemo(() => (shown ? groupEntries(shown.entries) : null), [shown]);
  const target = shown ? depositTarget(shown.path) : null;
  const atRoot = shown?.path === "";
  const nothing = groups && groups.orders.length + groups.drawers.length + groups.folders.length + groups.files.length === 0;
  const currentLabel = shown && shown.path !== "" ? folderCrumbs(room.label, shown.path).slice(-1)[0]!.label : room.label;

  return (
    <Card
      id="room-folder"
      title={currentLabel}
      hint={shown && shown.path !== "" ? <Crumbs roomLabel={room.label} path={shown.path} onOpen={open} /> : undefined}
      aside={shown ? <CopyButton text={shown.location} id="folder-location" labels={t.copyPath} /> : undefined}
    >
      {!ready && !shown && (
        <p role="status" className="text-sm text-muted">
          {t.loading}
        </p>
      )}
      {error !== null && ready && (
        <div className="space-y-2">
          <ErrorNote>{error}</ErrorNote>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass()} onClick={() => setReload((n) => n + 1)}>
              {t.retry}
            </button>
            {address.path !== "" && (
              <button type="button" className={buttonClass()} onClick={() => open("")}>
                {t.backToRoot}
              </button>
            )}
          </div>
        </div>
      )}
      {shown && groups && (
        <div className={`min-w-0 space-y-5 ${ready ? "" : "opacity-60"}`} aria-busy={!ready}>
          {notice && (
            <p role="status" className="text-sm text-ok">
              {notice}
            </p>
          )}
          {target && <Deposit room={room.name} order={target.order} caps={shown.deposit} onDone={() => setReload((n) => n + 1)} />}

          {atRoot && shown.orders && (
            <section aria-labelledby="orders-title" className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 id="orders-title" className="text-xs font-semibold uppercase tracking-wide text-muted">
                  {t.sections.orders}
                </h3>
                {!ordering && (
                  <button type="button" className={buttonClass()} onClick={() => setOrdering(true)}>
                    {t.newOrder.open}
                  </button>
                )}
              </div>
              {ordering && (
                <NewOrder
                  room={room.name}
                  onCancel={() => setOrdering(false)}
                  onOpened={(order, created) => {
                    open(`${order}/recu`);
                    setNotice(created ? t.newOrder.created(order) : t.newOrder.existed(order));
                  }}
                />
              )}
              {groups.orders.length === 0 ? (
                <p className="text-sm text-muted">{t.empty.orders}</p>
              ) : (
                <ul className="space-y-2">
                  {groups.orders.map((entry) => (
                    <DirRow key={entry.path} entry={entry} onOpen={open} />
                  ))}
                </ul>
              )}
            </section>
          )}

          {groups.drawers.length > 0 && (
            <Group title={t.sections.drawers}>
              {groups.drawers.map((entry) => (
                <DirRow key={entry.path} entry={entry} onOpen={open} />
              ))}
            </Group>
          )}
          {groups.folders.length > 0 && (
            <Group title={atRoot ? t.sections.others : t.sections.folders}>
              {groups.folders.map((entry) => (
                <DirRow key={entry.path} entry={entry} onOpen={open} />
              ))}
            </Group>
          )}
          {preview && <Preview room={room.name} entry={preview} onClose={() => setPreview(null)} />}
          {groups.files.length > 0 && (
            <Group title={t.sections.files}>
              {groups.files.map((entry) => (
                <FileRow
                  key={entry.path}
                  room={room.name}
                  entry={entry}
                  selected={preview?.path === entry.path}
                  flash={flash === entry.path}
                  onPreview={(next) => setPreview(preview?.path === next.path ? null : next)}
                />
              ))}
            </Group>
          )}
          {nothing && !(atRoot && shown.orders) && <p className="text-sm text-muted">{emptyText(shown.path)}</p>}
        </div>
      )}
    </Card>
  );
}

/** The room picker: one pressed button per room, its colour as a dot, as the desk marks a room. */
function RoomPicker({ rooms, current, onPick }: { rooms: readonly RoomChoice[]; current: string | null; onPick: (room: string) => void }) {
  return (
    <div role="group" aria-label={t.roomsLabel} className="settings-segmented">
      {rooms.map((room) => {
        const tint = chipStyle(room.color);
        return (
          <button
            key={room.name}
            type="button"
            aria-pressed={room.name === current}
            onClick={() => onPick(room.name)}
            style={tint ?? undefined}
            className="inline-flex items-center gap-2 pointer-coarse:min-h-11"
          >
            <span aria-hidden className={`size-2.5 shrink-0 rounded-full ${tint ? "bg-[var(--room-color)]" : "bg-line"}`} />
            {room.label}
          </button>
        );
      })}
    </div>
  );
}

export function FoldersPage() {
  const [rooms, setRooms] = useState<RoomChoice[] | null>(null);
  const [roomsError, setRoomsError] = useState<string | null>(null);
  const [address, go] = useAddress();

  const load = useCallback(() => {
    fetchState().then(
      (state) => {
        setRooms(state.rooms.map((room) => ({ name: room.name, label: room.label || room.name, color: room.color })));
        setRoomsError(null);
      },
      (error: unknown) => setRoomsError(`${t.roomsFailed} ${errorText(error)}`),
    );
  }, []);

  useEffect(() => {
    document.title = t.pageTitle;
    load();
  }, [load]);

  // No room in the address (or one the home no longer has): the first room is chosen, in place.
  const room = rooms?.find((each) => each.name === address.room) ?? null;
  useEffect(() => {
    if (rooms && rooms.length > 0 && room === null) go({ room: rooms[0]!.name, path: "" }, "replace");
  }, [rooms, room, go]);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-4 pb-10 pt-6">
      <header className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h1 className="text-xl font-semibold">{t.title}</h1>
          <SiteNav current="folders" />
        </div>
        <p className="max-w-2xl text-sm text-muted">{t.intro}</p>
      </header>

      {roomsError && (
        <div className="space-y-3">
          <ErrorNote>{roomsError}</ErrorNote>
          <button type="button" className={buttonClass()} onClick={load}>
            {t.retry}
          </button>
        </div>
      )}
      {!rooms && !roomsError && <p className="text-sm text-muted">{t.loadingRooms}</p>}
      {rooms && rooms.length === 0 && <p className="text-sm text-muted">{t.noRooms}</p>}
      {rooms && rooms.length > 0 && (
        <>
          <RoomPicker rooms={rooms} current={room?.name ?? null} onPick={(name) => go({ room: name, path: "" })} />
          {room && <RoomFolder key={room.name} room={room} address={{ room: room.name, path: address.path }} go={go} />}
        </>
      )}
    </div>
  );
}
