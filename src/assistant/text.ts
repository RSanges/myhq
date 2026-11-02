/** Telegram refuses messages over 4096 characters; replies are cut at 4000. */
export const MESSAGE_LIMIT = 4000;

// Built from code points: the repository itself never contains these characters.
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);

/**
 * Turns a Markdown answer into plain text for Telegram (messages are sent
 * without parse mode): no bold marks, headings or code marks, `*` bullets
 * become `-`, and em or en dashes become commas or hyphens.
 */
export function stripMarkdown(text: string): string {
  let out = text.replace(/\*\*/g, "").replace(/__/g, "");
  for (const dash of [EM_DASH, EN_DASH]) {
    out = out
      .split(` ${dash} `)
      .join(", ")
      .split(`${dash} `)
      .join(", ")
      .split(` ${dash}`)
      .join(",")
      .split(dash)
      .join("-");
  }
  out = out
    .split("\n")
    .map((line) => line.replace(/^#{1,6}\s+/, "").replace(/^(\s*)\*\s+/, "$1- "))
    .join("\n");
  return out.replace(/`/g, "");
}

/**
 * Cuts a text into messages of at most `limit` characters, at a line break
 * when one falls in the second half of the window. Blank parts are dropped.
 */
export function splitMessage(text: string, limit = MESSAGE_LIMIT): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = limit;
    // Never cut a surrogate pair (an emoji) in two.
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  parts.push(rest);
  return parts.filter((part) => part.trim() !== "");
}

/** Plain text, cut for Telegram: what every reply goes through. */
export function toTelegramMessages(text: string): string[] {
  return splitMessage(stripMarkdown(text));
}
