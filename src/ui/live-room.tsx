"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import dynamic from "next/dynamic";
import { errorText, fetchLiveRun } from "./api";
import { MODEL_FRAME_CLASS, modelFormat } from "./attachments-model";
import { DESK_PATH, runHash } from "./deep-link";
import { formatSize } from "./folders-model";
import { formatClock, formatCost, formatTime } from "./format";
import {
  autoplayRuns,
  canCompare,
  elapsedText,
  liveFigures,
  mergeTimeline,
  minutesAgo,
  minutesText,
  modelViewerRuns,
  pausedMinutes,
  quietness,
  shownIndex,
  taskHeadline,
  toolText,
  waitCauseText,
  type TimelineEntry,
} from "./live-room-model";
import type { Pin } from "./model-viewer";
import type { LiveQueueEntry, LiveRun, LiveTile, LiveWait, PieceVersion } from "./schemas";
import { SiteNav } from "./site-nav";
import { strings } from "./strings";
import { buttonClass, ErrorNote } from "./ui";
import { useLiveRoom } from "./use-live-room";
import { useMediaQuery } from "./use-media-query";

// The surveillance room (/surveillance, docs/architecture.md "The surveillance
// room"): one tile per agent at work, its piece shown large, and a detail
// panel per run (`?run=<id>` opens it at load).

const t = strings.live;

type Piece = NonNullable<LiveTile["piece"]>;
/** The version the owner picked on each run's strip, by path (none: the latest). */
type Chosen = ReadonlyMap<number, string>;

/** three.js and the viewer of the desk, fetched only when a 3D part is drawn, never rendered on the server. */
const ModelViewer = dynamic(() => import("./model-viewer"), {
  ssr: false,
  loading: () => <div className={`${MODEL_FRAME_CLASS} flex items-center justify-center text-sm text-muted`}>{strings.attachments.loading3d}</div>,
});
/** Stable props: the viewer redraws when its pins change, and the clock renders the page every second. No remark here. */
const NO_PINS: readonly Pin[] = [];
const ignore = () => {};

// ---- Icons -------------------------------------------------------------------

const PinIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M15 3l6 6-3 1-4 4 1 5-2 2-4-5-5 5-1-1 5-5-5-4 2-2 5 1 4-4z" />
  </svg>
);
const EyeIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
const CloseIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
const ZoomIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
    <circle cx="11" cy="11" r="6" />
    <path d="M20 20l-4.5-4.5M11 8v6M8 11h6" />
  </svg>
);
const HoldIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
    <circle cx="12" cy="12" r="9" />
    <path d="M10 9v6M14 9v6" />
  </svg>
);
const CubeIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
    <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
    <path d="M4 7.5l8 4.5 8-4.5M12 12v9" />
  </svg>
);
const PlayIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M7 4l13 8-13 8z" />
  </svg>
);

function SourceBadge({ source }: { source: Piece["source"] }) {
  return source === "pin" ? (
    <span className="watch-src" data-src="pin">
      <PinIcon />
      {t.legend.pin}
    </span>
  ) : (
    <span className="watch-src" data-src="auto">
      <EyeIcon />
      {t.legend.auto}
    </span>
  );
}

// ---- The page ------------------------------------------------------------------

/** The run of the panel, from `?run=<id>`. */
function runFromUrl(): number | null {
  const raw = new URLSearchParams(window.location.search).get("run");
  return raw && /^[1-9]\d{0,8}$/.test(raw) ? Number(raw) : null;
}

/** Told when the page changes `?run=` itself (replaceState fires no event). */
const RUN_CHANGED = "myhq-live-run";

function subscribeRun(notify: () => void): () => void {
  window.addEventListener("popstate", notify);
  window.addEventListener(RUN_CHANGED, notify);
  return () => {
    window.removeEventListener("popstate", notify);
    window.removeEventListener(RUN_CHANGED, notify);
  };
}

export function LiveRoomView() {
  const { state, version, now, connected, retry } = useLiveRoom();
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [chosen, setChosen] = useState<Map<number, string>>(() => new Map());
  const openRun = useSyncExternalStore(subscribeRun, runFromUrl, () => null);
  const [zoomed, setZoomed] = useState<{ url: string; caption: string } | null>(null);

  useEffect(() => {
    document.title = t.pageTitle;
  }, []);

  const open = useCallback((runId: number | null) => {
    const url = new URL(window.location.href);
    if (runId === null) url.searchParams.delete("run");
    else url.searchParams.set("run", String(runId));
    window.history.replaceState(null, "", url);
    window.dispatchEvent(new Event(RUN_CHANGED));
  }, []);

  const choose = useCallback((runId: number, path: string) => {
    setChosen((current) => new Map(current).set(runId, path));
  }, []);

  const tiles = useMemo(() => (state.status === "ready" ? state.room.tiles : []), [state]);
  const playing = useMemo(() => autoplayRuns(tiles, chosen, reducedMotion), [tiles, chosen, reducedMotion]);
  const drawing = useMemo(() => modelViewerRuns(tiles, chosen), [tiles, chosen]);

  return (
    <div className="wall-page">
      <header className="wall-hero">
        <div className="wall-wrap watch-wrap">
          <div className="wall-hero-top">
            <SiteNav current="live" />
            <p className="wall-live" role="status" data-connected={connected ? "" : undefined}>
              <span className="wall-live-dot watch-live-dot" aria-hidden />
              {connected && now > 0 ? t.liveAt(formatTime(new Date(now).toISOString())) : t.reconnecting}
            </p>
          </div>
          <div className="watch-hero-main">
            <div>
              <h1 className="watch-title wall-display">{t.title}</h1>
              <p className="watch-subtitle">{t.subtitle}</p>
            </div>
            <Figures tiles={tiles} />
          </div>
          <p className="watch-legend" aria-label={t.legend.label}>
            <span>
              <SourceBadge source="pin" /> {t.legend.pinText}
            </span>
            <span>
              <SourceBadge source="auto" /> {t.legend.autoText}
            </span>
          </p>
        </div>
      </header>

      <main className="wall-wrap watch-wrap watch-body">
        {state.status === "loading" && <p className="wall-empty-text">{t.loading}</p>}
        {state.status === "error" && (
          <div className="space-y-3">
            <ErrorNote>
              {t.loadFailed} {state.message}
            </ErrorNote>
            <button type="button" className={buttonClass()} onClick={retry}>
              {t.retry}
            </button>
          </div>
        )}
        {state.status === "ready" && <QueueBand queue={state.room.queue ?? []} waits={state.room.waits ?? []} now={now} />}
        {state.status === "ready" && tiles.length === 0 && <Empty />}
        {tiles.length > 0 && (
          <div className="watch-grid">
            {tiles.map((tile) => (
              <Tile
                key={tile.runId}
                tile={tile}
                now={now}
                chosen={chosen.get(tile.runId)}
                play={playing.has(tile.runId)}
                draw={drawing.has(tile.runId)}
                onChoose={(path) => choose(tile.runId, path)}
                onOpen={() => open(tile.runId)}
                onZoom={setZoomed}
              />
            ))}
          </div>
        )}
      </main>

      {openRun !== null && (
        <Panel
          key={openRun}
          runId={openRun}
          version={version}
          now={now}
          chosen={chosen}
          reducedMotion={reducedMotion}
          onChoose={choose}
          onClose={() => open(null)}
          onZoom={setZoomed}
        />
      )}
      {zoomed && <Lightbox image={zoomed} onClose={() => setZoomed(null)} />}
    </div>
  );
}

function Figures({ tiles }: { tiles: readonly LiveTile[] }) {
  const figures = liveFigures(tiles);
  return (
    <dl className="watch-figures" aria-label={t.figures.label}>
      <div className="watch-fig" data-k="work">
        <dt>{t.figures.working}</dt>
        <dd className="wall-display">{figures.working}</dd>
      </div>
      <div className="watch-fig" data-k="wait">
        <dt>{t.figures.waiting}</dt>
        <dd className="wall-display">{figures.waiting}</dd>
      </div>
      <div className="watch-fig" data-k="cost">
        <dt>{t.figures.cost}</dt>
        <dd className="wall-display">{formatCost(figures.costUsd)}</dd>
      </div>
    </dl>
  );
}

function Empty() {
  return (
    <section className="watch-empty">
      <div className="watch-screens" aria-hidden>
        {Array.from({ length: 6 }, (_, i) => (
          <i key={i} />
        ))}
      </div>
      <h2 className="wall-display">{t.empty.title}</h2>
      <p>{t.empty.text}</p>
    </section>
  );
}

// ---- A tile -----------------------------------------------------------------------

function Head({ tile, now, titleId }: { tile: LiveTile; now: number; titleId?: string }) {
  return (
    <>
      <div className="watch-avatar" aria-hidden>
        {tile.agentName.slice(0, 1).toUpperCase()}
      </div>
      <div className="watch-who">
        <h2 id={titleId} className="wall-display">
          {tile.agentName}
        </h2>
        <span className="watch-room">{t.room(tile.roomLabel ?? tile.room)}</span>
      </div>
      <div className="watch-meta">
        <span className="watch-chip" data-state={tile.state}>
          {t.state[tile.state]}
        </span>
        <span className="watch-meta-line">
          <b title={t.elapsedTitle}>{elapsedText(tile, now)}</b>
          {tile.costUsd !== null && <b title={t.costTitle}>{formatCost(tile.costUsd)}</b>}
        </span>
      </div>
    </>
  );
}

const roomStyle = (tile: LiveTile): CSSProperties => (tile.roomColor ? ({ "--room": tile.roomColor } as CSSProperties) : {});

/** Clicks on a control inside a tile do not open its panel (a drag on a 3D part turns it). */
const fromControl = (event: MouseEvent) => (event.target as HTMLElement).closest("a, button, select, audio, video[controls], .watch-model") !== null;

function Tile(props: {
  tile: LiveTile;
  now: number;
  chosen: string | undefined;
  play: boolean;
  draw: boolean;
  onChoose: (path: string) => void;
  onOpen: () => void;
  onZoom: (image: { url: string; caption: string }) => void;
}) {
  const { tile, now, chosen, play, draw } = props;
  const piece = tile.piece;
  const index = piece ? shownIndex(piece, chosen) : -1;
  const shown = piece ? piece.versions[index]! : null;
  const media = shown !== null && shown.kind !== "text";
  return (
    <article
      className="watch-tile"
      data-state={tile.state}
      data-layout={media ? "media" : "text"}
      style={roomStyle(tile)}
      onClick={(event) => {
        if (!fromControl(event)) props.onOpen();
      }}
    >
      <header className="watch-tile-head">
        <Head tile={tile} now={now} />
      </header>
      <div className="watch-tile-body">
        {piece && shown && (
          <PieceView piece={piece} version={shown} name={tile.agentName} play={play} draw={draw} large={false} onZoom={props.onZoom} />
        )}
        <div className="watch-info">
          <Info tile={tile} now={now} pin={piece?.source === "pin" ? shown : null} />
        </div>
      </div>
      {piece && <Strip piece={piece} index={index} onChoose={props.onChoose} />}
    </article>
  );
}

/** What the run is doing now, from its journal: the tool in progress, the latest background command and the end of its output, and how quiet it is. */
function Activity({ tile, now }: { tile: LiveTile; now: number }) {
  const activity = tile.activity;
  const quiet = quietness(tile, now);
  if (!activity || !quiet) return null;
  const a = t.activity;
  const background = activity.background;
  return (
    <div className="watch-activity" data-quiet={quiet.level}>
      <p className="watch-activity-now">
        <small>{a.current}</small>
        {activity.current ? (
          <span>
            {toolText(activity.current)} <em>{a.since(minutesAgo(activity.current.at, now))}</em>
          </span>
        ) : (
          <span>{a.thinking}</span>
        )}
      </p>
      {background && (
        <div className="watch-activity-bg">
          <small>
            {a.background} : {background.detail ?? background.tool}
            {background.outputAt && <> ({a.outputAt(formatClock(background.outputAt))})</>}
          </small>
          {background.output ? <pre>{background.output}</pre> : <p>{a.noOutput}</p>}
        </div>
      )}
      {quiet.level !== "ok" && (
        <p className="watch-activity-quiet" role="status">
          {a.quiet(quiet.minutes)}
        </p>
      )}
    </div>
  );
}

/** The tasks that wait in the queue and why, and how long each agent waited over the last day. Nothing when nothing waits or waited. */
function QueueBand({ queue, waits, now }: { queue: readonly LiveQueueEntry[]; waits: readonly LiveWait[]; now: number }) {
  const q = t.queue;
  if (queue.length === 0 && waits.length === 0) return null;
  return (
    <section className="watch-queue" aria-label={q.title}>
      <header>
        <h2 className="wall-display">{q.title}</h2>
        <p>{q.text}</p>
      </header>
      {queue.length > 0 && (
        <ol>
          {queue.map((entry) => (
            <li key={entry.taskId} style={entry.roomColor ? ({ "--room": entry.roomColor } as CSSProperties) : {}}>
              <b>{entry.agentName}</b>
              <span className="watch-room">{t.room(entry.roomLabel ?? entry.room)}</span>
              <span className="watch-queue-reason">{entry.reason}</span>
              <small>
                {q.task(entry.taskId)}, {q.since(minutesAgo(entry.since, now))}
              </small>
            </li>
          ))}
        </ol>
      )}
      {waits.length > 0 && (
        <p className="watch-queue-day">
          <small>{q.lastDay}</small>
          {waits
            .slice(0, 6)
            .map((each) => q.lastDayItem(each.agentName, minutesText(each.minutes), waitCauseText(each.cause)))
            .join(" · ")}
        </p>
      )}
    </section>
  );
}

function Info({ tile, now, pin }: { tile: LiveTile; now: number; pin: PieceVersion | null }) {
  return (
    <>
      <p className="watch-task">
        <small>{t.task}</small>
        {taskHeadline(tile)}
      </p>
      <Activity tile={tile} now={now} />
      {tile.state === "waiting" && tile.status && (
        <p className="watch-wait">
          <HoldIcon />
          <span>
            {tile.status.text}
            {tile.waitingSince && <small>{t.pausedFor(pausedMinutes(tile.waitingSince, now))}</small>}
          </span>
        </p>
      )}
      {pin?.caption && (
        <blockquote className="watch-note">
          « {pin.caption} »<small>{t.pinnedBy(tile.agentName, formatClock(pin.at))}</small>
        </blockquote>
      )}
      {tile.state !== "waiting" && (
        <p className="watch-now">
          <time>{tile.status ? (tile.state === "done" ? t.lastStatus(formatClock(tile.status.at)) : formatClock(tile.status.at)) : ""}</time>
          {tile.status?.text ?? t.noStatus}
        </p>
      )}
      {tile.previous.length > 0 && (
        <ol className="watch-prev">
          {tile.previous.map((status) => (
            <li key={status.at + status.text}>
              <time>{formatClock(status.at)}</time>
              <span>{status.text}</span>
            </li>
          ))}
        </ol>
      )}
      {tile.state === "done" && (
        <p className="watch-done-line">
          <a className="watch-link" href={`${DESK_PATH}${runHash(tile.runId)}`}>
            {t.summaryLink}
          </a>
        </p>
      )}
      {(tile.alsoRunning?.length ?? 0) > 0 && (
        <p className="watch-done-line">
          {t.alsoRunning}{" "}
          {tile.alsoRunning!.map((runId, index) => (
            <span key={runId}>
              {index > 0 && ", "}
              <a className="watch-link" href={`${DESK_PATH}${runHash(runId)}`}>
                {t.runLink(runId)}
              </a>
            </span>
          ))}
        </p>
      )}
    </>
  );
}

// ---- The piece ----------------------------------------------------------------------

/** The frame keeps the shape of its media once known (between 9:16 and 16:9), portrait until then. */
function useShape(): [CSSProperties, (width: number, height: number) => void] {
  const [ratio, setRatio] = useState<number | null>(null);
  const measure = useCallback((width: number, height: number) => {
    if (width > 0 && height > 0) setRatio(Math.min(16 / 9, Math.max(9 / 16, width / height)));
  }, []);
  return [{ aspectRatio: String(ratio ?? 3 / 4) }, measure];
}

function PieceView(props: {
  piece: Piece;
  version: PieceVersion;
  name: string;
  play: boolean;
  /** A 3D part is drawn (the viewer), else shown as a card. */
  draw: boolean;
  large: boolean;
  onZoom: (image: { url: string; caption: string }) => void;
}) {
  const { piece, version, play, large } = props;
  const [shape, measure] = useShape();
  const pinned = piece.source === "pin";
  if (version.kind === "text") return <TextPiece piece={piece} version={version} />;
  const fileName = version.path.split("/").pop() ?? version.path;
  if (version.kind === "model") return <ModelPiece piece={piece} version={version} name={fileName} draw={props.draw} large={large} />;
  return (
    <div className="watch-piece" data-large={large ? "" : undefined}>
      {version.kind === "image" ? (
        <button
          type="button"
          className="watch-frame"
          data-pin={pinned ? "" : undefined}
          style={shape}
          aria-label={t.zoomLabel(fileName)}
          onClick={() => props.onZoom({ url: version.url!, caption: `${props.name} : ${fileName}` })}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- a live file of the agent, served as is */}
          <img className="watch-media" src={version.url!} alt={fileName} onLoad={(event) => measure(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)} />
          <SourceBadge source={piece.source} />
          <span className="watch-zoom-hint">
            <ZoomIcon />
            {t.zoom}
          </span>
        </button>
      ) : version.kind === "video" ? (
        <div className="watch-frame" data-pin={pinned ? "" : undefined} style={shape}>
          <video
            key={version.url}
            className="watch-media"
            src={play ? version.url! : `${version.url}#t=0.1`}
            autoPlay={play}
            muted
            loop
            playsInline
            preload="metadata"
            controls={large}
            onLoadedMetadata={(event) => measure(event.currentTarget.videoWidth, event.currentTarget.videoHeight)}
          />
          <SourceBadge source={piece.source} />
          {play && !large && (
            <span className="watch-playing">
              <i />
              {t.loop}
            </span>
          )}
        </div>
      ) : (
        <div className="watch-audio" data-pin={pinned ? "" : undefined}>
          <SourceBadge source={piece.source} />
          <b>{fileName}</b>
          <audio src={version.url!} controls preload="metadata" />
        </div>
      )}
    </div>
  );
}

/**
 * A 3D part: the desk's viewer, without remarks, which loads the file again
 * only when its address changes (a new version, `&v=`); or, in a tile that
 * does not draw it, a card that the click on the tile opens large.
 */
function ModelPiece({ piece, version, name, draw, large }: { piece: Piece; version: PieceVersion; name: string; draw: boolean; large: boolean }) {
  const format = modelFormat(version.path);
  const pinned = piece.source === "pin" ? "" : undefined;
  const details = `${strings.attachments.kind.model}, ${formatSize(version.size)}, ${t.writtenAt(formatClock(version.at))}`;
  if (!draw || !format) {
    return (
      <div className="watch-piece">
        <div className="watch-model-card" data-pin={pinned}>
          <SourceBadge source={piece.source} />
          <CubeIcon />
          <b>{name}</b>
          <small>{details}</small>
          <span className="watch-model-hint">{t.model.open}</span>
        </div>
      </div>
    );
  }
  return (
    <div className="watch-piece" data-large={large ? "" : undefined}>
      <div className="watch-model" data-pin={pinned}>
        <div className="watch-model-head">
          <SourceBadge source={piece.source} />
          <b title={version.path}>{name}</b>
        </div>
        <ModelViewer
          url={version.url!}
          name={name}
          fileId={0}
          format={format}
          poster={null}
          pins={NO_PINS}
          picking={false}
          onPick={ignore}
          onPin={ignore}
          compact={!large}
        />
        {large && (
          <p className="watch-model-foot">
            <small>{details}</small>
            <a className="watch-link" href={version.url!} download={name}>
              {t.model.download}
            </a>
          </p>
        )}
      </div>
    </div>
  );
}

function TextPiece({ piece, version }: { piece: Piece; version: PieceVersion }) {
  const slash = version.path.lastIndexOf("/") + 1;
  return (
    <div className="watch-code" data-pin={piece.source === "pin" ? "" : undefined}>
      <div className="watch-code-head">
        <span className="watch-code-path">
          {version.path.slice(0, slash)}
          <b>{version.path.slice(slash)}</b>
        </span>
        <SourceBadge source={piece.source} />
      </div>
      {version.excerpt === null ? <p className="watch-code-empty">{t.unreadable}</p> : <pre>{version.excerpt}</pre>}
    </div>
  );
}

/** The versions of the run: thumbnails that never play, or file names, the latest marked. */
function Strip({ piece, index, onChoose }: { piece: Piece; index: number; onChoose: (path: string) => void }) {
  const last = piece.versions.length - 1;
  const media = piece.versions.every((version) => version.kind === "video" || version.kind === "image");
  const label = !media ? t.strip.files : piece.versions.length > 1 ? t.strip.versions : t.strip.single;
  return (
    <div className="watch-strip" role="group" aria-label={label}>
      <span className="watch-strip-label">{label}</span>
      {piece.versions.map((version, i) => {
        const name = version.path.split("/").pop() ?? version.path;
        const common = {
          type: "button" as const,
          "aria-pressed": i === index,
          "data-latest": i === last ? "" : undefined,
          onClick: () => onChoose(version.path),
        };
        if (media) {
          return (
            <button key={version.path} {...common} className="watch-thumb" aria-label={t.versionLabel(i + 1, formatClock(version.at))}>
              <span className="watch-thumb-box">
                {version.kind === "image" ? (
                  // eslint-disable-next-line @next/next/no-img-element -- a live file of the agent, served as is
                  <img src={version.url!} alt="" loading="lazy" />
                ) : (
                  <video src={`${version.url}#t=0.1`} preload="metadata" muted playsInline />
                )}
              </span>
              <span className="watch-thumb-cap">{formatClock(version.at)}</span>
            </button>
          );
        }
        return (
          <button key={version.path} {...common} className="watch-file" title={version.path}>
            {name}
            <small>{t.writtenAt(formatClock(version.at))}</small>
          </button>
        );
      })}
    </div>
  );
}

// ---- The detail panel ------------------------------------------------------------------

function Panel(props: {
  runId: number;
  version: number;
  now: number;
  chosen: Chosen;
  reducedMotion: boolean;
  onChoose: (runId: number, path: string) => void;
  onClose: () => void;
  onZoom: (image: { url: string; caption: string }) => void;
}) {
  const { runId, version, now, onClose } = props;
  const [run, setRun] = useState<LiveRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [compare, setCompare] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);

  // Read again whenever the room is read again: a new status, a new version.
  useEffect(() => {
    let closed = false;
    fetchLiveRun(runId)
      .then((next) => {
        if (closed) return;
        setRun(next);
        setError(null);
      })
      .catch((failure: unknown) => {
        if (!closed) setError(errorText(failure));
      });
    return () => {
      closed = true;
    };
  }, [runId, version]);

  // Once per opening: the clock renders the page every second, with a new onClose each time.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    closeButton.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, []);

  const tile = run?.tile ?? null;
  const piece = tile?.piece ?? null;
  const index = piece ? shownIndex(piece, props.chosen.get(runId)) : -1;
  const shown = piece ? piece.versions[index]! : null;
  const comparing = compare && canCompare(piece);

  return (
    <>
      <div className="watch-scrim" onClick={onClose} />
      <aside className="watch-panel" role="dialog" aria-modal="true" aria-labelledby="watch-panel-title" style={tile ? roomStyle(tile) : undefined}>
        <div className="watch-panel-head">
          {tile ? <Head tile={tile} now={now} titleId="watch-panel-title" /> : <h2 id="watch-panel-title" className="watch-who">{t.panel.loading}</h2>}
          <button ref={closeButton} type="button" className="watch-x" aria-label={t.panel.close} onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        {error && !run && (
          <div className="watch-stage">
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}
        {run && tile && (
          <div className="watch-panel-body">
            <section className="watch-stage">
              <div className="watch-stage-top">
                <h3 className="wall-display">{taskHeadline(tile)}</h3>
                {canCompare(piece) && (
                  <div className="watch-seg" role="group" aria-label={t.panel.display}>
                    <button type="button" aria-pressed={!comparing} onClick={() => setCompare(false)}>
                      {t.panel.one}
                    </button>
                    <button type="button" aria-pressed={comparing} onClick={() => setCompare(true)}>
                      {t.panel.compare}
                    </button>
                  </div>
                )}
              </div>
              {tile.taskSummary && (
                <details className="watch-full-task">
                  <summary>{t.panel.fullTask}</summary>
                  <p>{tile.task}</p>
                </details>
              )}
              {tile.state === "waiting" && tile.status && (
                <p className="watch-wait">
                  <HoldIcon />
                  <span>
                    {tile.status.text}
                    {tile.waitingSince && <small>{t.pausedFor(pausedMinutes(tile.waitingSince, now))}</small>}
                  </span>
                </p>
              )}
              {piece?.source === "pin" && shown?.caption && (
                <blockquote className="watch-note watch-note-stage">
                  « {shown.caption} »<small>{t.pinnedBy(tile.agentName, formatClock(shown.at))}</small>
                </blockquote>
              )}
              {!piece && <p className="wall-empty-text">{t.panel.noPiece}</p>}
              {piece && shown && comparing && <Compare piece={piece} name={tile.agentName} onZoom={props.onZoom} />}
              {piece && shown && !comparing && (
                <div className="watch-stage-piece">
                  <PieceView piece={piece} version={shown} name={tile.agentName} play={!props.reducedMotion} draw large onZoom={props.onZoom} />
                </div>
              )}
              {piece && !comparing && <Strip piece={piece} index={index} onChoose={(path) => props.onChoose(runId, path)} />}
              {tile.state === "done" && (
                <p className="watch-done-line">
                  <a className="watch-link" href={`${DESK_PATH}${runHash(tile.runId)}`}>
                    {t.summaryLink}
                  </a>
                </p>
              )}
            </section>
            <section className="watch-thread-col">
              <h3 className="wall-display">
                {t.panel.timeline} <span>{t.panel.timelineHint}</span>
              </h3>
              <ol className="watch-thread">
                {mergeTimeline(tile, run.timeline).map((entry) => (
                  <TimelineRow key={entry.key} entry={entry} piece={piece} onChoose={(path) => props.onChoose(runId, path)} />
                ))}
              </ol>
            </section>
          </div>
        )}
      </aside>
    </>
  );
}

function TimelineRow({ entry, piece, onChoose }: { entry: TimelineEntry; piece: Piece | null; onChoose: (path: string) => void }) {
  let body: ReactNode;
  if (entry.version !== undefined && piece) {
    const version = piece.versions[entry.version]!;
    const word = version.kind === "text" ? t.panel.written : entry.kind === "pin" ? t.panel.pin : t.panel.version;
    body = (
      <>
        {word}
        <button type="button" className="watch-ev-card" onClick={() => onChoose(version.path)}>
          <span>
            <b>{version.path.split("/").pop()}</b>
            <small>{t.panel.backToStage}</small>
          </span>
        </button>
      </>
    );
  } else if (entry.kind === "start") {
    body = t.panel.start(entry.text ?? "");
  } else if (entry.kind === "end") {
    body = t.panel.end;
  } else {
    body = entry.text;
  }
  return (
    <li className="watch-ev" data-k={entry.kind}>
      <time>{formatClock(entry.at)}</time>
      <span className="watch-mark" />
      <div className="watch-ev-text">{body}</div>
    </li>
  );
}

/** Two versions side by side, each with its own choice; two videos start together. */
function Compare({ piece, name, onZoom }: { piece: Piece; name: string; onZoom: (image: { url: string; caption: string }) => void }) {
  const last = piece.versions.length - 1;
  const [left, setLeft] = useState(Math.max(0, last - 1));
  const [right, setRight] = useState(last);
  const stage = useRef<HTMLDivElement>(null);
  const side = (value: number, set: (value: number) => void, label: string) => (
    <div className="watch-cmp">
      <select aria-label={label} value={value} onChange={(event) => set(Number(event.target.value))}>
        {piece.versions.map((version, i) => (
          <option key={version.path} value={i}>
            {t.versionLabel(i + 1, formatClock(version.at))}
          </option>
        ))}
      </select>
      <PieceView piece={piece} version={piece.versions[value]!} name={name} play={false} draw={false} large onZoom={onZoom} />
    </div>
  );
  return (
    <div className="watch-stage-piece" data-cmp="" ref={stage}>
      {side(left, setLeft, t.panel.left)}
      {side(right, setRight, t.panel.right)}
      {piece.versions[0]!.kind === "video" && (
        <div className="watch-cmp-bar">
          <button
            type="button"
            className="watch-play"
            onClick={() =>
              stage.current?.querySelectorAll("video").forEach((video) => {
                video.currentTime = 0;
                void video.play();
              })
            }
          >
            <PlayIcon />
            {t.panel.playBoth}
          </button>
        </div>
      )}
    </div>
  );
}

function Lightbox({ image, onClose }: { image: { url: string; caption: string }; onClose: () => void }) {
  const [full, setFull] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div className="watch-lightbox" role="dialog" aria-modal="true" aria-label={t.lightbox.label} data-full={full ? "" : undefined}>
      <div className="watch-lb-bar">
        <span>{image.caption}</span>
        <span className="watch-lb-hint">{t.lightbox.hint}</span>
        <button type="button" className="watch-x" aria-label={t.lightbox.close} onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <div className="watch-lb-scroll">
        {/* eslint-disable-next-line @next/next/no-img-element -- a live file of the agent, served as is */}
        <img src={image.url} alt={image.caption} onClick={() => setFull((value) => !value)} />
      </div>
    </div>
  );
}
