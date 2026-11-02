"use client";

import { useEffect, useRef, useState } from "react";
import { browserCopyIo, copyLabel, copyText, COPIED_RESET_MS, type CopyState } from "./clipboard";
import { branchHandover, claudeMdHandover, payloadUrl } from "./model";
import type { Approval } from "./schemas";
import { strings } from "./strings";
import { buttonClass, fieldClass } from "./ui";

/**
 * Copies a text to the clipboard. When the browser refuses, the text appears
 * in a read-only field, selected, so that Ctrl+C is enough.
 */
export function CopyButton({
  text,
  id,
  labels = strings.desk.copy,
}: {
  text: string;
  id: string;
  labels?: Record<CopyState, string>;
}) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const area = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  useEffect(() => {
    if (state === "manual") area.current?.select();
  }, [state]);

  const click = () => {
    if (timer.current) clearTimeout(timer.current);
    // The call to writeText happens inside the click handler (see copyText).
    void copyText(text, browserCopyIo()).then((result) => {
      setState(result);
      if (result === "copied") timer.current = setTimeout(() => setState("idle"), COPIED_RESET_MS);
    });
  };

  return (
    <span className="inline-flex flex-col gap-2">
      <button type="button" className={buttonClass()} onClick={click} aria-live="polite">
        {copyLabel(state, labels)}
      </button>
      {state === "manual" && (
        <textarea
          ref={area}
          readOnly
          rows={4}
          value={text}
          aria-label={strings.desk.copyManualLabel}
          id={`copy-${id}`}
          className={fieldClass}
          onFocus={(event) => event.currentTarget.select()}
        />
      )}
    </span>
  );
}

/**
 * The two controls of an item that points to a thread: copy the text, open the
 * link. `prominent` is for an approved item, which the user now posts himself.
 */
export function HandoverControls({ approval, prominent }: { approval: Approval; prominent: boolean }) {
  const url = payloadUrl(approval.payload);
  if (!url) {
    return claudeMdHandover(approval) ? (
      <ClaudeMdControls approval={approval} prominent={prominent} />
    ) : (
      <BranchControls approval={approval} prominent={prominent} />
    );
  }
  const link = (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={prominent ? buttonClass("primary") : "break-all text-accent underline underline-offset-2"}
    >
      {prominent ? strings.desk.openLink : `${strings.desk.openLink} : ${url}`}
    </a>
  );
  if (!prominent) {
    return (
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2 text-sm">
        <CopyButton text={approval.body} id={String(approval.id)} />
        {link}
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-md border border-accent bg-accent-soft p-3">
      <p className="text-sm font-medium">{strings.desk.handover}</p>
      <div className="flex flex-wrap items-start gap-2">
        <CopyButton text={approval.body} id={String(approval.id)} />
        {link}
      </div>
      <p className="break-all text-xs text-muted">{url}</p>
    </div>
  );
}

/**
 * A pull request or blog post committed on a local branch: the agent never
 * pushes, so once approved the user copies the push and `gh pr create`
 * commands and runs them from the target repository.
 */
function BranchControls({ approval, prominent }: { approval: Approval; prominent: boolean }) {
  const handover = branchHandover(approval);
  if (!handover) return null;
  const label = strings.desk.branch(handover.branch, handover.sha);
  if (!prominent) return <p className="break-all font-mono text-xs text-muted">{label}</p>;
  return (
    <div className="space-y-2 rounded-md border border-accent bg-accent-soft p-3">
      <p className="text-sm font-medium">{strings.desk.branchHandover}</p>
      <p className="break-all font-mono text-xs">{label}</p>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-card px-3 py-2 font-mono text-xs">
        {handover.commands}
      </pre>
      <CopyButton text={handover.commands} id={`cmd-${approval.id}`} labels={strings.desk.copyCommand} />
    </div>
  );
}

/** The "HQ agents" block of an approved room proposal, for the user to add to the project's CLAUDE.md. */
function ClaudeMdControls({ approval, prominent }: { approval: Approval; prominent: boolean }) {
  const handover = claudeMdHandover(approval);
  if (!handover || !prominent || approval.status !== "approved") return null;
  return (
    <div className="space-y-2 rounded-md border border-accent bg-accent-soft p-3">
      <p className="text-sm font-medium">{strings.desk.claudeMdHandover(handover.targetRepo)}</p>
      <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-card px-3 py-2 font-mono text-xs">
        {handover.text}
      </pre>
      <CopyButton text={handover.text} id={`claude-md-${approval.id}`} labels={strings.desk.copyBlock} />
    </div>
  );
}
