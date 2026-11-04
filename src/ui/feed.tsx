"use client";

import { useEffect, useMemo, useState } from "react";
import { runAnchor, runStartKey } from "./deep-link";
import { formatCost, formatTime, truncate } from "./format";
import { buildFeed, viewEvent, type FeedEntry, type TeamAgent } from "./model";
import type { HqEvent, Message } from "./schemas";
import { strings } from "./strings";
import { fieldClass, Section } from "./ui";
import type { DeepLinkTarget } from "./use-deep-link";

const PREVIEW_CHARS = 240;
/** How long a row reached by a deep link stays ringed. */
const FLASH_MS = 2_400;

type Line = { label: string; detail: string; tone: "normal" | "error" | "message" };

function describeEvent(event: HqEvent): Line {
  const view = viewEvent(event);
  switch (view.kind) {
    case "start":
      return { label: strings.feed.start(view.model, view.reason), detail: "", tone: "normal" };
    case "text":
      return { label: "", detail: view.text, tone: "normal" };
    case "tool_call":
      return { label: strings.feed.toolCall(view.name), detail: view.input, tone: "normal" };
    case "tool_result":
      return {
        label: view.isError ? strings.feed.toolResultError : strings.feed.toolResult,
        detail: view.content,
        tone: view.isError ? "error" : "normal",
      };
    case "end":
      return {
        label: strings.feed.end(view.status),
        detail: [view.summary, view.costUsd !== null ? strings.feed.cost(formatCost(view.costUsd)) : ""]
          .filter(Boolean)
          .join("\n"),
        tone: view.status === "failed" ? "error" : "normal",
      };
    case "unknown":
      return { label: strings.feed.unknown(view.type), detail: "", tone: "normal" };
  }
}

function describeMessage(message: Message): Line {
  return { label: strings.feed.message(message.from, message.to), detail: message.text, tone: "message" };
}

/** `anchor` gives the row an id (a deep link target); `flash` rings it. */
export function FeedRow({ entry, anchor, flash = false }: { entry: FeedEntry; anchor?: string; flash?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const line = entry.kind === "event" ? describeEvent(entry.event) : describeMessage(entry.message);
  const who = entry.kind === "event" ? entry.event.agentId : entry.message.from;
  const long = line.detail.length > PREVIEW_CHARS;
  const shown = expanded || !long ? line.detail : truncate(line.detail, PREVIEW_CHARS);
  const toneClass =
    line.tone === "error" ? "border-danger" : line.tone === "message" ? "border-accent" : "border-line";

  return (
    <li id={anchor} className={`deep-target min-w-0 space-y-1 border-l-2 py-1 pl-3 text-sm ${toneClass} ${flash ? "deep-flash" : ""}`}>
      <p className="flex flex-wrap gap-x-2 text-xs text-muted">
        <time dateTime={entry.at}>{formatTime(entry.at)}</time>
        <span className="font-medium text-foreground">{who}</span>
        <span>{entry.room}</span>
      </p>
      {line.label && <p className="break-words font-medium">{line.label}</p>}
      {shown && <p className="whitespace-pre-wrap break-words text-muted">{shown}</p>}
      {long && (
        <button type="button" className="text-xs text-accent underline underline-offset-2" onClick={() => setExpanded(!expanded)}>
          {expanded ? strings.feed.showLess : strings.feed.showMore}
        </button>
      )}
    </li>
  );
}

export function Feed({
  events,
  messages,
  agents,
  target,
}: {
  events: HqEvent[];
  messages: Message[];
  agents: TeamAgent[];
  /** The deep link of the address bar, if any (#run-<id>). */
  target: DeepLinkTarget | null;
}) {
  const [filter, setFilter] = useState("");
  const [flash, setFlash] = useState<{ key: string; runId: number; nonce: number } | null>(null);
  const [handled, setHandled] = useState<number | null>(null);
  // A run link scrolls to the start of the run, once, whatever the filter was. A run the page holds no event of is ignored.
  if (target && handled !== target.nonce) {
    setHandled(target.nonce);
    if (target.link.kind === "run") {
      const key = runStartKey(buildFeed(events, messages, null), target.link.id);
      if (key) {
        setFilter("");
        setFlash({ key, runId: target.link.id, nonce: target.nonce });
      }
    }
  }
  useEffect(() => {
    if (flash === null) return;
    document.getElementById(runAnchor(flash.runId))?.scrollIntoView({
      block: "start",
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
    const timer = window.setTimeout(() => setFlash(null), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [flash]);
  const entries = useMemo(() => buildFeed(events, messages, filter === "" ? null : filter), [events, messages, filter]);

  return (
    <Section
      title={strings.feed.title}
      aside={
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted">{strings.feed.filterLabel}</span>
          <select className={`${fieldClass} w-auto`} value={filter} onChange={(event) => setFilter(event.target.value)}>
            <option value="">{strings.feed.filterAll}</option>
            {agents.map((agent) => (
              <option key={agent.key} value={agent.key}>
                {agent.name}
              </option>
            ))}
          </select>
        </label>
      }
    >
      {entries.length === 0 ? (
        <p className="text-sm text-muted">{strings.feed.empty}</p>
      ) : (
        <ul className="max-h-[32rem] space-y-2 overflow-y-auto pr-1" aria-live="off">
          {entries.map((entry) => (
            <FeedRow
              key={entry.key}
              entry={entry}
              anchor={flash?.key === entry.key ? runAnchor(flash.runId) : undefined}
              flash={flash?.key === entry.key}
            />
          ))}
        </ul>
      )}
    </Section>
  );
}
