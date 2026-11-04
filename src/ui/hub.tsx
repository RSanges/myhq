"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import {
  badgeText,
  fitScale,
  hubSchema,
  pastel,
  sceneObjects,
  todayCell,
  type Hub,
  type HubFrameRef,
  type HubName,
  type HubState,
  type SceneObject,
} from "./hub-scene";
import type { Desk, DeskObject } from "./schemas";
import { strings } from "./strings";
import { useMediaQuery } from "./use-media-query";

// The hub: the desk drawn as an isometric pixel art office (public/iso/hub/,
// format in scripts/iso/README.md). The scene is composed at 1x on an
// offscreen canvas from the background and the state of each object, then
// drawn at the largest integer scale (in device pixels) that fits, with
// nearest neighbour sampling. Each object of the home's desk is a link over
// its hit box; the pointer is resolved per pixel, since some hit boxes
// overlap (the post-its, the pile and the newspaper).

const t = strings.hub;
const HUB_DIR = "/iso/hub/";

type Assets = {
  hub: Hub;
  background: HTMLImageElement;
  atlas: HTMLImageElement;
  /** The atlas as pixels: the alpha for the hit test, the grey of the masks for the tint. */
  pixels: ImageData;
};

let assetsPromise: Promise<Assets> | null = null;

async function loadImage(src: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = src;
  await image.decode();
  return image;
}

async function fetchAssets(): Promise<Assets> {
  const response = await fetch(`${HUB_DIR}hub.json`);
  if (!response.ok) throw new Error(`hub.json: HTTP ${response.status}`);
  const hub = hubSchema.parse(await response.json());
  const [background, atlas] = await Promise.all([loadImage(HUB_DIR + hub.background.file), loadImage(HUB_DIR + hub.atlas.file)]);
  const canvas = document.createElement("canvas");
  canvas.width = atlas.naturalWidth;
  canvas.height = atlas.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("no 2d context");
  context.drawImage(atlas, 0, 0);
  return { hub, background, atlas, pixels: context.getImageData(0, 0, canvas.width, canvas.height) };
}

/** The assets, loaded once per page; a failure is forgotten so that the next mount tries again. */
function loadAssets(): Promise<Assets> {
  assetsPromise ??= fetchAssets().catch((error: unknown) => {
    assetsPromise = null;
    throw error;
  });
  return assetsPromise;
}

const alphaAt = (pixels: ImageData, x: number, y: number): number => pixels.data[(y * pixels.width + x) * 4 + 3] ?? 0;

/** A mask frame tinted with a colour, as tintOnto() of scripts/iso/image.mjs does it: colour times the grey of the mask. */
function tintMask(assets: Assets, frame: number, color: string): HTMLCanvasElement {
  const [fx, fy, w, h] = assets.hub.atlas.frames[frame]!;
  const rgb = [1, 3, 5].map((at) => parseInt(color.slice(at, at + 2), 16));
  const out = new ImageData(w, h);
  const src = assets.pixels;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const from = ((fy + y) * src.width + fx + x) * 4;
      if (!src.data[from + 3]) continue;
      const grey = src.data[from]!;
      const to = (y * w + x) * 4;
      out.data[to] = Math.round((rgb[0]! * grey) / 255);
      out.data[to + 1] = Math.round((rgb[1]! * grey) / 255);
      out.data[to + 2] = Math.round((rgb[2]! * grey) / 255);
      out.data[to + 3] = 255;
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")?.putImageData(out, 0, 0);
  return canvas;
}

// --- The badge: a count in a 3 x 5 pixel font ------------------------------------------

const GLYPHS: Record<string, string[]> = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "011", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "001", "010", "010"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
  "+": ["000", "010", "111", "010", "000"],
  "!": ["1", "1", "1", "0", "1"],
};

/** Colours of the badge, from the palette of the hub (scripts/iso/palette.mjs). */
const BADGE = { outline: "#1b1424", fill: "#b02a5c", shade: "#5c1838", error: "#574a62", errorShade: "#352a3f", text: "#fffaf0" };

const textWidth = (text: string): number =>
  [...text].reduce((sum, char) => sum + (GLYPHS[char]?.[0]?.length ?? 3), 0) + Math.max(0, text.length - 1);

/** Size of a badge in art pixels. */
const badgeSize = (text: string) => ({ w: textWidth(text) + 6, h: 9 });

/**
 * Where the badge of a frame goes: centred over the top of what the frame
 * draws (the first rows that hold a pixel), so that it sits on the object
 * whatever its hit box. In art pixels, relative to the frame.
 */
function badgeAnchor(assets: Assets, frame: number): { x: number; y: number } {
  const [fx, fy, w, h] = assets.hub.atlas.frames[frame]!;
  let top = -1;
  let left = w;
  let right = -1;
  for (let y = 0; y < h && (top < 0 || y < top + 3); y++) {
    for (let x = 0; x < w; x++) {
      if (alphaAt(assets.pixels, fx + x, fy + y) === 0) continue;
      if (top < 0) top = y;
      left = Math.min(left, x);
      right = Math.max(right, x);
    }
  }
  return top < 0 ? { x: w / 2, y: 0 } : { x: (left + right + 1) / 2, y: top };
}

/** The box of a badge over a drawn frame, in art pixels, kept inside the scene. */
function badgeBox(assets: Assets, ref: { frame: number; at: [number, number] }, text: string) {
  const anchor = badgeAnchor(assets, ref.frame);
  const size = badgeSize(text);
  return {
    x: Math.max(0, Math.min(assets.hub.background.w - size.w, Math.round(ref.at[0] + anchor.x - size.w / 2))),
    y: Math.max(0, ref.at[1] + anchor.y - size.h - 1),
    ...size,
  };
}

/** Where the tooltip of a hovered object points: above the object, and above its badge when it has one. */
function tipSpot(assets: Assets, object: SceneObject, state: HubState): { x: number; y: number } {
  const text = badgeText(object.object);
  const anchor = badgeAnchor(assets, state.hover.frame);
  const top = text ? badgeBox(assets, state.hover, text).y : state.hover.at[1] + anchor.y;
  return { x: state.hover.at[0] + anchor.x, y: top - 2 };
}

function drawBadge(context: CanvasRenderingContext2D, text: string, x: number, y: number) {
  const { w, h } = badgeSize(text);
  const error = text === "!";
  // A rounded pill: the outline without its four corner pixels, the fill, a darker last row.
  context.fillStyle = BADGE.outline;
  context.fillRect(x + 1, y, w - 2, h);
  context.fillRect(x, y + 1, w, h - 2);
  context.fillStyle = error ? BADGE.error : BADGE.fill;
  context.fillRect(x + 1, y + 1, w - 2, h - 2);
  context.fillStyle = error ? BADGE.errorShade : BADGE.shade;
  context.fillRect(x + 1, y + h - 2, w - 2, 1);
  context.fillStyle = BADGE.text;
  let cursor = x + 3;
  for (const char of text) {
    const glyph = GLYPHS[char] ?? GLYPHS["0"]!;
    glyph.forEach((row, gy) => {
      [...row].forEach((bit, gx) => {
        if (bit === "1") context.fillRect(cursor + gx, y + 2 + gy, 1, 1);
      });
    });
    cursor += (glyph[0]?.length ?? 3) + 1;
  }
}

// --- Composition -----------------------------------------------------------------------

type View = {
  /** The object drawn in its hover state (under the pointer, or focused). */
  hovered: HubName | null;
  /** The phone's lamp, off for a beat of its blink. */
  lampOff: boolean;
  today: Date;
};

/** The state of an object, or null when nothing is drawn (no post-its, no newspaper). */
const stateFor = (hub: Hub, scene: SceneObject): HubState | null => hub.objects[scene.name].states[scene.state] ?? null;

const interactive = (hub: Hub, scene: SceneObject): boolean => scene.object !== null && stateFor(hub, scene) !== null;

function compose(context: CanvasRenderingContext2D, assets: Assets, scene: SceneObject[], view: View, tints: Map<string, HTMLCanvasElement>) {
  const { hub, atlas, background } = assets;
  const lift = hub.hover.lift;
  const frame = (ref: { frame: number; at: [number, number] }, dy = 0) => {
    const [x, y, w, h] = hub.atlas.frames[ref.frame]!;
    context.drawImage(atlas, x, y, w, h, ref.at[0], ref.at[1] + dy, w, h);
  };
  const tinted = (mask: HubFrameRef["masks"][number], color: string) => {
    const tone = mask.mode === "pastel" ? pastel(color) : color;
    const key = `${mask.frame}|${tone}`;
    let canvas = tints.get(key);
    if (!canvas) {
      canvas = tintMask(assets, mask.frame, tone);
      tints.set(key, canvas);
    }
    context.drawImage(canvas, mask.at[0], mask.at[1]);
  };

  context.clearRect(0, 0, hub.background.w, hub.background.h);
  context.drawImage(background, 0, 0);
  for (const object of scene) {
    // The phone's lamp blinks: for a beat, the unread phone is drawn as the idle one (same placement).
    const blinked = object.name === "phone" && object.state === "unread" && view.lampOff && view.hovered !== "phone";
    const state = blinked ? hub.objects.phone.states.idle ?? null : stateFor(hub, object);
    if (!state) continue;
    const hovered = view.hovered === object.name && interactive(hub, object);
    const ref = hovered ? state.hover : state;
    frame(ref);
    for (const mask of ref.masks) tinted(mask, object.tints[mask.slot] ?? object.tints[0] ?? "#b8adb9");
    if (object.name === "calendar" && object.object) {
      const today = hub.objects.calendar.today;
      const cell = today.cells[todayCell(view.today)];
      if (cell) frame({ frame: today.frame, at: cell }, hovered ? -lift : 0);
    }
  }
  for (const object of scene) {
    const text = badgeText(object.object);
    const state = stateFor(hub, object);
    if (!text || !state || !object.object) continue;
    const box = badgeBox(assets, view.hovered === object.name ? state.hover : state, text);
    drawBadge(context, text, box.x, box.y);
  }
}

/** The interactive object whose drawn pixels are under (x, y) in art pixels, the front one when two are. */
function hitTest(assets: Assets, scene: SceneObject[], x: number, y: number): SceneObject | null {
  const { hub, pixels } = assets;
  let best: { object: SceneObject; depth: number } | null = null;
  for (const object of scene) {
    const state = stateFor(hub, object);
    if (!state || !object.object) continue;
    // The normal frame and the hover frame both count, so that the edge of a lifted object does not flicker.
    const hit = [state, state.hover].some((ref) => {
      const [fx, fy, w, h] = hub.atlas.frames[ref.frame]!;
      const lx = x - ref.at[0];
      const ly = y - ref.at[1];
      return lx >= 0 && ly >= 0 && lx < w && ly < h && alphaAt(pixels, fx + lx, fy + ly) > 0;
    });
    const depth = state.hit[1] + state.hit[3];
    if (hit && (!best || depth > best.depth)) best = { object, depth };
  }
  return best?.object ?? null;
}

// --- The component -----------------------------------------------------------------------

const objectHref = (object: DeskObject): string => `/bureau/${object.id}`;

const ariaLabel = (object: DeskObject): string =>
  object.status === "error" ? t.objectError(object.label) : t.object(object.label, object.count);

/** Space kept under the scene on a wide screen, so that what waits shows below it. */
const BELOW_SCENE_PX = 160;

/**
 * The desk as a scene (the hub), live: it follows the objects of GET /api/desk.
 * On a narrow screen, the scene is followed by a list of the modules. Should
 * the assets fail to load, the list stands in for the scene.
 */
export function DeskHub({ desk, narrow }: { desk: Desk | null; narrow: boolean }) {
  const router = useRouter();
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [assets, setAssets] = useState<Assets | null>(null);
  const [failed, setFailed] = useState(false);
  const [room, setRoom] = useState<{ width: number; height: number; ratio: number } | null>(null);
  const [pointed, setPointed] = useState<HubName | null>(null);
  const [focused, setFocused] = useState<HubName | null>(null);
  const [lampOff, setLampOff] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const buffer = useRef<HTMLCanvasElement | null>(null);
  const tints = useRef(new Map<string, HTMLCanvasElement>());

  const scene = useMemo(() => sceneObjects(desk), [desk]);
  const hovered = pointed ?? focused;

  useEffect(() => {
    let closed = false;
    loadAssets().then(
      (loaded) => !closed && setAssets(loaded),
      (error: unknown) => {
        console.error(`[hub] assets not loaded: ${error instanceof Error ? error.message : String(error)}`);
        if (!closed) setFailed(true);
      },
    );
    return () => {
      closed = true;
    };
  }, []);

  // The room the scene has: the width of its column, and the height of the window on a wide screen.
  useLayoutEffect(() => {
    const element = wrapper.current;
    if (!element) return;
    const measure = () =>
      setRoom((current) => {
        const next = { width: element.clientWidth, height: window.innerHeight, ratio: window.devicePixelRatio || 1 };
        return current && current.width === next.width && current.height === next.height && current.ratio === next.ratio ? current : next;
      });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [failed]);

  const size = assets ? { w: assets.hub.background.w, h: assets.hub.background.h } : null;
  const scale =
    size && room && room.width > 0
      ? fitScale(size, { width: room.width, height: narrow ? undefined : Math.max(size.h, room.height - BELOW_SCENE_PX) }, room.ratio)
      : null;
  /** CSS pixels per art pixel. */
  const unit = scale && room ? scale / room.ratio : null;

  // The phone's lamp blinks while it has something unread, unless motion is reduced.
  const phone = scene.find((object) => object.name === "phone");
  const blinking = !reducedMotion && phone?.object != null && phone.state === "unread" && hovered !== "phone";
  useEffect(() => {
    if (!blinking) return;
    let off = false;
    let timer: ReturnType<typeof setTimeout>;
    const step = () => {
      off = !off;
      setLampOff(off);
      timer = setTimeout(step, off ? 450 : 1600);
    };
    timer = setTimeout(step, 1600);
    return () => {
      clearTimeout(timer);
      setLampOff(false);
    };
  }, [blinking]);

  useEffect(() => {
    const target = canvas.current;
    if (!assets || !scale || !target) return;
    const { w, h } = assets.hub.background;
    buffer.current ??= document.createElement("canvas");
    const art = buffer.current;
    if (art.width !== w || art.height !== h) {
      art.width = w;
      art.height = h;
    }
    const artContext = art.getContext("2d");
    const context = target.getContext("2d");
    if (!artContext || !context) return;
    compose(artContext, assets, scene, { hovered, lampOff: blinking && lampOff, today: new Date() }, tints.current);
    if (target.width !== w * scale || target.height !== h * scale) {
      target.width = w * scale;
      target.height = h * scale;
    }
    context.imageSmoothingEnabled = false;
    context.clearRect(0, 0, target.width, target.height);
    context.drawImage(art, 0, 0, target.width, target.height);
  }, [assets, scene, hovered, blinking, lampOff, scale]);

  const objectAt = (event: { clientX: number; clientY: number; currentTarget: HTMLElement }): SceneObject | null => {
    if (!assets || !unit) return null;
    const box = event.currentTarget.getBoundingClientRect();
    const x = Math.floor((event.clientX - box.left) / unit);
    const y = Math.floor((event.clientY - box.top) / unit);
    return hitTest(assets, scene, x, y);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const next = objectAt(event)?.name ?? null;
    if (next !== pointed) setPointed(next);
  };

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    // A link reached with the keyboard navigates by itself.
    if ((event.target as HTMLElement).closest("a")) return;
    const object = objectAt(event)?.object;
    if (!object) return;
    if (event.ctrlKey || event.metaKey) window.open(objectHref(object), "_blank", "noopener");
    else router.push(objectHref(object));
  };

  const configured = desk?.objects ?? [];
  // The tab order is the order of the home's desk.
  const links = assets
    ? configured
        .map((object) => scene.find((each) => each.object?.id === object.id))
        .filter((each): each is SceneObject => each !== undefined && interactive(assets.hub, each))
    : [];
  const hidden = assets ? configured.filter((object) => !links.some((each) => each.object?.id === object.id)) : [];
  const tip = hovered && assets ? scene.find((each) => each.name === hovered && interactive(assets.hub, each)) : undefined;
  const tipState = tip && assets ? stateFor(assets.hub, tip) : null;
  const tipAt = tip && tipState && assets ? tipSpot(assets, tip, tipState) : null;

  const cards = (failed || narrow) && configured.length > 0 && <ModuleCards objects={configured} />;

  if (failed) return cards || null;

  return (
    <div className="space-y-3">
      <div ref={wrapper} className="flex w-full justify-center">
        {assets && size && unit && (
          <div
            className="relative touch-manipulation select-none"
            style={{ width: size.w * unit, height: size.h * unit, cursor: pointed ? "pointer" : undefined }}
            onPointerMove={onPointerMove}
            onPointerLeave={() => setPointed(null)}
            onClick={onClick}
          >
            <canvas
              ref={canvas}
              aria-hidden
              className="block size-full"
              style={{ imageRendering: "pixelated" }}
            />
            <nav aria-label={t.sceneLabel}>
              <ul>
                {links.map((each) => {
                  const object = each.object!;
                  const [x, y, w, h] = stateFor(assets.hub, each)!.hit;
                  return (
                    <li key={object.id}>
                      <Link
                        href={objectHref(object)}
                        aria-label={ariaLabel(object)}
                        className="pointer-events-none absolute outline-none"
                        style={{ left: x * unit, top: y * unit, width: w * unit, height: h * unit }}
                        onFocus={() => setFocused(each.name)}
                        onBlur={() => setFocused((current) => (current === each.name ? null : current))}
                      />
                    </li>
                  );
                })}
              </ul>
            </nav>
            {tip?.object && tipAt && (
              <div
                aria-hidden
                className="pointer-events-none absolute z-10 whitespace-nowrap border-2 border-[#1b1424] bg-[#fffaf0] px-2 py-0.5 font-mono font-bold leading-snug text-[#1b1424] shadow-[2px_2px_0_#1b1424]"
                style={{
                  left: tipAt.x * unit,
                  top: tipAt.y * unit,
                  fontSize: Math.min(16, Math.max(12, Math.round(4 * unit))),
                  transform: "translate(-50%, -100%)",
                }}
              >
                {tip.object.label}
              </div>
            )}
          </div>
        )}
      </div>
      {!narrow && hidden.length > 0 && (
        <p className="text-center text-sm text-muted">
          {t.more}{" "}
          {hidden.map((object, index) => (
            <span key={object.id}>
              {index > 0 && ", "}
              <Link
                href={objectHref(object)}
                aria-label={ariaLabel(object)}
                className="underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                {object.label}
              </Link>
            </span>
          ))}
        </p>
      )}
      {cards}
    </div>
  );
}

/** The modules of the desk as cards (label, count, link): under the scene on a phone, or instead of it. */
function ModuleCards({ objects }: { objects: DeskObject[] }) {
  return (
    <nav aria-label={t.cardsLabel}>
      <ul className="grid grid-cols-2 gap-2">
        {objects.map((object) => (
          <li key={object.id} className="min-w-0">
            <Link
              href={objectHref(object)}
              aria-label={ariaLabel(object)}
              className="flex min-h-12 items-center justify-between gap-2 rounded-lg border border-line bg-card px-3 py-2 text-sm hover:bg-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <span className="min-w-0 truncate font-medium">{object.label}</span>
              {object.status === "error" ? (
                <span className="shrink-0 text-xs text-danger">{t.cardError}</span>
              ) : object.count > 0 ? (
                <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-xs font-semibold text-accent">{object.count}</span>
              ) : (
                <span className="shrink-0 text-xs text-muted">{t.cardEmpty}</span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
