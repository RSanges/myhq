import fs from "node:fs";
import path from "node:path";
import { replaceDashes } from "./dashes";
import { toPosix, type Agent, type Home } from "./rooms";

/**
 * The rooms of the home and their agents, one line each, for the prompt of
 * the receptionist (the onboarding agent): in agent mode and in room proposal
 * mode alike, so that neither proposes an agent whose trade a room already
 * has. A shared studio is marked as one an agent may order from.
 */

const SUMMARY_MAX = 160;

/**
 * What a role prompt says of its agent, in one line: the first paragraph after
 * its title, or the title when it has no other text. Empty when the file
 * cannot be read.
 */
export function roleSummary(rolePath: string): string {
  let text: string;
  try {
    text = fs.readFileSync(rolePath, "utf8");
  } catch {
    return "";
  }
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  let i = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, n) => n > 0 && line.trim() === "---");
    i = end === -1 ? 0 : end + 1;
  }
  let title = "";
  const paragraph: string[] = [];
  for (; i < lines.length; i++) {
    const line = lines[i]!.trim();
    const heading = /^#+\s+(.*)$/.exec(line);
    if (heading) {
      if (paragraph.length > 0) break;
      title ||= heading[1]!.trim();
    } else if (line === "") {
      if (paragraph.length > 0) break;
    } else {
      paragraph.push(line);
    }
  }
  const one = replaceDashes((paragraph.length > 0 ? paragraph.join(" ") : title).replace(/\s+/g, " ").trim());
  return one.length > SUMMARY_MAX ? `${one.slice(0, SUMMARY_MAX).trimEnd()}...` : one;
}

/** One agent's line: name, id, model, what its role says, tools, routines, and where its role is (relative to `roomsDir`). */
function agentLine(a: Agent, roomsDir: string): string {
  const routines = a.routines.map((r) => r.cron);
  const summary = roleSummary(a.rolePath);
  return `  - ${a.id} "${a.name}": ${a.model}${summary ? `, ${summary}` : ""}; tools ${a.allowedTools.join(", ") || "none"}${
    routines.length > 0 ? `; routines ${routines.join(" | ")}` : ""
  }; role ${toPosix(path.relative(roomsDir, a.rolePath))}`;
}

/** The rooms and agents of the home, for a prompt. Role paths are relative to `roomsDir`. */
export function homeRosterLines(home: Home, roomsDir: string): string[] {
  if (home.rooms.length === 0) return ["(no room yet)"];
  return home.rooms.flatMap((room) => [
    `- "${room.name}" (${
      room.shared ? "shared studio: you can order from it, its agents take orders from any room" : "project room"
    }), target repository ${toPosix(path.relative(home.root, room.targetRepo)) || "."}:`,
    ...room.agents.map((a) => agentLine(a, roomsDir)),
  ]);
}
