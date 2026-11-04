// Composes a floor the way the runtime should: tiles first, then floor
// shadows, then walls, furniture and characters in depth order (each with
// its tint masks), from the floor atlas data and character sheets. Used for
// the mock floor previews; it doubles as the reference for implementers.
import { DIRECTIONS as CHAR_DIRECTIONS, frameOf, FRAME } from "./character.mjs";
import { CELL, WALL } from "./furniture.mjs";
import { Img, blit, colour, crop, filled, pastel, tintOnto } from "./image.mjs";

/** Screen pixel of a floor point in voxels (z = 0), relative to the floor origin. */
export const screenOf = (x, y, z = 0) => [2 * (x - y), x + y - 2 * z];

const wallName = (kind) => (kind === "plain" ? "wall" : `wall-${kind}`);

/** True when box a is behind box b (non overlapping footprints, in voxels). */
function behind(a, b) {
  const ax = a.x1 <= b.x0, ay = a.y1 <= b.y0, bx = b.x1 <= a.x0, by = b.y1 <= a.y0;
  if ((ax || ay) && !(bx || by)) return true;
  if ((bx || by) && !(ax || ay)) return false;
  return a.x0 + a.x1 + a.y0 + a.y1 < b.x0 + b.x1 + b.y0 + b.y1; // overlap or both ways: by centre
}

/** Sorts drawables back to front (a topological sort on `behind`). */
export function depthSort(items) {
  const n = items.length;
  const after = items.map(() => []);
  const count = new Array(n).fill(0);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (i !== j && behind(items[i].box, items[j].box) && !behind(items[j].box, items[i].box)) { after[i].push(j); count[j]++; }
  }
  const out = [];
  const ready = items.map((_, i) => i).filter((i) => count[i] === 0);
  while (ready.length) {
    ready.sort((a, b) => items[a].box.x0 + items[a].box.y0 - (items[b].box.x0 + items[b].box.y0) || a - b);
    const i = ready.shift();
    out.push(items[i]);
    for (const j of after[i]) if (--count[j] === 0) ready.push(j);
  }
  if (out.length !== n) for (let i = 0; i < n; i++) if (!out.includes(items[i])) out.push(items[i]); // cycles: keep going
  return out;
}

/**
 * Builds a floor picture. `floor` is { json, atlas } from buildFloor();
 * `scene`: { rooms: [{ x, y, w, d, tile, colour, back: { y: [kinds], x: [kinds] } }],
 * pieces: [{ name, turn, cell: [cx, cy], room }], characters: [{ sheet, direction,
 * animation, frame, at: [vx, vy] } | { sheet, animation, frame, chair: index of a
 * desk-chair piece }] }.
 */
export function composeFloor(floor, scene, { background = colour("ink5"), margin = 24 } = {}) {
  const { json, atlas } = floor;
  const frame = (ref) => {
    const [k] = ref;
    const [x, y, w, h] = json.atlas.frames[k];
    return crop(atlas.img, { x, y, w, h });
  };
  // Extent of the floor in screen space.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const r of scene.rooms) {
    for (const [cx, cy] of [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.d], [r.x + r.w, r.y + r.d]]) {
      const [sx, sy] = screenOf(cx * CELL, cy * CELL);
      minX = Math.min(minX, sx); maxX = Math.max(maxX, sx); minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
    }
  }
  minY -= WALL.height * 2;
  const ox = margin - minX, oy = margin - minY;
  const img = filled(maxX - minX + 2 * margin, maxY - minY + 2 * margin + 8, background);
  const at = (vx, vy, ref) => { const [sx, sy] = screenOf(vx, vy); return [ox + sx + ref[1], oy + sy + ref[2]]; };
  const draw = (vx, vy, ref) => {
    if (!ref) return;
    blit(img, frame(ref), ...at(vx, vy, ref));
  };
  const drawMasks = (vx, vy, masks, roomColour) => {
    for (const m of masks ?? []) tintOnto(img, frame(m.frame), ...at(vx, vy, m.frame), m.mode === "pastel" ? pastel(roomColour) : roomColour);
  };

  // 1. Tiles, back to front.
  for (const r of scene.rooms) {
    for (let s = 0; s < r.w + r.d; s++) for (let cx = r.x; cx < r.x + r.w; cx++) {
      const cy = r.y + s - (cx - r.x);
      if (cy < r.y || cy >= r.y + r.d) continue;
      const variants = json.tiles[r.tile];
      const t = variants[(cx * 7 + cy * 3) % variants.length];
      draw(cx * CELL, cy * CELL, t.sprite);
      drawMasks(cx * CELL, cy * CELL, t.masks, r.colour);
    }
  }
  // 2. Floor shadows of the furniture.
  const roomOf = (p) => scene.rooms[p.room ?? 0];
  for (const p of scene.pieces) {
    const turn = json.furniture[p.name].turns[p.turn];
    draw(p.cell[0] * CELL, p.cell[1] * CELL, turn.shadow);
  }
  // Flat pieces (rugs) lie on the floor: under everything else.
  for (const p of scene.pieces) {
    const turn = json.furniture[p.name].turns[p.turn];
    if (!turn.flat) continue;
    draw(p.cell[0] * CELL, p.cell[1] * CELL, turn.sprite);
    drawMasks(p.cell[0] * CELL, p.cell[1] * CELL, turn.masks, roomOf(p).colour);
  }
  // 3. Walls, rims, furniture and characters in depth order.
  const items = [];
  const box = (x0, y0, x1, y1) => ({ x0, y0, x1, y1 });
  for (const r of scene.rooms) {
    const X = r.x * CELL, Y = r.y * CELL, X1 = (r.x + r.w) * CELL, Y1 = (r.y + r.d) * CELL;
    (r.back?.y ?? []).forEach((kind, i) => {
      const vx = X + i * CELL;
      items.push({ box: box(vx, Y - WALL.thick, vx + CELL, Y), paint: () => draw(vx, Y, json.walls[wallName(kind)][0].sprite) });
    });
    (r.back?.x ?? []).forEach((kind, i) => {
      const vy = Y + i * CELL;
      items.push({ box: box(X - WALL.thick, vy, X, vy + CELL), paint: () => draw(X, vy, json.walls[wallName(kind)][1].sprite) });
    });
    items.push({ box: box(X - WALL.thick, Y - WALL.thick, X, Y), paint: () => draw(X, Y, json.walls["wall-corner"].sprite) });
    for (let i = 0; i < r.w; i++) {
      if (r.gaps?.y?.includes(i)) continue;
      const vx = X + i * CELL;
      items.push({ box: box(vx, Y1, vx + CELL, Y1 + WALL.thick), paint: () => draw(vx, Y1 - CELL, json.walls.rim[0].sprite) });
    }
    for (let i = 0; i < r.d; i++) {
      if (r.gaps?.x?.includes(i)) continue;
      const vy = Y + i * CELL;
      items.push({ box: box(X1, vy, X1 + WALL.thick, vy + CELL), paint: () => draw(X1 - CELL, vy, json.walls.rim[1].sprite) });
    }
    items.push({ box: box(X1, Y1, X1 + WALL.thick, Y1 + WALL.thick), paint: () => draw(X1 - CELL, Y1 - CELL, json.walls["rim-corner"].sprite) });
  }
  const sitters = new Map();
  for (const c of scene.characters) if (c.chair !== undefined) sitters.set(c.chair, c);
  const characterFrame = (c, direction) => frameOf(c.sheet, direction, c.animation, c.frame);
  scene.pieces.forEach((p, index) => {
    const turn = json.furniture[p.name].turns[p.turn];
    if (turn.flat) return;
    const vx = p.cell[0] * CELL, vy = p.cell[1] * CELL;
    const colourOf = roomOf(p).colour;
    const b = box(vx, vy, vx + turn.cells[0] * CELL, vy + turn.cells[1] * CELL);
    const sitter = sitters.get(index);
    items.push({
      box: b,
      paint: () => {
        if (!sitter) { draw(vx, vy, turn.sprite); drawMasks(vx, vy, turn.masks, colourOf); return; }
        for (const ref of turn.under) draw(vx, vy, ref);
        const [sx, sy] = turn.seat;
        const [ax, ay] = at(vx, vy, [0, 0, 0]);
        blit(img, characterFrame(sitter, turn.sitterFaces), ax + sx - FRAME.anchor[0], ay + sy - FRAME.anchor[1]);
        for (const ref of turn.over) draw(vx, vy, ref);
      },
    });
  });
  for (const c of scene.characters) {
    if (c.chair !== undefined) continue;
    const [vx, vy] = c.at;
    items.push({
      box: box(vx - 4, vy - 4, vx + 4, vy + 4),
      paint: () => {
        const [sx, sy] = screenOf(vx, vy);
        blit(img, characterFrame(c, c.direction), ox + sx - FRAME.anchor[0], oy + sy - FRAME.anchor[1]);
      },
    });
  }
  for (const item of depthSort(items)) item.paint();
  return img;
}

export { CHAR_DIRECTIONS };
