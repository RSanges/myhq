"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Annotation } from "@/server/annotations";
import { AnnotatedBody } from "./annotated-body";
import { stepGuard, type GuardAction, type GuardState } from "./approve-guard";
import { Attachments, type PointFocus } from "./attachments";
import { askAboutItem, decideApproval, errorText, markSeen } from "./api";
import { HandoverControls } from "./copy-button";
import { approvalAnchor, resolveApprovalLink, type DeskTab } from "./deep-link";
import { excerpt } from "./excerpt";
import { formatAge, formatDateTime } from "./format";
import { approvalTitle, branchHandover, claudeMdHandover, payloadUrl, typeLabel, type Action, type TeamAgent } from "./model";
import { chipStyle } from "./room-color";
import type { Approval } from "./schemas";
import { strings } from "./strings";
import { Badge, buttonClass, ErrorNote, fieldClass, Section } from "./ui";
import type { DeepLinkTarget } from "./use-deep-link";

type Dispatch = (action: Action) => void;
type NoteMode = "rejected" | "revise";

const decisionTone = {
  approved: "ok",
  rejected: "danger",
  revise: "warn",
  pending: "neutral",
  unseen: "accent",
  seen: "neutral",
} as const;

/** Who brought an item, as the folded line shows it: the agent's name and the colour of its room. */
type Who = { name: string; color: string | null };

/** How often the ages (« il y a 2 h ») are refreshed. */
const AGE_REFRESH_MS = 60_000;

/** The time of day, refreshed once a minute, for the ages of the folded lines. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), AGE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** Who submitted it and when: the title and the type are on the folded line above. */
function ApprovalHeader({ approval }: { approval: Approval }) {
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
      <span>
        {strings.desk.submittedBy(
          approval.agentId,
          approval.forRoom ? strings.studio.forRoom(approval.room, approval.forRoom) : approval.room,
        )}
      </span>
      <span>{strings.desk.submittedOn(formatDateTime(approval.createdAt))}</span>
    </p>
  );
}

/** What every card of the desk gets to draw its folded line and its fold state. */
type ItemProps = {
  open: boolean;
  onToggle: () => void;
  /** Folds the item: it was handled, and would otherwise reappear unfolded in the history. */
  fold: () => void;
  /** Reached by a deep link: ringed for a moment. */
  flash: boolean;
  who: Who;
  now: number;
};

/**
 * An item of the desk: one compact line (the room colour, the agent, the type,
 * the title, the first line of the body, the age) that is a real button, and
 * under it the whole item when unfolded. Whether it is unfolded is the desk's
 * to say, so that a refresh of the data, a tab switch or « Tout déplier » all
 * agree. Once unfolded, the body stays mounted (hidden when folded again), so
 * a note being typed is not lost by folding.
 */
function DeskItem({
  approval,
  open,
  onToggle,
  flash,
  who,
  now,
  children,
}: {
  approval: Approval;
  open: boolean;
  onToggle: () => void;
  /** Reached by a deep link: ringed for a moment. */
  flash: boolean;
  who: Who;
  now: number;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  const tint = chipStyle(who.color);
  const panelId = `item-${approval.id}`;
  const waiting = approval.status === "pending" || approval.status === "unseen";
  const age = formatAge(waiting ? approval.createdAt : (approval.decidedAt ?? approval.createdAt), now);
  const title = approvalTitle(approval);
  const line = useMemo(() => (open ? "" : excerpt(approval.body, title)), [open, approval.body, title]);
  return (
    <li
      id={approvalAnchor(approval.id)}
      style={tint ?? undefined}
      className={`deep-target rounded-lg border border-line bg-card ${tint ? "border-l-4 border-l-[var(--room-color)]" : ""} ${flash ? "deep-flash" : ""}`}
    >
      <h3 className="text-sm">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={mounted ? panelId : undefined}
          onClick={onToggle}
          className="flex min-h-12 w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg px-3 py-2 text-left hover:bg-soft focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent pointer-coarse:min-h-14 sm:flex-nowrap"
        >
          <span
            aria-hidden
            title={approval.forRoom ? strings.studio.forRoom(approval.room, approval.forRoom) : approval.room}
            className={`size-2.5 shrink-0 rounded-full ${tint ? "bg-[var(--room-color)]" : "bg-line"}`}
          />
          <span className="max-w-[40%] shrink-0 truncate text-xs text-muted sm:max-w-40">{who.name}</span>
          <Badge tone="neutral">{typeLabel(approval.type)}</Badge>
          <span className="order-1 flex min-w-0 basis-full gap-x-1.5 sm:order-none sm:basis-0 sm:flex-1">
            <span
              className={`min-w-0 font-semibold ${open ? "break-words" : "max-w-[60%] shrink-0 truncate"}`}
            >
              {title}
            </span>
            {line !== "" && <span className="min-w-0 flex-1 truncate text-muted">{line}</span>}
          </span>
          <span className="ml-auto shrink-0 text-xs text-muted sm:ml-0">{age}</span>
          <svg
            aria-hidden
            viewBox="0 0 16 16"
            className={`size-4 shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M6 3l5 5-5 5" />
          </svg>
        </button>
      </h3>
      {mounted && (
        <div id={panelId} hidden={!open} className="space-y-3 border-t border-line p-4">
          {children}
        </div>
      )}
    </li>
  );
}

/**
 * The files joined to the item, then the body, with its remarks: editable while
 * the item is pending (`onAnnotations`), read-only after. A remark made on a
 * video or a sound at a given time, or on a point of a file, joins the remarks
 * of the body; « Voir le point » in their list shows that point on its file.
 */
function ApprovalContent({
  approval,
  showControls = true,
  annotations,
  onAnnotations,
}: {
  approval: Approval;
  showControls?: boolean;
  annotations: readonly Annotation[];
  onAnnotations?: (next: Annotation[]) => void;
}) {
  const [focus, setFocus] = useState<PointFocus | null>(null);
  const showPoint = (index: number) => {
    const point = annotations[index]?.point;
    if (!point) return;
    setFocus((current) => ({ index, fileId: point.fileId, t: point.kind === "video" ? point.t : null, seq: (current?.seq ?? 0) + 1 }));
  };
  return (
    <>
      {approval.files && approval.files.length > 0 && (
        <Attachments files={approval.files} annotations={annotations} onAnnotations={onAnnotations} focus={focus} />
      )}
      {approval.body.trim() === "" ? (
        <p className="text-sm text-muted">{strings.desk.emptyBody}</p>
      ) : (
        <AnnotatedBody source={approval.body} annotations={annotations} onChange={onAnnotations} onPoint={showPoint} />
      )}
      {showControls && <HandoverControls approval={approval} prominent={false} />}
    </>
  );
}

function PendingCard({
  approval,
  dispatch,
  onApproved,
  annotations,
  onAnnotations,
  item,
}: {
  approval: Approval;
  dispatch: Dispatch;
  onApproved: (approval: Approval) => void;
  item: ItemProps;
  /** The remarks made on the body so far: kept by the desk until the decision is sent. */
  annotations: Annotation[];
  onAnnotations: (next: Annotation[]) => void;
}) {
  const [mode, setMode] = useState<NoteMode | null>(null);
  const [note, setNote] = useState("");
  const [guard, setGuard] = useState<GuardState>("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (decision: Parameters<typeof decideApproval>[1]) => {
    setBusy(true);
    setError(null);
    try {
      const decided = await decideApproval(approval.id, decision);
      // An item handed over (a thread to open, a branch to push) stays unfolded in the history, with its copy buttons.
      const handover = decided.status === "approved" && (payloadUrl(decided.payload) || branchHandover(decided) || claudeMdHandover(decided));
      if (!handover) item.fold();
      dispatch({ type: "approval", approval: decided });
      // The remarks were sent with the decision, or dropped by it: no draft is left.
      onAnnotations([]);
      if (decided.status === "approved") onApproved(decided);
    } catch (failure) {
      setError(errorText(failure));
      setBusy(false);
    }
  };

  const runGuard = (action: GuardAction) => {
    const step = stepGuard(guard, action, annotations.length);
    setGuard(step.state);
    if (step.effect === "approve") void send({ decision: "approved" });
    if (step.effect === "revise") void send({ decision: "revise", annotations });
  };

  // The confirmation is moot once the last draft is removed; Escape cancels it.
  const draftCount = annotations.length;
  const settled = stepGuard(guard, "drafts", draftCount).state;
  if (settled !== guard) setGuard(settled);
  useEffect(() => {
    if (guard !== "confirming") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setGuard((state) => stepGuard(state, "escape", draftCount).state);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [guard, draftCount]);

  const submitNote = () => {
    if (mode === null) return;
    // A revision may rest on its remarks alone; a refusal always has a reason.
    if (note.trim() === "" && (mode === "rejected" || annotations.length === 0)) {
      setError(strings.desk.noteRequired);
      return;
    }
    void send({
      decision: mode,
      ...(note.trim() !== "" ? { note: note.trim() } : {}),
      ...(annotations.length > 0 ? { annotations } : {}),
    });
  };

  const chooseMode = (next: NoteMode) => {
    setMode(next);
    setError(null);
  };

  const noteOptional = mode === "revise" && annotations.length > 0;
  const label =
    mode === "rejected"
      ? strings.desk.rejectLabel
      : noteOptional
        ? strings.desk.reviseLabelOptional
        : strings.desk.reviseLabel;
  const fieldId = `note-${approval.id}`;

  return (
    <DeskItem approval={approval} {...item}>
      <ApprovalHeader approval={approval} />
      <ApprovalContent approval={approval} annotations={annotations} onAnnotations={onAnnotations} />
      {mode === null ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={buttonClass("primary")}
            disabled={busy}
            onClick={() => runGuard("approve")}
          >
            {busy ? strings.desk.sending : strings.desk.approve}
          </button>
          <button type="button" className={buttonClass("danger")} disabled={busy} onClick={() => chooseMode("rejected")}>
            {strings.desk.reject}
          </button>
          <button type="button" className={buttonClass()} disabled={busy} onClick={() => chooseMode("revise")}>
            {strings.desk.revise}
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <label htmlFor={fieldId} className="block text-sm font-medium">
            {label}
          </label>
          <textarea
            id={fieldId}
            className={fieldClass}
            rows={3}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={5000}
            required={!noteOptional}
            autoFocus
          />
          {annotations.length > 0 && <p className="text-xs text-muted">{strings.annotations.attached(annotations.length)}</p>}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass(mode === "rejected" ? "danger" : "primary")}
              disabled={busy}
              onClick={submitNote}
            >
              {busy ? strings.desk.sending : mode === "rejected" ? strings.desk.confirmReject : strings.desk.confirmRevise}
            </button>
            <button
              type="button"
              className={buttonClass()}
              disabled={busy}
              onClick={() => {
                setMode(null);
                setError(null);
              }}
            >
              {strings.desk.cancel}
            </button>
          </div>
        </div>
      )}
      {mode === null && guard === "confirming" && (
        <div className="space-y-2 rounded-md border border-warn bg-soft p-3">
          <p role="alert" className="text-sm">
            {strings.desk.guard.pending(annotations.length)}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass("primary")}
              disabled={busy}
              onClick={() => runGuard("revise")}
              autoFocus
            >
              {strings.desk.guard.toRevise}
            </button>
            <button type="button" className={buttonClass()} disabled={busy} onClick={() => runGuard("approveAnyway")}>
              {strings.desk.guard.approveAnyway}
            </button>
          </div>
        </div>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
    </DeskItem>
  );
}

/** Asks for a revision of an item already decided: remarks on the body, then a general note. */
function RevisionPanel({
  approval,
  dispatch,
  annotations,
  onAnnotations,
  onClose,
}: {
  approval: Approval;
  dispatch: Dispatch;
  annotations: Annotation[];
  onAnnotations: (next: Annotation[]) => void;
  onClose: () => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noteOptional = annotations.length > 0;
  const fieldId = `revision-note-${approval.id}`;

  const submit = async () => {
    if (note.trim() === "" && !noteOptional) {
      setError(strings.desk.noteRequired);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const decided = await decideApproval(approval.id, {
        decision: "revise",
        ...(note.trim() !== "" ? { note: note.trim() } : {}),
        ...(noteOptional ? { annotations } : {}),
      });
      dispatch({ type: "approval", approval: decided });
      onAnnotations([]);
      onClose();
    } catch (failure) {
      setError(errorText(failure));
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      {approval.actionDone && (
        <p role="note" className="rounded-md border border-warn bg-soft px-3 py-2 text-sm">
          {strings.desk.revisionActionDone}
        </p>
      )}
      <ApprovalContent approval={approval} showControls={false} annotations={annotations} onAnnotations={onAnnotations} />
      <div className="space-y-2">
        <label htmlFor={fieldId} className="block text-sm font-medium">
          {noteOptional ? strings.desk.revisionLabelOptional : strings.desk.revisionLabel}
        </label>
        <textarea
          id={fieldId}
          className={fieldClass}
          rows={3}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={5000}
          required={!noteOptional}
        />
        {noteOptional && <p className="text-xs text-muted">{strings.annotations.attached(annotations.length)}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonClass("primary")} disabled={busy} onClick={() => void submit()}>
            {busy ? strings.desk.sending : strings.desk.sendRevision}
          </button>
          <button type="button" className={buttonClass()} disabled={busy} onClick={onClose}>
            {strings.desk.cancel}
          </button>
        </div>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}

function HistoryCard({
  approval,
  dispatch,
  annotations,
  onAnnotations,
  item,
}: {
  approval: Approval;
  dispatch: Dispatch;
  /** The remarks drafted for a revision of this item, kept by the desk until sent. */
  annotations: Annotation[];
  onAnnotations: (next: Annotation[]) => void;
  item: ItemProps;
}) {
  const [revising, setRevising] = useState(false);
  return (
    <DeskItem approval={approval} {...item}>
      <ApprovalHeader approval={approval} />
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={decisionTone[approval.status]}>{strings.desk.decision[approval.status]}</Badge>
        {approval.decidedAt && <span className="text-muted">{strings.desk.decidedOn(formatDateTime(approval.decidedAt))}</span>}
      </p>
      {approval.status === "approved" && <HandoverControls approval={approval} prominent />}
      {approval.decisionNote && (
        <p className="break-words rounded-md bg-soft px-3 py-2 text-sm">
          <span className="font-medium">{strings.desk.noteTitle} : </span>
          {approval.decisionNote}
        </p>
      )}
      {approval.decisionHistory.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm text-muted">
            {strings.desk.previousDecisions(approval.decisionHistory.length)}
          </summary>
          <ul className="mt-1 space-y-1 text-sm">
            {approval.decisionHistory.map((record, index) => (
              <li key={index} className="break-words">
                <Badge tone={decisionTone[record.decision]}>{strings.desk.decision[record.decision]}</Badge>{" "}
                {record.decidedAt && <span className="text-muted">{strings.desk.decidedOn(formatDateTime(record.decidedAt))}</span>}
                {record.note && <span> : {record.note}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
      {revising ? (
        <RevisionPanel
          approval={approval}
          dispatch={dispatch}
          annotations={annotations}
          onAnnotations={onAnnotations}
          onClose={() => setRevising(false)}
        />
      ) : (
        <>
          {!approval.informational && (
            <button type="button" className={buttonClass()} onClick={() => setRevising(true)}>
              {strings.desk.requestRevision}
            </button>
          )}
          <ApprovalContent
            approval={approval}
            showControls={approval.status !== "approved"}
            annotations={approval.annotations}
          />
        </>
      )}
    </DeskItem>
  );
}

/** An item of the watch section: nothing to decide. "Vu", or a request to the assistant with the item as context. */
function WatchCard({ approval, dispatch, item }: { approval: Approval; dispatch: Dispatch; item: ItemProps }) {
  const assistant = strings.chat.assistantName;
  const [asking, setAsking] = useState(false);
  const [text, setText] = useState<string>(strings.desk.askDefault);
  const [busy, setBusy] = useState<"seen" | "ask" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fieldId = `ask-${approval.id}`;

  const markAsSeen = async () => {
    setBusy("seen");
    setError(null);
    try {
      const seen = await markSeen(approval.id);
      item.fold();
      dispatch({ type: "approval", approval: seen });
    } catch (failure) {
      setError(errorText(failure));
      setBusy(null);
    }
  };

  const ask = async () => {
    if (text.trim() === "") {
      setError(strings.desk.noteRequired);
      return;
    }
    setBusy("ask");
    setError(null);
    try {
      const answer = await askAboutItem(approval.id, text.trim());
      // The chat did not answer (budget, timeout): the item stays, and the reason is shown.
      if (!answer.ok) {
        setError(answer.reply);
        setBusy(null);
        return;
      }
      item.fold();
      dispatch({ type: "approval", approval: answer.approval });
    } catch (failure) {
      setError(errorText(failure));
      setBusy(null);
    }
  };

  return (
    <DeskItem approval={approval} {...item}>
      <ApprovalHeader approval={approval} />
      <ApprovalContent approval={approval} annotations={approval.annotations} />
      {asking ? (
        <div className="space-y-2">
          <label htmlFor={fieldId} className="block text-sm font-medium">
            {strings.desk.askLabel(assistant)}
          </label>
          <textarea
            id={fieldId}
            className={fieldClass}
            rows={3}
            value={text}
            onChange={(event) => setText(event.target.value)}
            maxLength={2000}
            required
            autoFocus
          />
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass("primary")} disabled={busy !== null} onClick={() => void ask()}>
              {busy === "ask" ? strings.desk.sending : strings.desk.askSend}
            </button>
            <button
              type="button"
              className={buttonClass()}
              disabled={busy !== null}
              onClick={() => {
                setAsking(false);
                setError(null);
              }}
            >
              {strings.desk.cancel}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonClass("primary")} disabled={busy !== null} onClick={() => void markAsSeen()}>
            {busy === "seen" ? strings.desk.sending : strings.desk.seen}
          </button>
          <button type="button" className={buttonClass()} disabled={busy !== null} onClick={() => setAsking(true)}>
            {strings.desk.askAssistant(assistant)}
          </button>
        </div>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
    </DeskItem>
  );
}

type Tab = DeskTab;

/** How long an item reached by a deep link stays ringed. */
const FLASH_MS = 2_400;

const NO_ANNOTATIONS: Annotation[] = [];

/**
 * The fold state of a list of desk items, kept by id so that a refresh of the
 * data, a switch of tab or a decision elsewhere never folds an item the user
 * opened; and the deep link (#approval-<id>) followed once, as soon as the
 * items hold it: unfolded, scrolled to and ringed. `onHit` lets the caller
 * show the right tab first.
 */
function useFolds(
  items: readonly Approval[],
  agents: readonly TeamAgent[],
  target: DeepLinkTarget | null,
  onHit?: (hit: { id: number; tab: DeskTab | null }) => void,
) {
  const [flash, setFlash] = useState<{ id: number; nonce: number } | null>(null);
  const [openIds, setOpenIds] = useState<ReadonlySet<number>>(new Set());
  const [handled, setHandled] = useState<number | null>(null);
  const now = useNow();
  const whoById = useMemo(() => {
    const byAgent = new Map(agents.map((agent) => [`${agent.room}/${agent.id}`, agent]));
    const roomColor = new Map(agents.map((agent) => [agent.room, agent.color]));
    return (approval: Approval): Who => {
      const agent = byAgent.get(`${approval.room}/${approval.agentId}`);
      // A delivery of a shared room takes the colour of the room that ordered it, whose pile it is in.
      const color = approval.forRoom ? (roomColor.get(approval.forRoom) ?? null) : (agent?.color ?? null);
      return { name: agent?.name ?? approval.agentId, color };
    };
  }, [agents]);
  const setOpen = (id: number, open: boolean) =>
    setOpenIds((current) => {
      if (current.has(id) === open) return current;
      const next = new Set(current);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  // An id the items do not hold is ignored. The hash stays in the address, so later refreshes of the data change nothing.
  if (target && handled !== target.nonce) {
    setHandled(target.nonce);
    const hit = resolveApprovalLink(target.link, items);
    if (hit) {
      onHit?.(hit);
      setFlash({ id: hit.id, nonce: target.nonce });
      setOpen(hit.id, true);
    }
  }
  useEffect(() => {
    if (flash === null) return;
    document.getElementById(approvalAnchor(flash.id))?.scrollIntoView({
      block: "start",
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
    const timer = window.setTimeout(() => setFlash(null), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [flash]);

  const itemProps = (approval: Approval): ItemProps => ({
    open: openIds.has(approval.id),
    onToggle: () => setOpen(approval.id, !openIds.has(approval.id)),
    fold: () => setOpen(approval.id, false),
    flash: flash?.id === approval.id,
    who: whoById(approval),
    now,
  });

  /** « Tout déplier / Tout replier » acts on what is on screen. */
  const allOpen = (shown: readonly Approval[]) => shown.length > 0 && shown.every((approval) => openIds.has(approval.id));
  const toggleAll = (shown: readonly Approval[]) => {
    const open = allOpen(shown);
    setOpenIds((current) => {
      const next = new Set(current);
      for (const approval of shown) {
        if (open) next.delete(approval.id);
        else next.add(approval.id);
      }
      return next;
    });
  };

  return { itemProps, allOpen, toggleAll };
}

export function Desk({
  pending,
  unseen,
  history,
  agents,
  dispatch,
  target,
  title = strings.desk.title,
}: {
  pending: Approval[];
  /** The informational items waiting for a look: their own section, above the tabs. */
  unseen: Approval[];
  history: Approval[];
  /** To give each folded line the name of its agent and the colour of its room. */
  agents: readonly TeamAgent[];
  dispatch: Dispatch;
  /** The deep link of the address bar, if any (#approval-<id>). */
  target: DeepLinkTarget | null;
  /** The title of the section (the page of the pile has its own). */
  title?: string;
}) {
  const [tab, setTab] = useState<Tab>("pending");
  const folds = useFolds([...pending, ...unseen, ...history], agents, target, (hit) => {
    if (hit.tab) setTab(hit.tab);
  });
  // Remarks made on pending items, kept here (not in the cards) until the decision is sent: a tab switch or a refresh keeps them.
  const [drafts, setDrafts] = useState<Record<number, Annotation[]>>({});
  // An approved item that points to a thread, a branch to push or a CLAUDE.md block is now the user's: show it in the history.
  const showHandover = (approval: Approval) => {
    if (payloadUrl(approval.payload) || branchHandover(approval) || claudeMdHandover(approval)) setTab("history");
  };
  const tabClass = (active: boolean) =>
    `min-h-10 pointer-coarse:min-h-12 rounded-md px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
      active ? "bg-soft" : "text-muted hover:bg-soft"
    }`;

  const itemProps = folds.itemProps;
  // « Tout déplier / Tout replier » acts on what is on screen: the watch section and the tab shown.
  const shown = tab === "pending" ? [...unseen, ...pending] : [...unseen, ...history];
  const allOpen = folds.allOpen(shown);
  const toggleAll = () => folds.toggleAll(shown);

  return (
    <Section
      title={title}
      aside={
        shown.length > 0 ? (
          <button type="button" className={buttonClass()} aria-pressed={allOpen} onClick={toggleAll}>
            {allOpen ? strings.desk.collapseAll : strings.desk.expandAll}
          </button>
        ) : undefined
      }
    >
      {unseen.length > 0 && (
        <section aria-labelledby="desk-watch" className="space-y-2">
          <h3 id="desk-watch" className="text-sm font-semibold">
            {strings.desk.watchTitle(unseen.length)}
          </h3>
          <p className="text-xs text-muted">{strings.desk.watchHint}</p>
          <ul className="space-y-2">
            {unseen.map((approval) => (
              <WatchCard key={approval.id} approval={approval} dispatch={dispatch} item={itemProps(approval)} />
            ))}
          </ul>
        </section>
      )}
      <div role="tablist" aria-label={strings.desk.tabsLabel} className="flex gap-1">
        <button
          type="button"
          role="tab"
          id="tab-pending"
          aria-selected={tab === "pending"}
          aria-controls="panel-desk"
          className={tabClass(tab === "pending")}
          onClick={() => setTab("pending")}
        >
          {strings.desk.pendingTab(pending.length)}
        </button>
        <button
          type="button"
          role="tab"
          id="tab-history"
          aria-selected={tab === "history"}
          aria-controls="panel-desk"
          className={tabClass(tab === "history")}
          onClick={() => setTab("history")}
        >
          {strings.desk.historyTab}
        </button>
      </div>
      <div id="panel-desk" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === "pending" ? (
          pending.length === 0 ? (
            <p className="text-sm text-muted">{strings.desk.emptyPending}</p>
          ) : (
            <ul className="space-y-2">
              {pending.map((approval) => (
                <PendingCard
                  key={approval.id}
                  approval={approval}
                  dispatch={dispatch}
                  onApproved={showHandover}
                  annotations={drafts[approval.id] ?? NO_ANNOTATIONS}
                  onAnnotations={(next) => setDrafts((all) => ({ ...all, [approval.id]: next }))}
                  item={itemProps(approval)}
                />
              ))}
            </ul>
          )
        ) : history.length === 0 ? (
          <p className="text-sm text-muted">{strings.desk.emptyHistory}</p>
        ) : (
          <ul className="space-y-2">
            {history.map((approval) => (
              <HistoryCard
                key={approval.id}
                approval={approval}
                dispatch={dispatch}
                annotations={drafts[approval.id] ?? NO_ANNOTATIONS}
                onAnnotations={(next) => setDrafts((all) => ({ ...all, [approval.id]: next }))}
                item={itemProps(approval)}
              />
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}

/**
 * The page of the tray: the informational items of its types, the unseen
 * ones first (Vu, Demander à l'assistant), sorted by age either way, then
 * the ones already seen, folded like on the desk.
 */
export function WatchDesk({
  unseen,
  seen,
  agents,
  dispatch,
  target,
}: {
  unseen: Approval[];
  seen: Approval[];
  agents: readonly TeamAgent[];
  dispatch: Dispatch;
  target: DeepLinkTarget | null;
}) {
  const t = strings.deskModules.courrier;
  const [newestFirst, setNewestFirst] = useState(false);
  const folds = useFolds([...unseen, ...seen], agents, target);
  const sorted = useMemo(() => {
    const list = [...unseen].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
    return newestFirst ? list.reverse() : list;
  }, [unseen, newestFirst]);
  const shown = [...unseen, ...seen];
  const allOpen = folds.allOpen(shown);
  const sortClass = (active: boolean) =>
    `min-h-10 pointer-coarse:min-h-12 rounded-md px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
      active ? "bg-soft" : "text-muted hover:bg-soft"
    }`;
  return (
    <div className="space-y-6">
      <section aria-labelledby="watch-unseen" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="watch-unseen" className="text-base font-semibold">
            {t.unseenTitle(unseen.length)}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <div role="group" aria-label={t.sortLabel} className="flex gap-1">
              <button type="button" aria-pressed={!newestFirst} className={sortClass(!newestFirst)} onClick={() => setNewestFirst(false)}>
                {t.oldestFirst}
              </button>
              <button type="button" aria-pressed={newestFirst} className={sortClass(newestFirst)} onClick={() => setNewestFirst(true)}>
                {t.newestFirst}
              </button>
            </div>
            {shown.length > 0 && (
              <button type="button" className={buttonClass()} aria-pressed={allOpen} onClick={() => folds.toggleAll(shown)}>
                {allOpen ? strings.desk.collapseAll : strings.desk.expandAll}
              </button>
            )}
          </div>
        </div>
        <p className="text-xs text-muted">{t.hint}</p>
        {sorted.length === 0 ? (
          <p className="text-sm text-muted">{t.emptyUnseen}</p>
        ) : (
          <ul className="space-y-2">
            {sorted.map((approval) => (
              <WatchCard key={approval.id} approval={approval} dispatch={dispatch} item={folds.itemProps(approval)} />
            ))}
          </ul>
        )}
      </section>
      {seen.length > 0 && (
        <section aria-labelledby="watch-seen" className="space-y-3">
          <h2 id="watch-seen" className="text-base font-semibold text-muted">
            {t.seenTitle(seen.length)}
          </h2>
          <ul className="space-y-2">
            {seen.map((approval) => (
              <HistoryCard
                key={approval.id}
                approval={approval}
                dispatch={dispatch}
                annotations={NO_ANNOTATIONS}
                onAnnotations={() => undefined}
                item={folds.itemProps(approval)}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
