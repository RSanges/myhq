"use client";

import { useEffect, useRef, useState } from "react";
import { snapshotRoom, type RoomView } from "./room-model";
import type { BoardRow } from "./room-board";
import type { RoomRenderer, RoomScene } from "./room-renderer";
import type { RoomStore } from "./room-store";
import { createLabelLayer } from "./room-labels";
import { readRoomTheme } from "./room-theme";
import { strings } from "./strings";

const t = strings.roomView;

export type RoomCanvasProps = {
  store: RoomStore;
  room: string;
  board: { title: string; rows: BoardRow[] };
  labels: RoomScene["labels"];
  /** Character sheet URL per agent key (an iso sheet; a neutral person when it fails to load). */
  sprites: Record<string, string>;
  /** Voxels per walk frame declared by an agent's own sheet; a key without one walks at the default. */
  strides: Record<string, number>;
  /** Colour of the room (a normalized hex) for carpets, tiles and name tags; null for the neutral look. */
  color: string | null;
  selected: string | null;
  reduced: boolean;
  onSelect: (key: string) => void;
  onFailure: () => void;
};

/** Where floor.json and floor.png are served (public/iso/floor). */
const FLOOR_URL = "/iso/floor";
/** A pointer that moves less than this (CSS pixels) between down and up is a click, not a drag. */
const DRAG_SLOP = 5;

/**
 * The whiteboard of the floor: the figures of the day, each one flashing when
 * it changes. Decorative like the canvas (the narrow band and the strip under
 * the floor say the same to a screen reader).
 */
function BoardCard({ title, rows }: { title: string; rows: BoardRow[] }) {
  // The figures as they were first shown: one that differs has changed since, and flashes when it does.
  const [initial] = useState(() => new Map(rows.map((row) => [row.key, row.value])));
  return (
    <div className="room-board" aria-hidden="true">
      <p className="room-board-title">{title}</p>
      <dl>
        {rows.map((row) => (
          <div key={row.key}>
            <dt>{row.label}</dt>
            <dd key={row.value} data-flash={initial.get(row.key) === row.value ? undefined : ""}>
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * The room, drawn on a canvas by PixiJS (loaded here, on the client, when the
 * component mounts). It decorates the page: the canvas is hidden from
 * assistive technology, and the list of agents under it says everything it
 * shows. The floor pans with a drag (or the wheel), zooms with the buttons, a
 * pinch or ctrl and the wheel, by whole steps so the pixel art stays sharp.
 * The loop draws only while the tab is visible and the room is on screen;
 * with reduced motion it draws when something changes.
 */
export function RoomCanvas(props: RoomCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<RoomRenderer | null>(null);
  const latest = useRef(props);
  const kickRef = useRef<() => void>(() => undefined);
  const [zoomable, setZoomable] = useState({ in: false, out: false });

  useEffect(() => {
    latest.current = props;
    kickRef.current();
  });

  const refreshZoom = () => {
    const renderer = rendererRef.current;
    setZoomable({ in: renderer?.canZoom(1) ?? false, out: renderer?.canZoom(-1) ?? false });
  };

  useEffect(() => {
    const host = hostRef.current;
    const labelHost = labelsRef.current;
    if (!host || !labelHost) return;
    const labelLayer = createLabelLayer(labelHost);
    let cancelled = false;
    let renderer: RoomRenderer | null = null;
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let visible = document.visibilityState === "visible";
    let onScreen = true;
    let lastView: RoomView | null = null;
    let sizedFor = { width: 0, height: 0 };

    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.display = "block";
    canvas.style.touchAction = "none";
    host.insertBefore(canvas, labelHost);

    const stop = () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      raf = 0;
      timer = undefined;
    };

    const frame = () => {
      raf = 0;
      if (!renderer || cancelled || !visible || !onScreen) return;
      const current = latest.current;
      const now = Date.now();
      const view = snapshotRoom(current.store.get(current.room), now, current.reduced);
      lastView = view;

      const { clientWidth: width, clientHeight: height } = host;
      if (width > 0 && height > 0 && (width !== sizedFor.width || height !== sizedFor.height)) {
        sizedFor = { width, height };
        renderer.resize(width, height);
        refreshZoom();
      }
      renderer.setSprites(current.sprites, current.strides);
      renderer.draw(
        { view, labels: current.labels, color: current.color, selected: current.selected, reduced: current.reduced },
        now,
      );
      canvas.dataset.frames = String(renderer.frames);

      const fps = renderer.busy(now, current.reduced) ? 60 : view.fps;
      if (fps > 0) schedule(fps >= 30 ? 0 : 1000 / fps);
      else if (Number.isFinite(view.nextChangeAt)) timer = setTimeout(kick, Math.max(0, view.nextChangeAt - now) + 5);
    };

    function schedule(delayMs: number) {
      if (delayMs <= 0) raf = requestAnimationFrame(frame);
      else
        timer = setTimeout(() => {
          timer = undefined;
          raf = requestAnimationFrame(frame);
        }, delayMs);
    }

    function kick() {
      if (!renderer || cancelled) return;
      stop();
      if (visible && onScreen) raf = requestAnimationFrame(frame);
    }
    kickRef.current = kick;

    const unsubscribe = latest.current.store.subscribe(kick);

    const onVisibility = () => {
      visible = document.visibilityState === "visible";
      if (visible) kick();
      else stop();
    };
    document.addEventListener("visibilitychange", onVisibility);

    const observer = new IntersectionObserver((entries) => {
      onScreen = entries.some((entry) => entry.isIntersecting);
      if (onScreen) kick();
      else stop();
    });
    observer.observe(host);

    const resizer = new ResizeObserver(() => {
      sizedFor = { width: 0, height: 0 };
      kick();
    });
    resizer.observe(host);

    // Zoom, or a move to another screen, changes the device pixel ratio: draw at the new density.
    let densityQuery: MediaQueryList | null = null;
    const watchDensity = () => {
      densityQuery?.removeEventListener("change", onDensity);
      densityQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      densityQuery.addEventListener("change", onDensity, { once: true });
    };
    function onDensity() {
      renderer?.setResolution(window.devicePixelRatio || 1);
      refreshZoom();
      watchDensity();
      kick();
    }
    watchDensity();

    const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => {
      renderer?.setTheme(readRoomTheme(host));
      kick();
    };
    colorScheme.addEventListener("change", onScheme);

    // Pointers: a drag pans, two fingers pinch to zoom, a click without a drag picks a character.
    const pointers = new Map<number, { x: number; y: number }>();
    let start = { x: 0, y: 0 };
    let dragged = false;
    let pinch = 0;
    const local = (event: PointerEvent | WheelEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const spread = () => {
      const [a, b] = [...pointers.values()];
      return a && b ? { distance: Math.hypot(a.x - b.x, a.y - b.y), middle: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } } : null;
    };
    const onDown = (event: PointerEvent) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        // A pointer that is already gone: the drag still works while it stays over the canvas.
      }
      pointers.set(event.pointerId, local(event));
      if (pointers.size === 1) {
        start = local(event);
        dragged = false;
      } else {
        dragged = true;
        pinch = spread()?.distance ?? 0;
      }
    };
    const onMove = (event: PointerEvent) => {
      const point = local(event);
      const before = pointers.get(event.pointerId);
      if (!before) {
        canvas.style.cursor = lastView && renderer?.agentAt(lastView, point.x, point.y) ? "pointer" : "grab";
        return;
      }
      pointers.set(event.pointerId, point);
      if (!renderer) return;
      if (pointers.size === 1) {
        if (!dragged && Math.hypot(point.x - start.x, point.y - start.y) > DRAG_SLOP) dragged = true;
        if (dragged) {
          canvas.style.cursor = "grabbing";
          renderer.panBy(point.x - before.x, point.y - before.y);
          kick();
        }
        return;
      }
      const now = spread();
      if (!now || pinch <= 0) return;
      const ratio = now.distance / pinch;
      if (ratio > 1.4 || ratio < 0.7) {
        renderer.zoomBy(ratio > 1 ? 1 : -1, now.middle);
        pinch = now.distance;
        refreshZoom();
        kick();
      }
    };
    const onUp = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId)) return;
      pointers.delete(event.pointerId);
      if (pointers.size > 0) return;
      canvas.style.cursor = "grab";
      if (dragged || event.type === "pointercancel") return;
      const point = local(event);
      const hit = lastView && renderer ? renderer.agentAt(lastView, point.x, point.y) : null;
      if (hit) latest.current.onSelect(hit.key);
    };
    const onWheel = (event: WheelEvent) => {
      if (!renderer) return;
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        if (Math.abs(event.deltaY) < 1) return;
        renderer.zoomBy(event.deltaY < 0 ? 1 : -1, local(event));
        refreshZoom();
      } else {
        renderer.panBy(-event.deltaX, -event.deltaY);
      }
      kick();
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });

    void (async () => {
      try {
        const { createRoomRenderer } = await import("./room-renderer");
        const created = await createRoomRenderer({ canvas, floorUrl: FLOOR_URL, labels: labelLayer, theme: readRoomTheme(host), onLoad: () => kick() });
        if (cancelled) {
          created.destroy();
          return;
        }
        renderer = created;
        rendererRef.current = created;
        kick();
      } catch {
        if (!cancelled) latest.current.onFailure();
      }
    })();

    return () => {
      cancelled = true;
      stop();
      kickRef.current = () => undefined;
      rendererRef.current = null;
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisibility);
      observer.disconnect();
      resizer.disconnect();
      colorScheme.removeEventListener("change", onScheme);
      densityQuery?.removeEventListener("change", onDensity);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("wheel", onWheel);
      renderer?.destroy();
      renderer = null;
      labelLayer.destroy();
      canvas.remove();
    };
  }, []);

  const zoom = (step: number) => {
    rendererRef.current?.zoomBy(step);
    refreshZoom();
    kickRef.current();
  };
  const fit = () => {
    rendererRef.current?.fit();
    refreshZoom();
    kickRef.current();
  };

  return (
    <div className="room-canvas-frame">
      <div ref={hostRef} className="room-canvas" aria-hidden="true">
        <div ref={labelsRef} className="room-labels" />
      </div>
      <BoardCard title={props.board.title} rows={props.board.rows} />
      <div className="room-zoom" role="group" aria-label={t.zoomLabel}>
        <button type="button" onClick={() => zoom(1)} disabled={!zoomable.in} aria-label={t.zoomIn} title={t.zoomIn}>
          <svg viewBox="0 0 20 20" aria-hidden focusable="false">
            <path d="M10 4v12M4 10h12" />
          </svg>
        </button>
        <button type="button" onClick={() => zoom(-1)} disabled={!zoomable.out} aria-label={t.zoomOut} title={t.zoomOut}>
          <svg viewBox="0 0 20 20" aria-hidden focusable="false">
            <path d="M4 10h12" />
          </svg>
        </button>
        <button type="button" onClick={fit} aria-label={t.fit} title={t.fit}>
          <svg viewBox="0 0 20 20" aria-hidden focusable="false">
            <path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4" />
          </svg>
        </button>
      </div>
    </div>
  );
}
