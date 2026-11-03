"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { cutQuote, type Annotation } from "@/server/annotations";
import { insertAnnotation, locateQuotes, plainText, quoteOf, rangeOffsets, type Mark, type Span } from "./annotate";
import { parseMarkdown } from "./markdown";
import { Markdown } from "./markdown-view";
import { strings } from "./strings";
import { buttonClass, fieldClass } from "./ui";

/** What is open under the body: a new remark on a selected passage, or an existing one. */
type Editing = { kind: "new"; span: Span; quote: string } | { kind: "edit"; index: number };

/** The « Annoter » button, placed under the end of the selection (px, relative to the body). */
type Floating = { top: number; left: number; span: Span; quote: string };

function CommentBox({
  quote,
  initial,
  readOnly,
  isNew,
  onValidate,
  onRemove,
  onClose,
}: {
  quote: string;
  initial: string;
  readOnly: boolean;
  isNew: boolean;
  onValidate: (comment: string) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const [comment, setComment] = useState(initial);
  const ready = comment.trim() !== "";
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && ready && !readOnly) {
      event.preventDefault();
      onValidate(comment);
    }
  };
  return (
    <div
      data-ann-ui
      role="group"
      aria-label={strings.annotations.commentLabel}
      onKeyDown={onKeyDown}
      className="space-y-2 rounded-md border border-line bg-soft p-3"
    >
      <blockquote className="line-clamp-4 border-l-2 border-warn pl-2 text-xs text-muted">
        <span className="sr-only">{strings.annotations.quoteLabel} : </span>
        {cutQuote(quote)}
      </blockquote>
      {readOnly ? (
        <p className="whitespace-pre-wrap text-sm">{initial}</p>
      ) : (
        <textarea
          className={fieldClass}
          rows={3}
          value={comment}
          maxLength={2000}
          placeholder={strings.annotations.commentPlaceholder}
          aria-label={strings.annotations.commentLabel}
          onChange={(event) => setComment(event.target.value)}
          autoFocus
        />
      )}
      <div className="flex flex-wrap gap-2">
        {readOnly ? (
          <button type="button" className={buttonClass()} onClick={onClose}>
            {strings.annotations.close}
          </button>
        ) : (
          <>
            <button type="button" className={buttonClass("primary")} disabled={!ready} onClick={() => onValidate(comment)}>
              {strings.annotations.validate}
            </button>
            <button type="button" className={buttonClass("danger")} onClick={isNew ? onClose : onRemove}>
              {isNew ? strings.desk.cancel : strings.annotations.remove}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The body of an item, with the remarks on its passages. Selecting text offers
 * « Annoter »; the remarks are listed beside (or under) the body and their
 * passages are highlighted. Without `onChange` the remarks are read-only.
 */
export function AnnotatedBody({
  source,
  annotations,
  onChange,
}: {
  source: string;
  annotations: readonly Annotation[];
  onChange?: (next: Annotation[]) => void;
}) {
  const readOnly = onChange === undefined;
  const text = useMemo(() => plainText(parseMarkdown(source)), [source]);
  const spans = useMemo(() => locateQuotes(text, annotations), [text, annotations]);
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const holdRef = useRef(false);
  const [floating, setFloating] = useState<Floating | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [flash, setFlash] = useState<number | null>(null);

  // A selection inside the body offers « Annoter ». Waits for the selection to settle (a drag, or the handles on a phone).
  useEffect(() => {
    if (readOnly) return;
    let timer: number | undefined;
    const read = () => {
      const body = bodyRef.current;
      const selection = document.getSelection();
      if (holdRef.current) return;
      if (!body || !selection || selection.rangeCount === 0 || selection.isCollapsed) return setFloating(null);
      const range = selection.getRangeAt(0);
      const inUi = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest("[data-ann-ui]");
      if (
        !body.contains(range.startContainer) ||
        !body.contains(range.endContainer) ||
        inUi(range.startContainer) ||
        inUi(range.endContainer)
      ) {
        return setFloating(null);
      }
      const offsets = rangeOffsets(body, range);
      const quoted = quoteOf(text, offsets.start, offsets.end);
      if (!quoted) return setFloating(null);
      const rects = range.getClientRects();
      const last = rects[rects.length - 1] ?? range.getBoundingClientRect();
      const origin = rootRef.current!.getBoundingClientRect();
      const width = rootRef.current!.clientWidth;
      setFloating({
        top: last.bottom - origin.top + 6,
        left: Math.max(0, Math.min(last.right - origin.left - 40, width - 96)),
        span: { start: quoted.start, end: quoted.end },
        quote: quoted.quote,
      });
    };
    const onSelectionChange = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(read, 120);
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [readOnly, text]);

  const marks: Mark[] = [];
  spans.forEach((span, index) => {
    if (span) marks.push({ ...span, id: index, kind: "saved" });
  });
  if (editing?.kind === "new") marks.push({ ...editing.span, id: -1, kind: "draft" });
  const activeIndex = editing?.kind === "edit" ? editing.index : flash;

  // Rings the passage being edited or jumped to.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    body.querySelectorAll("mark[data-ann]").forEach((node) => {
      const on = node.getAttribute("data-ann") === String(activeIndex);
      node.classList.toggle("ring-2", on);
      node.classList.toggle("ring-accent", on);
    });
  });

  const anchor = !editing ? null : editing.kind === "new" ? editing.span.end : (spans[editing.index]?.end ?? text.length);

  const startNew = () => {
    if (!floating) return;
    setEditing({ kind: "new", span: floating.span, quote: floating.quote });
    setFloating(null);
    document.getSelection()?.removeAllRanges();
  };

  const jump = (index: number) => {
    const mark = bodyRef.current?.querySelector(`mark[data-ann="${index}"]`);
    if (!mark) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    mark.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
    setFlash(index);
    window.setTimeout(() => setFlash((current) => (current === index ? null : current)), 1_600);
  };

  const box = () => {
    if (!editing) return null;
    if (editing.kind === "new") {
      return (
        <CommentBox
          key="new"
          quote={editing.quote}
          initial=""
          readOnly={false}
          isNew
          onValidate={(comment) => {
            onChange?.(
              insertAnnotation(annotations, { quote: editing.quote, comment: comment.trim(), position: editing.span.start }),
            );
            setEditing(null);
          }}
          onRemove={() => setEditing(null)}
          onClose={() => setEditing(null)}
        />
      );
    }
    const annotation = annotations[editing.index];
    if (!annotation) return null;
    return (
      <CommentBox
        key={`edit-${editing.index}`}
        quote={annotation.quote}
        initial={annotation.comment}
        readOnly={readOnly}
        isNew={false}
        onValidate={(comment) => {
          onChange?.(annotations.map((a, i) => (i === editing.index ? { ...a, comment: comment.trim() } : a)));
          setEditing(null);
        }}
        onRemove={() => {
          onChange?.(annotations.filter((_, i) => i !== editing.index));
          setEditing(null);
        }}
        onClose={() => setEditing(null)}
      />
    );
  };

  const hint = !readOnly && annotations.length === 0;
  const linkButton = "min-h-8 text-accent underline underline-offset-2 disabled:opacity-50";

  return (
    <div className="@container">
      <div className="grid gap-4 @xl:grid-cols-[minmax(0,1fr)_14rem]">
        <div ref={rootRef} className="relative min-w-0">
          <Markdown
            source={source}
            ref={bodyRef}
            marks={marks}
            onMark={(mark) => {
              if (!readOnly) setEditing({ kind: "edit", index: mark.id });
            }}
            afterBlock={(span) => (anchor !== null && anchor > span.start && anchor <= span.end ? box() : null)}
          />
          {floating && !editing && (
            <button
              type="button"
              className={`${buttonClass("primary")} absolute z-10 shadow-md`}
              style={{ top: floating.top, left: floating.left }}
              onPointerDown={(event) => {
                event.preventDefault();
                holdRef.current = true;
              }}
              onPointerUp={() => window.setTimeout(() => (holdRef.current = false), 300)}
              onPointerCancel={() => (holdRef.current = false)}
              onFocus={() => (holdRef.current = true)}
              onBlur={() => (holdRef.current = false)}
              onClick={() => {
                holdRef.current = false;
                startNew();
              }}
            >
              {strings.annotations.annotate}
            </button>
          )}
          {hint && <p className="mt-3 text-xs text-muted">{strings.annotations.listHint}</p>}
        </div>
        {annotations.length > 0 && (
          <aside
            aria-label={strings.annotations.listTitle(annotations.length)}
            className="min-w-0 @xl:sticky @xl:top-4 @xl:self-start"
          >
            <h4 className="mb-2 text-sm font-semibold">{strings.annotations.listTitle(annotations.length)}</h4>
            <ol className="space-y-2">
              {annotations.map((annotation, index) => (
                <li key={index} className="space-y-1 rounded-md border border-line bg-soft p-2 text-sm">
                  <p className="line-clamp-2 break-words border-l-2 border-warn pl-2 text-xs text-muted">
                    {index + 1}. {cutQuote(annotation.quote)}
                  </p>
                  <p className="whitespace-pre-wrap break-words">{annotation.comment}</p>
                  <div className="flex flex-wrap gap-x-3 text-xs">
                    <button type="button" className={linkButton} onClick={() => jump(index)} disabled={!spans[index]}>
                      {strings.annotations.jump}
                    </button>
                    {!readOnly && (
                      <button type="button" className={linkButton} onClick={() => setEditing({ kind: "edit", index })}>
                        {strings.annotations.edit}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </aside>
        )}
      </div>
    </div>
  );
}
