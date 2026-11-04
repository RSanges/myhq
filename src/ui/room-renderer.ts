import { Application, Container, Graphics, Rectangle, Sprite, Texture } from "pixi.js";
import {
  buildFloorScene,
  characterBox,
  depthOrder,
  floorSetSchema,
  NEUTRAL_ROOM_COLOR,
  neutralPersonFor,
  pastel,
  SHEET,
  sheetRow,
  turnOf,
  type Box,
  type Draw,
  type FloorSet,
} from "./iso-floor";
import type { LabelLayer } from "./room-labels";
import { CELL, screenOf, type Point, type RoomLayout } from "./room-layout";
import { VOXELS_PER_STEP, walkFrame, type AgentView, type RoomView } from "./room-model";
import { RECEPTION_KEY } from "./reception";

// The drawing of the floor, behind a small interface (create, draw a state,
// resize, pan and zoom, destroy) so that the engine can change without
// touching the model or the page. PixiJS, WebGL, at the device pixel ratio of
// the screen. The floor is isometric pixel art (public/iso/floor, see
// scripts/iso/README.md): it is only ever drawn at a whole number of device
// pixels per art pixel, with nearest sampling and whole-pixel positions, so it
// stays crisp. Tiles, floor shadows and rugs lie flat under everything; walls,
// rims, furniture and standing characters are sorted back to front by their
// footprints; a seated character is drawn inside its chair (under the
// backrest). Every piece of text is an HTML label over the canvas
// (room-labels.ts). This module is only ever imported dynamically, on the
// client.

/** Colors as numbers (0xRRGGBB), read from the page's CSS tokens (the marks drawn over the art follow light and dark). */
export type RoomTheme = {
  floor: number;
  floorLine: number;
  wall: number;
  wallEdge: number;
  ink: number;
  muted: number;
  card: number;
  line: number;
  accent: number;
  accentInk: number;
  danger: number;
  ok: number;
  wood: number;
  woodEdge: number;
  paper: number;
  appliance: number;
};

/** Everything the drawing needs besides the animation state (it holds no wording of its own). */
export type RoomScene = {
  view: RoomView;
  labels: { userDesk: string; trayCount: (count: number) => string };
  /** Colour of the room (a normalized hex): carpets, tiles, rugs, sofas, the counter and the name tags. Null: neutral. */
  color: string | null;
  selected: string | null;
  reduced: boolean;
};

export type RoomRenderer = {
  /**
   * Character sheet URL per agent key (a sheet that fails to load falls back to a
   * neutral person), and the voxels per walk frame the sheets declare (a key
   * without one walks at VOXELS_PER_STEP).
   */
  setSprites(urls: Record<string, string>, strides?: Record<string, number>): void;
  setTheme(theme: RoomTheme): void;
  /** The canvas has this CSS size now. */
  resize(cssWidth: number, cssHeight: number): void;
  /** The screen's device pixel ratio changed (zoom, another screen): draw at the new density. */
  setResolution(resolution: number): void;
  /** One step closer (+1) or further (-1), around a point of the canvas (CSS pixels) or its centre. */
  zoomBy(step: number, around?: Point): void;
  /** Moves the floor by this many CSS pixels. */
  panBy(dx: number, dy: number): void;
  /** Back to the zoom that fits the floor (or the offices, on a small screen). */
  fit(): void;
  /** Whether a step closer or further is possible. */
  canZoom(step: number): boolean;
  /** The character under a point of the canvas (CSS pixels), the front one when they overlap. */
  agentAt(view: RoomView, x: number, y: number): AgentView | null;
  draw(scene: RoomScene, at: number): void;
  /** True while a transient effect (the tray count that just rose) still needs frames; never with reduced motion. */
  busy(at: number, reduced: boolean): boolean;
  /** Frames drawn so far (the measure of "nothing is drawn while the tab is hidden"). */
  readonly frames: number;
  destroy(): void;
};

export type RendererOptions = {
  canvas: HTMLCanvasElement;
  /** Where floor.json and its atlas are served. */
  floorUrl: string;
  /** Where the text of the floor goes. */
  labels: LabelLayer;
  theme: RoomTheme;
  /** Something the drawing waited for arrived (a character sheet): draw again. */
  onLoad: () => void;
};

/** The closest the floor gets: this many device pixels per art pixel. */
export const MAX_ZOOM = 6;
const BUMP_MS = 650;
/** Free space around the floor when it is fitted, in art pixels. */
const MARGIN = 8;
/** A floor at most this much bigger than the canvas (at one device pixel) is still centred whole; a bigger one shows its offices. */
const NEARLY_FITS = 1.25;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`cannot load ${url}`));
    image.src = url;
  });
}

type Sheet = {
  frames: Texture[][];
  /** Per row, the highest opaque pixel above the anchor (the top of the head), in art pixels. */
  heights: number[];
};

/** Slices an iso character sheet (8 columns, 12 rows of 96 by 136), or null when the image is not one. */
function sliceSheet(image: HTMLImageElement): Sheet | null {
  const { w, h } = SHEET.frame;
  const rows = SHEET.directions.length * SHEET.animations.length;
  if (image.naturalWidth !== w * SHEET.columns || image.naturalHeight !== h * rows) return null;
  const texture = Texture.from(image);
  texture.source.scaleMode = "nearest";
  const frames: Texture[][] = [];
  for (let row = 0; row < rows; row += 1) {
    const line: Texture[] = [];
    for (let col = 0; col < SHEET.columns; col += 1) {
      line.push(new Texture({ source: texture.source, frame: new Rectangle(col * w, row * h, w, h) }));
    }
    frames.push(line);
  }
  const heights = new Array<number>(rows).fill(SHEET.anchor.y - 12);
  const probe = document.createElement("canvas");
  probe.width = image.naturalWidth;
  probe.height = image.naturalHeight;
  const context = probe.getContext("2d", { willReadFrequently: true });
  if (context) {
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, probe.width, probe.height);
    for (let row = 0; row < rows; row += 1) {
      search: for (let y = 0; y < h; y += 1) {
        const line = (row * h + y) * probe.width * 4;
        for (let x = 0; x < probe.width; x += 1) {
          if (data[line + x * 4 + 3]! > 0) {
            heights[row] = SHEET.anchor.y - y;
            break search;
          }
        }
      }
    }
  }
  return { frames, heights };
}

const hexToNumber = (hex: string | null): number | null => (hex ? Number.parseInt(hex.slice(1), 16) : null);

type ChairNode = { group: Container; empty: Sprite[]; under: Sprite[]; over: Sprite[]; slot: Container; seat: Point };

type AgentNode = {
  /** A standing character: its own sorted container. */
  standing: Container;
  sprite: Sprite;
  folder: Graphics;
  /** Screen position of the feet, last frame. */
  feet: Point;
  /** Top of the head above the feet, for its labels. */
  height: number;
  /** Footprint while standing, null while seated. */
  box: Box | null;
  url: string | null;
};

export async function createRoomRenderer(options: RendererOptions): Promise<RoomRenderer> {
  const { canvas, labels } = options;
  let theme = options.theme;
  let resolution = window.devicePixelRatio || 1;

  const [set, atlasImage] = await Promise.all([
    fetch(`${options.floorUrl}/floor.json`).then(async (response) => {
      if (!response.ok) throw new Error(`floor.json: ${response.status}`);
      return floorSetSchema.parse(await response.json());
    }),
    loadImage(`${options.floorUrl}/floor.png`),
  ]);
  const floorSet: FloorSet = set;

  const app = new Application();
  await app.init({
    canvas,
    width: 100,
    height: 100,
    resolution,
    autoDensity: true,
    antialias: false,
    roundPixels: true,
    backgroundAlpha: 0,
    autoStart: false,
    sharedTicker: false,
    preference: "webgl",
  });

  const atlas = Texture.from(atlasImage);
  atlas.source.scaleMode = "nearest";
  const frameTextures = floorSet.atlas.frames.map(([x, y, w, h]) => new Texture({ source: atlas.source, frame: new Rectangle(x, y, w, h) }));

  // Layers, back to front: the flat floor, the marks on it, everything sorted, effects on top.
  const world = new Container();
  const flatLayer = new Container();
  const marks = new Graphics();
  const sortedLayer = new Container();
  sortedLayer.sortableChildren = true;
  const effects = new Graphics();
  world.addChild(flatLayer, marks, sortedLayer, effects);
  app.stage.addChild(world);

  // View: a whole number of device pixels per art pixel, the art point at the centre of the canvas.
  let cssSize = { width: 100, height: 100 };
  let zoom = 1;
  let center: Point = { x: 0, y: 0 };
  let adjusted = false;
  let layout: RoomLayout | null = null;

  const scale = () => zoom / resolution;
  const offset = (): Point => ({
    x: Math.round((cssSize.width / 2 - center.x * scale()) * resolution) / resolution,
    y: Math.round((cssSize.height / 2 - center.y * scale()) * resolution) / resolution,
  });
  const applyView = () => {
    const at = offset();
    world.scale.set(scale());
    world.position.set(at.x, at.y);
    labels.setView(scale(), at.x, at.y, cssSize.width);
  };
  const clampCenter = () => {
    if (!layout) return;
    const b = layout.bounds;
    center = { x: Math.min(b.x + b.w, Math.max(b.x, center.x)), y: Math.min(b.y + b.h, Math.max(b.y, center.y)) };
  };
  const fitView = () => {
    if (!layout) return;
    const b = layout.bounds;
    const device = { w: cssSize.width * resolution, h: cssSize.height * resolution };
    zoom = Math.max(1, Math.min(MAX_ZOOM, Math.floor(Math.min(device.w / (b.w + 2 * MARGIN), device.h / (b.h + 2 * MARGIN)))));
    const overflow = Math.max(((b.w + 2 * MARGIN) * zoom) / device.w, ((b.h + 2 * MARGIN) * zoom) / device.h);
    if (overflow <= NEARLY_FITS || layout.offices.length === 0) {
      center = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    } else {
      // Much too big for the screen even at one device pixel (a phone): show where the agents work.
      const seats = layout.offices.map((office) => screenOf(office.seat.x, office.seat.y));
      center = {
        x: seats.reduce((sum, p) => sum + p.x, 0) / seats.length,
        y: seats.reduce((sum, p) => sum + p.y, 0) / seats.length - 40,
      };
      clampCenter();
    }
  };

  // ---- Character sheets ----
  const sheets = new Map<string, Sheet | null>();
  const loadSheet = (url: string) => {
    if (sheets.has(url)) return;
    sheets.set(url, null);
    void loadImage(url)
      .then((image) => {
        if (destroyed) return;
        sheets.set(url, sliceSheet(image));
        options.onLoad();
      })
      .catch(() => {
        // Try again later (the server may have been restarting); meanwhile the neutral person stands in.
        setTimeout(() => sheets.delete(url), 5_000);
      });
  };
  let wanted: Record<string, string> = {};
  let wantedStrides: Record<string, number> = {};

  // ---- The static floor ----
  let staticKey = "";
  let staticItems: { node: Container; box: Box }[] = [];
  const chairs = new Map<number, ChairNode>();
  let roomColor = NEUTRAL_ROOM_COLOR;

  const spriteOf = (draw: Draw): Sprite => {
    const sprite = new Sprite(frameTextures[draw.frame]!);
    sprite.position.set(draw.x, draw.y);
    if (draw.tint === "room") sprite.tint = roomColor;
    else if (draw.tint === "pastel") sprite.tint = pastel(roomColor);
    return sprite;
  };

  function buildStatic(next: RoomLayout, color: string | null) {
    flatLayer.removeChildren().forEach((child) => child.destroy());
    for (const item of staticItems) item.node.destroy({ children: true });
    staticItems = [];
    chairs.clear();
    roomColor = hexToNumber(color) ?? NEUTRAL_ROOM_COLOR;
    const scene = buildFloorScene(floorSet, next, color !== null);
    for (const draw of scene.flat) flatLayer.addChild(spriteOf(draw));
    const seatChairs = new Set(next.offices.map((office) => office.chair).filter((chair): chair is number => chair !== null));
    for (const item of scene.sorted) {
      const group = new Container();
      const sprites = item.draws.map(spriteOf);
      group.addChild(...sprites);
      if (item.piece !== null && seatChairs.has(item.piece)) {
        // A chair someone sits in: its plain sprite, or the layers around a sitter.
        const piece = next.pieces[item.piece]!;
        const turn = turnOf(floorSet, piece.name, piece.turn);
        const vx = piece.cell[0] * CELL;
        const vy = piece.cell[1] * CELL;
        const corner = screenOf(vx, vy);
        const layer = (ref: [number, number, number]) => spriteOf({ frame: ref[0], x: corner.x + ref[1], y: corner.y + ref[2], tint: null });
        const under = (turn.under ?? []).map(layer);
        const over = (turn.over ?? []).map(layer);
        const slot = new Container();
        group.addChild(...under, slot, ...over);
        const seat = turn.seat ?? [0, 16];
        chairs.set(item.piece, { group, empty: sprites, under, over, slot, seat: { x: corner.x + seat[0], y: corner.y + seat[1] } });
      }
      sortedLayer.addChild(group);
      staticItems.push({ node: group, box: item.box });
    }
    lastOrderKey = "";
  }

  // ---- Characters ----
  const nodes = new Map<string, AgentNode>();
  const nodeFor = (key: string): AgentNode => {
    let node = nodes.get(key);
    if (node) return node;
    const standing = new Container();
    const sprite = new Sprite();
    const folder = new Graphics();
    standing.addChild(sprite, folder);
    node = { standing, sprite, folder, feet: { x: 0, y: 0 }, height: 100, box: null, url: null };
    nodes.set(key, node);
    return node;
  };

  const sheetFor = (key: string): Sheet | null => {
    const url = wanted[key];
    const own = url ? sheets.get(url) : null;
    if (own) return own;
    const fallback = neutralPersonFor(key);
    loadSheet(fallback);
    return sheets.get(fallback) ?? null;
  };

  /** Voxels per walk frame of the sheet drawn for `key`: its own declared stride, the default for the neutral person standing in. */
  const strideFor = (key: string): number => {
    const url = wanted[key];
    return url && sheets.get(url) ? (wantedStrides[key] ?? VOXELS_PER_STEP) : VOXELS_PER_STEP;
  };

  /** A folder held in front of the character: a few pixels of paper. */
  const drawFolder = (g: Graphics, view: AgentView, feet: Point, height: number) => {
    g.clear();
    if (!view.carrying) return;
    const side = view.direction === "SE" || view.direction === "NE" ? 1 : -1;
    const x = Math.round(feet.x + side * 10);
    const y = Math.round(feet.y - height * 0.45);
    g.rect(x - 6, y - 4, 12, 9).fill(theme.woodEdge);
    g.rect(x - 5, y - 3, 10, 7).fill(theme.paper);
    g.rect(x - 5, y - 3, 4, 2).fill(theme.accent);
  };

  let lastOrderKey = "";
  let drawnLayout: RoomLayout | null = null;
  let frames = 0;
  let destroyed = false;
  let bumpAt = Number.NEGATIVE_INFINITY;
  let lastPending = -1;

  /**
   * Labels are sized in CSS pixels: their full size from one CSS pixel per art
   * pixel up, a little smaller when the floor is drawn smaller (a phone), so
   * the names of neighbours overlap less.
   */
  const px = (css: number) => (css * Math.min(1, Math.max(0.8, 0.7 + 0.3 * scale()))) / scale();

  return {
    get frames() {
      return frames;
    },
    setSprites(urls, strides = {}) {
      wanted = urls;
      wantedStrides = strides;
      for (const url of Object.values(urls)) loadSheet(url);
    },
    setTheme(next) {
      theme = next;
    },
    resize(cssWidth, cssHeight) {
      cssSize = { width: Math.max(1, cssWidth), height: Math.max(1, cssHeight) };
      app.renderer.resize(Math.round(cssSize.width), Math.round(cssSize.height));
      if (!adjusted) fitView();
      else clampCenter();
      applyView();
    },
    setResolution(next) {
      if (next === resolution) return;
      resolution = next;
      app.renderer.resolution = next;
      app.renderer.resize(Math.round(cssSize.width), Math.round(cssSize.height));
      if (!adjusted) fitView();
      applyView();
    },
    zoomBy(step, around) {
      const next = Math.max(1, Math.min(MAX_ZOOM, zoom + step));
      if (next === zoom) return;
      const anchor = around ?? { x: cssSize.width / 2, y: cssSize.height / 2 };
      const at = offset();
      const art = { x: (anchor.x - at.x) / scale(), y: (anchor.y - at.y) / scale() };
      zoom = next;
      center = { x: art.x - (anchor.x - cssSize.width / 2) / scale(), y: art.y - (anchor.y - cssSize.height / 2) / scale() };
      adjusted = true;
      clampCenter();
      applyView();
    },
    panBy(dx, dy) {
      center = { x: center.x - dx / scale(), y: center.y - dy / scale() };
      adjusted = true;
      clampCenter();
      applyView();
    },
    fit() {
      adjusted = false;
      fitView();
      applyView();
    },
    canZoom(step) {
      return step > 0 ? zoom < MAX_ZOOM : zoom > 1;
    },
    agentAt(view, x, y) {
      const at = offset();
      const art = { x: (x - at.x) / scale(), y: (y - at.y) / scale() };
      let found: AgentView | null = null;
      let foundDepth = Number.NEGATIVE_INFINITY;
      for (const agent of view.agents) {
        const node = nodes.get(agent.key);
        if (!node || agent.alpha < 0.5) continue;
        const { feet, height } = node;
        if (Math.abs(art.x - feet.x) > 22 || art.y < feet.y - height - 2 || art.y > feet.y + 8) continue;
        const depth = agent.x + agent.y;
        if (depth > foundDepth) {
          found = agent;
          foundDepth = depth;
        }
      }
      return found;
    },
    draw(scene, at) {
      if (destroyed) return;
      const { view, reduced } = scene;
      const key = `${scene.color ?? ""}`;
      if (view.layout !== drawnLayout || key !== staticKey) {
        layout = view.layout;
        buildStatic(view.layout, scene.color);
        drawnLayout = view.layout;
        staticKey = key;
        if (!adjusted) fitView();
        clampCenter();
        applyView();
      }
      const current = view.layout;
      marks.clear();
      effects.clear();

      // Chairs: empty unless their agent sits in them this frame.
      const occupied = new Map<number, AgentView>();
      for (const agent of view.agents) {
        if (!agent.seated) continue;
        const office = agent.key === RECEPTION_KEY ? current.reception?.office : current.offices.find((spot) => spot.key === agent.key);
        if (office && office.chair !== null) occupied.set(office.chair, agent);
      }
      for (const [index, chair] of chairs) {
        const sitting = occupied.has(index);
        for (const sprite of chair.empty) sprite.visible = !sitting;
        for (const sprite of [...chair.under, ...chair.over]) sprite.visible = sitting;
      }

      const standing: { node: AgentNode; box: Box }[] = [];
      for (const agent of view.agents) {
        const node = nodeFor(agent.key);
        const sheet = sheetFor(agent.key);
        const office = agent.key === RECEPTION_KEY ? current.reception?.office : current.offices.find((spot) => spot.key === agent.key);
        const chair = agent.seated && office && office.chair !== null ? chairs.get(office.chair) : undefined;
        const feet = chair ? chair.seat : screenOf(agent.x, agent.y);
        node.feet = { x: Math.round(feet.x), y: Math.round(feet.y) };
        const row = sheetRow(agent.direction, agent.animation);
        node.height = sheet?.heights[row] ?? 100;
        node.sprite.visible = sheet !== null;
        const frame = agent.animation === "walk" && !reduced ? walkFrame(agent.walked, strideFor(agent.key)) : agent.frame;
        if (sheet) node.sprite.texture = sheet.frames[row]![frame] ?? sheet.frames[row]![0]!;
        node.sprite.position.set(node.feet.x - SHEET.anchor.x, node.feet.y - SHEET.anchor.y);
        node.sprite.alpha = agent.alpha;
        drawFolder(node.folder, agent, node.feet, node.height);

        if (chair) {
          if (node.sprite.parent !== chair.slot) chair.slot.addChild(node.sprite);
          node.standing.removeFromParent();
          node.box = null;
        } else {
          if (node.sprite.parent !== node.standing) node.standing.addChildAt(node.sprite, 0);
          if (node.standing.parent !== sortedLayer) sortedLayer.addChild(node.standing);
          node.box = characterBox(Math.round(agent.x), Math.round(agent.y));
          standing.push({ node, box: node.box });
          // A soft shadow under the feet.
          if (agent.alpha > 0.05) marks.ellipse(node.feet.x, node.feet.y, 11, 5).fill({ color: theme.ink, alpha: 0.18 * agent.alpha });
        }
        if (scene.selected === agent.key) {
          marks.ellipse(node.feet.x, node.feet.y, 18, 9).stroke({ width: 2 / scale(), color: theme.accent, alignment: 0.5 });
        }

        // The name over the head, and what the agent is doing over the name.
        if (agent.alpha > 0.5) {
          const top = node.feet.y - node.height - 3;
          labels.place(`name:${agent.key}`, {
            text: agent.name,
            x: node.feet.x,
            y: top,
            size: px(11),
            weight: 700,
            box: "tag",
            ax: 0.5,
            ay: 1,
            color: agent.key === RECEPTION_KEY ? null : scene.color,
          });
          const bubbleY = top - px(22);
          const bubble = agent.bubble;
          if (bubble?.kind === "thought") {
            labels.place(`bubble:${agent.key}`, { text: bubble.text, x: node.feet.x, y: bubbleY, size: px(11), ax: 0.5, ay: 1, box: "bubble", maxWidth: px(180), clamp: true });
          } else if (bubble?.kind === "question") {
            labels.place(`bubble:${agent.key}`, { text: "?", x: node.feet.x, y: bubbleY, size: px(11), tone: "onDanger", weight: 700, box: "badge", ax: 0.5, ay: 1 });
          } else if (bubble?.kind === "talk") {
            labels.place(`bubble:${agent.key}`, { text: "...", x: node.feet.x, y: bubbleY, size: px(11), weight: 700, ax: 0.5, ay: 1, box: "bubble" });
          } else if (bubble?.kind === "zzz") {
            labels.place(`bubble:${agent.key}`, { text: "z Z", x: node.feet.x + px(14), y: bubbleY + px(6), size: px(11), tone: "muted", weight: 700, ax: 0, ay: 1 });
          }
        }
      }
      for (const [agentKey, node] of nodes) {
        if (!view.agents.some((agent) => agent.key === agentKey)) {
          node.sprite.destroy();
          node.standing.destroy({ children: true });
          nodes.delete(agentKey);
        }
      }

      // Depth order of walls, furniture and standing characters, when a standing footprint changed.
      const orderKey = standing.map(({ box }) => `${box.x0},${box.y0}`).join(";") + `|${staticItems.length}`;
      if (orderKey !== lastOrderKey) {
        lastOrderKey = orderKey;
        const items = [...staticItems, ...standing.map(({ node, box }) => ({ node: node.standing, box }))];
        depthOrder(items.map((item) => item.box)).forEach((index, z) => {
          items[index]!.node.zIndex = z;
        });
      }

      // The user's desk and the tray of the lobby, with its count.
      const deskPiece = current.pieces[current.user.desk]!;
      const deskTop = screenOf((deskPiece.cell[0] + 1) * CELL, deskPiece.cell[1] * CELL + 8);
      labels.place("user-desk", { text: scene.labels.userDesk, x: deskTop.x, y: deskTop.y - 84, size: px(11), weight: 700, tone: "muted", box: "tag", ax: 0.5, ay: 1 });
      const trayPiece = current.pieces[current.user.tray]!;
      const trayTop = screenOf((trayPiece.cell[0] + 0.5) * CELL, (trayPiece.cell[1] + 0.5) * CELL);
      const papers = Math.min(view.pending, 6);
      for (let i = 0; i < papers; i += 1) {
        const y = trayTop.y - 58 - i * 2;
        effects.poly([trayTop.x - 9, y, trayTop.x, y - 4, trayTop.x + 9, y, trayTop.x, y + 4]).fill(theme.paper).stroke({ width: 1 / scale(), color: theme.woodEdge });
      }
      if (lastPending >= 0 && view.pending > lastPending) bumpAt = at;
      lastPending = view.pending;
      const bump = reduced ? 0 : Math.max(0, 1 - (at - bumpAt) / BUMP_MS);
      labels.place("tray", {
        text: scene.labels.trayCount(view.pending),
        x: trayTop.x,
        y: trayTop.y - 66 - papers * 2,
        size: px(12),
        weight: 700,
        box: "tag",
        tone: view.pending > 0 ? "accent" : "muted",
        ax: 0.5,
        ay: 1,
        pop: 1 + 0.3 * bump,
      });

      // Coffee steam over the coffee corner, unless motion is reduced.
      if (!reduced && current.coffee !== null) {
        const machine = current.pieces[current.coffee]!;
        const top = screenOf((machine.cell[0] + 0.6) * CELL, (machine.cell[1] + 0.3) * CELL);
        for (let i = 0; i < 3; i += 1) {
          const phase = (at / 1600 + i / 3) % 1;
          const x = Math.round(top.x + Math.sin(phase * 6 + i) * 2);
          const y = Math.round(top.y - 70 - phase * 16);
          effects.rect(x, y, 2, 2).fill({ color: 0xffffff, alpha: 0.75 * (1 - phase) });
        }
      }

      labels.end();
      app.render();
      frames += 1;
    },
    busy(at, reduced) {
      if (reduced) return false;
      return at - bumpAt < BUMP_MS;
    },
    destroy() {
      destroyed = true;
      app.destroy({ removeView: false }, { children: true });
    },
  };
}
