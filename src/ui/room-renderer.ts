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
import { CELL, roomOfKey, screenOf, type OwnerDesk, type Point, type RoomLayout } from "./room-layout";
import { VOXELS_PER_STEP, walkFrame, type AgentView, type RoomView } from "./room-model";
import { RECEPTION_KEY, RECEPTION_ROOM } from "./reception";

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
  labels: {
    userDesk: string;
    trayCount: (count: number) => string;
    /** The sign at the door of a room of the single floor: its name, or the meeting room's. */
    roomSign?: (room: string | null) => string;
  };
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
  /** The user's desk of a room of the single floor under a point of the canvas (CSS pixels): the room it serves. */
  ownerDeskAt(x: number, y: number): string | null;
  /** Centres the view on a room of the single floor (the room of the home it stands for), close enough to see it whole. */
  focusRoom(room: string): void;
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

/** The colour of the room of an agent on the single floor (its name tag), null for none. */
const roomColorHex = (layout: RoomLayout, key: string): string | null =>
  layout.rooms.find((room) => room.project === roomOfKey(key))?.color ?? null;

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
    // The single floor is a balanced V with the lobby in the middle: its overview is always centred on the whole.
    if (overflow <= NEARLY_FITS || layout.offices.length === 0 || layout.template === "rooms") {
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

  /** On the single floor each room has its own colour (neutral without one); elsewhere the floor's. */
  let roomColors: number[] = [];
  const colorOf = (room: number): number => roomColors[room] ?? roomColor;
  const spriteOf = (draw: Draw): Sprite => {
    const sprite = new Sprite(frameTextures[draw.frame]!);
    sprite.position.set(draw.x, draw.y);
    if (draw.tint === "room") sprite.tint = colorOf(draw.room);
    else if (draw.tint === "pastel") sprite.tint = pastel(colorOf(draw.room));
    return sprite;
  };

  function buildStatic(next: RoomLayout, color: string | null) {
    flatLayer.removeChildren().forEach((child) => child.destroy());
    for (const item of staticItems) item.node.destroy({ children: true });
    staticItems = [];
    chairs.clear();
    roomColor = hexToNumber(color) ?? NEUTRAL_ROOM_COLOR;
    piles.clear();
    const single = next.template === "rooms";
    roomColors = single ? next.rooms.map((room) => hexToNumber(room.color) ?? NEUTRAL_ROOM_COLOR) : [];
    const scene = buildFloorScene(floorSet, next, single ? (index) => next.rooms[index]?.color != null : color !== null);
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
        const layer = (ref: [number, number, number]) => spriteOf({ frame: ref[0], x: corner.x + ref[1], y: corner.y + ref[2], tint: null, room: piece.room });
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
    // The pile on each user's desk (single floor): the desk's footprint, so it is drawn right after the desk.
    for (const owner of next.owners) {
      const desk = staticItems.find((entry, index) => scene.sorted[index]?.piece === owner.desk);
      if (!desk) continue;
      const node = new Graphics();
      sortedLayer.addChild(node);
      staticItems.push({ node, box: desk.box });
      piles.set(owner.room, { node, count: -1 });
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

  /** Folders on a user's desk of the single floor: at most this many drawn, the badge says the rest. */
  const PILE_MAX = 10;
  /** The cell of the desk the pile stands on (the far end of the workstation from its screen), in voxels, and the desk top. */
  const pileSpot = (current: RoomLayout, owner: OwnerDesk): { x: number; y: number } => {
    const desk = current.pieces[owner.desk]!;
    const [cx, cy] = desk.turn === 0 ? [desk.cell[0] + 1, desk.cell[1]] : [desk.cell[0], desk.cell[1] + 1];
    return { x: (cx + 0.55) * CELL, y: (cy + 0.5) * CELL };
  };
  /**
   * A pile of folders on the desk top (z 25), two voxels each, slightly
   * askew, in the style of the art: each folder is a box with a one pixel
   * dark outline, its spine (the face towards the lower left) in the room
   * colour, the edges of its sheets (lower right) a shade of paper, white on
   * top. The outline of each folder over the one below draws the line
   * between them.
   */
  const drawPile = (g: Graphics, at: { x: number; y: number }, count: number, spine: number) => {
    const half = { x: 6, y: 4 };
    const thick = 2;
    const shade = (color: number, k: number) =>
      (Math.round(((color >> 16) & 255) * k) << 16) | (Math.round(((color >> 8) & 255) * k) << 8) | Math.round((color & 255) * k);
    const point = (x: number, y: number, z: number): [number, number] => {
      const p = screenOf(x, y, z);
      return [Math.round(p.x), Math.round(p.y)];
    };
    for (let i = 0; i < count; i += 1) {
      const z0 = 25 + i * thick;
      const z1 = z0 + thick;
      const dx = ((i * 7) % 3) - 1;
      const dy = ((i * 5) % 3) === 0 ? 1 : 0;
      const x0 = at.x - half.x + dx;
      const x1 = at.x + half.x + dx;
      const y0 = at.y - half.y + dy;
      const y1 = at.y + half.y + dy;
      const top = point(x0, y0, z1);
      const right = point(x1, y0, z1);
      const rightLow = point(x1, y0, z0);
      const low = point(x1, y1, z0);
      const leftLow = point(x0, y1, z0);
      const left = point(x0, y1, z1);
      const front = point(x1, y1, z1);
      // The silhouette, one pixel larger all round: the outline.
      g.poly([top[0], top[1] - 1, right[0] + 1, right[1], rightLow[0] + 1, rightLow[1], low[0], low[1] + 1, leftLow[0] - 1, leftLow[1], left[0] - 1, left[1]]).fill(theme.woodEdge);
      g.poly([...left, ...front, ...low, ...leftLow]).fill(spine);
      g.poly([...front, ...right, ...rightLow, ...low]).fill(shade(theme.paper, 0.82));
      g.poly([...top, ...right, ...front, ...left]).fill(theme.paper);
      // A small label on the spine, a shade darker.
      const a = point(x0 + 4, y1, z0 + 1);
      const b = point(x1 - 4, y1, z0 + 1);
      g.poly([a[0], a[1] - 1, b[0], b[1] - 1, b[0], b[1], a[0], a[1]]).fill(shade(spine, 0.72));
    }
  };
  /** Screen boxes of the users' desks of the single floor, last frame (art pixels), for the pointer. */
  let ownerBoxes: { room: string; x0: number; y0: number; x1: number; y1: number }[] = [];
  /** The pile of each user's desk: sorted with its desk (drawn right after it), redrawn when its count changes. */
  const piles = new Map<string, { node: Graphics; count: number }>();

  let lastOrderKey = "";
  let drawnLayout: RoomLayout | null = null;
  /** A room to show, asked for before the floor was built. */
  let pendingFocus: string | null = null;
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

  const renderer: RoomRenderer = {
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
      // The piles are drawn in the theme's colours: draw them again.
      for (const pile of piles.values()) pile.count = -1;
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
    ownerDeskAt(x, y) {
      const at = offset();
      const art = { x: (x - at.x) / scale(), y: (y - at.y) / scale() };
      return ownerBoxes.find((box) => art.x >= box.x0 && art.x <= box.x1 && art.y >= box.y0 && art.y <= box.y1)?.room ?? null;
    },
    focusRoom(name) {
      if (!layout) {
        // Asked before the first drawing: done once the floor is built.
        pendingFocus = name;
        return;
      }
      pendingFocus = null;
      const room = layout.rooms.find((candidate) => candidate.project === name);
      if (!room) return;
      const corners = [
        screenOf(room.x * CELL, room.y * CELL),
        screenOf((room.x + room.w) * CELL, room.y * CELL),
        screenOf(room.x * CELL, (room.y + room.d) * CELL),
        screenOf((room.x + room.w) * CELL, (room.y + room.d) * CELL),
      ];
      const minX = Math.min(...corners.map((p) => p.x));
      const maxX = Math.max(...corners.map((p) => p.x));
      // The back walls rise above the room; its name sign and the heads of its agents too.
      const minY = Math.min(...corners.map((p) => p.y)) - 2 * 64;
      const maxY = Math.max(...corners.map((p) => p.y)) + 8;
      const device = { w: cssSize.width * resolution, h: cssSize.height * resolution };
      const fits = Math.floor(Math.min(device.w / (maxX - minX + 4 * MARGIN), device.h / (maxY - minY + 4 * MARGIN)));
      zoom = Math.max(1, Math.min(MAX_ZOOM - 2, Math.max(zoom, fits)));
      center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
      adjusted = true;
      clampCenter();
      applyView();
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
        if (pendingFocus !== null) renderer.focusRoom(pendingFocus);
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
            color: agent.key === RECEPTION_KEY ? null : current.template === "rooms" ? roomColorHex(current, agent.key) : scene.color,
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

      // The user's desk and the tray of the lobby, with its count (the floor of one room).
      if (current.user) {
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
      }

      // The single floor: the user's desk of each room, its pile and its count; the name of each room at its door.
      ownerBoxes = [];
      for (const owner of current.owners) {
        const count = view.pendingByRoom[owner.room] ?? 0;
        const spot = pileSpot(current, owner);
        const room = current.rooms[owner.roomIndex]!;
        const pile = piles.get(owner.room);
        if (pile && pile.count !== count) {
          pile.node.clear();
          drawPile(pile.node, spot, Math.min(PILE_MAX, count), hexToNumber(room.color) ?? theme.muted);
          pile.count = count;
        }
        const top = screenOf(spot.x, spot.y, 25 + Math.min(PILE_MAX, count) * 2);
        const desk = current.pieces[owner.desk]!;
        const deskTurn = turnOf(floorSet, desk.name, desk.turn);
        const a = screenOf(desk.cell[0] * CELL, desk.cell[1] * CELL);
        const b = screenOf((desk.cell[0] + deskTurn.cells[0]) * CELL, (desk.cell[1] + deskTurn.cells[1]) * CELL);
        const c = screenOf(desk.cell[0] * CELL, (desk.cell[1] + deskTurn.cells[1]) * CELL);
        const d = screenOf((desk.cell[0] + deskTurn.cells[0]) * CELL, desk.cell[1] * CELL);
        ownerBoxes.push({ room: owner.room, x0: Math.min(c.x, a.x) - 4, x1: Math.max(d.x, b.x) + 4, y0: a.y - 70, y1: b.y + 4 });
        if (count > 0) {
          labels.place(`owner:${owner.room}`, {
            text: count > 99 ? "99+" : String(count),
            x: top.x,
            y: top.y - 6,
            size: px(13),
            weight: 700,
            box: "count",
            tone: "onDanger",
            ax: 0.5,
            ay: 1,
          });
        }
      }
      if (current.template === "rooms" && scene.labels.roomSign) {
        for (const room of current.rooms) {
          if (room.project === RECEPTION_ROOM) continue;
          const door = room.open.y[0] !== undefined ? { x: room.x + room.open.y[0] + 0.5, y: room.y + room.d } : room.open.x[0] !== undefined ? { x: room.x + room.w, y: room.y + room.open.x[0] + 0.5 } : null;
          if (!door) continue;
          const at = screenOf(door.x * CELL, door.y * CELL, 30);
          labels.place(`sign:${room.x},${room.y}`, {
            text: scene.labels.roomSign(room.project),
            x: at.x,
            y: at.y,
            size: px(12),
            weight: 700,
            display: true,
            box: "plate",
            color: room.color,
            ax: 0.5,
            ay: 1,
          });
        }
      }

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
  return renderer;
}
