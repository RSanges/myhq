import { Application, Container, Graphics, Rectangle, Sprite, Texture } from "pixi.js";
import type { LabelLayer } from "./room-labels";
import { SPRITE_SIZE, WALL, type Door, type Rect, type RoomLayout } from "./room-layout";
import type { AgentView, RoomView } from "./room-model";

// The drawing of the floor, behind a small interface (create, draw a state,
// resize, destroy) so that the engine can change without touching the model or
// the page. PixiJS, WebGL, at the device pixel ratio of the screen. The plan is
// drawn in world units and scaled uniformly to the canvas (see `resize`). It
// draws shapes and sprites only: every piece of text is an HTML label over the
// canvas (room-labels.ts). This module is only ever imported dynamically, on
// the client.

/** Colors as numbers (0xRRGGBB), read from the page's CSS tokens so the floor follows light and dark. */
export type RoomTheme = {
  /** The corridor, and the ground of the plan. */
  floor: number;
  floorLine: number;
  /** The inside of an office. */
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

export type BoardLine = { key: string; label: string; value: string };

/** Everything the drawing needs besides the animation state (it holds no wording of its own). */
export type RoomScene = {
  view: RoomView;
  board: { title: string; rows: BoardLine[] };
  labels: { userDesk: string; tray: string };
  selected: string | null;
  reduced: boolean;
};

export type RoomRenderer = {
  /** Character sheet URL per agent key; null, or a sheet that fails to load, means the neutral one. */
  setSprites(urls: Record<string, string | null>): void;
  setTheme(theme: RoomTheme): void;
  /** Fits the plan (world units) to a canvas of this CSS size, centered, one scale for both axes. */
  resize(cssWidth: number, cssHeight: number, world: { width: number; height: number }): void;
  /** The screen's device pixel ratio changed (zoom, another screen): draw at the new density. */
  setResolution(resolution: number): void;
  /** A point of the canvas (CSS pixels, from its top left) in world units. */
  toWorld(x: number, y: number): { x: number; y: number };
  draw(scene: RoomScene, at: number): void;
  /** True while a transient effect (a figure that just changed, the tray) still needs frames; never with reduced motion. */
  busy(at: number, reduced: boolean): boolean;
  /** Frames drawn so far (the measure of "nothing is drawn while the tab is hidden"). */
  readonly frames: number;
  destroy(): void;
};

export type RendererOptions = {
  canvas: HTMLCanvasElement;
  neutralSheetUrl: string;
  /** Where the text of the floor goes. */
  labels: LabelLayer;
  theme: RoomTheme;
};

/** Tints of the neutral character, per agent (colour-blind safe, none of them the floor's). */
export const NEUTRAL_TINTS = [0xe69f00, 0x56b4e9, 0x009e73, 0xcc79a7, 0x0072b2, 0xd55e00, 0xf0e442, 0x9a9a9a] as const;

/** The plan is never scaled past this, so that a floor with two offices does not turn into giants. */
export const MAX_SCALE = 1.9;

const SHEET_COLUMNS = 4;
const SHEET_ROWS = 4;
const FLASH_MS = 1_800;
const BUMP_MS = 650;

type Sheet = { frames: Texture[][]; cell: number; texture: Texture };

function sliceSheet(texture: Texture): Sheet | null {
  const { width, height } = texture.source;
  const cell = width / SHEET_COLUMNS;
  if (width !== height || !Number.isInteger(cell) || cell < 16) return null;
  texture.source.scaleMode = "nearest";
  const frames: Texture[][] = [];
  for (let row = 0; row < SHEET_ROWS; row += 1) {
    const line: Texture[] = [];
    for (let col = 0; col < SHEET_COLUMNS; col += 1) {
      line.push(new Texture({ source: texture.source, frame: new Rectangle(col * cell, row * cell, cell, cell) }));
    }
    frames.push(line);
  }
  return { frames, cell, texture };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`cannot load ${url}`));
    image.src = url;
  });
}

type AgentNode = { sprite: Sprite; sheetUrl: string | null };

export async function createRoomRenderer(options: RendererOptions): Promise<RoomRenderer> {
  const { canvas, labels } = options;
  let theme = options.theme;
  let resolution = window.devicePixelRatio || 1;
  const app = new Application();
  await app.init({
    canvas,
    width: 100,
    height: 100,
    resolution,
    autoDensity: true,
    antialias: true,
    backgroundAlpha: 0,
    autoStart: false,
    sharedTicker: false,
    preference: "webgl",
  });

  let scale = 1;
  let offset = { x: 0, y: 0 };
  let cssSize = { width: 100, height: 100 };

  // Layers, back to front.
  const background = new Graphics();
  const under = new Graphics();
  const seatedLayer = new Container();
  const deskFront = new Graphics();
  const movingLayer = new Container();
  movingLayer.sortableChildren = true;
  const over = new Graphics();
  app.stage.addChild(background, under, seatedLayer, deskFront, movingLayer, over);

  const boardRows = 8;

  // Textures: the neutral sheet, and the sheets of the agents that have their own.
  let neutral: Sheet | null = null;
  const sheets = new Map<string, Sheet | null>();
  const nodes = new Map<string, AgentNode>();
  let wanted: Record<string, string | null> = {};
  let drawnLayout: RoomLayout | null = null;
  let themeVersion = 0;
  let drawnThemeVersion = -1;
  let frames = 0;
  let destroyed = false;

  /** Sheets drawn well below their size are smoothed, otherwise nearest keeps them crisp. */
  const applyFiltering = () => {
    const device = SPRITE_SIZE * scale * resolution;
    for (const sheet of [neutral, ...sheets.values()]) {
      if (sheet) sheet.texture.source.scaleMode = device < sheet.cell * 0.75 ? "linear" : "nearest";
    }
  };

  void loadImage(options.neutralSheetUrl)
    .then((image) => {
      if (destroyed) return;
      neutral = sliceSheet(Texture.from(image));
      applyFiltering();
    })
    .catch(() => undefined);

  const loadSheet = (url: string) => {
    if (sheets.has(url)) return;
    sheets.set(url, null);
    void loadImage(url)
      .then((image) => {
        if (destroyed) return;
        sheets.set(url, sliceSheet(Texture.from(image)));
        applyFiltering();
      })
      .catch(() => undefined);
  };

  const nodeFor = (view: AgentView): AgentNode => {
    let node = nodes.get(view.key);
    if (node) return node;
    const sprite = new Sprite();
    sprite.anchor.set(0.5, 1);
    node = { sprite, sheetUrl: null };
    nodes.set(view.key, node);
    return node;
  };

  const blend = (a: number, b: number, t: number): number => {
    const mix = (shift: number) => Math.round(((a >> shift) & 255) * (1 - t) + ((b >> shift) & 255) * t);
    return (mix(16) << 16) | (mix(8) << 8) | mix(0);
  };

  /** The four walls of a room as thick lines, with a gap where the door is. */
  function walls(g: Graphics, room: Rect, door: Door | null) {
    const { x, y, w, h } = room;
    const half = door ? door.w / 2 : 0;
    const line = (x1: number, y1: number, x2: number, y2: number) => g.moveTo(x1, y1).lineTo(x2, y2);
    const horizontal = (wallY: number, which: "top" | "bottom") => {
      if (door && door.wall === which) {
        line(x, wallY, door.x - half, wallY);
        line(door.x + half, wallY, x + w, wallY);
      } else line(x, wallY, x + w, wallY);
    };
    horizontal(y, "top");
    horizontal(y + h, "bottom");
    if (door && door.wall === "left") {
      line(x, y, x, door.y - half);
      line(x, door.y + half, x, y + h);
    } else line(x, y, x, y + h);
    line(x + w, y, x + w, y + h);
  }

  /** The furniture and the plan: redrawn only when the layout or the theme changes. */
  function drawStatic(layout: RoomLayout) {
    const g = background;
    g.clear();
    const margin = layout.meeting.room.x;
    g.rect(margin, margin, layout.width - 2 * margin, layout.height - 2 * margin).fill(theme.floor);
    const rooms: Rect[] = [
      ...layout.offices.map((office) => office.room),
      ...layout.vacant,
      layout.meeting.room,
      layout.coffee.room,
      layout.user.room,
    ];
    for (const room of rooms) g.rect(room.x, room.y, room.w, room.h).fill(theme.wall);
    // A vacant slot is shaded: nobody works there.
    for (const room of layout.vacant) g.rect(room.x, room.y, room.w, room.h).fill({ color: theme.floor, alpha: 0.8 });

    // Doors: a threshold in the floor tone across each gap.
    const gap = (door: Door) => {
      if (door.wall === "left") g.rect(door.x - WALL, door.y - door.w / 2, WALL * 2, door.w).fill(theme.floor);
      else g.rect(door.x - door.w / 2, door.y - WALL, door.w, WALL * 2).fill(theme.floor);
    };

    // Meeting room: the whiteboard on the back wall and a table.
    const b = layout.meeting.board;
    g.roundRect(b.x - 2, b.y - 2, b.w + 4, b.h + 4, 4).fill(theme.line);
    g.roundRect(b.x, b.y, b.w, b.h, 3).fill(theme.card);
    const m = layout.meeting.room;
    g.roundRect(m.x + 44, m.y + m.h - 30, m.w - 88, 14, 7).fill(theme.wood).stroke({ width: 1, color: theme.woodEdge });

    // The user's office: desk, monitor, chair, tray.
    const u = layout.user;
    g.circle(u.chair.x, u.chair.y, 7).fill(theme.line).stroke({ width: 1, color: theme.woodEdge });
    g.roundRect(u.desk.x, u.desk.y, u.desk.w, u.desk.h, 3).fill(theme.wood).stroke({ width: 1.5, color: theme.woodEdge });
    g.roundRect(u.monitor.x, u.monitor.y, u.monitor.w, u.monitor.h, 2).fill(theme.appliance);
    g.roundRect(u.monitor.x + 2, u.monitor.y + 2, u.monitor.w - 4, u.monitor.h - 4, 1).fill(theme.card);
    g.roundRect(u.tray.x, u.tray.y, u.tray.w, u.tray.h, 3).fill(theme.woodEdge);
    g.roundRect(u.tray.x + 2, u.tray.y + 2, u.tray.w - 4, u.tray.h - 4, 2).fill(blend(theme.wood, theme.woodEdge, 0.35));

    // Coffee corner.
    const c = layout.coffee;
    g.roundRect(c.machine.x, c.machine.y, c.machine.w, c.machine.h, 4).fill(theme.appliance);
    g.rect(c.machine.x + 5, c.machine.y + 5, c.machine.w - 10, 8).fill(theme.card);
    g.rect(c.machine.x + 8, c.machine.y + 18, c.machine.w - 16, 5).fill(theme.accent);
    g.circle(c.table.x, c.table.y, 14).fill(theme.wood).stroke({ width: 1.5, color: theme.woodEdge });
    g.circle(c.table.x - 3, c.table.y - 2, 3.2).fill(theme.card).stroke({ width: 1, color: theme.ink });
    g.circle(c.plant.x - 4, c.plant.y - 6, 7).fill(theme.ok);
    g.circle(c.plant.x + 5, c.plant.y - 8, 8).fill(blend(theme.ok, theme.floor, 0.25));
    g.roundRect(c.plant.x - 7, c.plant.y, 14, 10, 2).fill(theme.woodEdge);

    // Chairs of the offices.
    for (const office of layout.offices) {
      g.circle(office.chair.x, office.chair.y, 7.5).fill(theme.line).stroke({ width: 1, color: theme.woodEdge });
    }

    // Doors, then the walls over everything: ink, thick, with a gap at each door.
    for (const office of layout.offices) gap(office.door);
    gap(layout.meeting.door);
    gap(layout.coffee.door);
    gap(layout.user.door);
    for (const office of layout.offices) walls(g, office.room, office.door);
    for (const room of layout.vacant) walls(g, room, null);
    walls(g, layout.meeting.room, layout.meeting.door);
    walls(g, layout.coffee.room, layout.coffee.door);
    walls(g, layout.user.room, layout.user.door);
    // The corridor is closed at its far end.
    g.moveTo(layout.corridor.x, layout.corridor.y).lineTo(layout.corridor.x, layout.corridor.y + layout.corridor.h);
    g.stroke({ width: WALL, color: theme.ink, alpha: 0.78, join: "miter", cap: "square" });

    // Desks of the offices, in front of the seated characters.
    const d = deskFront;
    d.clear();
    for (const office of layout.offices) {
      const r = office.desk;
      d.roundRect(r.x, r.y, r.w, r.h, 3).fill(theme.wood).stroke({ width: 1.2, color: theme.woodEdge });
      d.roundRect(r.x + r.w / 2 - 10, r.y + 3, 20, 11, 2).fill(theme.appliance);
      d.roundRect(r.x + r.w / 2 - 8, r.y + 4.5, 16, 7, 1).fill(theme.card);
      d.circle(r.x + r.w - 8, r.y + 10, 3).fill(theme.card).stroke({ width: 1, color: theme.ink });
    }
  }

  function nodeSheet(node: AgentNode): Sheet | null {
    const own = node.sheetUrl ? sheets.get(node.sheetUrl) : null;
    return own ?? neutral;
  }

  /** The shape of a bubble's tail stays in the canvas; its text and box are HTML. */
  function drawBubble(view: AgentView, at: number, reduced: boolean) {
    const bubble = view.bubble;
    if (!bubble || view.alpha < 0.5) return;
    const bob = reduced ? 0 : Math.sin(at / 420 + view.index) * 1;
    const top = view.y - SPRITE_SIZE - 3 + bob;
    const key = `bubble:${view.key}`;
    if (bubble.kind === "thought") {
      labels.place(key, { text: bubble.text, x: view.x, y: top - 4, size: 8, ax: 0.5, ay: 1, box: "bubble", maxWidth: 100, clamp: true });
      over.circle(view.x - 2.5, top - 1, 1.5).circle(view.x - 5, top + 2.5, 1).fill(theme.card);
    } else if (bubble.kind === "question") {
      labels.place(key, { text: "?", x: view.x, y: top - 8, size: 8, tone: "onDanger", weight: 700, box: "badge" });
    } else if (bubble.kind === "talk") {
      labels.place(key, { text: "...", x: view.x, y: top - 6, size: 8, weight: 700, ax: 0.5, ay: 1, box: "bubble" });
    } else {
      labels.place(key, { text: "z Z", x: view.x + 4, y: top + 4 + bob, size: 8, tone: "muted", ax: 0, ay: 1 });
    }
  }

  const flashAt = new Map<string, number>();
  const lastValue = new Map<string, string>();
  let bumpAt = Number.NEGATIVE_INFINITY;
  let lastPending = -1;

  return {
    get frames() {
      return frames;
    },
    setSprites(urls) {
      wanted = urls;
      for (const url of Object.values(urls)) if (url) loadSheet(url);
    },
    setTheme(next) {
      theme = next;
      themeVersion += 1;
    },
    resize(cssWidth, cssHeight, world) {
      cssSize = { width: cssWidth, height: cssHeight };
      scale = Math.min(cssWidth / world.width, cssHeight / world.height, MAX_SCALE);
      offset = { x: (cssWidth - world.width * scale) / 2, y: (cssHeight - world.height * scale) / 2 };
      app.renderer.resize(Math.max(1, Math.round(cssWidth)), Math.max(1, Math.round(cssHeight)));
      app.stage.scale.set(scale);
      app.stage.position.set(offset.x, offset.y);
      labels.setView(scale, offset.x, offset.y, world.width);
      applyFiltering();
    },
    setResolution(next) {
      if (next === resolution) return;
      resolution = next;
      app.renderer.resolution = next;
      app.renderer.resize(Math.max(1, Math.round(cssSize.width)), Math.max(1, Math.round(cssSize.height)));
      applyFiltering();
    },
    toWorld(x, y) {
      return { x: (x - offset.x) / scale, y: (y - offset.y) / scale };
    },
    draw(scene, at) {
      if (destroyed) return;
      const { view, reduced } = scene;
      const layout = view.layout;
      if (layout !== drawnLayout || themeVersion !== drawnThemeVersion) {
        drawStatic(layout);
        drawnLayout = layout;
        drawnThemeVersion = themeVersion;
      }
      under.clear();
      over.clear();

      // The whiteboard of the meeting room: a flash on a figure that just moved.
      const b = layout.meeting.board;
      const rowH = Math.min(18, (b.h - 28) / Math.max(1, scene.board.rows.length));
      // Text grows with the room it has: a deep floor gives a roomier board.
      const labelSize = Math.min(10, Math.max(7.5, rowH * 0.58));
      const valueSize = Math.min(10.5, Math.max(8, rowH * 0.62));
      labels.place("board-title", { text: scene.board.title, x: b.x + 8, y: b.y + 6, size: Math.min(11, labelSize + 1), tone: "muted", weight: 700, display: true, ax: 0, ay: 0 });
      const top = b.y + 8 + Math.min(11, labelSize + 1) * 1.6;
      scene.board.rows.slice(0, boardRows).forEach((row, index) => {
        if (lastValue.has(row.key) && lastValue.get(row.key) !== row.value) flashAt.set(row.key, at);
        lastValue.set(row.key, row.value);
        const flashing = !reduced && at - (flashAt.get(row.key) ?? Number.NEGATIVE_INFINITY) < FLASH_MS;
        const y = top + index * rowH;
        if (flashing) {
          const fade = 1 - (at - flashAt.get(row.key)!) / FLASH_MS;
          over.roundRect(b.x + 4, y - 1, b.w - 8, rowH, 2).fill({ color: theme.accent, alpha: 0.18 * fade });
        }
        labels.place(`board-l${index}`, { text: row.label, x: b.x + 8, y, size: labelSize, weight: 400, tone: "muted", ax: 0, ay: 0 });
        labels.place(`board-v${index}`, {
          text: row.value,
          x: b.x + b.w - 8,
          y,
          size: valueSize,
          weight: 700,
          display: true,
          tone: flashing ? "accent" : "ink",
          ax: 1,
          ay: 0,
        });
      });

      // The user's office: its name on the back wall, the tray and its count.
      const u = layout.user;
      labels.place("user-plate", { text: scene.labels.userDesk, x: u.room.x + u.room.w / 2, y: u.room.y + 11, size: 8, tone: "muted", weight: 700 });
      for (let i = 0; i < Math.min(view.pending, 5); i += 1) {
        over.roundRect(u.tray.x + 4 + (i % 2), u.tray.y + u.tray.h - 8 - i * 2.5, u.tray.w - 8, 5, 1)
          .fill(theme.paper)
          .stroke({ width: 0.8, color: theme.woodEdge });
      }
      if (lastPending >= 0 && view.pending > lastPending) bumpAt = at;
      lastPending = view.pending;
      const bump = reduced ? 0 : Math.max(0, 1 - (at - bumpAt) / BUMP_MS);
      labels.place("tray-label", { text: scene.labels.tray, x: u.tray.x, y: u.room.y + 27, size: 7.5, tone: "muted", weight: 700, ax: 0 });
      labels.place("tray-count", {
        text: String(view.pending),
        x: u.tray.x + 40,
        y: u.room.y + 27,
        size: 13,
        weight: 700,
        display: true,
        tone: view.pending > 0 ? "accent" : "muted",
        ax: 0,
        pop: 1 + 0.3 * bump,
      });

      // Coffee steam, unless motion is reduced.
      if (!reduced) {
        const m = layout.coffee.machine;
        for (let i = 0; i < 3; i += 1) {
          const phase = (at / 1600 + i / 3) % 1;
          over.circle(m.x + m.w + 6 + Math.sin(phase * 6 + i) * 1.5, m.y - 2 - phase * 12, 1.4 + phase * 1.4).fill({
            color: theme.muted,
            alpha: 0.4 * (1 - phase),
          });
        }
      }

      // The agents.
      const sorted = view.agents;
      for (const agent of sorted) {
        const node = nodeFor(agent);
        const url = wanted[agent.key] ?? null;
        if (node.sheetUrl !== url) node.sheetUrl = url;
        const sheet = nodeSheet(node);
        const own = Boolean(node.sheetUrl && sheets.get(node.sheetUrl));
        const office = layout.offices.find((spot) => spot.key === agent.key)!;

        // The name plate on the back wall, and a tag under a character that is away from its office.
        labels.place(`plate:${agent.key}`, { text: agent.name, x: office.plate.x, y: office.plate.y, size: 8.5, weight: 700, box: "plate" });
        if (!agent.seated && agent.alpha > 0.5) {
          labels.place(`tag:${agent.key}`, { text: agent.name, x: agent.x, y: agent.y + 3, size: 7, weight: 700, ay: 0 });
        }

        if (!sheet) {
          node.sprite.visible = false;
          continue;
        }
        node.sprite.visible = true;
        node.sprite.texture = sheet.frames[agent.row]![agent.frame]!;
        const size = SPRITE_SIZE / sheet.cell;
        node.sprite.scale.set(size * agent.facing, size);
        node.sprite.position.set(agent.x, agent.y);
        node.sprite.alpha = agent.alpha;
        node.sprite.tint = own ? 0xffffff : NEUTRAL_TINTS[agent.index % NEUTRAL_TINTS.length]!;
        node.sprite.zIndex = agent.y;
        const layer = agent.seated ? seatedLayer : movingLayer;
        if (node.sprite.parent !== layer) layer.addChild(node.sprite);

        if (agent.alpha > 0.05) {
          under.ellipse(agent.x, agent.y - 0.5, 7, 2.2).fill({ color: theme.ink, alpha: 0.16 * agent.alpha });
        }
        if (scene.selected === agent.key) {
          under.ellipse(agent.x, agent.y - 0.5, 11, 3.8).stroke({ width: 1.6, color: theme.accent });
        }
        if (agent.carrying) {
          const fx = agent.x + agent.facing * 7;
          over.roundRect(fx - 4.5, agent.y - 14, 9, 7, 1).fill(theme.paper).stroke({ width: 0.9, color: theme.woodEdge });
          over.rect(fx - 4.5, agent.y - 14, 4, 2).fill(theme.woodEdge);
        }
      }
      for (const agent of sorted) drawBubble(agent, at, reduced);
      // Drop the nodes of agents that left the room.
      for (const [key, node] of nodes) {
        if (!sorted.some((agent) => agent.key === key)) {
          node.sprite.destroy();
          nodes.delete(key);
        }
      }

      labels.end();
      app.render();
      frames += 1;
    },
    busy(at, reduced) {
      if (reduced) return false;
      for (const changed of flashAt.values()) if (at - changed < FLASH_MS) return true;
      return at - bumpAt < BUMP_MS;
    },
    destroy() {
      destroyed = true;
      app.destroy({ removeView: false }, { children: true });
    },
  };
}
