import { useLayoutEffect, useRef, type RefObject } from "react";

/** Length of the slide of a chip to its new place. */
const FLIP_MS = 220;

/**
 * Slides the children marked `data-flip="<id>"` of `root` from their old place
 * to the new one when `orderKey` changes (an order that changes by itself, not
 * a resize). The Web Animations API does the sliding, so there is no
 * dependency; with `enabled` false (reduced motion) the children just jump.
 * The places are measured with `offsetLeft`/`offsetTop`, so `root` must be
 * positioned and a slide still running does not skew the measure.
 */
export function useFlip(root: RefObject<HTMLElement | null>, orderKey: string, enabled: boolean): void {
  const places = useRef(new Map<string, { x: number; y: number }>());
  const lastKey = useRef(orderKey);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const items = Array.from(element.querySelectorAll<HTMLElement>("[data-flip]"));
    const next = new Map(items.map((item) => [item.dataset.flip!, { x: item.offsetLeft, y: item.offsetTop }]));
    if (enabled && lastKey.current !== orderKey) {
      for (const item of items) {
        const before = places.current.get(item.dataset.flip!);
        const after = next.get(item.dataset.flip!);
        if (!before || !after || typeof item.animate !== "function") continue;
        const dx = before.x - after.x;
        const dy = before.y - after.y;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
        for (const running of item.getAnimations()) running.cancel();
        item.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
          duration: FLIP_MS,
          easing: "cubic-bezier(0.2, 0.7, 0.3, 1)",
        });
      }
    }
    lastKey.current = orderKey;
    places.current = next;
  });
}
