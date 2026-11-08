import type { AgentQuestion, ThreadEntry, ThreadItem, ThreadRun } from "./schemas";

// The thread of an agent's sheet, as the interface draws it: the entries of
// GET /api/rooms/<room>/agents/<agent>/thread turned into the lines of a
// conversation. The owner's message and the agent's answer, a run in one line
// (its summary on demand), an item with its status, a question of the agent
// that waits for the owner, and a day line when the day changes. Pure and
// testable: no DOM, no wording (the component words it with strings.ts),
// times given by the caller.

/** The end of a run's summary shown on its line, in characters. */
export const TAIL_CHARS = 140;

export type ReplyState = "thinking" | "answer" | "failed";

export type ThreadLine =
  /** A new day starts: `day` is the local calendar date (YYYY-MM-DD). */
  | { kind: "day"; key: string; day: string }
  | { kind: "mine"; key: string; at: string; text: string }
  | {
      kind: "reply";
      key: string;
      at: string;
      questionId: number;
      state: ReplyState;
      /** The answer (Markdown), when there is one. */
      text: string | null;
      /** Why there is no answer, for a failed one. */
      error: AgentQuestion["error"];
      costUsd: number;
    }
  | {
      kind: "run";
      key: string;
      at: string;
      run: ThreadRun;
      /** From its start to its end, or to now while it runs. */
      durationMs: number | null;
      /** The end of its summary, on its line. */
      tail: string | null;
    }
  | {
      kind: "item";
      key: string;
      at: string;
      item: ThreadItem;
      /** A question of the agent (hq_ask) that waits for the owner's answers. */
      waiting: boolean;
    };

/** The local calendar date of an instant, YYYY-MM-DD (null for a date that does not parse). */
export function localDay(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Plain text of a line of Markdown: no heading marks, list bullets, emphasis or code ticks. */
function plainLine(line: string): string {
  return line
    .replace(/^\s{0,3}(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, "")
    .replace(/(\*\*|__|\*|_|`)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The end of a summary for the line of its run: its last line of text, and
 * when that is longer than `max`, its last words, after an ellipsis.
 */
export function summaryTail(summary: string | null, max: number = TAIL_CHARS): string | null {
  if (summary === null) return null;
  const lines = summary.split(/\r?\n/).map(plainLine).filter((line) => line !== "" && !/^[-=_*|:\s]+$/.test(line));
  const last = lines[lines.length - 1];
  if (last === undefined) return null;
  if (last.length <= max) return last;
  const end = last.slice(last.length - (max - 1));
  const space = end.indexOf(" ");
  // From the first whole word, unless that leaves too little.
  const words = space > 0 && space < max / 3 ? end.slice(space + 1) : end;
  return `…${words.trimStart()}`;
}

/** How long a run took, or has been going, in milliseconds; null when its times do not parse. */
export function runDurationMs(run: Pick<ThreadRun, "startedAt" | "endedAt">, now: number): number | null {
  const start = Date.parse(run.startedAt);
  const end = run.endedAt === null ? now : Date.parse(run.endedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

function replyState(question: AgentQuestion): ReplyState {
  if (question.status === "running") return "thinking";
  return question.status === "done" && question.answer !== null ? "answer" : "failed";
}

/** The lines of a thread, oldest first, with a day line before the first entry of each day. */
export function threadLines(entries: readonly ThreadEntry[], now: number): ThreadLine[] {
  const lines: ThreadLine[] = [];
  let lastDay: string | null = null;
  const dayOf = (at: string) => {
    const day = localDay(at);
    if (day !== null && day !== lastDay) {
      lines.push({ kind: "day", key: `day:${day}`, day });
      lastDay = day;
    }
  };
  for (const entry of entries) {
    dayOf(entry.at);
    switch (entry.kind) {
      case "question": {
        const { question } = entry;
        lines.push({ kind: "mine", key: `mine:${question.id}`, at: question.askedAt, text: question.question });
        lines.push({
          kind: "reply",
          key: `reply:${question.id}`,
          at: question.answeredAt ?? question.askedAt,
          questionId: question.id,
          state: replyState(question),
          text: question.status === "done" ? question.answer : null,
          error: question.error,
          costUsd: question.costUsd,
        });
        break;
      }
      case "run":
        lines.push({
          kind: "run",
          key: `run:${entry.run.id}`,
          at: entry.at,
          run: entry.run,
          durationMs: runDurationMs(entry.run, now),
          tail: summaryTail(entry.run.summary),
        });
        break;
      case "item":
        lines.push({
          kind: "item",
          key: `item:${entry.item.id}`,
          at: entry.at,
          item: entry.item,
          waiting: entry.item.question && entry.item.status === "pending",
        });
        break;
    }
  }
  return lines;
}

/** What the header of the sheet says the agent is doing, without wording. */
export type SheetState =
  | { kind: "answering" }
  | { kind: "working"; activity: string | null }
  | { kind: "failed" }
  | { kind: "waiting"; resources: string[] }
  | { kind: "asleep" }
  | { kind: "idle" };

/**
 * The state of the header, most telling first: answering a question of the
 * owner, at work (with what it says it is doing), its last run failed, waiting
 * for a shared resource, asleep (the floor says so), or simply available.
 */
export function sheetState(input: {
  answering: boolean;
  working: boolean;
  failed: boolean;
  asleep: boolean;
  activity: string | null;
  waitingFor: readonly string[];
}): SheetState {
  if (input.answering) return { kind: "answering" };
  if (input.working) return { kind: "working", activity: input.activity };
  if (input.failed) return { kind: "failed" };
  if (input.waitingFor.length > 0) return { kind: "waiting", resources: [...input.waitingFor] };
  return input.asleep ? { kind: "asleep" } : { kind: "idle" };
}
