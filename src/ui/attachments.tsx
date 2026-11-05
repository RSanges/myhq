"use client";

import dynamic from "next/dynamic";
import { useMemo, useRef, useState } from "react";
import type { Annotation, AnnotationPoint } from "@/server/annotations";
import { CommentBox } from "./annotated-body";
import { insertAnnotation } from "./annotate";
import {
  fileEntries,
  formatTimecode,
  MODEL_FRAME_CLASS,
  modelFormat,
  pointQuote,
  timedQuote,
  type FileEntry,
  type ModelFormat,
} from "./attachments-model";
import type { Pin } from "./model-viewer";
import type { ApprovalFile } from "./schemas";
import { strings } from "./strings";
import { buttonClass } from "./ui";

type Remarks = {
  annotations: readonly Annotation[];
  /** Absent: the item is read-only, no remark can be added. */
  onAnnotations?: (next: Annotation[]) => void;
};

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
 * A video or a sound, with « Annoter à cet instant »: the player pauses, and a
 * remark box opens whose quote says the file and the time (« clip-01.mp4 à
 * 0:12 »). The remark joins the item's other remarks, sent with a revision.
 */
function MediaFile({ file, annotations, onAnnotations }: { file: ApprovalFile } & Remarks) {
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const start = () => {
    const player = ref.current;
    if (!player) return;
    player.pause();
    setDraft(timedQuote(file.name, player.currentTime));
  };
  const player =
    file.kind === "video" ? (
      <video
        ref={ref}
        src={file.url}
        controls
        playsInline
        preload="metadata"
        onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
        className="block max-h-[70vh] w-full rounded-md bg-black"
      />
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
    <figure className="space-y-2">
      {player}
      <FileCaption file={file} />
      {onAnnotations && draft === null && (
        <button
          type="button"
          className={buttonClass()}
          onClick={start}
          aria-label={strings.attachments.annotateAtLabel(file.name, formatTimecode(time))}
        >
          {strings.attachments.annotateAt} ({formatTimecode(time)})
        </button>
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
    </figure>
  );
}

/** An image, opened in full in a dialog when clicked. */
function ImageFile({ file }: { file: ApprovalFile }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const alt = file.caption ?? file.name;
  return (
    <figure className="space-y-2">
      <button
        type="button"
        onClick={() => dialog.current?.showModal()}
        aria-label={strings.attachments.enlarge(file.name)}
        className="block max-w-full cursor-zoom-in rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        {/* A file served by the app itself, of any size: next/image has nothing to optimize here. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={file.url} alt={alt} loading="lazy" className="block max-h-[60vh] w-auto max-w-full rounded-md border border-line" />
      </button>
      <FileCaption file={file} />
      <dialog
        ref={dialog}
        aria-label={file.name}
        onClick={(event) => {
          if (event.target === event.currentTarget) event.currentTarget.close();
        }}
        className="m-auto max-h-[100dvh] max-w-[100vw] bg-transparent p-2 backdrop:bg-black/80"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={file.url} alt={alt} className="mx-auto block max-h-[calc(100dvh-5rem)] w-auto max-w-full" />
        <form method="dialog" className="mt-2 flex justify-center gap-2">
          <a href={file.url} target="_blank" rel="noopener" className={buttonClass()}>
            {strings.attachments.open}
          </a>
          <button type="submit" className={buttonClass("primary")} autoFocus>
            {strings.attachments.close}
          </button>
        </form>
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
function ModelFile({ entry, format, annotations, onAnnotations }: { entry: FileEntry; format: ModelFormat } & Remarks) {
  const { file, preview } = entry;
  const [picking, setPicking] = useState(false);
  const [draft, setDraft] = useState<AnnotationPoint | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const pins = useMemo(() => {
    const list: Pin[] = [];
    annotations.forEach((annotation, index) => {
      if (annotation.point?.fileId !== file.id) return;
      list.push({
        key: String(index),
        number: index + 1,
        point: annotation.point,
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
  const opened = open === null ? undefined : annotations[open];

  return (
    <figure className="space-y-2">
      <ModelViewer
        url={file.url}
        name={file.name}
        fileId={file.id}
        format={format}
        poster={preview?.url ?? null}
        pins={pins}
        picking={picking}
        onPick={(point) => {
          setPicking(false);
          setOpen(null);
          setDraft(point);
        }}
        onPin={(key) => {
          if (key === "draft") return;
          setPicking(false);
          setDraft(null);
          setOpen(Number(key));
        }}
      />
      <FileCaption file={file} />
      <div className="flex flex-wrap gap-2">
        {onAnnotations &&
          (picking ? (
            <button type="button" className={buttonClass()} onClick={() => setPicking(false)}>
              {strings.attachments.cancelPick}
            </button>
          ) : (
            <button
              type="button"
              className={buttonClass()}
              disabled={draft !== null}
              onClick={() => {
                setOpen(null);
                setPicking(true);
              }}
            >
              {strings.attachments.annotatePoint}
            </button>
          ))}
        <a href={`${file.url}?download=1`} download={file.name} className={buttonClass()}>
          {strings.attachments.download}
        </a>
      </div>
      {onAnnotations && draft && (
        <CommentBox
          key="draft"
          quote={pointQuote(file.name, draft)}
          initial=""
          readOnly={false}
          isNew
          onValidate={(comment) => {
            onAnnotations(insertAnnotation(annotations, { quote: pointQuote(file.name, draft), comment: comment.trim(), point: draft }));
            setDraft(null);
          }}
          onRemove={() => setDraft(null)}
          onClose={() => setDraft(null)}
        />
      )}
      {open !== null && opened && (
        <CommentBox
          key={`pin-${open}`}
          quote={opened.quote}
          initial={opened.comment}
          readOnly={!onAnnotations}
          isNew={false}
          onValidate={(comment) => {
            onAnnotations?.(annotations.map((a, i) => (i === open ? { ...a, comment: comment.trim() } : a)));
            setOpen(null);
          }}
          onRemove={() => {
            onAnnotations?.(annotations.filter((_, i) => i !== open));
            setOpen(null);
          }}
          onClose={() => setOpen(null)}
        />
      )}
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
 * viewer for parts (with their download), and a download for PDFs.
 */
export function Attachments({ files, annotations, onAnnotations }: { files: readonly ApprovalFile[] } & Remarks) {
  const entries = fileEntries(files);
  if (entries.length === 0) return null;
  return (
    <section aria-label={strings.attachments.title(files.length)} className="space-y-4">
      {entries.map((entry) => (
        <div key={entry.file.id} className="min-w-0">
          {entry.file.kind === "video" || entry.file.kind === "audio" ? (
            <MediaFile file={entry.file} annotations={annotations} onAnnotations={onAnnotations} />
          ) : entry.file.kind === "image" ? (
            <ImageFile file={entry.file} />
          ) : entry.file.kind === "model" && modelFormat(entry.file.name) ? (
            <ModelFile entry={entry} format={modelFormat(entry.file.name)!} annotations={annotations} onAnnotations={onAnnotations} />
          ) : (
            <DownloadFile entry={entry} />
          )}
        </div>
      ))}
    </section>
  );
}
