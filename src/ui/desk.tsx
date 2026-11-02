"use client";

import { useState } from "react";
import { decideApproval, errorText } from "./api";
import { HandoverControls } from "./copy-button";
import { formatDateTime } from "./format";
import { Markdown } from "./markdown-view";
import { branchHandover, payloadUrl, type Action } from "./model";
import type { Approval } from "./schemas";
import { strings } from "./strings";
import { Badge, buttonClass, ErrorNote, fieldClass, Section } from "./ui";

type Dispatch = (action: Action) => void;
type NoteMode = "rejected" | "revise";

const decisionTone = { approved: "ok", rejected: "danger", revise: "warn", pending: "neutral" } as const;

function ApprovalHeader({ approval }: { approval: Approval }) {
  return (
    <header className="space-y-1">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <Badge tone="neutral">{approval.type}</Badge>
        <span>{strings.desk.submittedBy(approval.agentId, approval.room)}</span>
        <span>{strings.desk.submittedOn(formatDateTime(approval.createdAt))}</span>
      </p>
      <h3 className="break-words text-base font-semibold">{approval.title}</h3>
    </header>
  );
}

function ApprovalContent({ approval, showControls = true }: { approval: Approval; showControls?: boolean }) {
  return (
    <>
      {approval.body.trim() === "" ? (
        <p className="text-sm text-muted">{strings.desk.emptyBody}</p>
      ) : (
        <Markdown source={approval.body} />
      )}
      {showControls && <HandoverControls approval={approval} prominent={false} />}
    </>
  );
}

function PendingCard({
  approval,
  dispatch,
  onApproved,
}: {
  approval: Approval;
  dispatch: Dispatch;
  onApproved: (approval: Approval) => void;
}) {
  const [mode, setMode] = useState<NoteMode | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (decision: Parameters<typeof decideApproval>[1]) => {
    setBusy(true);
    setError(null);
    try {
      const decided = await decideApproval(approval.id, decision);
      dispatch({ type: "approval", approval: decided });
      if (decided.status === "approved") onApproved(decided);
    } catch (failure) {
      setError(errorText(failure));
      setBusy(false);
    }
  };

  const submitNote = () => {
    if (mode === null) return;
    if (note.trim() === "") {
      setError(strings.desk.noteRequired);
      return;
    }
    void send({ decision: mode, note: note.trim() });
  };

  const chooseMode = (next: NoteMode) => {
    setMode(next);
    setError(null);
  };

  const label = mode === "rejected" ? strings.desk.rejectLabel : strings.desk.reviseLabel;
  const fieldId = `note-${approval.id}`;

  return (
    <li className="space-y-3 rounded-lg border border-line bg-card p-4">
      <ApprovalHeader approval={approval} />
      <ApprovalContent approval={approval} />
      {mode === null ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={buttonClass("primary")}
            disabled={busy}
            onClick={() => void send({ decision: "approved" })}
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
            required
            autoFocus
          />
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
      {error && <ErrorNote>{error}</ErrorNote>}
    </li>
  );
}

function HistoryCard({ approval }: { approval: Approval }) {
  return (
    <li className="space-y-3 rounded-lg border border-line bg-card p-4">
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
      <details>
        <summary className="cursor-pointer text-sm text-muted">{strings.desk.openContent}</summary>
        <div className="mt-2 space-y-3">
          <ApprovalContent approval={approval} showControls={approval.status !== "approved"} />
        </div>
      </details>
    </li>
  );
}

type Tab = "pending" | "history";

export function Desk({
  pending,
  history,
  dispatch,
}: {
  pending: Approval[];
  history: Approval[];
  dispatch: Dispatch;
}) {
  const [tab, setTab] = useState<Tab>("pending");
  // An approved item that points to a thread, or a branch to push, is now the user's: show it in the history.
  const showHandover = (approval: Approval) => {
    if (payloadUrl(approval.payload) || branchHandover(approval)) setTab("history");
  };
  const tabClass = (active: boolean) =>
    `min-h-10 rounded-md px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
      active ? "bg-soft" : "text-muted hover:bg-soft"
    }`;

  return (
    <Section title={strings.desk.title}>
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
            <ul className="space-y-3">
              {pending.map((approval) => (
                <PendingCard key={approval.id} approval={approval} dispatch={dispatch} onApproved={showHandover} />
              ))}
            </ul>
          )
        ) : history.length === 0 ? (
          <p className="text-sm text-muted">{strings.desk.emptyHistory}</p>
        ) : (
          <ul className="space-y-3">
            {history.map((approval) => (
              <HistoryCard key={approval.id} approval={approval} />
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}
