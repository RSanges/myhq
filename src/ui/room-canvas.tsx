"use client";

import { useEffect, useRef } from "react";
import { WORLD_W } from "./room-layout";
import { snapshotRoom, type AgentView, type RoomView } from "./room-model";
import type { RoomRenderer, RoomScene } from "./room-renderer";
import type { RoomStore } from "./room-store";
import { readRoomFonts, readRoomTheme } from "./room-theme";

export type RoomCanvasProps = {
  store: RoomStore;
  room: string;
  board: RoomScene["board"];
  labels: RoomScene["labels"];
  /** Character sheet URL per agent key (null: the neutral character). */
  sprites: Record<string, string | null>;
  selected: string | null;
  reduced: boolean;
  onSelect: (key: string) => void;
  onFailure: () => void;
};

/** The neutral sheet shipped in public/. */
const NEUTRAL_SHEET = "/sprites/neutral.png";
const FONT_WAIT_MS = 1_500;

/** The character under a point of the room, in world units. */
function agentAt(view: RoomView, x: number, y: number): AgentView | null {
  let found: AgentView | null = null;
  for (const agent of view.agents) {
    if (Math.abs(x - agent.x) > 24 || y < agent.y - 66 || y > agent.y + 8) continue;
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
  const latest = useRef(props);
  const kickRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    latest.current = props;
    kickRef.current();
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let renderer: RoomRenderer | null = null;
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let visible = document.visibilityState === "visible";
    let onScreen = true;
    let lastView: RoomView | null = null;
    let sizedFor = { width: 0, world: 0 };

    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.display = "block";
    canvas.style.width = "100%";
    host.appendChild(canvas);

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

      const width = host.clientWidth;
      if (width > 0 && (width !== sizedFor.width || view.layout.height !== sizedFor.world)) {
        sizedFor = { width, world: view.layout.height };
        host.style.height = `${renderer.resize(width, view.layout.height)}px`;
      }
      renderer.setSprites(props.sprites);
      renderer.draw(
        { view, board: props.board, labels: props.labels, selected: props.selected, reduced: props.reduced },
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
      sizedFor = { width: 0, world: 0 };
      kick();
    });
    resizer.observe(host);

    const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => {
      renderer?.setTheme(readRoomTheme(host));
      kick();
    };
    colorScheme.addEventListener("change", onScheme);

    const pointerWorld = (event: PointerEvent | MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const factor = WORLD_W / rect.width;
      return { x: (event.clientX - rect.left) * factor, y: (event.clientY - rect.top) * factor };
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
        const fonts = readRoomFonts(host);
        await Promise.race([
          Promise.all([document.fonts.load(`600 12px ${fonts.body}`), document.fonts.load(`700 12px ${fonts.display}`)]),
          new Promise((resolve) => setTimeout(resolve, FONT_WAIT_MS)),
        ]).catch(() => undefined);
        const { createRoomRenderer } = await import("./room-renderer");
        const created = await createRoomRenderer({
          canvas,
          neutralSheetUrl: NEUTRAL_SHEET,
          bodyFont: fonts.body,
          displayFont: fonts.display,
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
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("click", onClick);
      renderer?.destroy();
      renderer = null;
      canvas.remove();
      host.style.height = "";
    };
  }, []);

  return <div ref={hostRef} className="room-canvas" aria-hidden="true" />;
}
