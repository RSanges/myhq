"use client";

import { useEffect, useId, useState } from "react";
import { askAgent, errorText, fetchDiscussion, resetDiscussion } from "./api";
import { formatCost, formatDateTime } from "./format";
import { Markdown } from "./markdown-view";
import type { AgentQuestion } from "./schemas";
import { strings } from "./strings";
import { buttonClass, ErrorNote, fieldClass } from "./ui";

const t = strings.room.sheet.ask;

/** How often the sheet reads the discussion again while the agent answers. */
const POLL_MS = 2_000;
/** The longest question, as the API takes it (agent-questions.ts). */
const QUESTION_MAX_CHARS = 4_000;

/**
 * « Poser une question », on the sheet of an agent: a question answered by the
 * agent without a run (no lock, no daily cap), its answer in Markdown under
 * it. The discussion goes on until « Nouvelle discussion »; it is read again
 * every few seconds while a question waits for its answer.
 */
export function AgentAsk({ room, agentId, name }: { room: string; agentId: string; name: string }) {
  const fieldId = useId();
  const [questions, setQuestions] = useState<AgentQuestion[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = questions.some((question) => question.status === "running");

  // Read at once, then every few seconds while a question waits for its answer.
  useEffect(() => {
    let closed = false;
    const load = async () => {
      try {
        const discussion = await fetchDiscussion(room, agentId);
        if (!closed) setQuestions(discussion.questions);
      } catch (failure) {
        if (!closed) setError(errorText(failure));
      }
    };
    void load();
    const timer = busy ? setInterval(() => void load(), POLL_MS) : null;
    return () => {
      closed = true;
      if (timer) clearInterval(timer);
    };
  }, [room, agentId, busy]);

  const ask = async () => {
    if (draft.trim() === "") return;
    setSending(true);
    setError(null);
    try {
      const question = await askAgent(room, agentId, draft);
      setQuestions((current) => [...current, question]);
      setDraft("");
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setSending(false);
    }
  };

  const reset = async () => {
    setResetting(true);
    setError(null);
    try {
      await resetDiscussion(room, agentId);
      setQuestions([]);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setResetting(false);
    }
  };

  return (
    <section className="space-y-2" aria-labelledby={`${fieldId}-title`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${fieldId}-title`} className="text-sm font-semibold">
          {t.title}
        </h3>
        {questions.length > 0 && (
          <button type="button" className={buttonClass()} disabled={busy || resetting} onClick={() => void reset()}>
            {resetting ? t.resetting : t.reset}
          </button>
        )}
      </div>
      <p className="text-xs text-muted">{t.lead}</p>
      {questions.length === 0 ? (
        <p className="text-sm text-muted">{t.empty}</p>
      ) : (
        <ul className="space-y-3">
          {questions.map((question) => (
            <li key={question.id} className="space-y-2 rounded-lg border border-line bg-card px-3 py-2">
              <p className="whitespace-pre-wrap break-words text-sm">
                <span className="font-medium">{t.you} : </span>
                {question.question}
              </p>
              {question.status === "running" ? (
                <p role="status" className="text-sm text-muted">
                  {t.thinking(name)}
                </p>
              ) : question.status === "done" && question.answer !== null ? (
                <div className="min-w-0 break-words rounded-md bg-soft px-3 py-2 text-sm">
                  <Markdown source={question.answer} />
                </div>
              ) : (
                <ErrorNote>{t.failed[question.error ?? "error"] ?? t.failed.error}</ErrorNote>
              )}
              {question.status !== "running" && (
                <p className="text-xs text-muted">
                  {formatDateTime(question.askedAt)}
                  {question.costUsd > 0 ? `, ${t.cost(formatCost(question.costUsd))}` : ""}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      <label htmlFor={fieldId} className="block text-sm font-medium">
        {t.label}
      </label>
      <textarea
        id={fieldId}
        className={fieldClass}
        rows={2}
        value={draft}
        maxLength={QUESTION_MAX_CHARS}
        placeholder={t.placeholder}
        onChange={(event) => setDraft(event.target.value)}
      />
      <button
        type="button"
        className={buttonClass("primary")}
        disabled={sending || busy || draft.trim() === ""}
        onClick={() => void ask()}
      >
        {sending ? t.sending : t.button}
      </button>
      {error && <ErrorNote>{error}</ErrorNote>}
    </section>
  );
}
