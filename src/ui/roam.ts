import {
  CELL,
  centreOf,
  directionOf,
  graphNodeAt,
  routeBetween,
  routeLength,
  tidy,
  type Direction,
  type Office,
  type Point,
  type RoomLayout,
} from "./room-layout";

// The round of an agent who roams the single floor (room.json
// `floor.behaviour: "roam"`, the janitor): from its spot by the broom closet
// it walks into every room in turn, along the aisles and lanes of the floor
// (so it never crosses a wall or a piece of furniture), stops in each one to
// sweep, and every other room once more in the corridor before its
// door; then it starts the round again, for as long as its run lasts. Pure:
// the round is a function of the layout, and the place on it a function of
// the time since the run began, so every client draws the same thing. An
// agent whose round never stops (`floor.always`) counts that time from
// ROAM_ORIGIN instead, a fixed origin: the same place on every client and
// after every reload, run or not.

/** Where the round of an agent that is always on it is counted from (epoch milliseconds). */
export const ROAM_ORIGIN = 0;

/** Walking speed of a round, in voxels per second: slower than an errand (a cell is 16 voxels). */
export const ROAM_SPEED = 32;
/** A sweep in a room, and one in the corridor. */
export const ROOM_SWEEP_MS = 6_000;
export const HALL_SWEEP_MS = 3_500;
/** The shortest walk between two stops. */
const MIN_WALK_MS = 600;

export type TourStep =
  | { kind: "walk"; path: Point[]; length: number; ms: number }
  | { kind: "sweep"; at: Point; faces: Direction; ms: number };

export type Tour = {
  /** Where the agent rests (by the closet), and its node in the graph. */
  home: Point;
  homeNode: number;
  /** From home to the first stop. */
  intro: TourStep[];
  /** The round itself, repeated: a sweep, the walk to the next stop, and so on back to the first. */
  loop: TourStep[];
  introMs: number;
  loopMs: number;
};

export type TourPose = {
  x: number;
  y: number;
  direction: Direction;
  /** Voxels walked on the current walk (frames the walk), 0 while sweeping. */
  walked: number;
  sweeping: boolean;
  /** The nodes on either side of the agent (the one it stands on while sweeping): where a way home may start. */
  nearby: Point[];
  /** Milliseconds into the round when the current step ends. */
  stepEnd: number;
};

const ease = (value: number): number => {
  const t = Math.min(1, Math.max(0, value));
  return t * t * (3 - 2 * t);
};

const walkMs = (length: number): number => Math.max(MIN_WALK_MS, (length / ROAM_SPEED) * 1000);

/** A walk from one node to another, or null when they are the same. */
function walk(layout: RoomLayout, from: number, to: number): Extract<TourStep, { kind: "walk" }> | null {
  if (from === to) return null;
  const path = tidy(routeBetween(layout, from, to));
  const length = routeLength(path);
  return length > 0 ? { kind: "walk", path, length, ms: walkMs(length) } : null;
}

/**
 * A stop of the round: where, how long, and the way the agent faces while it
 * sweeps there, always towards the viewer: three quarters along the front
 * aisle in a room (`SE`, its broom in profile), across the corridor (`SW`).
 */
type Stop = { node: number; ms: number; faces: Direction };

/**
 * The stops of a round: for each room, from the front row (the lobby's,
 * right to left) back, every other row the other way (a serpentine, so the
 * round never crosses the floor for nothing), a node of the room's front
 * aisle (the middle one), then every other room the corridor before its
 * door. The spots where roaming agents rest are no stops.
 */
function stopsOf(layout: RoomLayout): Stop[] {
  const rests = layout.offices.filter((office) => office.chair === null).map((office) => office.node);
  const ribs = [...new Set(layout.rooms.map((room) => room.y + room.d))].sort((a, b) => b - a);
  const order = layout.rooms
    .map((room, index) => ({ room, index }))
    .sort((a, b) => {
      const ra = ribs.indexOf(a.room.y + a.room.d);
      const rb = ribs.indexOf(b.room.y + b.room.d);
      if (ra !== rb) return ra - rb;
      return ra % 2 === 0 ? b.room.x - a.room.x : a.room.x - b.room.x;
    });
  const stops: Stop[] = [];
  order.forEach(({ room }, rank) => {
    const inside = layout.graph.nodes
      .map((point, node) => ({ point, node }))
      .filter(({ point, node }) => {
        if (rests.includes(node)) return false;
        return point.x > room.x * CELL && point.x < (room.x + room.w) * CELL && point.y > room.y * CELL && point.y < (room.y + room.d) * CELL;
      });
    if (inside.length > 0) {
      // The front aisle, before the front row of desks: in view, where the desks do not hide it.
      const front = Math.max(...inside.map(({ point }) => point.y));
      const row = inside.filter(({ point }) => point.y === front).sort((a, b) => a.point.x - b.point.x);
      stops.push({ node: row[Math.floor((row.length - 1) / 2)]!.node, ms: ROOM_SWEEP_MS, faces: "SE" });
    }
    const door = room.open.y[0];
    if (rank % 2 === 1 && door !== undefined) {
      const outside = graphNodeAt(layout, centreOf([room.x + door, room.y + room.d]));
      if (outside >= 0 && !rests.includes(outside)) stops.push({ node: outside, ms: HALL_SWEEP_MS, faces: "SW" });
    }
  });
  return stops;
}

/** The round of a roaming agent whose resting spot is `office`. */
export function buildTour(layout: RoomLayout, office: Office): Tour {
  const stops = stopsOf(layout);
  const home = office.seat;
  const tour: Tour = { home, homeNode: office.node, intro: [], loop: [], introMs: 0, loopMs: 0 };
  if (stops.length === 0 || office.node < 0) return tour;
  const first = walk(layout, office.node, stops[0]!.node);
  tour.intro = first ? [first] : [];
  stops.forEach((stop, index) => {
    tour.loop.push({ kind: "sweep", at: layout.graph.nodes[stop.node]!, faces: stop.faces, ms: stop.ms });
    const leg = walk(layout, stop.node, stops[(index + 1) % stops.length]!.node);
    if (leg) tour.loop.push(leg);
  });
  tour.introMs = tour.intro.reduce((total, step) => total + step.ms, 0);
  tour.loopMs = tour.loop.reduce((total, step) => total + step.ms, 0);
  return tour;
}

/** Where a step puts the agent `t` milliseconds into it. */
function stepPose(step: TourStep, t: number, stepEnd: number): TourPose {
  if (step.kind === "sweep") {
    return { x: step.at.x, y: step.at.y, direction: step.faces, walked: 0, sweeping: true, nearby: [step.at], stepEnd };
  }
  const walked = ease(t / step.ms) * step.length;
  let remaining = walked;
  for (let i = 1; i < step.path.length; i += 1) {
    const a = step.path[i - 1]!;
    const b = step.path[i]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (remaining <= length || i === step.path.length - 1) {
      const f = length === 0 ? 1 : Math.min(1, remaining / length);
      return {
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f,
        direction: directionOf(b.x - a.x, b.y - a.y),
        walked,
        sweeping: false,
        nearby: [a, b],
        stepEnd,
      };
    }
    remaining -= length;
  }
  const end = step.path[step.path.length - 1]!;
  return { x: end.x, y: end.y, direction: "SW", walked, sweeping: false, nearby: [end], stepEnd };
}

/**
 * Where the round puts the agent `elapsed` milliseconds after its run began:
 * the walk from home, then the loop over and over. `stepEnd` is in the same
 * time as `elapsed`. A floor with nowhere to go keeps the agent at home.
 */
export function tourPose(tour: Tour, elapsed: number, faces: Direction = "SW"): TourPose {
  const at = Math.max(0, elapsed);
  const resting: TourPose = { x: tour.home.x, y: tour.home.y, direction: faces, walked: 0, sweeping: false, nearby: [tour.home], stepEnd: Number.POSITIVE_INFINITY };
  let start = 0;
  for (const step of tour.intro) {
    if (at < start + step.ms) return stepPose(step, at - start, start + step.ms);
    start += step.ms;
  }
  if (tour.loopMs <= 0) return resting;
  const laps = Math.floor((at - start) / tour.loopMs);
  start += laps * tour.loopMs;
  for (const step of tour.loop) {
    if (at < start + step.ms) return stepPose(step, at - start, start + step.ms);
    start += step.ms;
  }
  return stepPose(tour.loop[tour.loop.length - 1]!, 0, start);
}

/** The way home from a pose of the round: through whichever of its nearby nodes is shorter. */
export function wayHome(layout: RoomLayout, tour: Tour, pose: TourPose): Point[] {
  let best: Point[] = [{ x: pose.x, y: pose.y }, tour.home];
  let bestLength = Number.POSITIVE_INFINITY;
  for (const point of pose.nearby) {
    const node = graphNodeAt(layout, point);
    if (node < 0) continue;
    const route = tidy([{ x: pose.x, y: pose.y }, ...routeBetween(layout, node, tour.homeNode)]);
    const length = routeLength(route);
    if (length < bestLength) {
      best = route;
      bestLength = length;
    }
  }
  return best;
}

/** How long the walk home takes. */
export const homeMs = (path: Point[]): number => walkMs(routeLength(path));
