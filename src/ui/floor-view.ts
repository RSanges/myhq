// The view of the floor, pure: the zoom a click on a room flies to (room-renderer.ts applies it).

/** A room flown to may overflow the view up to this many times along its tighter side, never more. */
export const FOCUS_OVERFLOW = 1.75;

/**
 * The whole zoom a click on a room flies to. `fits` is the exact zoom at which
 * the room's box fills the view along its tighter side: the nearest whole step
 * to it (a little over when it rounds up, the room then overflows a little),
 * and always at least one step closer than the `overview`, so that a click
 * zooms even on a room too big to show whole, unless the room would then
 * overflow the view more than FOCUS_OVERFLOW times. Between `min` and `max`.
 */
export function focusZoom(fits: number, overview: number, min: number, max: number): number {
  const nearest = Math.round(fits);
  const closer = Math.min(overview + 1, Math.floor(fits * FOCUS_OVERFLOW));
  return Math.max(min, Math.min(max, Math.max(nearest, closer)));
}
