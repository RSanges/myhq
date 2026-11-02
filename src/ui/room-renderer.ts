import { Application, Container, Graphics, Rectangle, Sprite, Text, Texture } from "pixi.js";
import { SPRITE_SIZE, WORLD_W, type RoomLayout } from "./room-layout";
import type { AgentView, RoomView } from "./room-model";

// The drawing of the room, behind a small interface (mount, draw a state,
// destroy) so that the engine can change without touching the model or the
// page. PixiJS, WebGL, nearest-neighbour textures, resolution capped at 2.
// This module is only ever imported dynamically, on the client.

/** Colors as numbers (0xRRGGBB), read from the page's CSS tokens so the room follows light and dark. */
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
  /** Fits the canvas to a CSS width and returns the CSS height. */
  resize(cssWidth: number, worldHeight: number): number;
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
  bodyFont: string;
  displayFont: string;
  theme: RoomTheme;
};

/** Tints of the neutral character, per agent (colour-blind safe, none of them the floor's). */
export const NEUTRAL_TINTS = [0xe69f00, 0x56b4e9, 0x009e73, 0xcc79a7, 0x0072b2, 0xd55e00, 0xf0e442, 0x9a9a9a] as const;

const SHEET_COLUMNS = 4;
const SHEET_ROWS = 4;
const MAX_RESOLUTION = 2;
const FLASH_MS = 1_800;
const BUMP_MS = 650;

type Sheet = { frames: Texture[][]; cell: number };

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
  return { frames, cell };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`cannot load ${url}`));
    image.src = url;
  });
}

type AgentNode = {
  sprite: Sprite;
  label: Text;
  bubbleText: Text;
  sheetUrl: string | null;
};

export async function createRoomRenderer(options: RendererOptions): Promise<RoomRenderer> {
  const { canvas } = options;
  let theme = options.theme;
  const resolution = Math.min(window.devicePixelRatio || 1, MAX_RESOLUTION);
  const app = new Application();
  await app.init({
    canvas,
    width: WORLD_W,
    height: 400,
    resolution,
    autoDensity: true,
    antialias: true,
    backgroundAlpha: 0,
    autoStart: false,
    sharedTicker: false,
    preference: "webgl",
  });

  const texts: Text[] = [];
  let scale = 1;
  const makeText = (size: number, weight: "400" | "600" | "700", display = false): Text => {
    const text = new Text({
      text: "",
      style: {
        fontFamily: display ? options.displayFont : options.bodyFont,
        fontSize: size,
        fontWeight: weight,
        fill: 0xffffff,
        lineHeight: size * 1.25,
      },
      resolution: resolution,
    });
    texts.push(text);
    return text;
  };
  const setText = (text: Text, value: string, fill: number) => {
    if (text.text !== value) text.text = value;
    if (text.style.fill !== fill) text.style.fill = fill;
  };

  // Layers, back to front.
  const background = new Graphics();
  const under = new Graphics();
  const seatedLayer = new Container();
  const deskFront = new Graphics();
  const movingLayer = new Container();
  movingLayer.sortableChildren = true;
  const over = new Graphics();
  const textLayer = new Container();
  app.stage.addChild(background, under, seatedLayer, deskFront, movingLayer, over, textLayer);

  const boardTitle = makeText(11, "700", true);
  const boardLabels: Text[] = [];
  const boardValues: Text[] = [];
  const userLabel = makeText(10, "600");
  const trayLabel = makeText(9, "700");
  const trayCount = makeText(20, "700", true);
  textLayer.addChild(boardTitle, userLabel, trayLabel, trayCount);
  boardTitle.anchor.set(0, 0);
  userLabel.anchor.set(0.5, 0);
  trayCount.anchor.set(0, 0.5);

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

  void loadImage(options.neutralSheetUrl)
    .then((image) => {
      if (!destroyed) neutral = sliceSheet(Texture.from(image));
    })
    .catch(() => undefined);

  const loadSheet = (url: string) => {
    if (sheets.has(url)) return;
    sheets.set(url, null);
    void loadImage(url)
      .then((image) => {
        if (!destroyed) sheets.set(url, sliceSheet(Texture.from(image)));
      })
      .catch(() => undefined);
  };

  const nodeFor = (view: AgentView): AgentNode => {
    let node = nodes.get(view.key);
    if (node) return node;
    const sprite = new Sprite();
    sprite.anchor.set(0.5, 1);
    const label = makeText(11, "700");
    label.anchor.set(0.5, 0);
    const bubbleText = makeText(9, "600");
    textLayer.addChild(label, bubbleText);
    node = { sprite, label, bubbleText, sheetUrl: null };
    nodes.set(view.key, node);
    return node;
  };

  const blend = (a: number, b: number, t: number): number => {
    const mix = (shift: number) => Math.round(((a >> shift) & 255) * (1 - t) + ((b >> shift) & 255) * t);
    return (mix(16) << 16) | (mix(8) << 8) | mix(0);
  };

  /** The furniture: redrawn only when the layout or the theme changes. */
  function drawStatic(layout: RoomLayout) {
    const g = background;
    g.clear();
    g.rect(0, 0, layout.width, layout.height).fill(theme.floor);
    for (let x = 48; x < layout.width; x += 48) g.moveTo(x, 0).lineTo(x, layout.height);
    for (let y = 48; y < layout.height; y += 48) g.moveTo(0, y).lineTo(layout.width, y);
    g.stroke({ width: 1, color: theme.floorLine, alpha: 0.5 });

    // The wall at the back, with its baseboard.
    const wallH = layout.userDesk.y + layout.userDesk.h + 28;
    g.rect(0, 0, layout.width, wallH).fill(theme.wall);
    g.rect(0, wallH, layout.width, 4).fill(theme.wallEdge);

    // The whiteboard.
    const b = layout.board;
    g.roundRect(b.x - 5, b.y - 5, b.w + 10, b.h + 10, 7).fill(theme.line);
    g.roundRect(b.x, b.y, b.w, b.h, 4).fill(theme.card);
    g.moveTo(b.x + 6, b.y + b.h + 3).lineTo(b.x + b.w - 6, b.y + b.h + 3).stroke({ width: 3, color: theme.wallEdge });

    // The user's desk, with its chair, monitor and the tray.
    const u = layout.userDesk;
    g.circle(layout.userChair.x, layout.userChair.y, 15).fill(theme.line).stroke({ width: 2, color: theme.wallEdge });
    g.roundRect(u.x, u.y, u.w, u.h, 5).fill(theme.wood).stroke({ width: 2, color: theme.woodEdge });
    g.roundRect(u.x + u.w - 46, u.y + 8, 34, 22, 3).fill(theme.appliance);
    g.roundRect(u.x + u.w - 43, u.y + 11, 28, 14, 2).fill(theme.card);
    const t = layout.tray;
    g.roundRect(t.x, t.y, t.w, t.h, 4).fill(theme.woodEdge);
    g.roundRect(t.x + 3, t.y + 3, t.w - 6, t.h - 6, 3).fill(blend(theme.wood, theme.woodEdge, 0.35));

    // The chairs of the agents.
    for (const desk of layout.desks) {
      g.circle(desk.chair.x, desk.chair.y, 17).fill(theme.line).stroke({ width: 2, color: theme.wallEdge });
    }

    // The coffee corner and a plant.
    const c = layout.coffee;
    g.roundRect(c.x - 8, c.y + c.h - 8, c.w + 40, 10, 3).fill(theme.woodEdge);
    g.roundRect(c.x, c.y, c.w, c.h - 6, 5).fill(theme.appliance);
    g.rect(c.x + 6, c.y + 7, c.w - 12, 9).fill(theme.card);
    g.rect(c.x + 10, c.y + 24, c.w - 20, 6).fill(theme.accent);
    g.roundRect(c.x + c.w + 8, c.y + c.h - 22, 12, 14, 2).fill(theme.card).stroke({ width: 1.5, color: theme.ink });
    const p = layout.plant;
    g.circle(p.x - 8, p.y - 12, 11).fill(theme.ok);
    g.circle(p.x + 7, p.y - 14, 12).fill(blend(theme.ok, theme.floor, 0.25));
    g.circle(p.x, p.y - 22, 10).fill(blend(theme.ok, theme.ink, 0.2));
    g.roundRect(p.x - 12, p.y - 6, 24, 18, 3).fill(theme.woodEdge);

    // Desks, in front of the seated characters.
    const d = deskFront;
    d.clear();
    for (const desk of layout.desks) {
      const r = desk.desk;
      d.roundRect(r.x, r.y, r.w, r.h, 5).fill(theme.wood).stroke({ width: 2, color: theme.woodEdge });
      d.roundRect(r.x + r.w / 2 - 16, r.y + 7, 32, 20, 3).fill(theme.appliance);
      d.roundRect(r.x + r.w / 2 - 13, r.y + 10, 26, 13, 2).fill(theme.card);
      d.circle(r.x + r.w - 14, r.y + 14, 5).fill(theme.card).stroke({ width: 1.5, color: theme.ink });
    }
  }

  function nodeSheet(node: AgentNode): Sheet | null {
    const own = node.sheetUrl ? sheets.get(node.sheetUrl) : null;
    return own ?? neutral;
  }

  function drawBubble(view: AgentView, node: AgentNode, at: number, reduced: boolean, layout: RoomLayout) {
    const bubble = view.bubble;
    node.bubbleText.visible = false;
    if (!bubble || view.alpha < 0.5) return;
    const bob = reduced ? 0 : Math.sin(at / 420 + view.index) * 1.5;
    const top = view.y - SPRITE_SIZE - 4 + bob;
    const tail = (cx: number, y: number) => over.circle(cx - 4, y + 5, 2.4).circle(cx - 9, y + 11, 1.6).fill(theme.card);
    if (bubble.kind === "thought") {
      node.bubbleText.visible = true;
      node.bubbleText.style.wordWrap = true;
      node.bubbleText.style.wordWrapWidth = 120;
      setText(node.bubbleText, bubble.text, theme.ink);
      const w = Math.min(node.bubbleText.width, 120) + 14;
      const h = node.bubbleText.height + 10;
      const x = Math.min(layout.width - w - 4, Math.max(4, view.x - w / 2));
      const y = top - h - 8;
      over.roundRect(x, y, w, h, 8).fill(theme.card).stroke({ width: 1.5, color: theme.line });
      tail(view.x, y + h - 4);
      node.bubbleText.anchor.set(0, 0);
      node.bubbleText.position.set(x + 7, y + 5);
    } else if (bubble.kind === "question") {
      over.circle(view.x, top - 12, 13).fill(theme.danger);
      node.bubbleText.visible = true;
      node.bubbleText.style.wordWrap = false;
      node.bubbleText.anchor.set(0.5, 0.5);
      setText(node.bubbleText, "?", 0xffffff);
      node.bubbleText.position.set(view.x, top - 12);
    } else if (bubble.kind === "talk") {
      const y = top - 12;
      over.roundRect(view.x - 16, y - 9, 32, 18, 9).fill(theme.card).stroke({ width: 1.5, color: theme.line });
      for (let i = 0; i < 3; i += 1) {
        const lit = reduced || Math.floor(at / 300) % 3 === i;
        over.circle(view.x - 8 + i * 8, y, 2.3).fill(lit ? theme.ink : theme.muted);
      }
    } else {
      node.bubbleText.visible = true;
      node.bubbleText.style.wordWrap = false;
      node.bubbleText.anchor.set(0, 1);
      setText(node.bubbleText, "z Z", theme.muted);
      node.bubbleText.position.set(view.x + 8, top + 6 + bob);
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
    resize(cssWidth, worldHeight) {
      scale = cssWidth / WORLD_W;
      const cssHeight = Math.round(worldHeight * scale);
      app.renderer.resize(Math.round(cssWidth), cssHeight);
      app.stage.scale.set(scale);
      // Text is drawn at the size it ends up on screen, so it stays sharp when the room is scaled up.
      for (const text of texts) text.resolution = Math.min(resolution * scale, 4);
      return cssHeight;
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

      // The board: a flash on a figure that just moved.
      const b = layout.board;
      setText(boardTitle, scene.board.title, theme.muted);
      boardTitle.position.set(b.x + 12, b.y + 8);
      const rowH = (b.h - 28) / Math.max(1, scene.board.rows.length);
      while (boardLabels.length < scene.board.rows.length) {
        const label = makeText(10, "400");
        const value = makeText(10.5, "700", true);
        value.anchor.set(1, 0);
        textLayer.addChild(label, value);
        boardLabels.push(label);
        boardValues.push(value);
      }
      under.clear();
      over.clear();
      scene.board.rows.forEach((row, index) => {
        if (lastValue.has(row.key) && lastValue.get(row.key) !== row.value) flashAt.set(row.key, at);
        lastValue.set(row.key, row.value);
        const flashing = !reduced && at - (flashAt.get(row.key) ?? Number.NEGATIVE_INFINITY) < FLASH_MS;
        const y = b.y + 26 + index * rowH;
        if (flashing) {
          const fade = 1 - (at - flashAt.get(row.key)!) / FLASH_MS;
          over.roundRect(b.x + 6, y - 1, b.w - 12, rowH, 3).fill({ color: theme.accent, alpha: 0.18 * fade });
        }
        const label = boardLabels[index]!;
        const value = boardValues[index]!;
        label.visible = value.visible = true;
        setText(label, row.label, theme.muted);
        setText(value, row.value, flashing ? theme.accent : theme.ink);
        label.position.set(b.x + 12, y);
        value.position.set(b.x + b.w - 12, y - 0.5);
      });
      for (let i = scene.board.rows.length; i < boardLabels.length; i += 1) {
        boardLabels[i]!.visible = false;
        boardValues[i]!.visible = false;
      }

      // The user's desk: its name on the wall, the tray and its count.
      const u = layout.userDesk;
      setText(userLabel, scene.labels.userDesk, theme.muted);
      userLabel.position.set(u.x + u.w / 2, 8);
      const t = layout.tray;
      for (let i = 0; i < Math.min(view.pending, 5); i += 1) {
        over.roundRect(t.x + 5 + (i % 2) * 2, t.y + t.h - 10 - i * 4, t.w - 12, 8, 1.5)
          .fill(theme.paper)
          .stroke({ width: 1, color: theme.woodEdge });
      }
      if (lastPending >= 0 && view.pending > lastPending) bumpAt = at;
      lastPending = view.pending;
      const bump = reduced ? 0 : Math.max(0, 1 - (at - bumpAt) / BUMP_MS);
      setText(trayLabel, scene.labels.tray, theme.muted);
      trayLabel.position.set(t.x + t.w + 8, t.y + 1);
      setText(trayCount, String(view.pending), view.pending > 0 ? theme.accent : theme.muted);
      trayCount.position.set(t.x + t.w + 9, t.y + t.h - 6);
      trayCount.scale.set(1 + 0.3 * bump);

      // Coffee steam, unless motion is reduced.
      if (!reduced) {
        const c = layout.coffee;
        for (let i = 0; i < 3; i += 1) {
          const phase = ((at / 1600 + i / 3) % 1);
          over.circle(c.x + c.w + 14 + Math.sin(phase * 6 + i) * 2, c.y + c.h - 28 - phase * 16, 2 + phase * 2).fill({
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
        const desk = layout.desks.find((spot) => spot.key === agent.key)!;

        setText(node.label, agent.name, theme.ink);
        node.label.position.set(desk.label.x, desk.label.y);

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
          under.ellipse(agent.x, agent.y - 1, 17, 5).fill({ color: theme.ink, alpha: 0.14 * agent.alpha });
        }
        if (scene.selected === agent.key) {
          under.ellipse(agent.x, agent.y - 1, 24, 8).stroke({ width: 2.5, color: theme.accent });
        }
        if (agent.carrying) {
          const fx = agent.x + agent.facing * 15;
          over.roundRect(fx - 8, agent.y - 34, 16, 12, 1.5).fill(theme.paper).stroke({ width: 1.5, color: theme.woodEdge });
          over.rect(fx - 8, agent.y - 34, 7, 3).fill(theme.woodEdge);
        }
      }
      for (const agent of sorted) drawBubble(agent, nodes.get(agent.key)!, at, reduced, layout);
      // Drop the nodes of agents that left the room.
      for (const [key, node] of nodes) {
        if (!sorted.some((agent) => agent.key === key)) {
          node.sprite.destroy();
          node.label.destroy();
          node.bubbleText.destroy();
          nodes.delete(key);
        }
      }

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
