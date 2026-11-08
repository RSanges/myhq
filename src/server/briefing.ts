import { decisionText, parseAnnotations } from "./annotations";
import { now, type ApprovalRow, type Db } from "./db";

/**
 * What MyHQ already knows and gives an agent in the prompt of its run, so
 * that the agent does not spend a model call to ask for it: the user's new
 * decisions on its submissions (what hq_read_decisions gives, once) and its
 * role memory (what hq_memory_read gives).
 */

export type Decision = {
  approvalId: number;
  type: string;
  title: string;
  decision: string;
  note: string | null;
  decidedAt: string | null;
  payload: unknown;
};

export type MemoryEntry = { key: string; value: string; updatedAt: string };

/**
 * Takes the decisions the agent has not seen yet and marks them seen, as
 * hq_read_decisions does: the run that gets them acts on them. Returns them
 * with the time they were marked, to give them back (`giveBackDecisions`)
 * when the run never reached the model.
 */
export function takeDecisions(db: Db, room: string, agentId: string): { decisions: Decision[]; seenAt: string } {
  const seenAt = now();
  const decisions = db
    .transaction(() => {
      const rows = db
        .prepare(
          `SELECT * FROM approvals WHERE room = ? AND agent_id = ?
           AND status NOT IN ('pending', 'unseen', 'seen') AND seen_by_agent_at IS NULL ORDER BY decided_at, id`,
        )
        .all(room, agentId) as ApprovalRow[];
      const markSeen = db.prepare("UPDATE approvals SET seen_by_agent_at = ? WHERE id = ?");
      for (const row of rows) markSeen.run(seenAt, row.id);
      return rows.map((row) => ({
        approvalId: row.id,
        type: row.type,
        title: row.title,
        decision: row.status,
        note: decisionText(row.decision_note, parseAnnotations(row.annotations)),
        decidedAt: row.decided_at,
        payload: JSON.parse(row.payload) as unknown,
      }));
    })
    .immediate();
  return { decisions, seenAt };
}

/** Makes decisions taken by a run unseen again, unless something else saw them since. */
export function giveBackDecisions(db: Db, ids: readonly number[], seenAt: string): void {
  if (ids.length === 0) return;
  db.prepare(
    `UPDATE approvals SET seen_by_agent_at = NULL WHERE seen_by_agent_at = ? AND id IN (${ids.map(() => "?").join(", ")})`,
  ).run(seenAt, ...ids);
}

export function readMemories(db: Db, room: string, agentId: string): MemoryEntry[] {
  return (
    db
      .prepare("SELECT key, value, updated_at FROM memories WHERE room = ? AND agent_id = ? ORDER BY key")
      .all(room, agentId) as { key: string; value: string; updated_at: string }[]
  ).map((row) => ({ key: row.key, value: row.value, updatedAt: row.updated_at }));
}

/** How many characters of memory values go into a prompt; the keys beyond are only named. */
export const MEMORY_PROMPT_MAX = 20_000;

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

/** The lines of the prompt that give the decisions and the memory. */
export function briefingText(decisions: readonly Decision[], memories: readonly MemoryEntry[]): string {
  const lines: string[] = [];
  if (decisions.length === 0) {
    lines.push("New decisions of the user on your submissions: none.");
  } else {
    lines.push("New decisions of the user on your submissions (each is given once, here: act on it in this run):");
    for (const d of decisions) {
      lines.push(`- Item #${d.approvalId} (${d.type}) "${d.title}": ${d.decision}${d.decidedAt ? `, on ${d.decidedAt}` : ""}.`);
      if (d.note) lines.push(indent(`Note: ${d.note}`));
      const payload = JSON.stringify(d.payload);
      if (payload && payload !== "{}" && payload !== "null") lines.push(indent(`Payload: ${payload}`));
    }
  }
  lines.push(
    "",
    memoryText(memories, {
      empty: "Your memory (hq_memory_write keeps a value for your next runs): empty.",
      heading: "Your memory, kept between runs (hq_memory_write changes a value):",
    }),
  );
  return lines.join("\n");
}

/**
 * The memory of an agent as a prompt gives it: `heading`, then each value
 * (the keys past MEMORY_PROMPT_MAX characters are only named), or `empty`.
 */
export function memoryText(memories: readonly MemoryEntry[], words: { empty: string; heading: string }): string {
  const lines: string[] = [];
  if (memories.length === 0) {
    lines.push(words.empty);
  } else {
    lines.push(words.heading);
    let budget = MEMORY_PROMPT_MAX;
    for (const m of memories) {
      if (m.value.length > budget) {
        lines.push(`- ${m.key} (updated ${m.updatedAt}): ${m.value.length} characters, read it with hq_memory_read.`);
        continue;
      }
      budget -= m.value.length;
      lines.push(`- ${m.key} (updated ${m.updatedAt}):`, indent(m.value));
    }
  }
  return lines.join("\n");
}
