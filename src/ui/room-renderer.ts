import { Application, Container, Graphics, Rectangle, Sprite, Texture } from "pixi.js";
import {
  buildFloorScene,
  characterBox,
  depthOrder,
  moverDepths,
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
  type OfficeState,
  type ScreenRect,
  type SignPart,
} from "./iso-floor";
import { focusZoom } from "./floor-view";
import type { LabelLayer } from "./room-labels";
import { CELL, COUNTER_FROM, COUNTER_SEGMENTS, roomOfKey, screenOf, SIGN_TOP, WALL_HEIGHT, type Point, type RoomLayout } from "./room-layout";
import { faceColumns, faceWidth, inkFor, LOGO_MARGIN, paintFace, placeSign, planSign, shrinkLogo, textWidth, type Pixels } from "./room-signs";
import { VOXELS_PER_STEP, walkFrame, type AgentView, type RoomView } from "./room-model";
import { RECEPTION_KEY } from "./reception";

// The drawing of the floor, behind a small interface (create, draw a state,
// resize, pan and zoom, destroy) so that the engine can change without
// touching the model or the page. PixiJS, WebGL, at the device pixel ratio of
// the screen. The floor is isometric pixel art (public/iso/floor, see
// scripts/iso/README.md): it is only ever drawn at a whole number of device
// pixels per art pixel (one at least), with nearest sampling, no mipmaps and
// whole-pixel positions, so it stays crisp; a view that flies to a room or
// back to the overview passes through whole zoom steps only. The signboards
// of the single floor are floor art too, their names drawn with the pixel
// font of the floor set. Tiles, floor shadows and rugs lie flat under everything; walls,
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
    /** The name on the signboard of a room of the single floor (the room of the home it stands for). */
    roomSign?: (room: string) => string;
    /** The name on the signboard of the user's own office (single floor). */
    officeSign?: string;
  };
  /** The logo of each room of the home that has one (an image URL), drawn on the left of its signboard. */
  logos?: Record<string, string>;
  /** How many letters lie in the tray of the user's own office. */
  officeTray?: number;
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
  /** Back to the overview: the largest whole zoom that fits the floor (one, centred, when even one does not); `animate` flies there. */
  fit(animate?: boolean): void;
  /** True while the view is the overview (nothing moved it since). */
  readonly overview: boolean;
  /** Whether a step closer or further is possible. */
  canZoom(step: number): boolean;
  /** The character under a point of the canvas (CSS pixels), the front one when they overlap. */
  agentAt(view: RoomView, x: number, y: number): AgentView | null;
  /** The counter of a room of the single floor under a point of the canvas (CSS pixels): the room it counts for. */
  counterAt(x: number, y: number): string | null;
  /**
   * Centres the view on a room of the single floor (the room of the home it stands for), at a whole zoom that
   * gives it about the size of the view (`focusZoom`). `insetRight`: CSS pixels on the right of the canvas
   * that a panel covers, left out of the view the room is centred in.
   */
  focusRoom(room: string, animate?: boolean, insetRight?: number): void;
  /** The same for a room of the floor by its index in the layout. */
  focusIndex(index: number, animate?: boolean, insetRight?: number): void;
  /**
   * Centres the room last flown to again, in the part of the canvas left of `insetRight` CSS pixels (a sheet that
   * opened or closed), unless the view moved since (a drag, a zoom, the overview).
   */
  refocus(insetRight: number, animate?: boolean): void;
  /** The room of the home a room of the floor stands for (`_hq` for the lobby), null for the user's office or a floor of one room. */
  roomName(index: number): string | null;
  /** The room of the floor under a point of the canvas (CSS pixels): its index, or null for the hall, the garden or nothing. */
  roomAt(x: number, y: number): number | null;
  /** Whether a point of the canvas is on the user's own office (single floor), or on the user's desk or tray of a lobby. */
  officeAt(x: number, y: number): boolean;
  draw(scene: RoomScene, at: number): void;
  /** True while something moves by itself: the view flying somewhere, or the tray count that just rose (never with reduced motion). */
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
/**
 * The furthest: one device pixel per art pixel, never less (a smoothed half
 * step blurred the art). A floor bigger than the screen at one is panned.
 */
export const MIN_ZOOM = 1;
const BUMP_MS = 650;
/** A counter with something to decide flashes this long, once per COUNTER_PERIOD (never with reduced motion). */
const COUNTER_FLASH_MS = 260;
const COUNTER_PERIOD_MS = 1600;
/** The most a counter shows (its font has no plus sign). */
const COUNTER_MAX = 99;
/** How long the view takes to fly to a room or back to the overview. */
const FLIGHT_MS = 380;
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
  const texture = crisp(Texture.from(image));
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

/** Nearest sampling and no mipmaps: pixel art drawn at a whole number of device pixels per pixel. */
function crisp(texture: Texture): Texture {
  texture.source.scaleMode = "nearest";
  texture.source.autoGenerateMipmaps = false;
  return texture;
}

/**
 * A logo `height` pixels high from its image: a PNG from its own pixels, an
 * SVG rasterized at eight times that first; then reduced (shrinkLogo).
 */
function logoPixels(image: HTMLImageElement, height: number, vector: boolean): Pixels | null {
  const natural = { w: image.naturalWidth || image.width, h: image.naturalHeight || image.height };
  if (natural.w === 0 || natural.h === 0) return null;
  const scale = vector ? (height * 8) / natural.h : 1;
  const w = Math.max(1, Math.round(natural.w * scale));
  const h = Math.max(1, Math.round(natural.h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(image, 0, 0, w, h);
  return shrinkLogo({ width: w, height: h, data: context.getImageData(0, 0, w, h).data }, height);
}

/** A crisp texture of a pixel buffer. */
function pixelTexture(pixels: Pixels): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = pixels.width;
  canvas.height = pixels.height;
  canvas.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height), 0, 0);
  return crisp(Texture.from(canvas));
}

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

  // floor.json first, revalidated, then the atlas it was built with (`atlas.hash`): a page never pairs the frames of
  // one build with the image of another (a cached atlas after a rebuild drew shifted furniture and cut signboards).
  const response = await fetch(`${options.floorUrl}/floor.json`, { cache: "no-cache" });
  if (!response.ok) throw new Error(`floor.json: ${response.status}`);
  const floorSet: FloorSet = floorSetSchema.parse(await response.json());
  const atlasImage = await loadImage(`${options.floorUrl}/${floorSet.atlas.file}${floorSet.atlas.hash ? `?v=${floorSet.atlas.hash}` : ""}`);

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

  const atlas = crisp(Texture.from(atlasImage));
  const frameTextures = floorSet.atlas.frames.map(([x, y, w, h]) => new Texture({ source: atlas.source, frame: new Rectangle(x, y, w, h) }));

  // Layers, back to front: the flat floor, the marks on it, everything sorted, effects on top.
  const world = new Container();
  const flatLayer = new Container();
  const marks = new Graphics();
  const sortedLayer = new Container();
  sortedLayer.sortableChildren = true;
  const effects = new Graphics();
  // The signboards stand on the back walls, above anything in front of them: drawn after everything sorted.
  const signLayer = new Container();
  world.addChild(flatLayer, marks, sortedLayer, signLayer, effects);
  app.stage.addChild(world);

  // View: a whole number of device pixels per art pixel, the art point at the centre of the canvas.
  let cssSize = { width: 100, height: 100 };
  let zoom = 1;
  let center: Point = { x: 0, y: 0 };
  let adjusted = false;
  /** The room of the floor the view was last flown to, while nothing else moved it. */
  let focused: number | null = null;
  let layout: RoomLayout | null = null;

  const scale = () => zoom / resolution;
  type View = { zoom: number; center: Point };
  /** The view flying to another (a room clicked, the overview), through whole zoom steps only; null when still. */
  let flight: { from: View; to: View; start: number | null } | null = null;
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
  /** The overview: the largest whole zoom that fits the floor, centred; one device pixel when even that is too big. */
  const overviewView = (): View | null => {
    if (!layout) return null;
    const b = layout.bounds;
    const device = { w: cssSize.width * resolution, h: cssSize.height * resolution };
    const fits = Math.min(device.w / (b.w + 2 * MARGIN), device.h / (b.h + 2 * MARGIN));
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.floor(fits)));
    const overflow = Math.max(((b.w + 2 * MARGIN) * next) / device.w, ((b.h + 2 * MARGIN) * next) / device.h);
    // The single floor is centred on the whole of it (what does not fit is a drag away).
    if (overflow <= NEARLY_FITS || layout.offices.length === 0 || layout.template === "rooms") {
      return { zoom: next, center: { x: b.x + b.w / 2, y: b.y + b.h / 2 } };
    }
    // A floor of one room much too big for the screen even at one device pixel (a phone): show where the agents work.
    const seats = layout.offices.map((office) => screenOf(office.seat.x, office.seat.y));
    return {
      zoom: next,
      center: { x: seats.reduce((sum, p) => sum + p.x, 0) / seats.length, y: seats.reduce((sum, p) => sum + p.y, 0) / seats.length - 40 },
    };
  };
  const fitView = () => {
    const view = overviewView();
    if (!view) return;
    flight = null;
    zoom = view.zoom;
    center = view.center;
    clampCenter();
  };
  /** Takes the view there: at once, or flying (the frame loop moves it while `busy` says so). */
  const goTo = (to: View, animate: boolean) => {
    if (!animate || (to.zoom === zoom && Math.hypot(to.center.x - center.x, to.center.y - center.y) < 1)) {
      flight = null;
      zoom = to.zoom;
      center = to.center;
      clampCenter();
      applyView();
      return;
    }
    flight = { from: { zoom, center }, to, start: null };
  };
  const stepFlight = (at: number) => {
    if (!flight) return;
    flight.start ??= at;
    const t = Math.min(1, (at - flight.start) / FLIGHT_MS);
    const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    const { from, to } = flight;
    // The zoom moves on a log scale, drawn at the nearest whole step: every frame stays crisp.
    zoom = Math.max(MIN_ZOOM, Math.round(Math.exp(Math.log(from.zoom) + (Math.log(to.zoom) - Math.log(from.zoom)) * e)));
    center = { x: from.center.x + (to.center.x - from.center.x) * e, y: from.center.y + (to.center.y - from.center.y) * e };
    if (t >= 1) {
      zoom = to.zoom;
      center = to.center;
      flight = null;
    }
    clampCenter();
    applyView();
  };
  /**
   * The view of a room of the floor (walls and signboard included): at the zoom of `focusZoom`, centred in the
   * part of the canvas left of `insetRight` CSS pixels.
   */
  const roomView = (index: number, insetRight = 0): View | null => {
    const room = layout?.rooms[index];
    if (!room) return null;
    const corners = [
      screenOf(room.x * CELL, room.y * CELL),
      screenOf((room.x + room.w) * CELL, room.y * CELL),
      screenOf(room.x * CELL, (room.y + room.d) * CELL),
      screenOf((room.x + room.w) * CELL, (room.y + room.d) * CELL),
    ];
    const minX = Math.min(...corners.map((p) => p.x)) - 6;
    const maxX = Math.max(...corners.map((p) => p.x)) + 6;
    // The back walls rise above the room, and its signboard (where it stands on the wall, or as high as one may).
    const board = signBoxes.find((box) => box.room === index);
    const wallTop = Math.min(...corners.map((p) => p.y)) - 2 * WALL_HEIGHT - 6;
    const minY = Math.min(wallTop, board ? board.top : room.sign ? wallTop - 2 * (SIGN_TOP - WALL_HEIGHT) : wallTop);
    const maxY = Math.max(...corners.map((p) => p.y)) + 10;
    const inset = Math.max(0, Math.min(cssSize.width - 1, insetRight));
    const device = { w: (cssSize.width - inset) * resolution, h: cssSize.height * resolution };
    // The box has its own few pixels of air: no margin on top of them, so a room fills the view as soon as it fits.
    const fits = Math.min(device.w / (maxX - minX), device.h / (maxY - minY));
    const next = focusZoom(fits, overviewView()?.zoom ?? MIN_ZOOM, MIN_ZOOM, MAX_ZOOM);
    // The centre of the box at the middle of the part left visible (half the inset left of the canvas's centre):
    // a room bigger than the view overflows it evenly on both sides.
    return { zoom: next, center: { x: (minX + maxX) / 2 + ((inset / 2) * resolution) / next, y: (minY + maxY) / 2 } };
  };
  /** A point of the canvas (CSS pixels) in art pixels. */
  const artOf = (x: number, y: number): Point => {
    const at = offset();
    return { x: (x - at.x) / scale(), y: (y - at.y) / scale() };
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
  /** Walls, rims and furniture: their sorted node, footprint, what they cover on the screen, and their fixed depth. */
  let staticItems: { node: Container; box: Box; rect: ScreenRect }[] = [];
  let staticRanks: number[] = [];
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
      const rect = { x0: Number.POSITIVE_INFINITY, y0: Number.POSITIVE_INFINITY, x1: Number.NEGATIVE_INFINITY, y1: Number.NEGATIVE_INFINITY };
      for (const draw of item.draws) {
        const [, , w, h] = floorSet.atlas.frames[draw.frame]!;
        rect.x0 = Math.min(rect.x0, draw.x);
        rect.y0 = Math.min(rect.y0, draw.y);
        rect.x1 = Math.max(rect.x1, draw.x + w);
        rect.y1 = Math.max(rect.y1, draw.y + h);
      }
      staticItems.push({ node: group, box: item.box, rect });
    }
    // The live objects of the user's office (its pile, its letter tray): over the office's own sprite.
    officeLive = null;
    const officeIndex = scene.sorted.findIndex((item) => item.office);
    const officeItem = officeIndex >= 0 ? staticItems[officeIndex] : undefined;
    if (officeItem && next.office) {
      const pile = new Container();
      const mail = new Container();
      officeItem.node.addChild(pile, mail);
      const room = next.rooms[next.office.room]!;
      officeLive = { pile, mail, corner: screenOf(room.x * CELL, room.y * CELL), drawn: { pile: "", mail: "" } };
    }
    // The depth order of the walls and furniture, once for this floor: characters are slotted in between (moverDepths).
    staticRanks = new Array<number>(staticItems.length);
    depthOrder(staticItems.map((each) => each.box)).forEach((index, z) => {
      staticRanks[index] = z;
      staticItems[index]!.node.zIndex = z;
    });
    signKey = "";
  }

  // ---- Signboards (single floor) ----
  /** Logos by URL: their pixels at the height of a face, null while loading or when they fail. */
  const logos = new Map<string, { pixels: Pixels | null; done: boolean }>();
  const faceHeight = floorSet.sign.middle.face.cols.find((col) => col !== null)?.[1] ?? 18;
  const loadLogo = (url: string) => {
    if (logos.has(url)) return;
    logos.set(url, { pixels: null, done: false });
    void (async () => {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${url}: ${response.status}`);
        const blob = await response.blob();
        const local = URL.createObjectURL(blob);
        try {
          const image = await loadImage(local);
          if (destroyed) return;
          logos.set(url, { pixels: logoPixels(image, faceHeight - 2 * LOGO_MARGIN, blob.type === "image/svg+xml"), done: true });
        } finally {
          URL.revokeObjectURL(local);
        }
      } catch {
        logos.set(url, { pixels: null, done: true });
      }
      if (!destroyed) options.onLoad();
    })();
  };
  let signKey = "";
  /** The textures of the names and logos drawn on the boards (their own, destroyed with the boards). */
  let signTextures: Texture[] = [];
  /** The faces of the boards on screen (art pixels), for the pointer: columns, and rows from a top that falls one pixel every two columns. */
  let signBoxes: { room: number; x0: number; x1: number; top: number; h: number }[] = [];
  /** The faces of the counters on screen (art pixels), for the pointer: the room of the home each counts for. */
  let counterBoxes: { room: string; x0: number; y0: number; x1: number; y1: number }[] = [];
  /** The counters drawn: their tinted sprites, the colour of the board, and whether they have something to decide (they flash). */
  let counters: { masks: Sprite[]; color: number; live: boolean }[] = [];
  const signTextOf = (current: RoomLayout, index: number, labels: RoomScene["labels"]): string | null => {
    const room = current.rooms[index]!;
    if (!room.sign) return null;
    if (room.kind === "owner") return labels.officeSign ?? null;
    if (room.project === null) return null;
    return labels.roomSign ? labels.roomSign(room.project) : room.project;
  };
  /** The text of a counter: the count, at most COUNTER_MAX. */
  const counterText = (count: number): string => String(Math.min(COUNTER_MAX, Math.max(0, count)));
  /** A light and a quiet look of a board colour: the flash of a counter, and a counter with nothing to decide. */
  const lighten = (color: number, k: number) => {
    const mix = (shift: number) => {
      const from = (color >> shift) & 255;
      return Math.round(from + (255 - from) * k);
    };
    return (mix(16) << 16) | (mix(8) << 8) | mix(0);
  };
  const blend = (a: number, b: number, k: number) => {
    const mix = (shift: number) => Math.round(((a >> shift) & 255) * (1 - k) + ((b >> shift) & 255) * k);
    return (mix(16) << 16) | (mix(8) << 8) | mix(0);
  };
  /**
   * The signboard of every room that has one: the board in the room colour, the logo and the name on its face.
   * A room with a counter (what waits for the user's decision there) has it beside its name on the same wall when
   * the wall holds both, else on its other back wall by the corner, the name's board starting by the corner too. A counter at zero is quiet (a pale board, a
   * soft ink); above zero it takes the room colour and the contrasted ink, and flashes (see `draw`).
   */
  function buildSigns(current: RoomLayout, scene: RoomScene) {
    const texts = current.rooms.map((_, index) => signTextOf(current, index, scene.labels));
    const urls = current.rooms.map((room) => (room.sign && room.project !== null ? (scene.logos?.[room.project] ?? null) : null));
    for (const url of urls) if (url) loadLogo(url);
    const counts = current.rooms.map((room) => (room.counter && room.project !== null ? counterText(scene.view.pendingByRoom[room.project] ?? 0) : ""));
    const key = `${texts.join("|")}#${urls.map((url) => (url ? `${url}:${logos.get(url)?.done ? 1 : 0}` : "")).join("|")}#${roomColors.join(",")}#${counts.join(",")}`;
    if (key === signKey) return;
    signKey = key;
    signLayer.removeChildren().forEach((child) => child.destroy({ children: true }));
    for (const texture of signTextures) texture.destroy(true);
    signTextures = [];
    signBoxes = [];
    counterBoxes = [];
    counters = [];
    const set = floorSet.sign;
    /**
     * One board at `anchor` (the screen pixel of its back left corner on the floor, under its face): its parts, the
     * board tinted `color`, then its face painted. `mirror` draws it on a wall along y (the art faces +y: a wall
     * along y is its mirror image on the screen), the text still read left to right.
     */
    const board = (anchor: Point, segments: number, color: number, face: ReturnType<typeof paintFace>, mirror: boolean) => {
      const group = new Container();
      const masks: Sprite[] = [];
      const part = (piece: SignPart, k: number) => {
        const shift = { x: k * set.period[0], y: k * set.period[1] };
        const add = (ref: [number, number, number], tint: number | null) => {
          const sprite = new Sprite(frameTextures[ref[0]]!);
          const x = ref[1] + shift.x;
          if (mirror) {
            sprite.scale.x = -1;
            sprite.position.set(anchor.x - x, anchor.y + ref[2] + shift.y);
          } else sprite.position.set(anchor.x + x, anchor.y + ref[2] + shift.y);
          if (tint !== null) {
            sprite.tint = tint;
            masks.push(sprite);
          }
          group.addChild(sprite);
        };
        add(piece.sprite, null);
        for (const mask of piece.masks) add(mask.frame, mask.mode === "pastel" ? pastel(color) : color);
      };
      part(set.left, 0);
      for (let k = 0; k < segments - 1; k += 1) part(set.middle, k);
      part(set.right, segments - 1);
      if (face) {
        const texture = pixelTexture(face.pixels);
        signTextures.push(texture);
        const sprite = new Sprite(texture);
        sprite.position.set(anchor.x + face.left, anchor.y + face.top);
        group.addChild(sprite);
      }
      signLayer.addChild(group);
      return masks;
    };
    current.rooms.forEach((room, index) => {
      const text = texts[index];
      if (!text) return;
      const url = urls[index];
      const logo = url ? (logos.get(url)?.pixels ?? null) : null;
      // The counter beside the name on the same wall when both fit (the pair centred), else on the other back
      // wall, by the corner, the name starting there too (placeSign).
      const { plan, from, counter: place } = placeSign(set, floorSet.font, text, logo?.width ?? 0, room.w * CELL, room.counter && room.project !== null);
      const beside = place?.beside ?? false;
      const anchor = screenOf(room.x * CELL + from, room.y * CELL);
      const color = colorOf(index);
      const columns = faceColumns(set, plan.segments);
      board(anchor, plan.segments, color, paintFace(columns, plan, floorSet.font, inkFor(color), plan.logoWidth > 0 ? logo : null, color), false);
      const first = columns[0];
      const last = columns[columns.length - 1];
      if (first && last) signBoxes.push({ room: index, x0: anchor.x + first.x - 4, x1: anchor.x + last.x + 4, top: anchor.y + first.top - 6, h: first.h + 12 });

      if (!room.counter || room.project === null) return;
      const count = counts[index] ?? "0";
      const live = count !== "0";
      // The counter's own plan: its count centred on a board of COUNTER_SEGMENTS segments.
      const counterPlan = { ...planSign(set, floorSet.font, count, 0, 1000), segments: COUNTER_SEGMENTS };
      counterPlan.start = Math.floor((faceWidth(set, COUNTER_SEGMENTS) - textWidth(floorSet.font, counterPlan.text)) / 2);
      const quiet = lighten(color, 0.62);
      const boardColor = live ? color : quiet;
      const ink = live ? inkFor(color) : blend(quiet, inkFor(quiet), 0.45);
      // On the other wall it is mirrored: its columns run the other way (x' = -x - 1), read left to right.
      const straight = faceColumns(set, COUNTER_SEGMENTS);
      const columnsOf = beside ? straight : straight.map((col) => ({ x: -col.x - 1, top: col.top, h: col.h })).reverse();
      const at = beside ? screenOf(room.x * CELL + (place?.from ?? 0), room.y * CELL) : screenOf(room.x * CELL, room.y * CELL + COUNTER_FROM);
      const masks = board(at, COUNTER_SEGMENTS, boardColor, paintFace(columnsOf, counterPlan, floorSet.font, ink, null, boardColor), !beside);
      counters.push({ masks, color: boardColor, live });
      const a = columnsOf[0];
      const b = columnsOf[columnsOf.length - 1];
      if (a && b) counterBoxes.push({ room: room.project, x0: at.x + a.x - 4, y0: at.y + Math.min(a.top, b.top) - 8, x1: at.x + b.x + 4, y1: at.y + Math.max(a.top, b.top) + a.h + 8 });
    });
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

  /** Sheets of paper in a tray on top of a filing cabinet whose top centre is at `top`: whole art pixels, an outline a pixel wider. */
  const drawPapers = (top: Point, count: number) => {
    const x = Math.round(top.x);
    for (let i = 0; i < count; i += 1) {
      const y = Math.round(top.y) - 58 - i * 2;
      effects.poly([x - 10, y, x, y - 5, x + 10, y, x, y + 5]).fill(theme.woodEdge);
      effects.poly([x - 8, y, x, y - 4, x + 8, y, x, y + 4]).fill(theme.paper);
    }
  };
  /** The screen box of a footprint of cells (art pixels), with `rise` pixels above it for what stands on it. */
  const footprintBox = (cell: [number, number], cells: [number, number], rise: number) => {
    const a = screenOf(cell[0] * CELL, cell[1] * CELL);
    const b = screenOf((cell[0] + cells[0]) * CELL, (cell[1] + cells[1]) * CELL);
    const c = screenOf(cell[0] * CELL, (cell[1] + cells[1]) * CELL);
    const d = screenOf((cell[0] + cells[0]) * CELL, cell[1] * CELL);
    return { x0: c.x - 4, x1: d.x + 4, y0: a.y - rise, y1: b.y + 4 };
  };
  /** Screen boxes of the user's desk and tray of a lobby (the floor of one room), last frame: they open the desk. */
  let userBoxes: { x0: number; y0: number; x1: number; y1: number }[] = [];
  /**
   * The live objects of the user's office (single floor): the hub's pile and letter tray, in containers over the
   * office's sprite, and the state each one shows.
   */
  let officeLive: { pile: Container; mail: Container; corner: Point; drawn: { pile: string; mail: string } } | null = null;
  /** Draws a state of a live object of the office in its container; `colors[k]` tints the masks of slot k. */
  const drawOfficeState = (into: Container, corner: Point, state: OfficeState | undefined, colors: number[]) => {
    into.removeChildren().forEach((child) => child.destroy());
    if (!state) return;
    const add = (ref: [number, number, number], tint: number | null) => {
      const sprite = new Sprite(frameTextures[ref[0]]!);
      sprite.position.set(corner.x + ref[1], corner.y + ref[2]);
      if (tint !== null) sprite.tint = tint;
      into.addChild(sprite);
    };
    add(state.sprite, null);
    for (const mask of state.masks) add(mask.frame, colors[mask.slot] ?? theme.accent);
  };

  let drawnLayout: RoomLayout | null = null;
  /** A room to show, asked for before the floor was built. */
  let pendingFocus: { room: string; animate: boolean; insetRight: number } | null = null;
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
  const inBox = (p: Point, box: { x0: number; y0: number; x1: number; y1: number }) => p.x >= box.x0 && p.x <= box.x1 && p.y >= box.y0 && p.y <= box.y1;

  const renderer: RoomRenderer = {
    get frames() {
      return frames;
    },
    get overview() {
      return !adjusted;
    },
    setSprites(urls, strides = {}) {
      wanted = urls;
      wantedStrides = strides;
      for (const url of Object.values(urls)) loadSheet(url);
    },
    setTheme(next) {
      theme = next;
      // The office's pile takes the theme's accent for an item without a room colour: draw it again.
      if (officeLive) officeLive.drawn = { pile: "", mail: "" };
    },
    resize(cssWidth, cssHeight) {
      cssSize = { width: Math.max(1, cssWidth), height: Math.max(1, cssHeight) };
      app.renderer.resize(cssSize.width, cssSize.height);
      if (!adjusted) fitView();
      else clampCenter();
      applyView();
    },
    setResolution(next) {
      if (next === resolution) return;
      resolution = next;
      app.renderer.resolution = next;
      app.renderer.resize(cssSize.width, cssSize.height);
      if (!adjusted) fitView();
      applyView();
    },
    zoomBy(step, around) {
      // Whole steps only, from one device pixel per art pixel to MAX_ZOOM.
      flight = null;
      focused = null;
      const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom + Math.sign(step)));
      if (next === zoom) return;
      const anchor = around ?? { x: cssSize.width / 2, y: cssSize.height / 2 };
      const art = artOf(anchor.x, anchor.y);
      zoom = next;
      center = { x: art.x - (anchor.x - cssSize.width / 2) / scale(), y: art.y - (anchor.y - cssSize.height / 2) / scale() };
      adjusted = true;
      clampCenter();
      applyView();
    },
    panBy(dx, dy) {
      flight = null;
      focused = null;
      center = { x: center.x - dx / scale(), y: center.y - dy / scale() };
      adjusted = true;
      clampCenter();
      applyView();
    },
    fit(animate = false) {
      const view = overviewView();
      if (!view) return;
      goTo(view, animate);
      adjusted = false;
      focused = null;
    },
    canZoom(step) {
      return step > 0 ? zoom < MAX_ZOOM : zoom > MIN_ZOOM;
    },
    counterAt(x, y) {
      const art = artOf(x, y);
      return counterBoxes.find((box) => inBox(art, box))?.room ?? null;
    },
    roomAt(x, y) {
      if (!layout) return null;
      const art = artOf(x, y);
      // A signboard first (it stands above the floor), then the room whose floor, walls or furniture are there:
      // the ground under the point at rising heights, the first inside a room.
      const board = signBoxes.find((box) => art.x >= box.x0 && art.x <= box.x1 && art.y >= box.top + (art.x - box.x0) / 2 && art.y <= box.top + (art.x - box.x0) / 2 + box.h);
      if (board) return board.room;
      const rooms = layout.rooms;
      for (let z = 0; z <= WALL_HEIGHT; z += 4) {
        const vx = (art.x / 2 + art.y + 2 * z) / 2;
        const vy = (art.y + 2 * z - art.x / 2) / 2;
        const index = rooms.findIndex(
          (room) => vx >= room.x * CELL - 4 && vx < (room.x + room.w) * CELL + 4 && vy >= room.y * CELL - 4 && vy < (room.y + room.d) * CELL + 4,
        );
        if (index >= 0) return index;
      }
      return null;
    },
    officeAt(x, y) {
      const art = artOf(x, y);
      if (userBoxes.some((box) => inBox(art, box))) return true;
      if (!layout?.office) return false;
      return renderer.roomAt(x, y) === layout.office.room;
    },
    focusRoom(name, animate = false, insetRight = 0) {
      if (!layout) {
        // Asked before the first drawing: done once the floor is built.
        pendingFocus = { room: name, animate, insetRight };
        return;
      }
      pendingFocus = null;
      const index = layout.rooms.findIndex((candidate) => candidate.project === name);
      if (index >= 0) renderer.focusIndex(index, animate, insetRight);
    },
    focusIndex(index, animate = false, insetRight = 0) {
      const view = roomView(index, insetRight);
      if (!view) return;
      adjusted = true;
      focused = index;
      goTo(view, animate);
    },
    refocus(insetRight, animate = false) {
      if (focused !== null) renderer.focusIndex(focused, animate, insetRight);
    },
    roomName(index) {
      return layout?.rooms[index]?.project ?? null;
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
      stepFlight(at);
      const key = `${scene.color ?? ""}`;
      if (view.layout !== drawnLayout || key !== staticKey) {
        layout = view.layout;
        buildStatic(view.layout, scene.color);
        drawnLayout = view.layout;
        staticKey = key;
        if (!adjusted) fitView();
        clampCenter();
        applyView();
        if (pendingFocus !== null) renderer.focusRoom(pendingFocus.room, pendingFocus.animate, pendingFocus.insetRight);
      }
      const current = view.layout;
      buildSigns(current, scene);
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

      const standing: { node: AgentNode; box: Box; rect: ScreenRect }[] = [];
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
          // What it covers on the screen, its broom and bucket included.
          const rect = { x0: node.feet.x - 24, y0: node.feet.y - node.height - 4, x1: node.feet.x + 24, y1: node.feet.y + 16 };
          standing.push({ node, box: node.box, rect });
          // A soft shadow under the feet.
          if (agent.alpha > 0.05) marks.ellipse(node.feet.x, node.feet.y, 11, 5).fill({ color: theme.ink, alpha: 0.18 * agent.alpha });
        }
        if (scene.selected === agent.key) {
          marks.ellipse(node.feet.x, node.feet.y, 18, 9).stroke({ width: 2, color: theme.accent, alignment: 0.5 });
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

      // Standing characters among the walls and furniture, whose own order never changes (see moverDepths).
      moverDepths(staticItems, staticRanks, standing).forEach((z, index) => {
        const node = standing[index]!.node.standing;
        if (node.zIndex !== z) node.zIndex = z;
      });

      // The user's desk and the tray of the lobby, with its count (the floor of one room).
      userBoxes = [];
      if (current.user) {
        const deskPiece = current.pieces[current.user.desk]!;
        const deskTop = screenOf((deskPiece.cell[0] + 1) * CELL, deskPiece.cell[1] * CELL + 8);
        labels.place("user-desk", { text: scene.labels.userDesk, x: deskTop.x, y: deskTop.y - 84, size: px(11), weight: 700, tone: "muted", box: "tag", ax: 0.5, ay: 1 });
        const trayPiece = current.pieces[current.user.tray]!;
        const trayTop = screenOf((trayPiece.cell[0] + 0.5) * CELL, (trayPiece.cell[1] + 0.5) * CELL);
        const papers = Math.min(view.pending, 6);
        drawPapers(trayTop, papers);
        const deskTurn = turnOf(floorSet, deskPiece.name, deskPiece.turn);
        userBoxes = [
          footprintBox(deskPiece.cell, deskTurn.cells, 70),
          footprintBox(trayPiece.cell, [1, 1], 80),
        ];
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

      // The single floor: the counters flash while something waits for a decision (never with reduced motion).
      const flash = !reduced && at % COUNTER_PERIOD_MS < COUNTER_FLASH_MS;
      for (const counter of counters) {
        const tint = counter.live && flash ? lighten(counter.color, 0.45) : counter.color;
        for (const sprite of counter.masks) if (sprite.tint !== tint) sprite.tint = tint;
      }
      // The user's own office: the hub's pile (a folder per item, each in its room's colour) and its letter tray.
      if (officeLive && current.office) {
        const states = floorSet.office.states;
        const pileState = Math.min(states.pile.length - 1, view.pending);
        const colors: number[] = [];
        for (const room of current.rooms) {
          if (room.project === null) continue;
          const color = hexToNumber(room.color) ?? theme.accent;
          for (let k = 0; k < (view.pendingByRoom[room.project] ?? 0); k += 1) colors.push(color);
        }
        const pileKey = `${pileState}:${colors.join(",")}:${theme.accent}`;
        if (officeLive.drawn.pile !== pileKey) {
          drawOfficeState(officeLive.pile, officeLive.corner, states.pile[pileState], colors);
          officeLive.drawn.pile = pileKey;
        }
        const mailState = Math.min(states.mail.length - 1, scene.officeTray ?? 0);
        const mailKey = String(mailState);
        if (officeLive.drawn.mail !== mailKey) {
          drawOfficeState(officeLive.mail, officeLive.corner, states.mail[mailState], []);
          officeLive.drawn.mail = mailKey;
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
      if (flight) return true;
      if (reduced) return false;
      return at - bumpAt < BUMP_MS;
    },
    destroy() {
      destroyed = true;
      app.destroy({ removeView: false }, { children: true });
      for (const texture of signTextures) texture.destroy(true);
    },
  };
  return renderer;
}
