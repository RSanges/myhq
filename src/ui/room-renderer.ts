import { Application, Container, Graphics, Rectangle, Sprite, Texture } from "pixi.js";
import type { LabelLayer } from "./room-labels";
import { DESK_H, DESK_W, SPRITE_SIZE, WALL, type Item, type RoomLayout } from "./room-layout";
import type { AgentView, RoomView } from "./room-model";
import { RECEPTION_KEY } from "./reception";

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
  /** Colour of the room (a normalized hex): a thin line under each agent's name plate. Null: none. */
  color: string | null;
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

/** The plan is never scaled past this: a character is then about 64 px on screen. */
export const MAX_SCALE = 2.45;

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

  const toneColor = (tone: Item["tone"]): number => {
    switch (tone) {
      case "wood":
        return theme.wood;
      case "dark":
        return theme.appliance;
      case "soft":
        return blend(theme.accent, theme.wall, 0.72);
      case "paper":
        return theme.paper;
      case "chair":
        return theme.line;
      case "green":
        return theme.ok;
      case "leaf":
        return blend(theme.ok, theme.ink, 0.3);
    }
  };

  /** The furniture and the plan: redrawn only when the layout or the theme changes. */
  function drawStatic(layout: RoomLayout) {
    const g = background;
    g.clear();
    const outline = layout.outline.flatMap((point) => [point.x, point.y]);
    g.poly(outline).fill(theme.floor);
    // The inside of each room; the common rooms are warmer, a closet and a vacant office duller.
    for (const { kind, rect, vacant } of layout.rooms) {
      const color =
        vacant ? blend(theme.wall, theme.floor, 0.6) : kind === "closet" ? blend(theme.wall, theme.floor, 0.35) : kind === "kitchen" || kind === "lounge" || kind === "meeting" ? blend(theme.wall, theme.wood, 0.1) : theme.wall;
      g.rect(rect.x, rect.y, rect.w, rect.h).fill(color);
    }

    // Furniture.
    for (const item of layout.items) {
      if (item.t === "disc") g.circle(item.x, item.y, item.r).fill(toneColor(item.tone)).stroke({ width: 0.8, color: theme.woodEdge, alpha: 0.7 });
      else g.roundRect(item.x, item.y, item.w, item.h, item.r ?? 2).fill(toneColor(item.tone)).stroke({ width: 0.8, color: theme.woodEdge, alpha: 0.7 });
    }
    for (const office of layout.offices) g.circle(office.chair.x, office.chair.y, 7).fill(theme.line).stroke({ width: 0.8, color: theme.woodEdge });

    // The whiteboard of the meeting room.
    if (layout.meeting) {
      const b = layout.meeting.board;
      g.roundRect(b.x - 2, b.y - 2, b.w + 4, b.h + 4, 4).fill(theme.line);
      g.roundRect(b.x, b.y, b.w, b.h, 3).fill(theme.card);
    }

    // The user's office: chair, desk, monitor. The lobby: the console and the tray.
    const u = layout.user;
    g.circle(u.chair.x, u.chair.y, 7).fill(theme.line).stroke({ width: 0.8, color: theme.woodEdge });
    g.roundRect(u.desk.x, u.desk.y, u.desk.w, u.desk.h, 3).fill(theme.wood).stroke({ width: 1.2, color: theme.woodEdge });
    g.roundRect(u.monitor.x, u.monitor.y, u.monitor.w, u.monitor.h, 2).fill(theme.appliance);
    g.roundRect(u.monitor.x + 2, u.monitor.y + 2, u.monitor.w - 4, u.monitor.h - 4, 1).fill(theme.card);
    g.roundRect(u.console.x, u.console.y, u.console.w, u.console.h, 2).fill(theme.wood).stroke({ width: 1, color: theme.woodEdge });
    g.roundRect(u.tray.x, u.tray.y, u.tray.w, u.tray.h, 2).fill(theme.woodEdge);
    g.roundRect(u.tray.x + 1.5, u.tray.y + 1.5, u.tray.w - 3, u.tray.h - 3, 1.5).fill(blend(theme.wood, theme.woodEdge, 0.35));

    // The coffee machine.
    if (layout.coffee) {
      const m = layout.coffee;
      g.roundRect(m.x, m.y, m.w, m.h, 3).fill(theme.appliance);
      g.rect(m.x + 3, m.y + 2.5, m.w - 6, 3).fill(theme.card);
      g.rect(m.x + 4, m.y + 7, m.w - 8, 2.5).fill(theme.accent);
    }

    // Walls over everything: ink, thick, with a gap at each door and none on an open side.
    for (const { a, b } of layout.walls) g.moveTo(a.x, a.y).lineTo(b.x, b.y);
    g.stroke({ width: WALL, color: theme.ink, alpha: 0.78, join: "miter", cap: "square" });
    // Window bands along the outer walls.
    for (const { a, b } of layout.windows) g.moveTo(a.x, a.y).lineTo(b.x, b.y);
    g.stroke({ width: WALL * 1.5, color: blend(theme.floor, theme.accent, 0.5), cap: "butt" });
    for (const { a, b } of layout.windows) g.moveTo(a.x, a.y).lineTo(b.x, b.y);
    g.stroke({ width: 0.7, color: theme.card, cap: "butt" });

    // Desks of the offices, in front of the seated characters (with a laptop each).
    const d = deskFront;
    d.clear();
    for (const desk of [...layout.offices.map((office) => office.desk), ...layout.vacantDesks]) {
      d.roundRect(desk.x, desk.y, DESK_W, DESK_H, 2.5).fill(theme.wood).stroke({ width: 1, color: theme.woodEdge });
      d.roundRect(desk.x + DESK_W / 2 - 8, desk.y + 2.5, 16, 8, 1.5).fill(theme.appliance);
      d.roundRect(desk.x + DESK_W / 2 - 6.5, desk.y + 3.7, 13, 5.2, 1).fill(theme.card);
      d.circle(desk.x + DESK_W - 6, desk.y + 8, 2.2).fill(theme.card).stroke({ width: 0.8, color: theme.ink });
    }

    // The reception desk of the lobby: a counter with a bell and a small screen, in front of the receptionist.
    if (layout.reception) {
      const { counter, bell, screen } = layout.reception;
      d.roundRect(counter.x, counter.y, counter.w, counter.h, 2.5).fill(theme.wood).stroke({ width: 1.2, color: theme.woodEdge });
      d.rect(counter.x + 2, counter.y + counter.h - 3.5, counter.w - 4, 1.4).fill(theme.woodEdge);
      d.roundRect(screen.x, screen.y, screen.w, screen.h, 1.5).fill(theme.appliance);
      d.roundRect(screen.x + 1.5, screen.y + 1.5, screen.w - 3, screen.h - 3.5, 1).fill(theme.card);
      d.rect(screen.x + screen.w / 2 - 2, screen.y + screen.h, 4, 1.6).fill(theme.appliance);
      d.ellipse(bell.x, bell.y + 1.5, 4.2, 1.2).fill(theme.woodEdge);
      d.moveTo(bell.x - 3.4, bell.y + 1).arc(bell.x, bell.y + 1, 3.4, Math.PI, 0).closePath().fill(theme.accent).stroke({ width: 0.7, color: theme.woodEdge });
      d.circle(bell.x, bell.y - 3, 0.9).fill(theme.woodEdge);
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
      const b = layout.meeting?.board ?? { x: 0, y: 0, w: 0, h: 0 };
      const rowH = Math.min(18, (b.h - 28) / Math.max(1, scene.board.rows.length));
      // Text grows with the room it has: a deep floor gives a roomier board.
      const labelSize = Math.min(10, Math.max(5, rowH * 0.58));
      const valueSize = Math.min(10.5, Math.max(5.5, rowH * 0.62));
      if (layout.meeting) labels.place("board-title", { text: scene.board.title, x: b.x + 8, y: b.y + 6, size: Math.min(11, labelSize + 1), tone: "muted", weight: 700, display: true, ax: 0, ay: 0 });
      const top = b.y + 8 + Math.min(11, labelSize + 1) * 1.6;
      scene.board.rows.slice(0, layout.meeting ? boardRows : 0).forEach((row, index) => {
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

      // The user's office: its name, and the tray of the lobby with its count.
      const u = layout.user;
      labels.place("user-plate", { text: scene.labels.userDesk, x: u.plate.x, y: u.plate.y, size: 7, tone: "muted", weight: 700 });
      for (let i = 0; i < Math.min(view.pending, 5); i += 1) {
        over.roundRect(u.tray.x + 3 + (i % 2), u.tray.y + u.tray.h - 5 - i * 1.8, u.tray.w - 8, 3.5, 0.8)
          .fill(theme.paper)
          .stroke({ width: 0.6, color: theme.woodEdge });
      }
      if (lastPending >= 0 && view.pending > lastPending) bumpAt = at;
      lastPending = view.pending;
      const bump = reduced ? 0 : Math.max(0, 1 - (at - bumpAt) / BUMP_MS);
      labels.place("tray-label", { text: scene.labels.tray, x: u.console.x + u.console.w + 5, y: u.console.y + 1, size: 6.5, tone: "muted", weight: 700, ax: 0, ay: 0 });
      labels.place("tray-count", {
        text: String(view.pending),
        x: u.console.x + u.console.w + 5,
        y: u.console.y + 8,
        size: 12,
        weight: 700,
        display: true,
        tone: view.pending > 0 ? "accent" : "muted",
        ax: 0,
        ay: 0,
        pop: 1 + 0.3 * bump,
      });

      // Coffee steam, unless motion is reduced.
      if (!reduced && layout.coffee) {
        const m = layout.coffee;
        for (let i = 0; i < 3; i += 1) {
          const phase = (at / 1600 + i / 3) % 1;
          over.circle(m.x + m.w / 2 + Math.sin(phase * 6 + i) * 1.5, m.y - 2 - phase * 11, 1.2 + phase * 1.3).fill({
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

        // The name plate on the wall outside the door of the office (under the counter for the receptionist), and a tag under a character that is away from its office.
        if (agent.key === RECEPTION_KEY && layout.reception) {
          const { plate } = layout.reception;
          labels.place(`plate:${agent.key}`, { text: agent.name, x: plate.x, y: plate.y, size: 6.6, weight: 700, box: "plate", ax: 0.5, ay: 0 });
        } else {
          const office = layout.offices.find((spot) => spot.key === agent.key);
          if (office) labels.place(`plate:${agent.key}`, { text: agent.name, x: office.plate.x, y: office.plate.y, size: 6.6, weight: 700, box: "plate", ax: office.plate.ax === 0 ? 0 : 1, color: scene.color });
        }
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
