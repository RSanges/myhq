"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { formatClock } from "./format";
import { Markdown } from "./markdown-view";
import type { TeamAgent } from "./model";
import type { ChatMessage, ChatSignal } from "./schemas";
import { strings } from "./strings";
import { useChat } from "./use-chat";

const t = strings.chat;

const CHAT_TARGET = "chat";
const PANEL_ID = "chat-panel";

/** A key press that is not meant for the page: typing somewhere, or a shortcut of the browser. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * Open state of the panel, and the shortcut that toggles it (the key `c`,
 * when nothing is being typed). The panel is mounted the first time it opens
 * and stays mounted, so that the conversation is kept while it is closed.
 */
export function useChatToggle() {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);

  const toggle = useCallback(() => {
    setMounted(true);
    setOpen((value) => !value);
  }, []);
  const close = useCallback(() => {
    setOpen(false);
    toggleRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key.toLowerCase() !== "c" || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      toggle();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [toggle]);

  return { open, mounted, toggle, close, toggleRef };
}

/** The button of the headers (the floor's and the desk's) that shows and hides the panel. */
export function ChatToggle({
  open,
  onClick,
  buttonRef,
}: {
  open: boolean;
  onClick: () => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className="chat-toggle"
      aria-expanded={open}
      aria-controls={PANEL_ID}
      aria-keyshortcuts="c"
      title={t.toggleLabel(t.assistantName)}
      onClick={onClick}
    >
      <svg viewBox="0 0 20 20" aria-hidden focusable="false">
        <path d="M4 4.5h12a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H9l-3.5 3v-3H4A1.5 1.5 0 0 1 2.5 12V6A1.5 1.5 0 0 1 4 4.5Z" />
      </svg>
      {t.toggle}
      <kbd aria-hidden>c</kbd>
    </button>
  );
}

function agentName(agents: TeamAgent[], to: { room: string; agent: string }): string {
  return agents.find((agent) => agent.room === to.room && agent.id === to.agent)?.name ?? `${to.room} / ${to.agent}`;
}

function Bubble({ message, agents }: { message: Pick<ChatMessage, "role" | "kind" | "channel" | "to" | "text"> & { createdAt?: string }; agents: TeamAgent[] }) {
  const meta = [
    message.createdAt ? formatClock(message.createdAt) : null,
    message.channel === "telegram" ? t.via.telegram : null,
  ].filter(Boolean);
  const who =
    message.role === "user"
      ? message.to
        ? t.toAgent(agentName(agents, message.to))
        : t.you
      : message.role === "assistant"
        ? t.assistantName
        : (t.botKind[message.kind ?? ""] ?? t.botDefault);
  return (
    <li className="chat-msg" data-role={message.role} data-kind={message.kind ?? undefined}>
      <p className="chat-msg-meta">
        <span className="chat-msg-who">{who}</span>
        {meta.length > 0 && <span>{meta.join(" · ")}</span>}
      </p>
      {message.role === "assistant" ? (
        <div className="chat-msg-text">
          <Markdown source={message.text} />
        </div>
      ) : (
        <p className="chat-msg-text">{message.text}</p>
      )}
    </li>
  );
}

/**
 * The conversation with the assistant, the same one as on Telegram, and the
 * way to give a task to an agent: a panel docked on the right of a wide
 * screen (the page gives up the width), the whole screen on a phone. It sits
 * on the floor (`/room`, whose agents are those of the room shown) and on the
 * desk (`/`, all the agents).
 */
export function ChatPanel({
  open,
  onClose,
  subscribe,
  agents,
  narrow,
}: {
  open: boolean;
  onClose: () => void;
  subscribe: (listener: (signal: ChatSignal) => void) => () => void;
  agents: TeamAgent[];
  /** The panel covers the whole screen (a phone). */
  narrow: boolean;
}) {
  const chat = useChat(subscribe);
  const [target, setTarget] = useState(CHAT_TARGET);
  const [draft, setDraft] = useState("");
  const textRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const agent = agents.find((each) => each.key === target) ?? null;
  const inRooms = new Set(agents.map((each) => each.room)).size > 1;
  const name = t.assistantName;

  const { turn, inflight, outgoing, messages } = chat;
  // One turn at a time: while this page waits behind another message, or another channel's message is answered, say so.
  const waitingBehind = inflight > 0 && turn.queued > 0;
  const answeringOther = inflight === 0 && turn.running;
  const typing = waitingBehind || answeringOther || inflight > 0;
  const typingLabel = waitingBehind || answeringOther ? t.busyOther(name) : t.typing(name);

  useEffect(() => {
    if (open) textRef.current?.focus();
  }, [open]);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [open, messages.length, outgoing.length, typing, turn.pendingConfirmation]);

  const submit = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    const ok = await chat.send(text, agent ? { room: agent.room, agent: agent.id } : null);
    // Not taken (an error, a refused task): the text comes back unless something was typed since.
    if (!ok) setDraft((current) => (current === "" ? text : current));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <aside
      id={PANEL_ID}
      className="chat-panel"
      hidden={!open}
      role={narrow ? "dialog" : "complementary"}
      aria-modal={narrow ? true : undefined}
      aria-label={name}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <header className="chat-head">
        <h2 className="chat-title">{name}</h2>
        <button type="button" className="chat-link" title={t.newTitle} onClick={() => void chat.clear()}>
          {t.newLink}
        </button>
        <button type="button" className="chat-btn" onClick={onClose}>
          {t.close}
        </button>
      </header>

      <div ref={logRef} className="chat-log" role="log" aria-live="polite" aria-label={t.logLabel}>
        {!chat.loaded && !chat.loadFailed && <p className="chat-note">{t.loading}</p>}
        {chat.loadFailed && !chat.loaded && <p className="chat-note">{t.loadFailed}</p>}
        {chat.loaded && messages.length === 0 && outgoing.length === 0 && <p className="chat-note">{t.emptyLog(name)}</p>}
        <ul className="chat-msgs">
          {messages.map((message) => (
            <Bubble key={message.id} message={message} agents={agents} />
          ))}
          {outgoing.map((message) => (
            <Bubble
              key={`out-${message.key}`}
              message={{ role: "user", kind: null, channel: "desk", to: message.to, text: message.text }}
              agents={agents}
            />
          ))}
        </ul>
        {typing && (
          <p className="chat-typing" role="status">
            <span className="chat-typing-dots" aria-hidden>
              <i />
              <i />
              <i />
            </span>
            {typingLabel}
          </p>
        )}
        {turn.pendingConfirmation && (
          <section className="chat-confirm" aria-label={t.confirmTitle}>
            <p className="chat-confirm-title">{t.confirmTitle}</p>
            <p>{t.confirmLead(turn.pendingConfirmation.summary)}</p>
            <div className="chat-confirm-actions">
              <button type="button" className="chat-btn chat-btn-primary" onClick={() => void chat.send(strings.assistant.actions.yes[0], null)}>
                {t.yes}
              </button>
              <button type="button" className="chat-btn" onClick={() => void chat.send(strings.assistant.actions.no[0], null)}>
                {t.no}
              </button>
            </div>
          </section>
        )}
        {chat.error && (
          <p className="chat-error" role="alert">
            {chat.error}
          </p>
        )}
      </div>

      <form
        className="chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="chat-chips" role="radiogroup" aria-label={t.recipientsLabel}>
          <button
            type="button"
            role="radio"
            aria-checked={agent === null}
            className="chat-chip"
            onClick={() => setTarget(CHAT_TARGET)}
          >
            {t.chatChip(name)}
          </button>
          {agents.map((each) => (
            <button
              key={each.key}
              type="button"
              role="radio"
              aria-checked={agent?.key === each.key}
              className="chat-chip"
              data-state={each.state}
              title={t.agentChip({ name: each.name, room: inRooms ? each.room : null, state: strings.team.state[each.state] })}
              onClick={() => setTarget(each.key)}
            >
              <span className="chat-dot" aria-hidden />
              {each.name}
              <span className="sr-only">{`, ${strings.team.state[each.state]}`}</span>
            </button>
          ))}
        </div>
        <textarea
          ref={textRef}
          className="chat-input"
          rows={2}
          value={draft}
          maxLength={20000}
          aria-label={t.composerLabel}
          placeholder={agent ? t.placeholderAgent(agent.name) : t.placeholderChat(name)}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="chat-composer-foot">
          <p className="chat-hint">{agent ? t.hintAgent(agent.name) : t.hint}</p>
          <button type="submit" className="chat-btn chat-btn-primary" disabled={draft.trim() === ""}>
            {agent ? t.sendAgent : t.send}
          </button>
        </div>
      </form>
    </aside>
  );
}
