"use client";

import { useEffect, useRef } from "react";
import { SPRITE_SIZE } from "./room-layout";
import { snapshotRoom, type AgentView, type RoomView } from "./room-model";
import type { RoomRenderer, RoomScene } from "./room-renderer";
import type { RoomStore } from "./room-store";
import { createLabelLayer } from "./room-labels";
import { readRoomTheme } from "./room-theme";

export type RoomCanvasProps = {
  store: RoomStore;
  room: string;
  board: RoomScene["board"];
  labels: RoomScene["labels"];
  /** Character sheet URL per agent key (null: the neutral character). */
  sprites: Record<string, string | null>;
  /** Colour of the room (a normalized hex), worn by the name plates; null for the neutral look. */
  color: string | null;
  selected: string | null;
  reduced: boolean;
  onSelect: (key: string) => void;
  onFailure: () => void;
};

/** The neutral sheet shipped in public/. */
const NEUTRAL_SHEET = "/sprites/neutral.png";

/** The character under a point of the room, in world units. */
function agentAt(view: RoomView, x: number, y: number): AgentView | null {
  let found: AgentView | null = null;
  for (const agent of view.agents) {
    if (Math.abs(x - agent.x) > 14 || y < agent.y - SPRITE_SIZE - 2 || y > agent.y + 6) continue;
    if (!found || agent.y > found.y) found = agent;
  }
  return found;
}

/**
 * The room, drawn on a canvas by PixiJS (loaded here, on the client, when the
 * component mounts). It decorates the page: the canvas is hidden from
 * assistive technology, and the list of agents under it says everything it
 * shows. The loop draws only while the tab is visible and the room is on
 * screen; with reduced motion it draws when something changes.
 */
export function RoomCanvas(props: RoomCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  const kickRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    latest.current = props;
    kickRef.current();
  });

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
    let sizedFor = { width: 0, height: 0, world: "" };

    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.display = "block";
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
      const props = latest.current;
      const now = Date.now();
      const view = snapshotRoom(props.store.get(props.room), now, props.reduced);
      lastView = view;

      const { clientWidth: width, clientHeight: height } = host;
      const world = `${view.layout.width}x${view.layout.height}`;
      if (width > 0 && height > 0 && (width !== sizedFor.width || height !== sizedFor.height || world !== sizedFor.world)) {
        sizedFor = { width, height, world };
        renderer.resize(width, height, view.layout);
      }
      renderer.setSprites(props.sprites);
      renderer.draw(
        { view, board: props.board, labels: props.labels, color: props.color, selected: props.selected, reduced: props.reduced },
        now,
      );
      canvas.dataset.frames = String(renderer.frames);

      const fps = renderer.busy(now, props.reduced) ? 60 : view.fps;
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
      sizedFor = { width: 0, height: 0, world: "" };
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

    const pointerWorld = (event: PointerEvent | MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      return renderer?.toWorld(event.clientX - rect.left, event.clientY - rect.top) ?? { x: -1, y: -1 };
    };
    const onMove = (event: PointerEvent) => {
      const point = pointerWorld(event);
      canvas.style.cursor = lastView && agentAt(lastView, point.x, point.y) ? "pointer" : "default";
    };
    const onClick = (event: MouseEvent) => {
      const point = pointerWorld(event);
      const hit = lastView ? agentAt(lastView, point.x, point.y) : null;
      if (hit) latest.current.onSelect(hit.key);
    };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("click", onClick);

    void (async () => {
      try {
        const { createRoomRenderer } = await import("./room-renderer");
        const created = await createRoomRenderer({
          canvas,
          neutralSheetUrl: NEUTRAL_SHEET,
          labels: labelLayer,
          theme: readRoomTheme(host),
        });
        if (cancelled) {
          created.destroy();
          return;
        }
        renderer = created;
        kick();
      } catch {
        if (!cancelled) latest.current.onFailure();
      }
    })();

    return () => {
      cancelled = true;
      stop();
      kickRef.current = () => undefined;
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisibility);
      observer.disconnect();
      resizer.disconnect();
      colorScheme.removeEventListener("change", onScheme);
      densityQuery?.removeEventListener("change", onDensity);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("click", onClick);
      renderer?.destroy();
      renderer = null;
      labelLayer.destroy();
      canvas.remove();
    };
  }, []);

  return (
    <div ref={hostRef} className="room-canvas" aria-hidden="true">
      <div ref={labelsRef} className="room-labels" />
    </div>
  );
}
