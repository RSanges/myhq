import {
  templateFor,
  type FloorTemplate,
  type Item,
  type Point,
  type Rect,
  type RoomKind,
  type RoomSpec,
  type Side,
} from "./floor-templates";
import { RECEPTION_KEY } from "./reception";

// The floor plan the room view draws and the agents walk in, in world units
// (one unit is one pixel at a scale of 1). It is built from a hand-designed
// template (floor-templates.ts) chosen by the number of agents; agents fill the
// desks in order. Pure: no canvas, no clock. Routes go out of an office through
// its door, along the corridors (a graph built from their center lines) and in
// through the other door, never through a wall.

export type { Item, Point, Rect, RoomKind, Side };

/** Thickness of a wall. */
export const WALL = 2.4;
/** Displayed size of a character, in world units (its sheet cell is drawn at this size). */
export const SPRITE_SIZE = 26;
/** Width of a door gap unless a room says otherwise. */
export const DOOR_W = 22;
export const DESK_W = 38;
export const DESK_H = 15;

export type Segment = { a: Point; b: Point };

export type Door = { x: number; y: number; w: number; wall: Side };

export type Office = {
  key: string;
  room: Rect;
  door: Door;
  desk: Rect;
  chair: Point;
  /** Where the character's feet are when it sits (center, bottom). */
  seat: Point;
  /** The name plate, on the wall outside the door. `ax` 1 puts the plate to the left of the door, 0 to the right. */
  plate: { x: number; y: number; ax: 0 | 1 };
  /** From the seat out of the office, ending just outside the door (a node of the corridors). */
  exit: Point[];
  /** From just outside the door to where a visitor stands inside. */
  visit: Point[];
  outside: number;
};

/**
 * The reception desk of the lobby, on the floor that has the receptionist. Its
 * `office` is the receptionist's spot, like an agent's: the same routes (to the
 * tray, to a colleague) start from it.
 */
export type Reception = {
  counter: Rect;
  /** The bell on the counter, and the small screen. */
  bell: Point;
  screen: Rect;
  /** Where the name of the desk is written, under the counter. */
  plate: Point;
  office: Office;
};

export type PlacedRoom = { kind: RoomKind; rect: Rect; vacant: boolean };

export type RoomLayout = {
  template: FloorTemplate["id"];
  width: number;
  height: number;
  outline: Point[];
  rooms: PlacedRoom[];
  walls: Segment[];
  windows: Segment[];
  /** Furniture drawn behind the characters (chairs, shelves, sofas, plants, tables). */
  items: Item[];
  /** Desks of agents with nobody at them (drawn like the others). */
  vacantDesks: Rect[];
  offices: Office[];
  /** The reception desk and its receptionist's spot, null on the floors that do not have one. */
  reception: Reception | null;
  meeting: { rect: Rect; board: Rect } | null;
  coffee: Rect | null;
  user: {
    room: Rect;
    desk: Rect;
    chair: Point;
    monitor: Rect;
    /** Where the name of the user's office is written. */
    plate: Point;
    /** The console of the lobby with the "to approve" tray. */
    console: Rect;
    tray: Rect;
    /** Where an agent stands to drop a folder in the tray (a node of the corridors). */
    stand: Point;
    standNode: number;
  };
  graph: Graph;
};

type Graph = { nodes: Point[]; edges: [number, number][] };

// ---- Routes -----------------------------------------------------------------------------------

const same = (a: Point, b: Point): boolean => Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;

/** A route without consecutive duplicate points. */
export function tidy(points: Point[]): Point[] {
  return points.filter((point, index) => index === 0 || !same(point, points[index - 1]!));
}

function nodeAt(graph: Graph, point: Point): number {
  const found = graph.nodes.findIndex((node) => same(node, point));
  if (found >= 0) return found;
  graph.nodes.push({ ...point });
  return graph.nodes.length - 1;
}

/** Joins a point to the nearest place of a corridor (splitting it there) and returns the point's node. */
function attach(graph: Graph, point: Point): number {
  let best: { edge: number; q: Point; distance: number } | null = null;
  graph.edges.forEach(([i, j], edge) => {
    const a = graph.nodes[i]!;
    const b = graph.nodes[j]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const t = Math.min(1, Math.max(0, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy)));
    const q = { x: a.x + dx * t, y: a.y + dy * t };
    const distance = Math.hypot(point.x - q.x, point.y - q.y);
    if (!best || distance < best.distance) best = { edge, q, distance };
  });
  if (!best) return nodeAt(graph, point);
  const { edge, q } = best as { edge: number; q: Point };
  const [i, j] = graph.edges[edge]!;
  // The corridor is split at q first, so that a point that lies on a corridor joins it.
  let qId = graph.nodes.findIndex((node) => same(node, q));
  if (qId < 0) {
    qId = nodeAt(graph, q);
    graph.edges.splice(edge, 1, [i, qId], [qId, j]);
  }
  const own = nodeAt(graph, point);
  if (qId !== own) graph.edges.push([own, qId]);
  return own;
}

/** The shortest way along the corridors between two nodes, as points (Dijkstra). */
function graphRoute(graph: Graph, from: number, to: number): Point[] {
  const count = graph.nodes.length;
  const distance = new Array<number>(count).fill(Number.POSITIVE_INFINITY);
  const previous = new Array<number>(count).fill(-1);
  const done = new Array<boolean>(count).fill(false);
  distance[from] = 0;
  for (;;) {
    let current = -1;
    for (let i = 0; i < count; i += 1) if (!done[i] && distance[i]! < Number.POSITIVE_INFINITY && (current < 0 || distance[i]! < distance[current]!)) current = i;
    if (current < 0 || current === to) break;
    done[current] = true;
    for (const [a, b] of graph.edges) {
      const other = a === current ? b : b === current ? a : -1;
      if (other < 0 || done[other]) continue;
      const length = Math.hypot(graph.nodes[a]!.x - graph.nodes[b]!.x, graph.nodes[a]!.y - graph.nodes[b]!.y);
      if (distance[current]! + length < distance[other]!) {
        distance[other] = distance[current]! + length;
        previous[other] = current;
      }
    }
  }
  const route: Point[] = [];
  for (let node = to; node >= 0; node = previous[node]!) {
    route.unshift(graph.nodes[node]!);
    if (node === from) break;
  }
  return route;
}

// ---- Building a layout from a template ------------------------------------------------------------

function deskRects(spec: RoomSpec): Rect[] {
  if (Array.isArray(spec.desks)) return spec.desks;
  const count = spec.desks ?? 0;
  const { rect } = spec;
  const y = spec.door.wall === "bottom" ? rect.y + 26 : rect.y + rect.h - 22;
  return Array.from({ length: count }, (_, i) => ({ x: rect.x + (rect.w * (i + 0.5)) / count - DESK_W / 2, y, w: DESK_W, h: DESK_H }));
}

function doorOf(spec: RoomSpec): Door {
  const { rect, door } = spec;
  const w = door.w ?? DOOR_W;
  if (door.wall === "top") return { x: door.at, y: rect.y, w, wall: "top" };
  if (door.wall === "bottom") return { x: door.at, y: rect.y + rect.h, w, wall: "bottom" };
  if (door.wall === "left") return { x: rect.x, y: door.at, w, wall: "left" };
  return { x: rect.x + rect.w, y: door.at, w, wall: "right" };
}

/** The walls of a room: four sides minus the open ones, with a gap where the door is. */
function wallsOf(spec: RoomSpec, door: Door): Segment[] {
  const { x, y, w, h } = spec.rect;
  const open = new Set(spec.open ?? []);
  const segments: Segment[] = [];
  const horizontal = (wy: number, side: "top" | "bottom") => {
    if (open.has(side)) return;
    if (door.wall === side) {
      segments.push({ a: { x, y: wy }, b: { x: door.x - door.w / 2, y: wy } }, { a: { x: door.x + door.w / 2, y: wy }, b: { x: x + w, y: wy } });
    } else segments.push({ a: { x, y: wy }, b: { x: x + w, y: wy } });
  };
  const vertical = (wx: number, side: "left" | "right") => {
    if (open.has(side)) return;
    if (door.wall === side) {
      segments.push({ a: { x: wx, y }, b: { x: wx, y: door.y - door.w / 2 } }, { a: { x: wx, y: door.y + door.w / 2 }, b: { x: wx, y: y + h } });
    } else segments.push({ a: { x: wx, y }, b: { x: wx, y: y + h } });
  };
  horizontal(y, "top");
  horizontal(y + h, "bottom");
  vertical(x, "left");
  vertical(x + w, "right");
  return segments;
}

function buildOffice(graph: Graph, key: string, spec: RoomSpec, door: Door, desk: Rect, index: number, count: number): Office {
  const { rect } = spec;
  const seat = { x: desk.x + desk.w / 2, y: desk.y + 6 };
  const south = door.wall === "bottom";
  const inside = { x: door.x, y: south ? rect.y + rect.h - 11 : rect.y + 11 };
  const outsidePoint = { x: door.x, y: south ? rect.y + rect.h + 7 : rect.y - 7 };
  const outside = attach(graph, outsidePoint);
  // The way round the desk: on the side that faces the door.
  const sx = inside.x >= seat.x ? desk.x + desk.w + 8 : desk.x - 8;
  const exit = south
    ? tidy([seat, { x: sx, y: seat.y }, { x: sx, y: inside.y }, inside, outsidePoint])
    : tidy([seat, inside, outsidePoint]);
  const visit = tidy([outsidePoint, inside, { x: sx, y: inside.y }, { x: sx, y: seat.y + 6 }]);
  const ax = count === 1 || index === 1 ? 0 : 1;
  return {
    key,
    room: rect,
    door,
    desk,
    chair: { x: seat.x, y: seat.y - 7 },
    seat,
    plate: { x: door.x + (ax === 0 ? 1 : -1) * (door.w / 2 + 3), y: south ? rect.y + rect.h + 8 : rect.y - 8, ax },
    exit,
    visit,
    outside,
  };
}

function buildReception(graph: Graph, spec: FloorTemplate["lobby"]["reception"]): Reception {
  const { counter, seat, outside } = spec;
  const outsideNode = attach(graph, outside);
  // The receptionist leaves straight ahead, away from the visitors' side of the counter.
  const ahead = { x: seat.x, y: seat.y - 18 };
  const exit = tidy([seat, ahead, outside]);
  return {
    counter,
    bell: { x: counter.x + 11, y: counter.y + 4.5 },
    screen: { x: counter.x + counter.w - 22, y: counter.y - 3, w: 14, h: 9 },
    plate: { x: counter.x + counter.w / 2, y: counter.y + counter.h + 4 },
    office: {
      key: RECEPTION_KEY,
      room: counter,
      door: { x: outside.x, y: outside.y, w: DOOR_W, wall: "top" },
      desk: counter,
      chair: { x: seat.x, y: seat.y - 7 },
      seat,
      plate: { x: counter.x + counter.w / 2, y: counter.y + counter.h + 4, ax: 0 },
      exit,
      visit: tidy([...exit].reverse()),
      outside: outsideNode,
    },
  };
}

export type LayoutOptions = {
  /** Draw the reception desk of the lobby (the floor that has the receptionist). */
  reception?: boolean;
};

/**
 * The floor plan for the given agent keys, in order, from the smallest template
 * that seats them. The reception desk is added to the lobby on request: it
 * seats nobody of `keys`, the receptionist belongs to the home, not to a room.
 */
export function layoutRoom(keys: string[], options: LayoutOptions = {}): RoomLayout {
  const template = templateFor(keys.length);
  const graph: Graph = { nodes: [], edges: [] };
  for (const line of template.corridors) {
    for (let i = 1; i < line.length; i += 1) graph.edges.push([nodeAt(graph, line[i - 1]!), nodeAt(graph, line[i]!)]);
  }

  const walls: Segment[] = [];
  const items: Item[] = [...template.lobby.items];
  const offices: Office[] = [];
  const vacantDesks: Rect[] = [];
  const rooms: PlacedRoom[] = [];
  let meeting: RoomLayout["meeting"] = null;
  let coffee: Rect | null = null;
  let userSpec: RoomSpec | null = null;
  let next = 0;

  for (const spec of template.rooms) {
    const door = doorOf(spec);
    walls.push(...wallsOf(spec, door));
    items.push(...(spec.items ?? []));
    const desks = deskRects(spec);
    let seated = 0;
    desks.forEach((desk, index) => {
      const key = keys[next];
      next += 1;
      if (key === undefined) {
        vacantDesks.push(desk);
        return;
      }
      offices.push(buildOffice(graph, key, spec, door, desk, index, desks.length));
      seated += 1;
    });
    rooms.push({ kind: spec.kind, rect: spec.rect, vacant: desks.length > 0 && seated === 0 });
    if (spec.kind === "meeting" && spec.board) meeting = { rect: spec.rect, board: spec.board };
    if (spec.machine) coffee = spec.machine;
    if (spec.kind === "user") userSpec = spec;
  }
  if (!userSpec?.userDesk) throw new Error(`template ${template.id} has no user office`);

  const outline = template.outline;
  for (let i = 0; i < outline.length; i += 1) walls.push({ a: outline[i]!, b: outline[(i + 1) % outline.length]! });

  const standNode = attach(graph, template.lobby.stand);
  const reception = options.reception ? buildReception(graph, template.lobby.reception) : null;
  const user = userSpec.userDesk;
  return {
    template: template.id,
    width: template.width,
    height: template.height,
    outline,
    rooms,
    walls,
    windows: template.windows.map(([a, b]) => ({ a, b })),
    items,
    vacantDesks,
    offices,
    reception,
    meeting,
    coffee,
    user: {
      room: userSpec.rect,
      desk: user.desk,
      chair: user.chair,
      monitor: user.monitor,
      plate: { x: userSpec.rect.x + userSpec.rect.w - 46, y: userSpec.rect.y + 11 },
      console: template.lobby.console,
      tray: template.lobby.tray,
      stand: template.lobby.stand,
      standNode,
    },
    graph,
  };
}

export function officeOf(layout: RoomLayout, key: string): Office | null {
  if (key === RECEPTION_KEY) return layout.reception?.office ?? null;
  return layout.offices.find((office) => office.key === key) ?? null;
}

/** The route from an agent's seat to where a visitor stands in another agent's office. */
export function routeToOffice(layout: RoomLayout, from: Office, to: Office): Point[] {
  // Two agents of the same office just cross it.
  if (from.room === to.room) return tidy([from.seat, to.visit[to.visit.length - 1]!]);
  const along = graphRoute(layout.graph, from.outside, to.outside);
  return tidy([...from.exit, ...along.slice(1), ...to.visit.slice(1)]);
}

/** The route from an agent's seat to the tray of the lobby. */
export function routeToUser(layout: RoomLayout, from: Office): Point[] {
  const along = graphRoute(layout.graph, from.outside, layout.user.standNode);
  return tidy([...from.exit, ...along.slice(1)]);
}

/** Total length of a route. */
export function routeLength(route: Point[]): number {
  let length = 0;
  for (let i = 1; i < route.length; i += 1) length += Math.hypot(route[i]!.x - route[i - 1]!.x, route[i]!.y - route[i - 1]!.y);
  return length;
}

/**
 * The point at `fraction` (0 to 1) of the length of a route, and the way the
 * character faces there (1 right, -1 left): the direction of its segment, or
 * of the nearest segment that is not straight up or down.
 */
export function pointOnRoute(route: Point[], fraction: number): { point: Point; facing: 1 | -1 } {
  const total = routeLength(route);
  let remaining = Math.min(1, Math.max(0, fraction)) * total;
  const direction = (index: number): 1 | -1 | 0 => {
    const dx = route[index]!.x - route[index - 1]!.x;
    return dx > 0.5 ? 1 : dx < -0.5 ? -1 : 0;
  };
  for (let i = 1; i < route.length; i += 1) {
    const a = route[i - 1]!;
    const b = route[i]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (remaining <= length || i === route.length - 1) {
      const t = length === 0 ? 1 : Math.min(1, remaining / length);
      let facing = direction(i);
      for (let j = i - 1; facing === 0 && j >= 1; j -= 1) facing = direction(j);
      for (let j = i + 1; facing === 0 && j < route.length; j += 1) facing = direction(j);
      return { point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, facing: facing === 0 ? 1 : facing };
    }
    remaining -= length;
  }
  return { point: route[0] ?? { x: 0, y: 0 }, facing: 1 };
}
