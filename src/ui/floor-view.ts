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

/** The closest the floor gets: this many device pixels per art pixel. */
export const MAX_ZOOM = 6;
/** Whole zoom steps start here: one device pixel per art pixel, the view the floor always had at the furthest. */
export const MIN_ZOOM = 1;
/** Never further than this, even for a floor of many rooms: the art would be a speck. */
export const FLOOR_MIN_ZOOM = 0.15;
/** Fractional steps below one, from which the levels under it are picked (the exact fit of the floor ends them). */
const FRACTIONAL_ZOOMS = [0.75, 0.5, 0.35, 0.25];
/** A fractional step this close to the fit (a ratio) is dropped: two levels a hair apart are not a step. */
const CLOSE_LEVELS = 1.15;

/**
 * The exact zoom (device pixels per art pixel) at which a box of `width` by `height` art pixels, with `margin` art
 * pixels of air around it, fills a view of `deviceWidth` by `deviceHeight` device pixels along its tighter side.
 */
export function fitZoom(width: number, height: number, margin: number, deviceWidth: number, deviceHeight: number): number {
  return Math.min(deviceWidth / (width + 2 * margin), deviceHeight / (height + 2 * margin));
}

/**
 * The furthest zoom for a floor whose exact fit is `fits`: the fit itself, so that the whole floor shows, but never
 * more than MIN_ZOOM (a floor that fits at one or more keeps the whole steps it always had) and never less than
 * FLOOR_MIN_ZOOM.
 */
export function minZoomFor(fits: number): number {
  if (!Number.isFinite(fits)) return MIN_ZOOM;
  return Math.max(FLOOR_MIN_ZOOM, Math.min(MIN_ZOOM, fits));
}

/**
 * The zoom levels, from the furthest up: the fit of the floor (`min`), a few fractional steps over it (when `min`
 * is under one), then one device pixel per art pixel up to `max` by whole steps.
 */
export function zoomLevels(min: number, max: number): number[] {
  const levels: number[] = [];
  if (min < MIN_ZOOM) {
    levels.push(min, ...FRACTIONAL_ZOOMS.filter((level) => level > min * CLOSE_LEVELS).reverse());
  }
  for (let level = MIN_ZOOM; level <= max; level += 1) levels.push(level);
  return levels.sort((a, b) => a - b);
}

/** The level one step closer (+) or further (-) than `zoom`, which may sit between two levels; `zoom` itself at the ends. */
export function stepZoom(levels: number[], zoom: number, step: number): number {
  if (step > 0) return levels.find((level) => level > zoom * 1.001) ?? zoom;
  if (step < 0) return [...levels].reverse().find((level) => level < zoom / 1.001) ?? zoom;
  return zoom;
}

/** The level nearest to `zoom` on a log scale (a zoom in flight is drawn at a level only, so the art stays even). */
export function nearestZoom(levels: number[], zoom: number): number {
  let best = levels[0] ?? zoom;
  for (const level of levels) {
    if (Math.abs(Math.log(level / zoom)) < Math.abs(Math.log(best / zoom))) best = level;
  }
  return best;
}

/** On screen the text bubbles over agents need this many CSS pixels per art pixel to stay apart. */
export const BUBBLE_MIN_SCALE = 0.75;
/** The names and small marks over agents need this many. */
export const NAME_MIN_SCALE = 0.5;

/**
 * What text the floor still draws over its agents at a zoom. `zoom` is device pixels per art pixel, `scale` CSS pixels
 * per art pixel (the zoom over the device pixel ratio). At one device pixel per art pixel or more, everything the
 * floor ever drew stays; under it (the far levels), the text that would pile up goes: first the wide bubbles of what
 * an agent is doing or thinking, then the names and the small marks. The question mark of a decision and the count
 * of the tray stay at every level.
 */
export function labelDetail(zoom: number, scale: number): { bubbles: boolean; names: boolean } {
  if (zoom >= MIN_ZOOM) return { bubbles: true, names: true };
  return { bubbles: scale >= BUBBLE_MIN_SCALE, names: scale >= NAME_MIN_SCALE };
}
