import type { RoomTheme } from "./room-renderer";

// The colors of the room come from the page's CSS tokens (see .wall in
// globals.css), so the canvas follows light and dark like the rest of the page.

/** Any CSS color as 0xRRGGBB (the canvas normalizes it to #rrggbb or rgba(...)), or the fallback. */
export function cssColor(value: string, fallback: number): number {
  const probe = document.createElement("canvas").getContext("2d");
  if (!probe || !value.trim()) return fallback;
  probe.fillStyle = "#000000";
  probe.fillStyle = value.trim();
  const normalized = String(probe.fillStyle);
  if (normalized.startsWith("#")) return Number.parseInt(normalized.slice(1, 7), 16);
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(normalized);
  return rgb ? (Number(rgb[1]) << 16) | (Number(rgb[2]) << 8) | Number(rgb[3]) : fallback;
}

export function readRoomTheme(element: Element): RoomTheme {
  const style = getComputedStyle(element);
  const color = (name: string, fallback: number) => cssColor(style.getPropertyValue(name), fallback);
  return {
    floor: color("--room-floor", 0xe9ece8),
    floorLine: color("--room-floor-line", 0xd5dbd6),
    wall: color("--room-wall", 0xdde3df),
    wallEdge: color("--room-wall-edge", 0xb9c4bd),
    ink: color("--foreground", 0x131d19),
    muted: color("--muted", 0x4a5a53),
    card: color("--card", 0xfbfcfb),
    line: color("--line", 0xc6d0ca),
    accent: color("--accent", 0x2543c4),
    accentInk: color("--accent-fg", 0xffffff),
    danger: color("--danger", 0xa82525),
    ok: color("--ok", 0x17703f),
    wood: color("--room-wood", 0xd8c3a0),
    woodEdge: color("--room-wood-edge", 0xa38a62),
    paper: color("--room-paper", 0xf3e7c1),
    appliance: color("--room-appliance", 0x3b4743),
  };
}
