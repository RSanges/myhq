import type { CSSProperties } from "react";

// The colour of a room (`color` in room.json) as the interface wears it: a soft
// tint on the chips of the room's agents, never a full fill, so that the text
// stays in the foreground token and reads in both themes. The stylesheet does
// the mixing (see `data-tint` in globals.css); this file only decides which
// colour is safe to hand over.

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** The colour as `#rrggbb` lowercase, or null when it is not a `#rgb` or `#rrggbb` hex colour. */
export function normalizeRoomColor(color: string | null | undefined): string | null {
  if (typeof color !== "string") return null;
  const value = color.trim().toLowerCase();
  if (!HEX.test(value)) return null;
  return value.length === 4 ? `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}` : value;
}

/** Share of the colour in the background of a chip, at rest and when chosen or open. */
export const TINT_REST = 0.14;
export const TINT_ACTIVE = 0.3;

export type TintStyle = CSSProperties & { "--room-color": string };

/**
 * The inline style of a tinted chip: the colour as the custom property
 * `--room-color`, which the `[data-tint]` rules turn into the soft background,
 * the border, the dot and the ring. Null for a room without a (valid) colour:
 * the chip stays neutral.
 */
export function chipStyle(color: string | null | undefined): TintStyle | null {
  const normalized = normalizeRoomColor(color);
  return normalized ? { "--room-color": normalized } : null;
}
