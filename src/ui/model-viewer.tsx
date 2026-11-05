"use client";

// The 3D viewer of a part joined to an item (3MF, STL, GLB). attachments.tsx
// loads it on demand (next/dynamic, client only), so three.js stays out of
// every other page. The part sits on a grid, at its overall dimensions, lit
// from the camera; it turns, zooms and moves with the mouse or the fingers
// (OrbitControls), and the scene is drawn only when something changed. In
// « Annoter un point » mode a click or a tap on the part is cast into it, and
// the point hit is handed back in the part's frame (see model-load.ts) with
// the normal of the face. The pins of the remarks are HTML buttons placed over
// the canvas at each frame, dimmed when the part hides them.

import { useEffect, useRef, useState } from "react";
import {
  Box3,
  Color,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  GridHelper,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  MeshStandardMaterial,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Sphere,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Material,
  type Mesh,
  type Object3D,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { ModelPoint } from "@/server/annotations";
import { dimensionsText, formatMm, MODEL_FRAME_CLASS, roundPoint, type ModelFormat } from "./attachments-model";
import { loadModel, pointInPart } from "./model-load";
import { strings } from "./strings";
import { buttonClass } from "./ui";

/** A pin over the part: a remark of the item (numbered as in the list of remarks) or the one being written. */
export type Pin = { key: string; number: number; point: ModelPoint; label: string; active: boolean; draft: boolean };

type View = "front" | "top" | "side" | "iso";

/** Where the camera stands, seen from the centre of the part (Z up; the front is seen from -Y). */
const VIEWS: Record<View, readonly [number, number, number]> = {
  front: [0, -1, 0],
  top: [0, -1e-4, 1],
  side: [1, 0, 0],
  iso: [1, -1, 1],
};
const INITIAL_VIEW: View = "iso";
/** Above this many triangles the edges are not drawn (EdgesGeometry is slow on big meshes). */
const MAX_EDGED_TRIANGLES = 400_000;
/** A press that moves more than this, in pixels, turned the part: it places no pin. */
const TAP_SLOP = 6;

type SceneHandle = { view: (view: View | "reset") => void; refresh: () => void };

/** The step of the grid: a power of ten, at most half of the part's largest side. */
function gridStep(largest: number): number {
  return 10 ** Math.floor(Math.log10(Math.max(largest, 0.01) / 2));
}

function cssColor(element: Element, name: string, fallback: string): Color {
  const value = getComputedStyle(element).getPropertyValue(name).trim();
  return new Color(/^#[0-9a-f]{3,6}$/i.test(value) ? value : fallback);
}

function disposeTree(root: Object3D) {
  root.traverse((object) => {
    const item = object as Partial<Mesh>;
    item.geometry?.dispose();
    const materials: Material[] = Array.isArray(item.material) ? item.material : item.material ? [item.material] : [];
    for (const material of materials) material.dispose();
  });
}

export default function ModelViewer({
  url,
  name,
  fileId,
  format,
  poster,
  pins,
  picking,
  onPick,
  onPin,
}: {
  url: string;
  name: string;
  fileId: number;
  format: ModelFormat;
  /** The image the agent joined of the part, shown while it loads or when it cannot be drawn. */
  poster: string | null;
  pins: readonly Pin[];
  picking: boolean;
  onPick: (point: ModelPoint) => void;
  onPin: (key: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SceneHandle | null>(null);
  const pinsRef = useRef(pins);
  const pickingRef = useRef(picking);
  const onPickRef = useRef(onPick);
  const pinElements = useRef(new Map<string, HTMLElement>());
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [size, setSize] = useState<{ x: number; y: number; z: number; step: number } | null>(null);

  // The pins are drawn once the part is shown, then whenever they change.
  useEffect(() => {
    pinsRef.current = pins;
    sceneRef.current?.refresh();
  }, [pins, status]);
  useEffect(() => {
    pickingRef.current = picking;
    const canvas = hostRef.current?.querySelector("canvas");
    if (canvas) canvas.style.cursor = picking ? "crosshair" : "grab";
  }, [picking]);
  useEffect(() => {
    onPickRef.current = onPick;
  }, [onPick]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      // No WebGL (an old phone, a locked-down browser): the download stays.
      queueMicrotask(() => setStatus("error"));
      return;
    }
    let disposed = false;
    const abort = new AbortController();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    const canvas = renderer.domElement;
    canvas.className = "absolute inset-0 block size-full touch-none";
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.cursor = pickingRef.current ? "crosshair" : "grab";
    host.prepend(canvas);

    const scene = new Scene();
    const camera = new PerspectiveCamera(35, 1, 0.1, 1000);
    camera.up.set(0, 0, 1);
    scene.add(camera);
    const sky = new HemisphereLight(0xffffff, 0xb4afa8, 1.9);
    sky.position.set(0, 0, 1);
    scene.add(sky);
    // A headlight: the face seen is always lit, slightly from the upper left.
    const head = new DirectionalLight(0xffffff, 1.3);
    head.position.set(-0.5, 0.8, 0);
    head.target.position.set(0, 0, -1);
    camera.add(head, head.target);

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.14;
    controls.zoomToCursor = true;
    const raycaster = new Raycaster();
    const meshes: Mesh[] = [];
    const occluded = new Set<string>();
    let part: Group | null = null;
    let home = { target: new Vector3(), distance: 1 };
    let frame = 0;
    let flight: { from: Vector3; to: Vector3; fromTarget: Vector3; toTarget: Vector3; start: number } | null = null;

    const placePins = () => {
      if (!part) return;
      const width = host.clientWidth;
      const height = host.clientHeight;
      for (const pin of pinsRef.current) {
        const element = pinElements.current.get(pin.key);
        if (!element) continue;
        const at = part.localToWorld(new Vector3(pin.point.x, pin.point.y, pin.point.z)).project(camera);
        const inView = at.z > -1 && at.z < 1 && Math.abs(at.x) <= 1.02 && Math.abs(at.y) <= 1.02;
        element.style.transform = `translate(${((at.x + 1) / 2) * width}px, ${((1 - at.y) / 2) * height}px)`;
        element.style.visibility = inView ? "visible" : "hidden";
        element.dataset.behind = occluded.has(pin.key) ? "true" : "false";
      }
    };

    /** Which pins the part hides from the camera: a ray towards each that hits the part first. */
    const updateOcclusion = () => {
      occluded.clear();
      if (!part) return;
      const margin = home.distance * 0.002;
      for (const pin of pinsRef.current) {
        const at = part.localToWorld(new Vector3(pin.point.x, pin.point.y, pin.point.z));
        const towards = at.clone().sub(camera.position);
        const distance = towards.length();
        raycaster.set(camera.position, towards.normalize());
        raycaster.far = Math.max(0, distance - margin);
        if (raycaster.intersectObjects(meshes, false).length > 0) occluded.add(pin.key);
      }
      raycaster.far = Infinity;
    };

    const request = () => {
      if (!frame && !disposed) frame = requestAnimationFrame(draw);
    };
    function draw() {
      frame = 0;
      if (flight) {
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const t = reduce ? 1 : Math.min(1, (performance.now() - flight.start) / 380);
        const ease = 1 - (1 - t) ** 3;
        camera.position.lerpVectors(flight.from, flight.to, ease);
        controls.target.lerpVectors(flight.fromTarget, flight.toTarget, ease);
        if (t >= 1) {
          flight = null;
          updateOcclusion();
        } else {
          request();
        }
      }
      controls.update();
      renderer.render(scene, camera);
      placePins();
    }

    const fly = (direction: readonly [number, number, number], distance: number, target: Vector3) => {
      const to = new Vector3(...direction).normalize().multiplyScalar(distance).add(target);
      flight = { from: camera.position.clone(), to, fromTarget: controls.target.clone(), toTarget: target.clone(), start: performance.now() };
      request();
    };

    sceneRef.current = {
      view: (view) => {
        if (!part) return;
        if (view === "reset") return fly(VIEWS[INITIAL_VIEW], home.distance, home.target);
        // A quick view keeps the zoom of the moment, around the centre of the part.
        fly(VIEWS[view], camera.position.distanceTo(controls.target), home.target);
      },
      refresh: () => {
        updateOcclusion();
        request();
      },
    };

    const resize = () => {
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      request();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();
    controls.addEventListener("change", request);
    controls.addEventListener("start", () => {
      flight = null;
    });
    controls.addEventListener("end", () => {
      updateOcclusion();
      request();
    });

    let press: { x: number; y: number; id: number } | null = null;
    const onPointerDown = (event: PointerEvent) => {
      press = { x: event.clientX, y: event.clientY, id: event.pointerId };
    };
    const onPointerUp = (event: PointerEvent) => {
      const tap = press !== null && press.id === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) <= TAP_SLOP;
      press = null;
      if (!tap || !pickingRef.current || !part) return;
      const rect = canvas.getBoundingClientRect();
      const pointer = new Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(meshes, false)[0];
      if (!hit?.face) return;
      const worldNormal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      const { point, normal } = pointInPart(part, hit.point, worldNormal, raycaster.ray.direction);
      onPickRef.current(roundPoint(fileId, point, normal));
    };
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointerup", onPointerUp);

    const show = (loaded: Group) => {
      part = loaded;
      const material = new MeshStandardMaterial({
        color: 0xc9ccd1,
        roughness: 0.6,
        metalness: 0.05,
        flatShading: true,
        side: DoubleSide,
        // The edges are drawn on the faces without flickering.
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
      const edgeMaterial = new LineBasicMaterial({ color: 0x1c1917, transparent: true, opacity: 0.4 });
      let triangles = 0;
      loaded.traverse((object) => {
        if (!(object as Mesh).isMesh) return;
        const mesh = object as Mesh;
        const old: Material[] = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const item of old) item.dispose();
        mesh.material = material;
        meshes.push(mesh);
        triangles += (mesh.geometry.index?.count ?? mesh.geometry.attributes.position?.count ?? 0) / 3;
      });
      if (triangles <= MAX_EDGED_TRIANGLES) {
        for (const mesh of meshes) mesh.add(new LineSegments(new EdgesGeometry(mesh.geometry, 40), edgeMaterial));
      }

      // On the grid: centred in X and Y, its lowest point on the plane.
      const box = new Box3().setFromObject(loaded, true);
      const dims = box.getSize(new Vector3());
      const center = box.getCenter(new Vector3());
      const placement = new Group();
      placement.position.set(-center.x, -center.y, -box.min.z);
      placement.add(loaded);
      scene.add(placement);
      placement.updateMatrixWorld(true);

      const step = gridStep(Math.max(dims.x, dims.y, dims.z * 0.5));
      const cells = Math.min(400, 2 * Math.ceil((Math.max(dims.x, dims.y, step) * 0.85) / step));
      const line = cssColor(host, "--line", "#d6d3d1");
      const axes = new Color().lerpColors(line, cssColor(host, "--muted", "#57534e"), 0.45);
      const grid = new GridHelper(cells * step, cells, axes, line);
      grid.material.transparent = true;
      grid.material.opacity = 0.75;
      grid.rotation.x = Math.PI / 2;
      grid.position.z = -Math.max(dims.x, dims.y, dims.z) * 1e-3;
      scene.add(grid);

      const placed = box.clone().translate(placement.position);
      const radius = Math.max(placed.getBoundingSphere(new Sphere()).radius, 0.01);
      const distance = (radius / Math.sin(((camera.fov / 2) * Math.PI) / 180)) * 0.95;
      home = { target: placed.getCenter(new Vector3()), distance };
      camera.near = distance / 200;
      camera.far = distance * 50;
      camera.updateProjectionMatrix();
      controls.minDistance = radius * 0.3;
      controls.maxDistance = distance * 8;
      controls.target.copy(home.target);
      camera.position.copy(new Vector3(...VIEWS[INITIAL_VIEW]).normalize().multiplyScalar(distance).add(home.target));
      controls.update();
      updateOcclusion();
      setSize({ x: dims.x, y: dims.y, z: dims.z, step });
      setStatus("ready");
      request();
    };

    fetch(url, { signal: abort.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.arrayBuffer();
      })
      .then((data) => loadModel(format, data))
      .then((loaded) => {
        if (disposed) return disposeTree(loaded);
        show(loaded);
      })
      .catch(() => {
        if (!disposed) setStatus("error");
      });

    return () => {
      disposed = true;
      abort.abort();
      cancelAnimationFrame(frame);
      observer.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", onPointerUp);
      controls.dispose();
      disposeTree(scene);
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
      sceneRef.current = null;
    };
  }, [url, format, fileId]);

  const dimensions = size ? dimensionsText(size) : null;
  const viewButton = `${buttonClass()} min-h-9 px-2.5 py-1 text-xs pointer-coarse:min-h-11`;

  return (
    <div className="space-y-2">
      <div
        ref={hostRef}
        role="group"
        aria-label={strings.attachments.viewer(name, dimensions ?? "")}
        className={`${MODEL_FRAME_CLASS} select-none`}
      >
        {status !== "ready" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted">
            {poster && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={poster} alt="" className="max-h-[70%] max-w-full rounded object-contain opacity-80" />
            )}
            <p>{status === "loading" ? strings.attachments.loading3d : strings.attachments.error3d}</p>
          </div>
        )}
        {status === "ready" && dimensions && size && (
          <p
            className="pointer-events-none absolute left-2 top-2 max-w-[calc(100%-4rem)] rounded bg-card/90 px-2 py-1 text-xs tabular-nums shadow-sm"
            title={strings.attachments.dimensionsLabel}
          >
            <span className="sr-only">{strings.attachments.dimensionsLabel} : </span>
            <span className="font-semibold">{dimensions}</span>
            <span className="text-muted">, {strings.attachments.grid(formatMm(size.step).replace(/,0$/, ""))}</span>
          </p>
        )}
        {status === "ready" && (
          <button
            type="button"
            onClick={() => sceneRef.current?.view("reset")}
            aria-label={strings.attachments.resetView}
            title={strings.attachments.resetView}
            className="absolute right-2 top-2 flex size-9 items-center justify-center rounded-md border border-line bg-card/90 text-lg leading-none shadow-sm hover:bg-card focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent pointer-coarse:size-11"
          >
            <span aria-hidden="true">⟲</span>
          </button>
        )}
        {status === "ready" && picking && (
          <p className="pointer-events-none absolute inset-x-2 bottom-2 rounded bg-accent px-2 py-1 text-center text-xs font-medium text-accent-fg shadow-sm">
            {strings.attachments.pickHint}
          </p>
        )}
        {status === "ready" &&
          pins.map((pin) => (
            <div
              key={pin.key}
              ref={(element) => {
                if (element) pinElements.current.set(pin.key, element);
                else pinElements.current.delete(pin.key);
              }}
              className="invisible absolute left-0 top-0 data-[behind=true]:opacity-50"
            >
              <span
                className={`absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card ${pin.draft ? "bg-accent" : "bg-warn"}`}
              />
              <span className={`absolute bottom-0 h-3 w-0.5 -translate-x-1/2 ${pin.draft ? "bg-accent" : "bg-warn"}`} />
              <button
                type="button"
                aria-label={pin.label}
                title={pin.label}
                onClick={() => onPin(pin.key)}
                className={`absolute bottom-3 flex size-7 -translate-x-1/2 items-center justify-center rounded-full border-2 border-card text-xs font-bold shadow-md focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
                  pin.draft ? "bg-accent text-accent-fg" : "bg-warn text-card"
                } ${pin.active ? "ring-2 ring-accent ring-offset-1" : ""}`}
              >
                {pin.number}
              </button>
            </div>
          ))}
      </div>
      {status === "ready" && (
        <div className="grid grid-cols-4 gap-1.5 sm:flex sm:flex-wrap" role="toolbar" aria-label={strings.attachments.viewsLabel}>
          {(Object.keys(VIEWS) as View[]).map((view) => (
            <button key={view} type="button" className={viewButton} onClick={() => sceneRef.current?.view(view)}>
              {strings.attachments.views[view]}
            </button>
          ))}
        </div>
      )}
      {status === "ready" && <p className="text-xs text-muted">{strings.attachments.viewerHelp}</p>}
    </div>
  );
}
