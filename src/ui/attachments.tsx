"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Annotation, AnnotationPoint, ImagePoint, ModelPoint, VideoPoint } from "@/server/annotations";
import { CommentBox } from "./annotated-body";
import { insertAnnotation } from "./annotate";
import {
  containBox,
  fileEntries,
  formatTimecode,
  imagePoint,
  MODEL_FRAME_CLASS,
  modelFormat,
  pinShownAt,
  pointInPicture,
  pointQuote,
  timedQuote,
  videoPoint,
  type Box,
  type FileEntry,
  type ModelFormat,
} from "./attachments-model";
import type { Pin } from "./model-viewer";
import type { ApprovalFile } from "./schemas";
import { strings } from "./strings";
import { buttonClass } from "./ui";

/**
 * A remark asked for from « Voir le point » in the list of remarks: its index,
 * the file it is on, the time of a video's point, and a count that changes at
 * each request (the same remark can be asked for twice).
 */
export type PointFocus = { index: number; fileId: number; t: number | null; seq: number };

type Remarks = {
  annotations: readonly Annotation[];
  /** Absent: the item is read-only, no remark can be added. */
  onAnnotations?: (next: Annotation[]) => void;
  /** The last remark asked for from the list of remarks. */
  focus?: PointFocus | null;
};

const isModelPoint = (point: AnnotationPoint | undefined): point is ModelPoint =>
  point !== undefined && (point.kind === undefined || point.kind === "model");
const isVideoPoint = (point: AnnotationPoint | undefined): point is VideoPoint => point?.kind === "video";
const isImagePoint = (point: AnnotationPoint | undefined): point is ImagePoint => point?.kind === "image";

/** Name, kind, size and the agent's caption, under a file. */
function FileCaption({ file }: { file: ApprovalFile }) {
  return (
    <figcaption className="space-y-0.5 text-xs">
      <p className="flex flex-wrap gap-x-2 text-muted">
        <span className="break-all font-medium text-current">{file.name}</span>
        <span>{strings.attachments.kind[file.kind]}</span>
        <span>{strings.attachments.size(file.size)}</span>
      </p>
      {file.caption && <p className="whitespace-pre-wrap break-words">{file.caption}</p>}
    </figcaption>
  );
}

/**
 * The state of the remarks pinned on one file: picking a point, the point of
 * the remark being written (`draft`), the remark opened from its pin (`open`).
 * A remark asked for from the list (`focus`) opens here when it is on this file.
 */
function usePinnedRemarks<P extends AnnotationPoint>(fileId: number, focus: PointFocus | null | undefined) {
  const [picking, setPicking] = useState(false);
  const [draft, setDraft] = useState<P | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [seen, setSeen] = useState(focus?.seq ?? 0);
  // Adjusted while rendering, not in an effect: the remark asked for opens with the render that asked for it.
  if (focus && focus.seq !== seen) {
    setSeen(focus.seq);
    if (focus.fileId === fileId) {
      setPicking(false);
      setDraft(null);
      setOpen(focus.index);
    }
  }
  return {
    picking,
    draft,
    open,
    startPicking: () => {
      setOpen(null);
      setPicking(true);
    },
    stopPicking: () => setPicking(false),
    pick: (point: P) => {
      setPicking(false);
      setOpen(null);
      setDraft(point);
    },
    openRemark: (index: number) => {
      setPicking(false);
      setDraft(null);
      setOpen(index);
    },
    clearDraft: () => setDraft(null),
    close: () => setOpen(null),
  };
}

/** The box of the remark being written on a point, or of the remark opened from its pin. */
function PinnedRemarkBox({
  name,
  draft,
  open,
  annotations,
  onAnnotations,
  onDraftDone,
  onClose,
}: {
  name: string;
  draft: AnnotationPoint | null;
  open: number | null;
  onDraftDone: () => void;
  onClose: () => void;
} & Remarks) {
  const opened = open === null ? undefined : annotations[open];
  if (onAnnotations && draft) {
    return (
      <CommentBox
        key="draft"
        quote={pointQuote(name, draft)}
        initial=""
        readOnly={false}
        isNew
        onValidate={(comment) => {
          onAnnotations(insertAnnotation(annotations, { quote: pointQuote(name, draft), comment: comment.trim(), point: draft }));
          onDraftDone();
        }}
        onRemove={onDraftDone}
        onClose={onDraftDone}
      />
    );
  }
  if (open === null || !opened) return null;
  return (
    <CommentBox
      key={`pin-${open}`}
      quote={opened.quote}
      initial={opened.comment}
      readOnly={!onAnnotations}
      isNew={false}
      onValidate={(comment) => {
        onAnnotations?.(annotations.map((a, i) => (i === open ? { ...a, comment: comment.trim() } : a)));
        onClose();
      }}
      onRemove={() => {
        onAnnotations?.(annotations.filter((_, i) => i !== open));
        onClose();
      }}
      onClose={onClose}
    />
  );
}

/** A pin on a picture: where it points (shares of the picture), its number as in « Remarques (n) », its label. */
type FlatPin = { key: string; index: number | null; number: number; x: number; y: number; label: string; active: boolean };

/** The size of the frame of a video, once known; an image fills its own box. */
const naturalSize = (element: HTMLImageElement | HTMLVideoElement) =>
  element instanceof HTMLVideoElement && element.videoWidth > 0 ? { width: element.videoWidth, height: element.videoHeight } : null;

/**
 * Where the picture of an image or a video is drawn, in the pixels of the
 * element's positioned parent: the element's content box, less the bands of a
 * video whose frame does not fill it. Measured again when the element resizes
 * and when its picture is known.
 */
function useDrawnBox(ref: RefObject<HTMLImageElement | HTMLVideoElement | null>): Box | null {
  const [box, setBox] = useState<Box | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const inner = containBox({ width: element.clientWidth, height: element.clientHeight }, naturalSize(element));
      setBox({ ...inner, left: inner.left + element.offsetLeft + element.clientLeft, top: inner.top + element.offsetTop + element.clientTop });
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    element.addEventListener("load", update);
    element.addEventListener("loadedmetadata", update);
    return () => {
      observer.disconnect();
      element.removeEventListener("load", update);
      element.removeEventListener("loadedmetadata", update);
    };
  }, [ref]);
  return box;
}

/** Where a click falls in the picture of an image or a video (shares of its width and height), or null outside it. */
function pointOfClick(element: HTMLImageElement | HTMLVideoElement, clientX: number, clientY: number) {
  const rect = element.getBoundingClientRect();
  const drawn = containBox({ width: element.clientWidth, height: element.clientHeight }, naturalSize(element));
  return pointInPicture(clientX - rect.left - element.clientLeft, clientY - rect.top - element.clientTop, drawn);
}

/** The pins over a picture, laid on the box where the picture is drawn; a click on a pin opens its remark. */
function PinLayer({ box, pins, onPin }: { box: Box | null; pins: readonly FlatPin[]; onPin: (index: number) => void }) {
  if (!box || pins.length === 0) return null;
  return (
    <div className="pointer-events-none absolute" style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
      {pins.map((pin) => {
        const draft = pin.index === null;
        const tone = draft ? "bg-accent" : "bg-warn";
        // Near the top edge the number hangs under its point, so it stays on the picture.
        const under = pin.y < 0.12;
        return (
          <div key={pin.key} className="absolute" style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%` }}>
            <span className={`absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card ${tone}`} />
            <span className={`absolute h-3 w-0.5 -translate-x-1/2 ${under ? "top-0" : "bottom-0"} ${tone}`} />
            <button
              type="button"
              aria-label={pin.label}
              title={pin.label}
              tabIndex={draft ? -1 : undefined}
              onClick={() => {
                if (pin.index !== null) onPin(pin.index);
              }}
              className={`pointer-events-auto absolute ${under ? "top-3" : "bottom-3"} flex size-7 -translate-x-1/2 items-center justify-center rounded-full border-2 border-card text-xs font-bold shadow-md focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent pointer-coarse:size-8 ${
                draft ? "bg-accent text-accent-fg" : "bg-warn text-card"
              } ${pin.active ? "ring-2 ring-accent ring-offset-1" : ""}`}
            >
              {pin.number}
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** The pins of the remarks on a file's points (`accept` picks them, `shown` hides some), and the one being written. */
function flatPins<P extends ImagePoint | VideoPoint>(
  annotations: readonly Annotation[],
  accept: (point: AnnotationPoint | undefined) => point is P,
  open: number | null,
  draft: P | null,
  shown: (point: P, index: number) => boolean = () => true,
): FlatPin[] {
  const list: FlatPin[] = [];
  annotations.forEach((annotation, index) => {
    const point = annotation.point;
    if (!accept(point) || !shown(point, index)) return;
    list.push({
      key: String(index),
      index,
      number: index + 1,
      x: point.x,
      y: point.y,
      label: strings.attachments.pin(index + 1, annotation.comment),
      active: open === index,
    });
  });
  if (draft) {
    list.push({ key: "draft", index: null, number: annotations.length + 1, x: draft.x, y: draft.y, label: strings.attachments.newPin, active: true });
  }
  return list;
}

/** The hint over a picture while a point is being picked. */
function PickHint({ text }: { text: string }) {
  return (
    <p className="pointer-events-none absolute inset-x-2 bottom-2 rounded bg-accent px-2 py-1 text-center text-xs font-medium text-accent-fg shadow-sm">
      {text}
    </p>
  );
}

/** « Annoter un point », or « Annuler » while a point is being picked. */
function PickButton({ picking, disabled, onStart, onCancel }: { picking: boolean; disabled: boolean; onStart: () => void; onCancel: () => void }) {
  return picking ? (
    <button type="button" className={buttonClass()} onClick={onCancel}>
      {strings.attachments.cancelPick}
    </button>
  ) : (
    <button type="button" className={buttonClass()} disabled={disabled} onClick={onStart}>
      {strings.attachments.annotatePoint}
    </button>
  );
}

/** Brings a file into view, without the smooth scroll when motion is reduced. */
function reveal(element: Element | null) {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  element?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
}

/**
 * A video or a sound, with « Annoter à cet instant »: the player pauses, and a
 * remark box opens whose quote says the file and the time (« clip-01.mp4 à
 * 0:12 »). The remark joins the item's other remarks, sent with a revision.
 * On a video, « Annoter un point » also pauses it, and a click or a tap on the
 * paused frame pins that point at that time (« clip-01.mp4 à 0:12, point à
 * 40 % ; 70 % »). A pin shows over the video while the playback is within half
 * a second of its time; a click on it, or « Voir le point » in the list of
 * remarks, brings the video back to that time, paused, and opens the remark.
 */
function MediaFile({ file, annotations, onAnnotations, focus }: { file: ApprovalFile } & Remarks) {
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const figure = useRef<HTMLElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const pinned = usePinnedRemarks<VideoPoint>(file.id, focus);
  const box = useDrawnBox(ref);
  const isVideo = file.kind === "video";
  const onFile = (point: AnnotationPoint | undefined): point is VideoPoint => isVideoPoint(point) && point.fileId === file.id;

  /** Pauses the video on the time of a point. */
  const pauseAt = (t: number) => {
    const player = ref.current;
    if (!player) return;
    player.pause();
    player.currentTime = t;
  };
  // A remark asked for from the list: the video comes into view, paused on its time.
  useEffect(() => {
    if (focus?.fileId !== file.id) return;
    reveal(figure.current);
    if (focus.t !== null) pauseAt(focus.t);
  }, [focus, file.id]);

  const start = () => {
    const player = ref.current;
    if (!player) return;
    player.pause();
    pinned.stopPicking();
    pinned.close();
    setDraft(timedQuote(file.name, player.currentTime));
  };
  const startPicking = () => {
    ref.current?.pause();
    setDraft(null);
    pinned.startPicking();
  };
  const pins = isVideo
    ? flatPins(annotations, onFile, pinned.open, pinned.draft, (point, index) => index === pinned.open || pinShownAt(point.t, time))
    : [];

  const player = isVideo ? (
    <div className="relative">
      <video
        ref={ref}
        src={file.url}
        controls
        playsInline
        preload="metadata"
        onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
        onPlay={pinned.stopPicking}
        className="block max-h-[70vh] w-full rounded-md bg-black"
      />
      {pinned.picking && (
        // The paused frame takes the click (the player's own controls are under it until the pick is done or cancelled).
        <div
          aria-hidden="true"
          className="absolute inset-0 cursor-crosshair rounded-md ring-2 ring-inset ring-accent"
          onClick={(event) => {
            const player = ref.current;
            const at = player && pointOfClick(player, event.clientX, event.clientY);
            if (player && at) pinned.pick(videoPoint(file.id, at, player.currentTime));
          }}
        />
      )}
      <PinLayer
        box={box}
        pins={pins}
        onPin={(index) => {
          const point = annotations[index]?.point;
          if (isVideoPoint(point)) pauseAt(point.t);
          pinned.openRemark(index);
        }}
      />
      {pinned.picking && <PickHint text={strings.attachments.pickVideoHint} />}
    </div>
  ) : (
    <audio
      ref={ref}
      src={file.url}
      controls
      preload="metadata"
      onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
      className="block w-full"
    />
  );
  return (
    <figure ref={figure} className="space-y-2">
      {player}
      <FileCaption file={file} />
      {onAnnotations && draft === null && (
        <div className="flex flex-wrap gap-2">
          {isVideo && (
            <PickButton picking={pinned.picking} disabled={pinned.draft !== null} onStart={startPicking} onCancel={pinned.stopPicking} />
          )}
          <button
            type="button"
            className={buttonClass()}
            onClick={start}
            aria-label={strings.attachments.annotateAtLabel(file.name, formatTimecode(time))}
          >
            {strings.attachments.annotateAt} ({formatTimecode(time)})
          </button>
        </div>
      )}
      {onAnnotations && draft !== null && (
        <CommentBox
          quote={draft}
          initial=""
          readOnly={false}
          isNew
          onValidate={(comment) => {
            onAnnotations(insertAnnotation(annotations, { quote: draft, comment: comment.trim() }));
            setDraft(null);
          }}
          onRemove={() => setDraft(null)}
          onClose={() => setDraft(null)}
        />
      )}
      <PinnedRemarkBox
        name={file.name}
        draft={pinned.draft}
        open={pinned.open}
        annotations={annotations}
        onAnnotations={onAnnotations}
        onDraftDone={pinned.clearDraft}
        onClose={pinned.close}
      />
    </figure>
  );
}

/**
 * An image, opened in full in a dialog when clicked, with « Annoter un point »
 * (under the image and in the dialog): a click or a tap on the image pins the
 * point, from its left and top edges in shares of the image (the same at any
 * size it is shown), and opens the remark box (« cover.png, point à 62 % de la
 * largeur et 18 % de la hauteur »). The pins of its remarks are drawn on the
 * image and in the dialog, numbered as in the list; a click on a pin opens its
 * remark.
 */
function ImageFile({ file, annotations, onAnnotations, focus }: { file: ApprovalFile } & Remarks) {
  const dialog = useRef<HTMLDialogElement>(null);
  const figure = useRef<HTMLElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const large = useRef<HTMLImageElement>(null);
  const [enlarged, setEnlarged] = useState(false);
  const pinned = usePinnedRemarks<ImagePoint>(file.id, focus);
  const box = useDrawnBox(image);
  const largeBox = useDrawnBox(large);
  const alt = file.caption ?? file.name;
  const onFile = (point: AnnotationPoint | undefined): point is ImagePoint => isImagePoint(point) && point.fileId === file.id;
  const pins = flatPins(annotations, onFile, pinned.open, pinned.draft);
  // In the dialog, the image makes room for the remark box under it.
  const remarkShown = (onAnnotations !== undefined && pinned.draft !== null) || pinned.open !== null;

  useEffect(() => {
    if (focus?.fileId === file.id) reveal(figure.current);
  }, [focus, file.id]);

  const pickFrom = (element: HTMLImageElement | null, clientX: number, clientY: number) => {
    const at = element && pointOfClick(element, clientX, clientY);
    if (at) pinned.pick(imagePoint(file.id, at));
  };
  const remarkBox = (
    <PinnedRemarkBox
      name={file.name}
      draft={pinned.draft}
      open={pinned.open}
      annotations={annotations}
      onAnnotations={onAnnotations}
      onDraftDone={pinned.clearDraft}
      onClose={pinned.close}
    />
  );
  const pickButton = onAnnotations && (
    <PickButton picking={pinned.picking} disabled={pinned.draft !== null} onStart={pinned.startPicking} onCancel={pinned.stopPicking} />
  );

  return (
    <figure ref={figure} className="space-y-2">
      <div className="relative w-fit max-w-full">
        <button
          type="button"
          onClick={(event) => {
            if (pinned.picking) return pickFrom(image.current, event.clientX, event.clientY);
            dialog.current?.showModal();
            setEnlarged(true);
          }}
          aria-label={pinned.picking ? strings.attachments.pickImageHint : strings.attachments.enlarge(file.name)}
          className={`block max-w-full rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
            pinned.picking ? "cursor-crosshair" : "cursor-zoom-in"
          }`}
        >
          {/* A file served by the app itself, of any size: next/image has nothing to optimize here. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={image}
            src={file.url}
            alt={alt}
            loading="lazy"
            className={`block max-h-[60vh] w-auto max-w-full rounded-md border ${pinned.picking && !enlarged ? "border-accent" : "border-line"}`}
          />
        </button>
        <PinLayer box={box} pins={pins} onPin={pinned.openRemark} />
        {pinned.picking && !enlarged && <PickHint text={strings.attachments.pickImageHint} />}
      </div>
      <FileCaption file={file} />
      {pickButton && <div className="flex flex-wrap gap-2">{pickButton}</div>}
      {!enlarged && remarkBox}
      <dialog
        ref={dialog}
        aria-label={file.name}
        onClose={() => setEnlarged(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) event.currentTarget.close();
        }}
        className="m-auto max-h-[100dvh] max-w-[100vw] overflow-y-auto bg-transparent p-2 backdrop:bg-black/80"
      >
        <div className="relative mx-auto w-fit max-w-full">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={large}
            src={file.url}
            alt={alt}
            onClick={(event) => {
              if (pinned.picking) pickFrom(large.current, event.clientX, event.clientY);
            }}
            className={`mx-auto block w-auto max-w-full ${remarkShown ? "max-h-[calc(100dvh-17rem)]" : "max-h-[calc(100dvh-5rem)]"} ${
              pinned.picking ? "cursor-crosshair" : ""
            }`}
          />
          {enlarged && <PinLayer box={largeBox} pins={pins} onPin={pinned.openRemark} />}
          {pinned.picking && enlarged && <PickHint text={strings.attachments.pickImageHint} />}
        </div>
        <form method="dialog" className="mt-2 flex flex-wrap justify-center gap-2">
          {pickButton}
          <a href={file.url} target="_blank" rel="noopener" className={buttonClass()}>
            {strings.attachments.open}
          </a>
          <button type="submit" className={buttonClass("primary")} autoFocus>
            {strings.attachments.close}
          </button>
        </form>
        {enlarged && <div className="mx-auto mt-2 w-[min(36rem,calc(100vw-1rem))]">{remarkBox}</div>}
      </dialog>
    </figure>
  );
}

/** three.js and the viewer, fetched only when an item shows a 3D part, and never rendered on the server. */
const ModelViewer = dynamic(() => import("./model-viewer"), {
  ssr: false,
  loading: () => (
    <div className={`${MODEL_FRAME_CLASS} flex items-center justify-center text-sm text-muted`}>{strings.attachments.loading3d}</div>
  ),
});

/**
 * A 3D part (3MF, STL, GLB), drawn in the viewer, with « Annoter un point »: a
 * click or a tap on the part pins the point and opens the remark box, whose
 * quote names the file, the point in the part's frame and the face
 * (« piece.3mf, point (12,4 ; -3,0 ; 8,5) mm, face +Z »). The remark joins the
 * item's other remarks with its point (`point`), and its pin stays on the part,
 * numbered as in the list; a click on a pin opens its remark. The file can
 * still be downloaded to be printed.
 */
function ModelFile({ entry, format, annotations, onAnnotations, focus }: { entry: FileEntry; format: ModelFormat } & Remarks) {
  const { file, preview } = entry;
  const figure = useRef<HTMLElement>(null);
  const pinned = usePinnedRemarks<ModelPoint>(file.id, focus);
  const { open, draft } = pinned;
  const pins = useMemo(() => {
    const list: Pin[] = [];
    annotations.forEach((annotation, index) => {
      const point = annotation.point;
      if (!isModelPoint(point) || point.fileId !== file.id) return;
      list.push({
        key: String(index),
        number: index + 1,
        point,
        label: strings.attachments.pin(index + 1, annotation.comment),
        active: open === index,
        draft: false,
      });
    });
    if (draft) {
      list.push({ key: "draft", number: annotations.length + 1, point: draft, label: strings.attachments.newPin, active: true, draft: true });
    }
    return list;
  }, [annotations, file.id, open, draft]);

  useEffect(() => {
    if (focus?.fileId === file.id) reveal(figure.current);
  }, [focus, file.id]);

  return (
    <figure ref={figure} className="space-y-2">
      <ModelViewer
        url={file.url}
        name={file.name}
        fileId={file.id}
        format={format}
        poster={preview?.url ?? null}
        pins={pins}
        picking={pinned.picking}
        onPick={pinned.pick}
        onPin={(key) => {
          if (key !== "draft") pinned.openRemark(Number(key));
        }}
      />
      <FileCaption file={file} />
      <div className="flex flex-wrap gap-2">
        {onAnnotations && (
          <PickButton picking={pinned.picking} disabled={draft !== null} onStart={pinned.startPicking} onCancel={pinned.stopPicking} />
        )}
        <a href={`${file.url}?download=1`} download={file.name} className={buttonClass()}>
          {strings.attachments.download}
        </a>
      </div>
      <PinnedRemarkBox
        name={file.name}
        draft={draft}
        open={open}
        annotations={annotations}
        onAnnotations={onAnnotations}
        onDraftDone={pinned.clearDraft}
        onClose={pinned.close}
      />
    </figure>
  );
}

/** A 3D part or a PDF: a download link, with its preview image when the agent joined one. */
function DownloadFile({ entry }: { entry: FileEntry }) {
  const { file, preview } = entry;
  const href = file.kind === "model" ? `${file.url}?download=1` : file.url;
  return (
    <figure className="space-y-2">
      <a
        href={href}
        {...(file.kind === "model" ? { download: file.name } : { target: "_blank", rel: "noopener" })}
        className="flex min-h-12 items-center gap-3 rounded-md border border-line bg-soft p-2 hover:border-accent focus-visible:outline-2 focus-visible:outline-accent"
      >
        {preview && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={preview.url}
            alt={strings.attachments.previewOf(file.name)}
            loading="lazy"
            className="size-20 shrink-0 rounded object-cover sm:size-28"
          />
        )}
        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="block break-all text-sm font-medium">{file.name}</span>
          <span className="block text-xs text-muted">
            {strings.attachments.kind[file.kind]}, {strings.attachments.size(file.size)}
          </span>
        </span>
        <span className="shrink-0 text-sm text-accent underline underline-offset-2">
          {file.kind === "model" ? strings.attachments.download : strings.attachments.open}
        </span>
      </a>
      {file.caption && <p className="whitespace-pre-wrap break-words text-xs">{file.caption}</p>}
    </figure>
  );
}

/**
 * The files joined to an item, for the owner to validate a render from the
 * desk or a phone: players for videos and sounds, images to enlarge, a 3D
 * viewer for parts (with their download), and a download for PDFs. Images,
 * videos and parts take remarks pinned on a point.
 */
export function Attachments({ files, annotations, onAnnotations, focus }: { files: readonly ApprovalFile[] } & Remarks) {
  const entries = fileEntries(files);
  if (entries.length === 0) return null;
  return (
    <section aria-label={strings.attachments.title(files.length)} className="space-y-4">
      {entries.map((entry) => (
        <div key={entry.file.id} className="min-w-0">
          {entry.file.kind === "video" || entry.file.kind === "audio" ? (
            <MediaFile file={entry.file} annotations={annotations} onAnnotations={onAnnotations} focus={focus} />
          ) : entry.file.kind === "image" ? (
            <ImageFile file={entry.file} annotations={annotations} onAnnotations={onAnnotations} focus={focus} />
          ) : entry.file.kind === "model" && modelFormat(entry.file.name) ? (
            <ModelFile
              entry={entry}
              format={modelFormat(entry.file.name)!}
              annotations={annotations}
              onAnnotations={onAnnotations}
              focus={focus}
            />
          ) : (
            <DownloadFile entry={entry} />
          )}
        </div>
      ))}
    </section>
  );
}
