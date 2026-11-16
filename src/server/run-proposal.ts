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
// When the owner asks to change something in an item the agent delivered, the
// block names that item instead, and holds the note of the revision (the
// agent's own recap of what the owner asked); confirmed, it is the « revise »
// decision on that item, not a new run:
//
//   <revision-proposal item="12">
//   Make the border 2 mm wide and keep the rest as it is.
//   </revision-proposal>
//
// A tag pair is used rather than JSON or a code fence: it survives Markdown
// (the model does not escape it), it cannot be confused with an answer that
// shows code, and a missing or broken block degrades to a plain answer. Pure.

export const RUN_PROPOSAL_TAG = "run-proposal";
export const REVISION_PROPOSAL_TAG = "revision-proposal";
/** The longest task a run takes (startRunSchema in runner.ts). */
export const RUN_PROPOSAL_MAX_CHARS = 20_000;
/** The longest note of a revision (the note of decisionSchema in approvals.ts). */
export const REVISION_PROPOSAL_MAX_CHARS = 5_000;

/** A block of either kind; the closing tag is the opening one's (case-insensitive, as the flag makes the reference). */
const BLOCK = /<(run-proposal|revision-proposal)(\s[^>]*)?>([\s\S]*?)<\/\1\s*>/gi;
/** A tag left alone: an opening without its closing, or the reverse. */
const STRAY_TAG = /<\/?(run-proposal|revision-proposal)(\s[^>]*)?>/gi;
/** A code fence left empty once a block that was wrapped in it is gone. */
const EMPTY_FENCE = /```[\w-]*[ \t]*\r?\n\s*```/g;
/** The item a revision block names: item="12" (quotes and a # optional). */
const ITEM_ATTRIBUTE = /^\s*item\s*=\s*["']?#?(\d+)["']?\s*$/i;

/** The task inside a block: trimmed, out of a code fence the model may have put it in. */
function cleanTask(inner: string): string {
  const trimmed = inner.trim();
  const fenced = /^```[\w-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(trimmed);
  return (fenced ? fenced[1]! : trimmed).trim();
}

/** What a block proposes, or null for a block that proposes nothing (empty, too long, a revision with no item). */
function proposalOf(tag: string, attributes: string, inner: string): { task: string; revise?: number } | null {
  const task = cleanTask(inner);
  if (task === "") return null;
  if (tag.toLowerCase() === RUN_PROPOSAL_TAG) {
    return attributes.trim() === "" && task.length <= RUN_PROPOSAL_MAX_CHARS ? { task } : null;
  }
  const item = ITEM_ATTRIBUTE.exec(attributes);
  return item && task.length <= REVISION_PROPOSAL_MAX_CHARS ? { task, revise: Number(item[1]) } : null;
}

/**
 * Splits an answer into the text shown to the owner and what it proposes: the
 * task of a run, or, with `revise` (present only then), the item to revise and
 * the note of that revision in `task`. The last complete block is the
 * proposal; every block and every stray tag leaves the text (what a broken
 * block held stays readable). No block, or a last block that proposes
 * nothing: no proposal.
 */
export function parseRunProposal(raw: string): { text: string; task: string | null; revise?: number } {
  let proposal: { task: string; revise?: number } | null = null;
  for (const match of raw.matchAll(BLOCK)) {
    proposal = proposalOf(match[1] ?? "", match[2] ?? "", match[3] ?? "");
  }
  const text = raw
    .replace(BLOCK, "")
    .replace(STRAY_TAG, "")
    .replace(EMPTY_FENCE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return proposal ? { text, ...proposal } : { text, task: null };
}
