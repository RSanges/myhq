import path from "node:path";
import { ATTACHMENT_TYPES } from "./attachments";

/**
 * The surveillance room (docs/architecture.md, "The surveillance room"): the
 * agents at work right now, each with the piece it works on. The piece is a
 * file of its working directory, either shown by the agent itself (hq_show,
 * `run_pins`) or followed by MyHQ through the patterns of its role
 * (room.json `pieces`): the matching files written during the run.
 */

export type PieceKind = "video" | "image" | "audio" | "text";

/** The text files a piece may be: shown as their path and a short excerpt, never served raw. */
const TEXT_EXTENSIONS = new Set([".md", ".txt", ".json", ".csv", ".srt", ".vtt", ".html", ".css", ".js", ".ts", ".tsx", ".py", ".yaml", ".yml"]);

/** The kind of a piece from its name: the media kinds of the attachments, text from a short list, null otherwise. */
export function pieceKind(name: string): PieceKind | null {
  const ext = path.extname(name).toLowerCase();
  const kind = ATTACHMENT_TYPES[ext]?.kind;
  if (kind === "video" || kind === "image" || kind === "audio") return kind;
  return TEXT_EXTENSIONS.has(ext) ? "text" : null;
}
