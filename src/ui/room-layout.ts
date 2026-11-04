import {
  templateFor,
  type Cell,
  type CellRect,
  type DeskSpec,
  type Direction,
  type FloorTemplate,
  type RoomKind,
  type RoomSpec,
  type TileKind,
  type WallKind,
} from "./floor-templates";
import { RECEPTION_KEY } from "./reception";

// The floor the room view draws and the agents walk in. It is built from a
// hand-designed template (floor-templates.ts) chosen by the number of agents;
// agents fill the desks in order. Pure: no canvas, no clock.
//
// Two coordinate systems. The world is in voxels of the floor set (16 per
// cell, x towards the lower right of the screen, y towards the lower left):
// seats, routes and the positions of the characters. The screen is in pixels
// of the art at 1x: a point (x, y) of the floor is drawn at (2 (x - y), x + y)
// from the top corner of cell (0, 0) (scripts/iso/README.md). Routes are
// axis-aligned lines through cell centres: the aisles of the rooms and the
// lanes of the hall, joined into a graph, so a character only walks in the
// four directions of its sheet and never through a wall or a piece of
// furniture.

export type { Cell, CellRect, Direction, RoomKind, TileKind, WallKind };

/** Voxels per floor cell. */
export const CELL = 16;
/** Height of a back wall in voxels (floor.json `wall.height`). */
export const WALL_HEIGHT = 64;

export type Point = { x: number; y: number };

/** A point of the floor (voxels, on the ground) on the screen, in art pixels. */
export const screenOf = (x: number, y: number, z = 0): Point => ({ x: 2 * (x - y), y: x + y - 2 * z });

/** The centre of a cell, in voxels. */
export const centreOf = ([cx, cy]: Cell): Point => ({ x: (cx + 0.5) * CELL, y: (cy + 0.5) * CELL });

/** A piece of furniture placed on the floor: its name in floor.json, its turn, its first cell (absolute). */
export type Piece = { name: string; turn: number; cell: Cell; room: number };

export type PlacedRoom = {
  kind: RoomKind;
  x: number;
  y: number;
  w: number;
  d: number;
  floor: TileKind;
  back: { y: WallKind[]; x: WallKind[] };
  open: { y: number[]; x: number[] };
  /** An office with desks and nobody at them. */
  vacant: boolean;
  /** The room of the home it stands for on a single floor (`_hq` for the lobby); null on the floor of one room. */
  project: string | null;
  /** Its own colour on a single floor (a normalized hex); null: the colour of the floor shown, or neutral. */
  color: string | null;
};

/** The user's own desk in a room of a single floor: empty, with the pile of what that room waits for. */
export type OwnerDesk = {
  /** The room of the home whose items it holds (`_hq`, the onboarding room, in the lobby). */
  room: string;
  /** Index of its room in `rooms`. */
  roomIndex: number;
  /** The workstation and its empty chair (pieces). */
  desk: number;
  chair: number;
  /** Where an agent stands to drop a folder, and the way it faces there. */
  stand: Point;
  standNode: number;
  faces: Direction;
};

export type Office = {
  key: string;
  /** Index of its room in `rooms`. */
  room: number;
  /** Index in `pieces` of the desk chair the agent sits in, or null for a spot where it stands (the receptionist). */
  chair: number | null;
  /** Where the character is when at its desk: the centre of its chair's cell (voxels). */
  seat: Point;
  /** The way it faces there (towards its screen, or the visitors of the counter). */
  faces: Direction;
  /** The aisle cell next to the seat: where it gets up to, and where a visitor stands. */
  stand: Point;
  /** Node of `stand` in the graph. */
  node: number;
};

export type RoomLayout = {
  /** The template of a floor of one room, or `rooms`: the single floor where each room of the home is a room. */
  template: FloorTemplate["id"] | "rooms";
  rooms: PlacedRoom[];
  /** Cells of the wooden hall (outside the rooms). */
  hall: Cell[];
  /** Cells of grass between the blocks of the single floor (the shadow of their walls); none elsewhere. */
  garden: Cell[];
  pieces: Piece[];
  offices: Office[];
  /** The reception counter (a piece) and the receptionist's spot, on the floor that has it; null elsewhere. */
  reception: { counter: number; office: Office } | null;
  /** The lobby of a floor of one room: the user's desk and the tray; null on a single floor (see `owners`). */
  user: {
    /** The user's own workstation and chair (pieces), always empty. */
    desk: number;
    chair: number;
    /** The filing cabinet that holds the "to approve" tray (a piece). */
    tray: number;
    /** Where an agent stands to drop a folder, and the way it faces there. */
    stand: Point;
    standNode: number;
    faces: Direction;
  } | null;
  /** The user's desk of each room of a single floor; none on the floor of one room. */
  owners: OwnerDesk[];
  /** The whiteboard of the meeting room and the coffee corner (pieces), when the floor has them. */
  board: number | null;
  coffee: number | null;
  /** What the floor covers on the screen, walls included, in art pixels. */
  bounds: { x: number; y: number; w: number; h: number };
  graph: Graph;
};

type Graph = { nodes: Point[]; edges: [number, number][] };

// ---- Directions ---------------------------------------------------------------------------------

/** The direction of a move along an axis (screen directions of the character sheets). */
export function directionOf(dx: number, dy: number, fallback: Direction = "SW"): Direction {
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return fallback;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? "SE" : "NW";
  return dy > 0 ? "SW" : "NE";
}

// ---- The graph of the aisles and lanes ----------------------------------------------------------

const same = (a: Point, b: Point): boolean => Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;

/** A route without consecutive duplicate points nor points in the middle of a straight run. */
export function tidy(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const point of points) {
    if (out.length > 0 && same(point, out[out.length - 1]!)) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2]!;
      const b = out[out.length - 1]!;
      const straight = (Math.abs(a.x - b.x) < 0.01 && Math.abs(b.x - point.x) < 0.01) || (Math.abs(a.y - b.y) < 0.01 && Math.abs(b.y - point.y) < 0.01);
      const forward = (b.x - a.x) * (point.x - b.x) + (b.y - a.y) * (point.y - b.y) > 0;
      if (straight && forward) out.pop();
    }
    out.push({ ...point });
  }
  return out;
}

function nodeAt(graph: Graph, point: Point): number {
  const found = graph.nodes.findIndex((node) => same(node, point));
  if (found >= 0) return found;
  graph.nodes.push({ ...point });
  return graph.nodes.length - 1;
}

/** Whether `p` lies on the axis-aligned segment a-b (ends included). */
function onSegment(p: Point, a: Point, b: Point): boolean {
  const within = (v: number, s: number, t: number) => v >= Math.min(s, t) - 0.01 && v <= Math.max(s, t) + 0.01;
  if (Math.abs(a.x - b.x) < 0.01) return Math.abs(p.x - a.x) < 0.01 && within(p.y, a.y, b.y);
  if (Math.abs(a.y - b.y) < 0.01) return Math.abs(p.y - a.y) < 0.01 && within(p.x, a.x, b.x);
  return false;
}

/**
 * The graph of a set of axis-aligned lines: every end, crossing and point of
 * `extra` that lies on a line becomes a node, and each line is split at them.
 */
function buildGraph(lines: Point[][], extra: Point[]): Graph {
  const segments: [Point, Point][] = [];
  for (const line of lines) for (let i = 1; i < line.length; i += 1) segments.push([line[i - 1]!, line[i]!]);
  const points: Point[] = [...extra];
  for (const [a, b] of segments) points.push(a, b);
  for (let i = 0; i < segments.length; i += 1) {
    for (let j = i + 1; j < segments.length; j += 1) {
      const [a, b] = segments[i]!;
      const [c, d] = segments[j]!;
      const vertical = Math.abs(a.x - b.x) < 0.01;
      const otherVertical = Math.abs(c.x - d.x) < 0.01;
      if (vertical === otherVertical) continue;
      const cross = vertical ? { x: a.x, y: c.y } : { x: c.x, y: a.y };
      if (onSegment(cross, a, b) && onSegment(cross, c, d)) points.push(cross);
    }
  }
  const graph: Graph = { nodes: [], edges: [] };
  for (const [a, b] of segments) {
    const along = points
      .filter((p) => onSegment(p, a, b))
      .sort((p, q) => Math.hypot(p.x - a.x, p.y - a.y) - Math.hypot(q.x - a.x, q.y - a.y));
    for (let i = 1; i < along.length; i += 1) {
      const from = nodeAt(graph, along[i - 1]!);
      const to = nodeAt(graph, along[i]!);
      if (from !== to && !graph.edges.some(([p, q]) => (p === from && q === to) || (p === to && q === from))) graph.edges.push([from, to]);
    }
  }
  for (const p of extra) nodeAt(graph, p);
  return graph;
}

/** The shortest way between two nodes, as points (Dijkstra). */
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
  if (from !== to && previous[to] === -1) return [graph.nodes[from]!, graph.nodes[to]!];
  const route: Point[] = [];
  for (let node = to; node >= 0; node = previous[node]!) {
    route.unshift(graph.nodes[node]!);
    if (node === from) break;
  }
  return route;
}

// ---- Building a layout from a template ---------------------------------------------------------------

/** The chair cell and turn of a workstation (floor.json: `chair` of the workstation's turn). */
export function chairOf(desk: { turn: number; at: Cell }): { at: Cell; turn: number; faces: Direction } {
  return desk.turn === 0
    ? { at: [desk.at[0], desk.at[1] + 1], turn: 0, faces: "NE" }
    : { at: [desk.at[0] + 1, desk.at[1] + 1], turn: 1, faces: "NW" };
}

const add = (room: RoomSpec, [cx, cy]: Cell): Cell => [room.x + cx, room.y + cy];

export type LayoutOptions = {
  /** Draw the reception counter of the lobby (the floor that has the receptionist). */
  reception?: boolean;
};

/** A room to assemble: its plan, who sits at its desks, and, on a single floor, the user's desk and the counter. */
export type BuildRoom = {
  spec: RoomSpec;
  project: string | null;
  color: string | null;
  /** The agent of each desk of `spec.desks`, in order; undefined leaves the chair empty. */
  keys: (string | undefined)[];
  /** The user's own desk of the room (single floor). */
  owner?: DeskSpec;
  /** The reception counter of the lobby of a single floor, drawn with the receptionist on request. */
  counter?: { at: Cell; staff: Cell; stand: Cell; faces: Direction; turn: 0 | 1 };
};

/** A floor to assemble: its rooms, the hall around them (cells) and the lanes of the hall (absolute cells). */
export type BuildFloor = {
  template: RoomLayout["template"];
  rooms: BuildRoom[];
  hall: CellRect[];
  lanes: Cell[][];
};

type UserSpot = Omit<NonNullable<RoomLayout["user"]>, "standNode">;
type PendingOffice = Omit<Office, "node">;

/**
 * The layout of a floor: pieces in absolute cells, offices of the agents, the
 * user's desks, the hall's cells and the graph of aisles and lanes. Shared by
 * the templates of a floor of one room and the single floor of the home.
 */
export function assembleLayout(floor: BuildFloor, options: LayoutOptions = {}): RoomLayout {
  const pieces: Piece[] = [];
  const rooms: PlacedRoom[] = [];
  const lines: Point[][] = floor.lanes.map((lane) => lane.map(centreOf));
  const stands: Point[] = [];
  const offices: PendingOffice[] = [];
  const owners: Omit<OwnerDesk, "standNode">[] = [];
  const found: { reception: { counter: number; office: PendingOffice } | null; user: UserSpot | null } = { reception: null, user: null };
  let board: number | null = null;
  let coffee: number | null = null;

  const place = (room: RoomSpec, index: number, name: string, turn: number, at: Cell): number => {
    pieces.push({ name, turn, cell: add(room, at), room: index });
    return pieces.length - 1;
  };
  const placeDesk = (room: RoomSpec, index: number, desk: DeskSpec) => {
    place(room, index, "workstation", desk.turn, desk.at);
    const chair = chairOf(desk);
    return { chair: place(room, index, "desk-chair", chair.turn, chair.at), seat: centreOf(add(room, chair.at)), faces: chair.faces };
  };
  const placeCounter = (room: RoomSpec, index: number, counter: { at: Cell; staff: Cell; stand: Cell; faces?: Direction; turn?: 0 | 1 }) => {
    const id = place(room, index, "reception-counter", counter.turn ?? 0, counter.at);
    const standAt = centreOf(add(room, counter.stand));
    stands.push(standAt);
    found.reception = {
      counter: id,
      office: {
        key: RECEPTION_KEY,
        room: index,
        chair: null,
        seat: centreOf(add(room, counter.staff)),
        faces: counter.faces ?? "SW",
        stand: standAt,
      },
    };
  };

  floor.rooms.forEach((build, index) => {
    const spec = build.spec;
    let seated = 0;
    for (const item of spec.pieces) {
      const id = place(spec, index, item.name, item.turn, item.at);
      if (item.name === "whiteboard" && board === null) board = id;
      if (item.name === "coffee-corner" && coffee === null) coffee = id;
    }
    (spec.desks ?? []).forEach((desk, order) => {
      const key = build.keys[order];
      const { chair, seat, faces } = placeDesk(spec, index, desk);
      if (key === undefined) return;
      const stand = centreOf(add(spec, desk.stand));
      stands.push(stand);
      offices.push({ key, room: index, chair, seat, faces, stand });
      seated += 1;
    });
    for (const aisle of spec.aisles ?? []) lines.push(aisle.map((cell) => centreOf(add(spec, cell))));
    if (build.owner && build.project !== null) {
      const desk = placeDesk(spec, index, build.owner);
      const stand = centreOf(add(spec, build.owner.stand));
      stands.push(stand);
      owners.push({ room: build.project, roomIndex: index, desk: desk.chair - 1, chair: desk.chair, stand, faces: desk.faces });
    }
    if (build.counter && options.reception) placeCounter(spec, index, build.counter);
    if (spec.lobby) {
      const { user: own, tray, reception: counter, instead } = spec.lobby;
      const desk = placeDesk(spec, index, own);
      const trayPiece = place(spec, index, "filing-cabinet", 0, tray.at);
      const stand = centreOf(add(spec, tray.stand));
      const cabinet = centreOf(add(spec, tray.at));
      stands.push(stand);
      found.user = {
        desk: desk.chair - 1,
        chair: desk.chair,
        tray: trayPiece,
        stand,
        faces: directionOf(cabinet.x - stand.x, cabinet.y - stand.y),
      };
      if (options.reception) placeCounter(spec, index, counter);
      else for (const item of instead) place(spec, index, item.name, item.turn, item.at);
    }
    rooms.push({
      kind: spec.kind,
      x: spec.x,
      y: spec.y,
      w: spec.w,
      d: spec.d,
      floor: spec.floor,
      back: spec.back,
      open: { y: spec.open.y ?? [], x: spec.open.x ?? [] },
      vacant: (spec.desks?.length ?? 0) > 0 && seated === 0,
      project: build.project,
      color: build.color,
    });
  });

  const graph = buildGraph(lines, stands);
  const node = (point: Point) => graph.nodes.findIndex((candidate) => same(candidate, point));
  const withNode = (office: PendingOffice): Office => ({ ...office, node: node(office.stand) });

  const inRoom = (cx: number, cy: number) => rooms.some((room) => cx >= room.x && cx < room.x + room.w && cy >= room.y && cy < room.y + room.d);
  const hall: Cell[] = [];
  const seen = new Set<string>();
  for (const area of floor.hall) {
    for (let cx = area.x; cx < area.x + area.w; cx += 1) {
      for (let cy = area.y; cy < area.y + area.d; cy += 1) {
        const id = `${cx},${cy}`;
        if (seen.has(id) || inRoom(cx, cy)) continue;
        seen.add(id);
        hall.push([cx, cy]);
      }
    }
  }

  const { reception, user } = found;
  return {
    template: floor.template,
    rooms,
    hall,
    garden: [],
    pieces,
    offices: offices.map(withNode),
    reception: reception ? { counter: reception.counter, office: withNode(reception.office) } : null,
    user: user ? { ...user, standNode: node(user.stand) } : null,
    owners: owners.map((owner) => ({ ...owner, standNode: node(owner.stand) })),
    board,
    coffee,
    bounds: boundsOf(rooms, hall),
    graph,
  };
}

/**
 * The floor of one room for the given agent keys, in order, from the smallest
 * template that seats them. The reception counter is added to the lobby on
 * request: it seats nobody of `keys`, the receptionist belongs to the home,
 * not to a room.
 */
export function layoutRoom(keys: string[], options: LayoutOptions = {}): RoomLayout {
  const template = templateFor(keys.length);
  let next = 0;
  const rooms = template.rooms.map((spec): BuildRoom => {
    const seats = (spec.desks ?? []).map(() => {
      const key = keys[next];
      next += 1;
      return key;
    });
    return { spec, project: null, color: null, keys: seats };
  });
  return assembleLayout({ template: template.id, rooms, hall: template.hall, lanes: template.lanes }, options);
}

/** The screen box of the floor: every room with its walls, every cell of the hall (and of a garden). */
export function boundsOf(rooms: PlacedRoom[], hall: Cell[]): RoomLayout["bounds"] {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const take = (cx: number, cy: number, top: number) => {
    const p = screenOf(cx * CELL, cy * CELL);
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y - top);
    maxY = Math.max(maxY, p.y);
  };
  for (const room of rooms) {
    // The back walls rise from the back edges (with their top); the rim adds a few pixels around the front.
    take(room.x, room.y, 2 * WALL_HEIGHT + 12);
    take(room.x + room.w, room.y, 2 * WALL_HEIGHT + 12);
    take(room.x, room.y + room.d, 2 * WALL_HEIGHT + 12);
    take(room.x + room.w, room.y + room.d, 0);
  }
  for (const [cx, cy] of hall) {
    take(cx, cy, 0);
    take(cx + 1, cy + 1, 0);
    take(cx, cy + 1, 0);
    take(cx + 1, cy, 0);
  }
  const pad = 8;
  return { x: minX - pad, y: minY, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad };
}

export function officeOf(layout: RoomLayout, key: string): Office | null {
  if (key === RECEPTION_KEY) return layout.reception?.office ?? null;
  return layout.offices.find((office) => office.key === key) ?? null;
}

/** The route from an agent's seat to where a visitor stands next to another agent's seat. */
export function routeToOffice(layout: RoomLayout, from: Office, to: Office): Point[] {
  return tidy([from.seat, ...graphRoute(layout.graph, from.node, to.node)]);
}

/** The room of the home of an agent key (`room/agent`). */
export const roomOfKey = (key: string): string => key.slice(0, Math.max(0, key.indexOf("/")));

/**
 * Where an agent brings what it submits: the user's desk of its own room on a
 * single floor (of `forRoom`, the room that ordered it from a shared room,
 * when there is one), the tray of the lobby on the floor of one room. Null
 * when the floor has neither for it.
 */
export function dropSpotOf(
  layout: RoomLayout,
  key: string,
  forRoom: string | null = null,
): { standNode: number; stand: Point; faces: Direction } | null {
  if (layout.owners.length > 0) {
    const room = forRoom ?? roomOfKey(key);
    return layout.owners.find((owner) => owner.room === room) ?? layout.owners.find((owner) => owner.room === roomOfKey(key)) ?? null;
  }
  return layout.user;
}

/** The route from an agent's seat to where it drops a folder (`dropSpotOf`); just its seat when there is none. */
export function routeToUser(layout: RoomLayout, from: Office, forRoom: string | null = null): Point[] {
  const spot = dropSpotOf(layout, from.key, forRoom);
  if (!spot) return [from.seat];
  return tidy([from.seat, ...graphRoute(layout.graph, from.node, spot.standNode)]);
}

/** Total length of a route. */
export function routeLength(route: Point[]): number {
  let length = 0;
  for (let i = 1; i < route.length; i += 1) length += Math.hypot(route[i]!.x - route[i - 1]!.x, route[i]!.y - route[i - 1]!.y);
  return length;
}

/**
 * The point at `fraction` (0 to 1) of the length of a route, the way the
 * character faces there (the direction of its segment) and the distance
 * walked so far (which picks the frame of the walk, so the feet do not slide).
 */
export function pointOnRoute(route: Point[], fraction: number): { point: Point; direction: Direction; walked: number } {
  const total = routeLength(route);
  const walked = Math.min(1, Math.max(0, fraction)) * total;
  let remaining = walked;
  for (let i = 1; i < route.length; i += 1) {
    const a = route[i - 1]!;
    const b = route[i]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (remaining <= length || i === route.length - 1) {
      const t = length === 0 ? 1 : Math.min(1, remaining / length);
      return { point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, direction: directionOf(b.x - a.x, b.y - a.y), walked };
    }
    remaining -= length;
  }
  return { point: route[0] ?? { x: 0, y: 0 }, direction: "SW", walked: 0 };
}
