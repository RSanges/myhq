// The text of the floor: HTML elements over the canvas, placed from the same
// world coordinates and the same scale as the drawing, in the page's fonts and
// colors. Text is never drawn in the canvas: it stays sharp at any zoom and
// device pixel ratio, in both themes, and follows the page's font loading.
// The layer is imperative (the loop moves labels on every frame without a
// React render) and decorative (aria-hidden, no pointer events): the list of
// agents under the floor says what the labels show.

export type Tone = "ink" | "muted" | "accent" | "danger" | "onDanger";

export type LabelSpec = {
  text: string;
  /** World coordinates of the anchor point. */
  x: number;
  y: number;
  /** Font size in world units. */
  size: number;
  tone?: Tone;
  weight?: 400 | 600 | 700;
  /** The display face of the wall (figures, titles) instead of the body face. */
  display?: boolean;
  /** Which point of the label sits at (x, y): 0 left or top, 0.5 center, 1 right or bottom. Default: centered. */
  ax?: number;
  ay?: number;
  /** A box around the text, drawn in CSS: a name plate, a name tag over a head, a bubble, a round badge, a count pill. */
  box?: "plate" | "tag" | "bubble" | "badge" | "count";
  /** A colour (normalized hex) for the box: a thin line under a name plate or tag. Null or left out: none. */
  color?: string | null;
  /** Wrap at this width (world units), for a bubble. */
  maxWidth?: number;
  /** Keep the label inside the canvas horizontally. */
  clamp?: boolean;
  opacity?: number;
  /** Extra scale, for a figure that just changed. */
  pop?: number;
};

type Entry = {
  element: HTMLDivElement;
  text: string;
  transform: string;
  fontSize: number;
  maxWidth: number;
  data: string;
  opacity: number;
  width: number;
  used: boolean;
};

export type LabelLayer = {
  /** The plan's place on screen: CSS pixels per world unit, where the world's origin is, the width of the canvas (CSS pixels). */
  setView(scale: number, offsetX: number, offsetY: number, viewWidth: number): void;
  place(key: string, spec: LabelSpec): void;
  /** Hides the labels that were not placed since the last call. */
  end(): void;
  destroy(): void;
};

export function createLabelLayer(container: HTMLElement): LabelLayer {
  const entries = new Map<string, Entry>();
  let scale = 1;
  let offset = { x: 0, y: 0 };
  let viewWidth = 1;

  const entryFor = (key: string): Entry => {
    let entry = entries.get(key);
    if (!entry) {
      const element = document.createElement("div");
      element.className = "room-label";
      container.appendChild(element);
      entry = { element, text: "", transform: "", fontSize: 0, maxWidth: -1, data: "", opacity: 1, width: 0, used: false };
      entries.set(key, entry);
    }
    return entry;
  };

  return {
    setView(nextScale, offsetX, offsetY, nextViewWidth) {
      scale = nextScale;
      offset = { x: offsetX, y: offsetY };
      viewWidth = nextViewWidth;
      // Sizes and widths change with the scale: measure again on the next placement.
      for (const entry of entries.values()) {
        entry.fontSize = 0;
        entry.maxWidth = -1;
      }
    },
    place(key, spec) {
      const entry = entryFor(key);
      entry.used = true;
      const { element } = entry;
      if (element.hidden) element.hidden = false;
      const fontSize = Math.round(spec.size * scale * 100) / 100;
      const maxWidth = spec.maxWidth ? Math.round(spec.maxWidth * scale) : 0;
      const data = `${spec.tone ?? "ink"}|${spec.weight ?? 600}|${spec.display ? 1 : 0}|${spec.box ?? ""}|${spec.color ?? ""}`;
      let measure = false;
      if (entry.data !== data) {
        entry.data = data;
        element.dataset.tone = spec.tone ?? "ink";
        element.style.fontWeight = String(spec.weight ?? 600);
        if (spec.display) element.dataset.display = "";
        else delete element.dataset.display;
        if (spec.box) element.dataset.box = spec.box;
        else delete element.dataset.box;
        if (spec.color) {
          element.dataset.tint = "";
          element.style.setProperty("--room-color", spec.color);
        } else {
          delete element.dataset.tint;
          element.style.removeProperty("--room-color");
        }
        measure = true;
      }
      if (entry.text !== spec.text) {
        entry.text = spec.text;
        element.textContent = spec.text;
        measure = true;
      }
      if (entry.fontSize !== fontSize) {
        entry.fontSize = fontSize;
        element.style.fontSize = `${fontSize}px`;
        measure = true;
      }
      if (entry.maxWidth !== maxWidth) {
        entry.maxWidth = maxWidth;
        element.style.maxWidth = maxWidth > 0 ? `${maxWidth}px` : "";
        measure = true;
      }
      if (measure && spec.clamp) entry.width = element.offsetWidth;
      const ax = spec.ax ?? 0.5;
      const ay = spec.ay ?? 0.5;
      let x = offset.x + spec.x * scale;
      if (spec.clamp) {
        const left = x - entry.width * ax;
        const max = viewWidth - entry.width - 4;
        x += Math.min(max, Math.max(4, left)) - left;
      }
      const y = offset.y + spec.y * scale;
      const pop = spec.pop && spec.pop !== 1 ? ` scale(${spec.pop})` : "";
      // Whole CSS pixels: the text stays sharp.
      const transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(${-ax * 100}%, ${-ay * 100}%)${pop}`;
      if (entry.transform !== transform) {
        entry.transform = transform;
        element.style.transform = transform;
      }
      const opacity = spec.opacity ?? 1;
      if (entry.opacity !== opacity) {
        entry.opacity = opacity;
        element.style.opacity = String(opacity);
      }
    },
    end() {
      for (const entry of entries.values()) {
        if (!entry.used && !entry.element.hidden) entry.element.hidden = true;
        entry.used = false;
      }
    },
    destroy() {
      for (const entry of entries.values()) entry.element.remove();
      entries.clear();
    },
  };
}
