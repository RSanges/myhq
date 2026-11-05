"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { TeamAgent } from "./model";
import { groupByRoom } from "./recipient-groups";
import { chipStyle } from "./room-color";
import { strings } from "./strings";

const t = strings.chat;

/**
 * Who the message goes to: the assistant (null) or an agent. Folded, it is one
 * line, the current recipient in its room's colour and an arrow; the arrow or
 * the chip unfolds the list of every agent by room, in a zone of limited
 * height above the input. Choosing, Escape or a click outside folds it back.
 */
export function RecipientPicker({
  panelOpen,
  agents,
  selected,
  onSelect,
}: {
  /** Whether the chat panel is shown: the list is folded again when it is closed. */
  panelOpen: boolean;
  agents: TeamAgent[];
  /** The agent chosen, null for the assistant. */
  selected: TeamAgent | null;
  onSelect: (agent: TeamAgent | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const groups = groupByRoom(agents);
  const inRooms = groups.length > 1;
  const name = t.assistantName;

  // Folded again when the panel is closed (state adjusted while rendering, see react.dev "storing information from previous renders").
  const [wasOpen, setWasOpen] = useState(panelOpen);
  if (wasOpen !== panelOpen) {
    setWasOpen(panelOpen);
    if (!panelOpen) setExpanded(false);
  }

  useEffect(() => {
    if (!expanded) return;
    // The chosen recipient takes the focus, which also scrolls it into view in the list.
    listRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    // Escape folds the list only: it is caught before the panel, which Escape would close.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (wrapRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
      setExpanded(false);
    };
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !wrapRef.current?.contains(event.target)) setExpanded(false);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, [expanded]);

  const choose = (agent: TeamAgent | null) => {
    onSelect(agent);
    setExpanded(false);
  };

  const chip = (agent: TeamAgent) => {
    const tint = chipStyle(agent.color);
    return (
      <button
        key={agent.key}
        type="button"
        role="radio"
        aria-checked={selected?.key === agent.key}
        className="chat-chip"
        data-state={agent.state}
        data-tint={tint ? "" : undefined}
        style={tint ?? undefined}
        title={t.agentChip({ name: agent.name, room: inRooms ? agent.room : null, state: strings.team.state[agent.state] })}
        onClick={() => choose(agent)}
      >
        <span className="chat-dot" aria-hidden />
        {agent.name}
        <span className="sr-only">{`, ${strings.team.state[agent.state]}`}</span>
      </button>
    );
  };

  const currentName = selected ? selected.name : t.chatChip(name);
  const currentTint = selected ? chipStyle(selected.color) : null;

  return (
    <div ref={wrapRef} className="chat-recipient-wrap">
      <button
        ref={triggerRef}
        type="button"
        className="chat-chip chat-recipient"
        data-current=""
        data-state={selected?.state}
        data-tint={currentTint ? "" : undefined}
        style={currentTint ?? undefined}
        aria-expanded={expanded}
        aria-controls={listId}
        aria-label={t.recipientCurrent(currentName)}
        title={t.recipientToggle}
        onClick={() => setExpanded((value) => !value)}
      >
        {selected && <span className="chat-dot" aria-hidden />}
        <span className="chat-recipient-name">{currentName}</span>
        <svg className="chat-chevron" viewBox="0 0 12 12" aria-hidden focusable="false">
          <path d="M2.5 4.5 6 8l3.5-3.5" />
        </svg>
      </button>
      <div ref={listRef} id={listId} className="chat-recipients" role="radiogroup" aria-label={t.recipientsLabel} hidden={!expanded}>
        <div className="chat-chips">
          <button
            type="button"
            role="radio"
            aria-checked={selected === null}
            className="chat-chip"
            onClick={() => choose(null)}
          >
            {t.chatChip(name)}
          </button>
        </div>
        {groups.map((group) => {
          const tint = chipStyle(group.color);
          return (
            <div key={group.room} role="group" aria-label={group.room}>
              {inRooms && (
                <p className="chat-room-title" data-tint={tint ? "" : undefined} style={tint ?? undefined}>
                  {group.room}
                </p>
              )}
              <div className="chat-chips">{group.agents.map(chip)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
