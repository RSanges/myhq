// The run an agent proposes when a message of the owner asks for work
// (docs/architecture.md, "A task or a discussion"). In question mode the agent
// never does the work: it says so in a short sentence and ends its answer with
// a tagged block that holds the task of the run, reworded, complete and
// self-contained:
//
//   <run-proposal>
//   Render clip B again with the new music, then submit it for approval.
//   </run-proposal>
//
// A tag pair is used rather than JSON or a code fence: it survives Markdown
// (the model does not escape it), it cannot be confused with an answer that
// shows code, and a missing or broken block degrades to a plain answer. Pure.

export const RUN_PROPOSAL_TAG = "run-proposal";
/** The longest task a run takes (startRunSchema in runner.ts). */
export const RUN_PROPOSAL_MAX_CHARS = 20_000;

const BLOCK = /<run-proposal\s*>([\s\S]*?)<\/run-proposal\s*>/gi;
/** A tag left alone: an opening without its closing, or the reverse. */
const STRAY_TAG = /<\/?run-proposal\s*>/gi;
/** A code fence left empty once a block that was wrapped in it is gone. */
const EMPTY_FENCE = /```[\w-]*[ \t]*\r?\n\s*```/g;

/** The task inside a block: trimmed, out of a code fence the model may have put it in. */
function cleanTask(inner: string): string {
  const trimmed = inner.trim();
  const fenced = /^```[\w-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(trimmed);
  return (fenced ? fenced[1]! : trimmed).trim();
}

/**
 * Splits an answer into the text shown to the owner and the task of the run
 * it proposes. The last complete block is the proposal; every block and every
 * stray tag leaves the text (what a broken block held stays readable). No
 * block, an empty one or one longer than a run's task: no proposal.
 */
export function parseRunProposal(raw: string): { text: string; task: string | null } {
  let task: string | null = null;
  for (const match of raw.matchAll(BLOCK)) {
    const candidate = cleanTask(match[1] ?? "");
    task = candidate !== "" && candidate.length <= RUN_PROPOSAL_MAX_CHARS ? candidate : null;
  }
  const text = raw
    .replace(BLOCK, "")
    .replace(STRAY_TAG, "")
    .replace(EMPTY_FENCE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, task };
}
