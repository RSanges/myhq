import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  behind,
  buildFloorScene,
  depthOrder,
  floorSetSchema,
  hiddenByWalls,
  neutralPersonFor,
  NEUTRAL_PEOPLE,
  pastel,
  sheetRow,
  turnOf,
} from "../src/ui/iso-floor";
import { BESIDE, layoutFloor, LOBBY_SIZE, MAX_ROOM_AGENTS, roomLength, type FloorRoomInput } from "../src/ui/floor-plan";
import { FLOOR_TEMPLATES } from "../src/ui/floor-templates";
import {
  CELL,
  dropSpotOf,
  layoutRoom,
  roomOfKey,
  routeToOffice,
  routeToUser,
  type Point,
  type RoomLayout,
} from "../src/ui/room-layout";
import { RECEPTION_KEY, RECEPTION_ROOM } from "../src/ui/reception";

const root = path.join(import.meta.dirname, "..");
const floorSet = floorSetSchema.parse(JSON.parse(fs.readFileSync(path.join(root, "public", "iso", "floor", "floor.json"), "utf8")));

const keys = (count: number, room = "r") => Array.from({ length: count }, (_, i) => `${room}/a${i}`);

/** Rooms of a home for the single floor: `counts[i]` agents in room `p<i>`, every other one with a colour. */
const homeRooms = (counts: number[]): FloorRoomInput[] =>
  counts.map((count, i) => ({ name: `p${i}`, color: i % 2 === 0 ? "#ff3d7f" : null, keys: keys(count, `p${i}`) }));

/**
 * Homes of 1 to 8 rooms of 1 to 12 agents for the single floor: the extremes
 * (all of one size), rising and falling sizes, the shape of a real home, and
 * a few drawn from a fixed pseudo-random sequence, so the run is the same
 * every time.
 */
function floorHomes(): number[][] {
  const homes: number[][] = [[9, 2, 4, 6, 4], [9, 2, 4]];
  let seed = 7;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return 1 + (seed % 12);
  };
  for (let rooms = 1; rooms <= 8; rooms += 1) {
    homes.push(Array.from({ length: rooms }, () => 1));
    homes.push(Array.from({ length: rooms }, () => 12));
    homes.push(Array.from({ length: rooms }, (_, i) => 1 + ((i * 11) % 12)));
    homes.push(Array.from({ length: rooms }, (_, i) => 12 - ((i * 5) % 12)));
    for (let draw = 0; draw < 3; draw += 1) homes.push(Array.from({ length: rooms }, next));
  }
  return homes;
}

/** The same rooms, every third one a library (room.json `decor`). */
const withLibraries = (rooms: FloorRoomInput[]): FloorRoomInput[] => rooms.map((room, i) => (i % 3 === 1 ? { ...room, decor: "library" } : room));

/**
 * Single floors for every home of `floorHomes`, the reception on the first, third or no room, with and without the
 * receptionist, and with libraries among the rooms.
 */
const floorLayouts = (): RoomLayout[] =>
  floorHomes().flatMap((counts, index) => {
    const rooms = homeRooms(counts);
    const reception = index % 3 === 0 ? null : (rooms[Math.min(rooms.length - 1, index % 2 === 0 ? 0 : 2)]?.name ?? null);
    return [
      layoutFloor(rooms, { reception, receptionist: true }),
      layoutFloor(rooms, { reception, receptionist: false }),
      layoutFloor(withLibraries(rooms), { reception, receptionist: true }),
    ];
  });

const layouts = (): RoomLayout[] => [
  ...[1, 3, 4, 6, 7, 9, 12].flatMap((count) => [layoutRoom(keys(count)), layoutRoom(keys(count), { reception: true })]),
  ...floorLayouts(),
];

/** Cells covered by a non-flat piece of furniture. */
function occupied(layout: RoomLayout): Set<string> {
  const cells = new Set<string>();
  for (const piece of layout.pieces) {
    const turn = turnOf(floorSet, piece.name, piece.turn);
    if (turn.flat) continue;
    for (let i = 0; i < turn.cells[0]; i += 1) for (let j = 0; j < turn.cells[1]; j += 1) cells.add(`${piece.cell[0] + i},${piece.cell[1] + j}`);
  }
  return cells;
}

const cellOf = (p: Point) => `${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)}`;

/** Points every half cell along a route. */
function samples(route: Point[]): Point[] {
  const out: Point[] = [route[0]!];
  for (let i = 1; i < route.length; i += 1) {
    const a = route[i - 1]!;
    const b = route[i]!;
    const steps = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / (CELL / 2)));
    for (let s = 1; s <= steps; s += 1) out.push({ x: a.x + ((b.x - a.x) * s) / steps, y: a.y + ((b.y - a.y) * s) / steps });
  }
  return out;
}

/** Whether a segment crosses the boundary of a room anywhere but through one of its openings. */
function crossesWall(layout: RoomLayout, a: Point, b: Point): boolean {
  const inside = (p: Point, room: RoomLayout["rooms"][number]) =>
    p.x > room.x * CELL && p.x < (room.x + room.w) * CELL && p.y > room.y * CELL && p.y < (room.y + room.d) * CELL;
  for (const room of layout.rooms) {
    if (inside(a, room) === inside(b, room)) continue;
    // Leaving or entering: only through an opening of the front rim, along the axis.
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const ix = Math.floor(mid.x / CELL) - room.x;
    const iy = Math.floor(mid.y / CELL) - room.y;
    const throughFrontY = Math.abs(a.x - b.x) < 0.01 && room.open.y.includes(ix) && Math.max(a.y, b.y) >= (room.y + room.d) * CELL;
    const throughFrontX = Math.abs(a.y - b.y) < 0.01 && room.open.x.includes(iy) && Math.max(a.x, b.x) >= (room.x + room.w) * CELL;
    if (!throughFrontY && !throughFrontX) return true;
  }
  return false;
}

function checkRoute(layout: RoomLayout, route: Point[], label: string) {
  const blocked = occupied(layout);
  for (let i = 1; i < route.length; i += 1) {
    const a = route[i - 1]!;
    const b = route[i]!;
    assert.ok(Math.abs(a.x - b.x) < 0.01 || Math.abs(a.y - b.y) < 0.01, `${label}: axis-aligned`);
    assert.ok(!crossesWall(layout, a, b), `${label}: through a wall near ${cellOf(b)}`);
  }
  // The first point is the seat (in a chair); everything after walks on free cells, seen from the viewer.
  for (const point of samples(route).slice(2)) {
    assert.ok(!blocked.has(cellOf(point)), `${label}: through furniture at ${cellOf(point)}`);
    assert.ok(!hiddenByWalls(layout, point.x, point.y), `${label}: behind a wall at ${cellOf(point)}`);
  }
}

test("the floor set parses and has every piece the templates use", () => {
  for (const template of Object.values(FLOOR_TEMPLATES)) {
    for (const room of template.rooms) {
      for (const piece of room.pieces) assert.ok(turnOf(floorSet, piece.name, piece.turn), `${piece.name} ${piece.turn}`);
    }
  }
  for (const name of ["workstation", "desk-chair", "filing-cabinet", "reception-counter"]) assert.ok(floorSet.furniture[name], name);
});

test("no room hides another: every cell of a room and of the hall is in front of the other rooms' back walls", () => {
  for (const layout of layouts()) {
    for (const room of layout.rooms) {
      for (let cx = room.x; cx < room.x + room.w; cx += 1) {
        for (let cy = room.y; cy < room.y + room.d; cy += 1) {
          for (const [fx, fy] of [
            [0.5, 0.5],
            [0.1, 0.1],
            [0.9, 0.9],
            [0.1, 0.9],
            [0.9, 0.1],
          ] as const) {
            assert.ok(!hiddenByWalls(layout, (cx + fx) * CELL, (cy + fy) * CELL), `${layout.template}: ${room.kind} at ${cx},${cy} is hidden`);
          }
        }
      }
    }
  }
});

test("rooms do not overlap, pieces stay inside their room and never share a cell", () => {
  for (const layout of layouts()) {
    const cells = new Map<string, string>();
    layout.rooms.forEach((room, index) => {
      for (let cx = room.x; cx < room.x + room.w; cx += 1) {
        for (let cy = room.y; cy < room.y + room.d; cy += 1) {
          const id = `${cx},${cy}`;
          assert.ok(!cells.has(id), `${layout.template}: rooms overlap at ${id}`);
          cells.set(id, String(index));
        }
      }
    });
    const taken = new Map<string, string>();
    for (const piece of layout.pieces) {
      const turn = turnOf(floorSet, piece.name, piece.turn);
      if (turn.flat) continue;
      for (let i = 0; i < turn.cells[0]; i += 1) {
        for (let j = 0; j < turn.cells[1]; j += 1) {
          const id = `${piece.cell[0] + i},${piece.cell[1] + j}`;
          assert.equal(cells.get(id), String(piece.room), `${layout.template}: ${piece.name} at ${id} outside its room`);
          assert.ok(!taken.has(id), `${layout.template}: ${piece.name} and ${taken.get(id)} share ${id}`);
          taken.set(id, piece.name);
        }
      }
    }
  }
});

test("routes walk the aisles and lanes only: axis-aligned, through openings, around furniture, never behind a wall", () => {
  for (const layout of layouts()) {
    const spots = [...layout.offices, ...(layout.reception ? [layout.reception.office] : [])];
    for (const office of spots) {
      const toUser = routeToUser(layout, office);
      checkRoute(layout, toUser, `${layout.template}: ${office.key} to the tray`);
      const spot = dropSpotOf(layout, office.key);
      assert.ok(spot, `${layout.template}: ${office.key} has somewhere to drop a folder`);
      const end = toUser[toUser.length - 1]!;
      assert.ok(Math.hypot(end.x - spot.stand.x, end.y - spot.stand.y) < 0.01, `${layout.template}: ${office.key} reaches it`);
      for (const other of spots) {
        if (other !== office) checkRoute(layout, routeToOffice(layout, office, other), `${layout.template}: ${office.key} to ${other.key}`);
      }
    }
  }
});

/** Furniture tall enough to stand in front of a window: it never does. */
const TALL = new Set([
  "bookshelf",
  "whiteboard",
  "filing-cabinet",
  "water-cooler",
  "plant-tall",
  "coffee-corner",
  "library-shelf",
  "library-shelf-b",
  "library-shelf-c",
  "library-ladder",
  "globe",
  "floor-lamp",
]);

/**
 * The cells of a room's walls with what lies beyond each: the back walls (-y,
 * -x, their kind) and the front rim (+y, +x, open or not), each with the cell
 * just inside and the cell on the other side.
 */
function wallCells(room: RoomLayout["rooms"][number]) {
  const cells: { side: string; kind: string; inside: [number, number]; beyond: [number, number] }[] = [];
  room.back.y.forEach((kind, i) => cells.push({ side: "-y", kind, inside: [room.x + i, room.y], beyond: [room.x + i, room.y - 1] }));
  room.back.x.forEach((kind, j) => cells.push({ side: "-x", kind, inside: [room.x, room.y + j], beyond: [room.x - 1, room.y + j] }));
  for (let i = 0; i < room.w; i += 1) {
    const inside: [number, number] = [room.x + i, room.y + room.d - 1];
    cells.push({ side: "+y", kind: room.open.y.includes(i) ? "opening" : "rim", inside, beyond: [room.x + i, room.y + room.d] });
  }
  for (let j = 0; j < room.d; j += 1) {
    const inside: [number, number] = [room.x + room.w - 1, room.y + j];
    cells.push({ side: "+x", kind: room.open.x.includes(j) ? "opening" : "rim", inside, beyond: [room.x + room.w, room.y + j] });
  }
  return cells;
}

test("walls make sense: doors and openings lead onto the hall, windows look outside, nothing tall hides a window, nothing blocks a door", () => {
  for (const layout of layouts()) {
    const hall = new Set(layout.hall.map(([cx, cy]) => `${cx},${cy}`));
    const inRoom = (cx: number, cy: number) =>
      layout.rooms.some((room) => cx >= room.x && cx < room.x + room.w && cy >= room.y && cy < room.y + room.d);
    const pieceAt = new Map<string, string>();
    for (const piece of layout.pieces) {
      const turn = turnOf(floorSet, piece.name, piece.turn);
      if (turn.flat) continue;
      for (let i = 0; i < turn.cells[0]; i += 1) for (let j = 0; j < turn.cells[1]; j += 1) pieceAt.set(`${piece.cell[0] + i},${piece.cell[1] + j}`, piece.name);
    }
    for (const room of layout.rooms) {
      let ways = 0;
      for (const { side, kind, inside, beyond } of wallCells(room)) {
        const label = `${layout.template}: ${room.kind} at ${room.x},${room.y}, ${side} wall by ${inside.join(",")}`;
        const id = beyond.join(",");
        const here = pieceAt.get(inside.join(","));
        if (kind === "door" || kind === "opening") {
          ways += 1;
          assert.ok(hall.has(id), `${label}: the ${kind} leads onto the hall, not outside or into a room`);
          assert.equal(here, undefined, `${label}: the ${kind} is not blocked by a ${here}`);
        }
        if (kind === "window") {
          assert.ok(!hall.has(id) && !inRoom(beyond[0], beyond[1]), `${label}: the window looks outside, not onto the hall or a room`);
          assert.ok(!here || !TALL.has(here), `${label}: a ${here} stands in front of the window`);
        }
      }
      assert.ok(ways >= 1, `${layout.template}: ${room.kind} has a way in`);
      // A side without a back wall (a room of a wing of the single floor) is a low partition: another room all along it.
      const owner = (cx: number, cy: number) =>
        layout.rooms.find((other) => other !== room && cx >= other.x && cx < other.x + other.w && cy >= other.y && cy < other.y + other.d);
      if (room.back.y.length === 0) {
        for (let i = 0; i < room.w; i += 1) assert.ok(owner(room.x + i, room.y - 1), `${layout.template}: ${room.kind} at ${room.x},${room.y} is open at the back`);
      } else assert.equal(room.back.y.length, room.w);
      if (room.back.x.length === 0) {
        for (let j = 0; j < room.d; j += 1) assert.ok(owner(room.x - 1, room.y + j), `${layout.template}: ${room.kind} at ${room.x},${room.y} is open on its side`);
      } else assert.equal(room.back.x.length, room.d);
    }
  }
});

test("the hall is one piece: every cell of it reaches every other", () => {
  for (const layout of layouts()) {
    const cells = new Set(layout.hall.map(([cx, cy]) => `${cx},${cy}`));
    const start = layout.hall[0]!;
    const seen = new Set([`${start[0]},${start[1]}`]);
    const queue = [start];
    while (queue.length > 0) {
      const [cx, cy] = queue.shift()!;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const id = `${cx + dx},${cy + dy}`;
        if (cells.has(id) && !seen.has(id)) {
          seen.add(id);
          queue.push([cx + dx, cy + dy]);
        }
      }
    }
    assert.equal(seen.size, cells.size, `${layout.template}: the hall is connected`);
  }
});

test("a template by size, agents in the desks in order, the counter on request only", () => {
  const expected = (count: number) => (count <= 3 ? "small" : count <= 6 ? "medium" : "large");
  for (let count = 1; count <= 12; count += 1) {
    const layout = layoutRoom(keys(count));
    assert.equal(layout.template, expected(count));
    assert.equal(layout.offices.length, count);
    assert.equal(new Set(layout.offices.map((o) => `${o.seat.x},${o.seat.y}`)).size, count, "no two agents share a chair");
    for (const office of layout.offices) assert.equal(layout.pieces[office.chair!]!.name, "desk-chair");
    assert.equal(layout.reception, null);
    assert.ok(layout.board !== null, "a whiteboard");
    assert.ok(layout.coffee !== null, "a coffee corner");
    assert.ok(layout.bounds.w > layout.bounds.h, "a floor wider than tall");
  }
  const withDesk = layoutRoom(keys(2), { reception: true });
  assert.equal(withDesk.reception?.office.key, RECEPTION_KEY);
  assert.equal(withDesk.reception?.office.chair, null, "the receptionist stands behind the counter");
  assert.equal(withDesk.pieces[withDesk.reception!.counter]!.name, "reception-counter");
  assert.ok(layoutRoom(keys(1)).rooms.some((room) => room.kind === "office" && !room.vacant));
  assert.equal(layoutRoom(keys(13)).offices.length, 12, "agents beyond the desks have no office");
});

test("the scene: tiles first in depth order, walls and furniture sorted, masks tinted", () => {
  const layout = layoutRoom(keys(9), { reception: true });
  const scene = buildFloorScene(floorSet, layout, true);
  const cells = layout.hall.length + layout.rooms.reduce((total, room) => total + room.w * room.d, 0);
  assert.ok(scene.flat.length >= cells, "a tile per cell");
  assert.ok(scene.flat.some((draw) => draw.tint === "pastel"), "room carpets take the pastel of the colour");
  assert.ok(scene.sorted.some((item) => item.draws.some((draw) => draw.tint === "room")), "sofas and the counter take the colour");
  assert.ok(buildFloorScene(floorSet, layout, false).flat.every((draw) => draw.tint !== "pastel"), "no colour: neutral carpet and tiles");
  for (const draw of [...scene.flat, ...scene.sorted.flatMap((item) => item.draws)]) {
    assert.ok(Number.isInteger(draw.x) && Number.isInteger(draw.y), "whole pixels");
    assert.ok(draw.frame < floorSet.atlas.frames.length);
  }
});

test("depth order: a box that ends before another on x or y is drawn first", () => {
  const desk = { x0: 0, y0: 0, x1: 32, y1: 16 };
  const chair = { x0: 0, y0: 16, x1: 16, y1: 32 };
  const walker = { x0: 20, y0: 36, x1: 28, y1: 44 };
  const behindWall = { x0: 0, y0: -4, x1: 16, y1: 0 };
  assert.ok(behind(desk, chair) && !behind(chair, desk));
  assert.deepEqual(depthOrder([walker, chair, desk, behindWall]), [3, 2, 1, 0]);
});

test("sheets: rows by direction and animation, a neutral person per agent, the pastel of a colour", () => {
  assert.equal(sheetRow("NE", "idle"), 0);
  assert.equal(sheetRow("SE", "walk"), 4);
  assert.equal(sheetRow("NW", "type"), 11);
  assert.equal(neutralPersonFor("r/a"), neutralPersonFor("r/a"));
  assert.ok(new Set(keys(12).map(neutralPersonFor)).size > 1, "not everybody looks the same");
  for (const sheet of NEUTRAL_PEOPLE) assert.ok(fs.existsSync(path.join(root, "public", sheet)), sheet);
  assert.equal(pastel(0xff3d7f), 0xffa5bd);
});

// ---- The single floor (myhq.json `floor.layout: "room-per-project"`) ----------------------------

test("the single floor: a room per room of the home, its colour, its agents at its desks, a counter and a drop spot in each", () => {
  for (const counts of floorHomes()) {
    const rooms = homeRooms(counts);
    const layout = layoutFloor(rooms, { reception: rooms[0]!.name, receptionist: true });
    const label = `rooms ${counts.join(",")}`;
    assert.equal(layout.template, "rooms");
    assert.equal(layout.user, null, `${label}: no tray of a lobby`);
    for (const room of rooms) {
      const placed = layout.rooms.filter((each) => each.project === room.name);
      assert.equal(placed.length, 1, `${label}: one room for ${room.name}`);
      assert.equal(placed[0]!.color, room.color, `${label}: ${room.name} keeps its colour`);
      const seated = layout.offices.filter((office) => roomOfKey(office.key) === room.name);
      assert.equal(seated.length, Math.min(MAX_ROOM_AGENTS, room.keys.length), `${label}: ${room.name} seats its agents`);
      for (const office of seated) assert.equal(layout.rooms[office.room]!.project, room.name, `${label}: ${office.key} works in its own room`);
      const owners = layout.owners.filter((owner) => owner.room === room.name);
      assert.equal(owners.length, 1, `${label}: where the items of ${room.name} are dropped`);
      const home = layout.rooms[owners[0]!.roomIndex]!;
      assert.equal(home.project, room.name);
      assert.ok(home.counter, `${label}: ${room.name} has its counter`);
      // The drop spot is in the room's opening, and no desk is left for the user in the room.
      const [cx, cy] = [Math.floor(owners[0]!.stand.x / CELL), Math.floor(owners[0]!.stand.y / CELL)];
      assert.deepEqual([cy, home.open.y.includes(cx - home.x)], [home.y + home.d - 1, true], `${label}: ${room.name} drops in its opening`);
      const desks = layout.pieces.filter((piece) => piece.room === owners[0]!.roomIndex && piece.name === "workstation").length;
      assert.equal(desks, Math.min(MAX_ROOM_AGENTS, room.keys.length), `${label}: ${room.name} has a desk per agent, none for the user`);
    }
    assert.equal(new Set(layout.offices.map((o) => `${o.seat.x},${o.seat.y}`)).size, layout.offices.length, `${label}: one agent per chair`);
    // The lobby: with the reception counter, the receptionist and the drop spot and counter of the onboarding room.
    const lobby = layout.rooms[0]!;
    assert.deepEqual([lobby.kind, lobby.w, lobby.d], ["lobby", LOBBY_SIZE, LOBBY_SIZE]);
    assert.equal(layout.reception?.office.key, RECEPTION_KEY);
    assert.ok(layout.owners.some((owner) => owner.room === RECEPTION_ROOM && owner.roomIndex === 0));
    assert.ok(lobby.counter, `${label}: the lobby has its counter`);
    assert.ok(!layout.rooms.some((each) => each.kind === "owner" && each.counter), `${label}: the user's office has none`);
    assert.ok(layout.coffee !== null, `${label}: a coffee corner`);
  }
});

/** Cells of a floor's box (the rooms, the hall and the garden fill it) taken by rooms or corridors. */
function usedShare(layout: RoomLayout): number {
  const cells = new Set(layout.hall.map(([cx, cy]) => `${cx},${cy}`));
  for (const room of layout.rooms) for (let cx = room.x; cx < room.x + room.w; cx += 1) for (let cy = room.y; cy < room.y + room.d; cy += 1) cells.add(`${cx},${cy}`);
  return cells.size / (cells.size + layout.garden.length);
}

test("the single floor: separate suites around a spine and its ribs, packed, the reception's room next to the lobby", () => {
  for (const counts of floorHomes()) {
    const rooms = homeRooms(counts);
    const reception = rooms[rooms.length - 1]!.name;
    const layout = layoutFloor(rooms, { reception, receptionist: false });
    const label = `rooms ${counts.join(",")}`;
    assert.equal(layout.reception, null, `${label}: no counter without the receptionist`);
    // The reception's room is the first suite placed after the lobby: right above it, or first on the lobby's rib.
    assert.equal(layout.rooms[1]!.project, reception, `${label}: the reception's room next to the lobby`);
    // Blocks stand apart (the shadow of a wall between them, or a corridor and that shadow), each with its own walls.
    layout.rooms.forEach((a, i) => {
      assert.ok(a.back.x.length > 0 && a.back.y.length > 0, `${label}: the block at ${a.x},${a.y} has its walls`);
      layout.rooms.forEach((b, j) => {
        if (j <= i) return;
        const apartX = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
        const apartY = Math.max(b.y - (a.y + a.d), a.y - (b.y + b.d));
        assert.ok(apartX >= BESIDE || apartY >= BESIDE, `${label}: blocks at ${a.x},${a.y} and ${b.x},${b.y} stand apart`);
      });
    });
    // Not a line: from two rooms on, the blocks spread along x and along y.
    if (rooms.length >= 2) {
      assert.ok(new Set(layout.rooms.map((room) => room.x)).size >= 2, `${label}: more than one column`);
      assert.ok(new Set(layout.rooms.map((room) => room.y)).size >= 2, `${label}: more than one row`);
    }
    // Packed: rooms and corridors take most of the floor's box, the garden (the shadow strips between the rows,
    // four cells deep for the signboards) fills only the rest: about 55 % for a usual home, under 45 % only for a
    // home of one or two rooms.
    assert.ok(usedShare(layout) >= 0.35, `${label}: ${Math.round(usedShare(layout) * 100)} % of the box used`);
    const taken = new Set([...layout.hall].map(([cx, cy]) => `${cx},${cy}`));
    for (const [cx, cy] of layout.garden) {
      assert.ok(!taken.has(`${cx},${cy}`), `${label}: the garden is not on the hall`);
      assert.ok(!layout.rooms.some((room) => cx >= room.x && cx < room.x + room.w && cy >= room.y && cy < room.y + room.d), `${label}: nor in a room`);
    }
    for (const room of rooms) {
      const placed = layout.rooms.find((each) => each.project === room.name)!;
      const length = placed.open.y.length > 0 ? placed.w : placed.d;
      assert.equal(length, roomLength(room.keys.length), `${label}: ${room.name} sized from its agents`);
    }
  }
  assert.ok(roomLength(1) < roomLength(6) && roomLength(6) < roomLength(12), "a bigger team, a longer room");
  const crowded = layoutFloor(homeRooms([15]), { reception: null });
  assert.equal(crowded.offices.length, MAX_ROOM_AGENTS, "agents beyond the desks of a room have no office");
});

test("the single floor: a library keeps the desks and aisles of its suite, lines its walls with books, reads in a wing", () => {
  const LIBRARY = new Set(["library-shelf", "library-shelf-b", "library-shelf-c", "library-ladder", "reading-table", "armchair", "side-table", "floor-lamp", "globe", "rug", "book-stacks", "plant-small"]);
  for (let count = 1; count <= MAX_ROOM_AGENTS; count += 1) {
    const office = layoutFloor([{ name: "lib", color: "#2e8b6e", keys: keys(count, "lib") }], { reception: null });
    const layout = layoutFloor([{ name: "lib", color: "#2e8b6e", decor: "library", keys: keys(count, "lib") }], { reception: null });
    const index = layout.rooms.findIndex((room) => room.project === "lib");
    const room = layout.rooms[index]!;
    const plain = office.rooms.find((each) => each.project === "lib")!;
    const label = `a library of ${count}`;
    assert.equal(room.floor, "wood", `${label}: a wooden floor`);
    assert.equal(plain.floor, "carpet-room", `${label}: an office keeps its carpet`);
    assert.equal(room.w, roomLength(count, "library"), `${label}: sized with its reading wing`);
    // The reading wing takes the place of a big team's nook, and adds three cells to a smaller team's suite.
    assert.equal(roomLength(count, "library"), roomLength(count) + (count >= 6 ? 0 : 3), `${label}: its length`);
    const pieces = layout.pieces.filter((piece) => piece.room === index);
    // The same desks as an office of the same team, at the same places in the suite.
    const desks = (each: RoomLayout, at: number) =>
      each.pieces.filter((piece) => piece.name === "workstation" && piece.room === at).map((piece) => `${piece.cell[0] - each.rooms[at]!.x},${piece.cell[1] - each.rooms[at]!.y}`);
    assert.deepEqual(desks(layout, index), desks(office, office.rooms.indexOf(plain)), `${label}: its desks`);
    for (const piece of pieces) {
      if (piece.name === "workstation" || piece.name === "desk-chair") continue;
      assert.ok(LIBRARY.has(piece.name), `${label}: a ${piece.name} in a library`);
    }
    // Walls of books: every cell of the back wall without a desk holds a shelf, a ladder among them.
    const backDesks = new Set(pieces.filter((piece) => piece.name === "workstation" && piece.cell[1] === room.y).flatMap((piece) => [piece.cell[0], piece.cell[0] + 1]));
    for (let cx = room.x; cx < room.x + room.w; cx += 1) {
      if (backDesks.has(cx)) continue;
      const here = pieces.find((piece) => piece.cell[0] === cx && piece.cell[1] === room.y);
      assert.ok(here && here.name.startsWith("library-"), `${label}: a shelf against the back wall at ${cx - room.x}`);
    }
    assert.ok(pieces.some((piece) => piece.name === "library-ladder"), `${label}: a ladder`);
    for (const name of ["armchair", "floor-lamp", "side-table", "rug", "book-stacks"]) assert.equal(pieces.filter((piece) => piece.name === name).length, 1, `${label}: its ${name}`);
    assert.ok(!pieces.some((piece) => ["coffee-corner", "sofa", "water-cooler", "printer", "whiteboard", "bookshelf"].includes(piece.name)), `${label}: no office furniture`);
  }
  // A lone agent: the spare places of the front row take a reading table, the side wall its shelves, the corner a globe.
  const lone = layoutFloor([{ name: "lib", color: null, decor: "library", keys: keys(1, "lib") }], { reception: null });
  const names = lone.pieces.map((piece) => piece.name);
  assert.ok(names.includes("reading-table") && names.includes("globe"));
  assert.equal(lone.pieces.filter((piece) => piece.name.startsWith("library-") && piece.turn === 1).length, 2);
});

test("the single floor: the lobby is the entrance, at the front, where the main corridor starts", () => {
  for (const counts of floorHomes()) {
    const layout = layoutFloor(homeRooms(counts), { reception: "p0", receptionist: true });
    const label = `rooms ${counts.join(",")}`;
    const lobby = layout.rooms[0]!;
    assert.equal(lobby.kind, "lobby");
    // At the front: the corner nearest the viewer (the bottom of the screen, the largest x + y) is the lobby's.
    const front = (room: RoomLayout["rooms"][number]) => room.x + room.w + room.y + room.d;
    assert.equal(front(lobby), Math.max(...layout.rooms.map(front)), `${label}: the lobby is in front`);
    // It opens onto the main corridor, and the corridors start there: their front corner (where the main corridor
    // and the spine meet) is in front of the lobby, nothing of the hall lies further towards the viewer.
    const door: [number, number] = [lobby.x + lobby.open.y[0]!, lobby.y + lobby.d];
    const hall = new Set(layout.hall.map(([cx, cy]) => `${cx},${cy}`));
    assert.ok(hall.has(`${door[0]},${door[1]}`), `${label}: the lobby opens onto the corridor`);
    const corner = layout.hall.reduce((best, cell) => (cell[0] + cell[1] > best[0] + best[1] ? cell : best));
    assert.ok(
      corner[0] >= lobby.x && corner[0] < lobby.x + lobby.w + 2 && corner[1] >= lobby.y + lobby.d && corner[1] < lobby.y + lobby.d + 2,
      `${label}: the corridors start in front of the lobby, not at ${corner.join(",")}`,
    );
    // Every other block is reached from there: the receptionist walks to every desk.
    const office = layout.reception!.office;
    for (const other of layout.offices) {
      const route = routeToOffice(layout, office, other);
      assert.ok(route.length >= 2, `${label}: a way to ${other.key}`);
    }
  }
});

test("the single floor: an agent brings its folder to the user's desk of its own room", () => {
  const rooms = homeRooms([3, 2]);
  const layout = layoutFloor(rooms, { reception: "p0", receptionist: true });
  for (const office of [...layout.offices, layout.reception!.office]) {
    const spot = dropSpotOf(layout, office.key)!;
    const owner = layout.owners.find((each) => each === spot);
    assert.ok(owner, office.key);
    assert.equal(owner.room, roomOfKey(office.key));
  }
});

test("the single floor's scene: each room takes its own colour, a room without one stays neutral", () => {
  const layout = layoutFloor(homeRooms([4, 3]), { reception: "p0", receptionist: true });
  const scene = buildFloorScene(floorSet, layout, (room) => layout.rooms[room]?.color != null);
  const colored = layout.rooms.findIndex((room) => room.color !== null);
  const plain = layout.rooms.findIndex((room) => room.project === "p1");
  assert.ok(scene.flat.some((draw) => draw.tint === "pastel" && draw.room === colored), "the coloured room's carpet");
  assert.ok(!scene.flat.some((draw) => draw.tint === "pastel" && draw.room === plain), "the neutral room's carpet");
  assert.ok(scene.flat.filter((draw) => draw.room === -1).length >= layout.hall.length, "the hall belongs to no room");
});
