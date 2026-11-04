"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { selectionMessage, textWithoutChoices, type Choice } from "../assistant/choices";
import { formatClock } from "./format";
import { Markdown } from "./markdown-view";
import type { TeamAgent } from "./model";
import { chipStyle } from "./room-color";
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

/**
 * The items of a selection list (a task list in the chat's reply) as real
 * checkboxes. While the list is the last thing said, it can be ticked and
 * sent as « Sélection : 1, 3, 5 »; once the conversation has moved on it is
 * only shown.
 */
function ChoiceList({ choices, active, onSend }: { choices: Choice[]; active: boolean; onSend: (text: string) => void }) {
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const toggle = (index: number) =>
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(index)) next.add(index);
      return next;
    });
  return (
    <form
      className="chat-confirm"
      aria-label={t.selectionTitle}
      onSubmit={(event) => {
        event.preventDefault();
        if (active && selected.size > 0) onSend(selectionMessage(choices, selected));
      }}
    >
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {choices.map((choice, index) => (
          <li key={index}>
            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={selected.has(index)}
                disabled={!active}
                onChange={() => toggle(index)}
              />
              <span>{choice.label}</span>
            </label>
          </li>
        ))}
      </ul>
      {active && (
        <div className="chat-confirm-actions">
          <button type="submit" className="chat-btn chat-btn-primary" disabled={selected.size === 0}>
            {t.selectionSend}
          </button>
          <button
            type="button"
            className="chat-btn"
            onClick={() => setSelected(selected.size === choices.length ? new Set() : new Set(choices.keys()))}
          >
            {selected.size === choices.length ? t.selectionNone : t.selectionAll}
          </button>
        </div>
      )}
    </form>
  );
}

function Bubble({
  message,
  agents,
  onSelect,
}: {
  message: Pick<ChatMessage, "role" | "kind" | "channel" | "to" | "text"> & { createdAt?: string; choices?: Choice[] | null };
  agents: TeamAgent[];
  /** Sends a selection; given only to the message whose list can still be ticked. */
  onSelect?: (text: string) => void;
}) {
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
  const text = message.choices ? textWithoutChoices(message.text) : message.text;
  return (
    <li className="chat-msg" data-role={message.role} data-kind={message.kind ?? undefined}>
      <p className="chat-msg-meta">
        <span className="chat-msg-who">{who}</span>
        {meta.length > 0 && <span>{meta.join(" · ")}</span>}
      </p>
      {text &&
        (message.role === "assistant" ? (
          <div className="chat-msg-text">
            <Markdown source={text} />
          </div>
        ) : (
          <p className="chat-msg-text">{text}</p>
        ))}
      {message.choices && <ChoiceList choices={message.choices} active={onSelect !== undefined} onSend={onSelect ?? (() => undefined)} />}
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
  page = false,
}: {
  open: boolean;
  onClose: () => void;
  subscribe: (listener: (signal: ChatSignal) => void) => () => void;
  agents: TeamAgent[];
  /** The panel covers the whole screen (a phone). */
  narrow: boolean;
  /** The panel is the page itself (the phone of the desk, /bureau/<id>): no overlay, and its button goes back to the desk. */
  page?: boolean;
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
      className={page ? "chat-panel chat-panel-page" : "chat-panel"}
      hidden={!open}
      role={page ? "region" : narrow ? "dialog" : "complementary"}
      aria-modal={narrow && !page ? true : undefined}
      aria-label={name}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !page) onClose();
      }}
    >
      <header className="chat-head">
        <h2 className="chat-title">{name}</h2>
        <button type="button" className="chat-link" title={t.newTitle} onClick={() => void chat.clear()}>
          {t.newLink}
        </button>
        <button type="button" className="chat-btn" onClick={onClose} aria-label={page ? strings.deskModules.backLabel : undefined}>
          {page ? strings.deskModules.back : t.close}
        </button>
      </header>

      <div ref={logRef} className="chat-log" role="log" aria-live="polite" aria-label={t.logLabel}>
        {!chat.loaded && !chat.loadFailed && <p className="chat-note">{t.loading}</p>}
        {chat.loadFailed && !chat.loaded && <p className="chat-note">{t.loadFailed}</p>}
        {chat.loaded && messages.length === 0 && outgoing.length === 0 && <p className="chat-note">{t.emptyLog(name)}</p>}
        <ul className="chat-msgs">
          {messages.map((message, index) => (
            <Bubble
              key={message.id}
              message={message}
              agents={agents}
              // Only the last word of the conversation can still be answered by a selection.
              onSelect={
                index === messages.length - 1 && outgoing.length === 0 && inflight === 0
                  ? (text) => void chat.send(text, null)
                  : undefined
              }
            />
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
          {agents.map((each) => {
            const tint = chipStyle(each.color);
            return (
              <button
                key={each.key}
                type="button"
                role="radio"
                aria-checked={agent?.key === each.key}
                className="chat-chip"
                data-state={each.state}
                data-tint={tint ? "" : undefined}
                style={tint ?? undefined}
                title={t.agentChip({ name: each.name, room: inRooms ? each.room : null, state: strings.team.state[each.state] })}
                onClick={() => setTarget(each.key)}
              >
                <span className="chat-dot" aria-hidden />
                {each.name}
                <span className="sr-only">{`, ${strings.team.state[each.state]}`}</span>
              </button>
            );
          })}
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
