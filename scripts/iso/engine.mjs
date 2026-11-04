// Voxel to isometric pixel art rasterizer.
//
// World axes: x runs to the lower right of the screen, y to the lower left,
// z up. The viewer looks along (-1, -1, -1), so the three visible faces of a
// voxel are its top (+z), its LEFT face (+y normal, lower left on screen)
// and its RIGHT face (+x normal, lower right on screen).
//
// Projection (2:1 dimetric, 1x, no anti-aliasing):
//   u = 2 * (x - y)        screen x
//   v = (x + y) - 2 * z    screen y
// so one voxel is a 4 x 2 px top diamond with 2 px vertical edges, and a
// floor cell of 16 x 16 voxels is the classic 64 x 32 px tile.
//
// Every pixel centre is solved exactly against the face planes of each
// exposed voxel face (half-open bounds, so faces never overlap or leave
// gaps) and a z-buffer keeps the nearest one: depth is x + y + z, larger is
// nearer. The output is deterministic: same voxels, same pixels.
import { INDEX, PALETTE, RAMP_ID, RAMP_LIST } from "./palette.mjs";
import { encodePng } from "./png.mjs";

export const TOP = 1;
export const LEFT = 2;
export const RIGHT = 3;
const NORMAL = [null, [0, 0, 1], [0, 1, 0], [1, 0, 0]];

/** Depth gap (in x + y + z units) above which a silhouette gets an outline. */
export const OUTLINE_GAP = 2.5;
/** Depth gap inside one object above which a darker crease line is drawn. */
export const CREASE_GAP = 2.0;

// ---------------------------------------------------------------- materials

export const materials = [null];

/**
 * Declares a material. `ramp` names a palette ramp; `top`, `left` and
 * `right` are the ramp levels of each face (default: base + 1, base,
 * base - 1, so the top is lightest, the left face mid and the right face
 * darker). Options: `paint(face, x, y, z, level)` returns a level, or
 * { ramp, level, emissive }, or null, from the local surface point (decals);
 * `emissive` ignores lighting; `transparent` lets light through;
 * `rim: false` disables the top edge highlight; `round: [cx, cy]` shades
 * the sides as a smooth cylinder around that local axis; `outline` forces the
 * outline colour (a palette name).
 */
export function material(def) {
  const base = def.base ?? 2;
  const m = { top: base + 1, left: base, right: base - 1, rim: true, ...def };
  if (!(m.ramp in RAMP_ID)) throw new Error(`unknown ramp ${m.ramp}`);
  m.rampId = RAMP_ID[m.ramp];
  m.id = materials.length;
  materials.push(m);
  return m;
}

/**
 * Side shading of a round material (`round: [cx, cy]`, its axis in local
 * coordinates): voxel stairs would alternate left and right tones, so the
 * level follows the true cylinder normal instead, with a highlight band on
 * the lit side.
 */
const ROUND_LIGHT = [-0.45, 0.89];
function roundLevel(m, x, y) {
  const dx = x - m.round[0], dy = y - m.round[1];
  const l = Math.hypot(dx, dy) || 1;
  const t = (dx * ROUND_LIGHT[0] + dy * ROUND_LIGHT[1]) / l;
  if (t > 0.8) return m.left + 1;
  if (t > -0.15) return m.left;
  return m.right;
}

// -------------------------------------------------------------------- world

const OFF = 1024;
const SIZE = 2048;
const pack = (x, y, z) => ((x + OFF) * SIZE + (y + OFF)) * SIZE + (z + OFF);

export class World {
  constructor() {
    this.cells = new Map();
    this.objects = [null];
  }

  /**
   * Places an object: `build(b)` draws it with the builder `b` in local
   * coordinates, `at` is the world position of its local origin.
   * `extra.sunShadow: false` keeps it from casting the key light shadow.
   */
  add(name, at, build, extra = {}) {
    const object = { id: this.objects.length, name, origin: at, ...extra };
    this.objects.push(object);
    build(builder(this, object));
    return object;
  }
}

/** Drawing helpers in the local frame of one object. */
export function builder(world, object) {
  const [ox, oy, oz] = object.origin;
  const tag = object.id * 65536;
  const b = {
    set(x, y, z, m) {
      world.cells.set(pack(ox + x, oy + y, oz + z), tag + m.id);
    },
    del(x, y, z) {
      world.cells.delete(pack(ox + x, oy + y, oz + z));
    },
    has(x, y, z) {
      return world.cells.has(pack(ox + x, oy + y, oz + z));
    },
    box(x, y, z, w, d, h, m) {
      for (let i = x; i < x + w; i++) for (let j = y; j < y + d; j++) for (let k = z; k < z + h; k++) b.set(i, j, k, m);
    },
    clear(x, y, z, w, d, h) {
      for (let i = x; i < x + w; i++) for (let j = y; j < y + d; j++) for (let k = z; k < z + h; k++) b.del(i, j, k);
    },
    /** Vertical cylinder centred on (cx, cy): voxel centres within r (and beyond inner). */
    cylinder(cx, cy, z, r, h, m, inner = -1) {
      for (let i = Math.floor(cx - r); i <= Math.ceil(cx + r); i++) {
        for (let j = Math.floor(cy - r); j <= Math.ceil(cy + r); j++) {
          const d2 = (i + 0.5 - cx) ** 2 + (j + 0.5 - cy) ** 2;
          if (d2 <= r * r && (inner < 0 || d2 > inner * inner)) for (let k = z; k < z + h; k++) b.set(i, j, k, m);
        }
      }
    },
    /** A one voxel thick 3D segment between two points. */
    line(a, c, m) {
      const steps = Math.ceil(Math.max(...[0, 1, 2].map((k) => Math.abs(c[k] - a[k]))) * 2) || 1;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        b.set(...[0, 1, 2].map((k) => Math.floor(a[k] + (c[k] - a[k]) * t)), m);
      }
    },
    /** Filled ellipsoid; `keep(i, j, k)` may refuse voxels (holes, cuts). */
    ellipsoid(cx, cy, cz, rx, ry, rz, m, keep = () => true) {
      for (let i = Math.floor(cx - rx); i <= Math.ceil(cx + rx); i++) {
        for (let j = Math.floor(cy - ry); j <= Math.ceil(cy + ry); j++) {
          for (let k = Math.floor(cz - rz); k <= Math.ceil(cz + rz); k++) {
            const e = ((i + 0.5 - cx) / rx) ** 2 + ((j + 0.5 - cy) / ry) ** 2 + ((k + 0.5 - cz) / rz) ** 2;
            if (e <= 1 && keep(i, j, k)) b.set(i, j, k, m);
          }
        }
      }
    },
  };
  return b;
}

/** Small deterministic integer hash in [0, 1). */
export function hash(...values) {
  let h = 2166136261;
  for (const value of values) {
    h ^= value | 0;
    h = Math.imul(h, 16777619);
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995);
    h ^= h >>> 15;
  }
  return (h >>> 0) / 4294967296;
}

// ------------------------------------------------------------------- render

/**
 * Renders a world. Options:
 * - ground: treat empty pixels as a virtual floor at z = 0 (lone props), so
 *   outlines fade out at ground contact like they do in the scene;
 * - sun: [x, y, z] direction towards the key light, casting a one tone
 *   shadow;
 * - cover: height in voxels within which a top face covered from above
 *   gets the shadow tone too (objects with `cover: false` do not count);
 * - windows: [{ dir, outside(x, y, z) }]: daylight through openings, one
 *   tone lighter where a ray towards `dir` reaches an `outside` cell;
 * - lamps: [{ at, radius, topOnly }]: point lights, one tone lighter;
 * - hover: object ids that get a 1 px bright outline.
 * Returns { w, h, idx (palette index per pixel, -1 transparent), obj, uMin, vMin }.
 */
export function render(world, options = {}) {
  const { pad = 2, ground = false, sun = null, cover = 0, windows = [], lamps = [], hover = [], hoverColour = "gold2" } = options;

  // Voxels into flat arrays and a dense grid for ray marching.
  const count = world.cells.size;
  const xs = new Int32Array(count);
  const ys = new Int32Array(count);
  const zs = new Int32Array(count);
  const vs = new Int32Array(count);
  let n = 0;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (const [key, value] of world.cells) {
    const z = (key % SIZE) - OFF;
    const rest = Math.floor(key / SIZE);
    const y = (rest % SIZE) - OFF;
    const x = Math.floor(rest / SIZE) - OFF;
    xs[n] = x; ys[n] = y; zs[n] = z; vs[n] = value; n++;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  const ny = y1 - y0 + 1, nz = z1 - z0 + 1;
  const grid = new Int32Array((x1 - x0 + 1) * ny * nz);
  const cellIndex = (x, y, z) => ((x - x0) * ny + (y - y0)) * nz + (z - z0);
  for (let i = 0; i < count; i++) grid[cellIndex(xs[i], ys[i], zs[i])] = vs[i];
  const inside = (x, y, z) => x >= x0 && x <= x1 && y >= y0 && y <= y1 && z >= z0 && z <= z1;
  const at = (x, y, z) => (inside(x, y, z) ? grid[cellIndex(x, y, z)] : 0);

  // Screen bounds.
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (let i = 0; i < count; i++) {
    const U = 2 * (xs[i] - ys[i]);
    const V = xs[i] + ys[i] - 2 * zs[i];
    if (U - 2 < uMin) uMin = U - 2;
    if (U + 2 > uMax) uMax = U + 2;
    if (V - 2 < vMin) vMin = V - 2;
    if (V + 2 > vMax) vMax = V + 2;
  }
  uMin -= pad; vMin -= pad; uMax += pad; vMax += pad;
  const W = uMax - uMin;
  const H = vMax - vMin;
  const N = W * H;
  const depth = new Float32Array(N).fill(-Infinity);
  // Depth of the voxel centre behind each pixel: outline and crease decisions
  // use it, so they are stable along an edge instead of flickering with the
  // exact surface point.
  const vdepth = new Float32Array(N).fill(-Infinity);
  const cell = new Int32Array(N);
  const face = new Uint8Array(N);
  const PX = new Float32Array(N), PY = new Float32Array(N), PZ = new Float32Array(N);

  const plot = (px, py, d, value, f, X, Y, Z) => {
    const i = py * W + px;
    if (d > depth[i]) {
      depth[i] = d; cell[i] = value; face[i] = f; PX[i] = X; PY[i] = Y; PZ[i] = Z;
      vdepth[i] = Math.floor(X - (f === RIGHT ? 0.5 : 0)) + Math.floor(Y - (f === LEFT ? 0.5 : 0)) + Math.floor(Z - (f === TOP ? 0.5 : 0)) + 1.5;
    }
  };

  // Rasterize every exposed face.
  for (let i = 0; i < count; i++) {
    const x = xs[i], y = ys[i], z = zs[i], value = vs[i];
    const U = 2 * (x - y);
    const V = x + y - 2 * z;
    if (!at(x, y, z + 1)) {
      const Z = z + 1;
      for (let py = V - 2 - vMin; py < V - vMin; py++) {
        for (let px = U - 2 - uMin; px < U + 2 - uMin; px++) {
          const u = px + uMin + 0.5, v = py + vMin + 0.5;
          const X = (u / 2 + v + 2 * Z) / 2, Y = (v + 2 * Z - u / 2) / 2;
          if (X >= x && X < x + 1 && Y >= y && Y < y + 1) plot(px, py, X + Y + Z, value, TOP, X, Y, Z);
        }
      }
    }
    if (!at(x + 1, y, z)) {
      const X = x + 1;
      for (let py = V - 1 - vMin; py < V + 2 - vMin; py++) {
        for (let px = U - uMin; px < U + 2 - uMin; px++) {
          const u = px + uMin + 0.5, v = py + vMin + 0.5;
          const Y = X - u / 2, Z = (X + Y - v) / 2;
          if (Y >= y && Y < y + 1 && Z >= z && Z < z + 1) plot(px, py, X + Y + Z, value, RIGHT, X, Y, Z);
        }
      }
    }
    if (!at(x, y + 1, z)) {
      const Y = y + 1;
      for (let py = V - 1 - vMin; py < V + 2 - vMin; py++) {
        for (let px = U - 2 - uMin; px < U - uMin; px++) {
          const u = px + uMin + 0.5, v = py + vMin + 0.5;
          const X = Y + u / 2, Z = (X + Y - v) / 2;
          if (X >= x && X < x + 1 && Z >= z && Z < z + 1) plot(px, py, X + Y + Z, value, LEFT, X, Y, Z);
        }
      }
    }
  }

  // Ray marching through the grid (Amanatides and Woo). `visit(value, x, y, z)`
  // returns a value to stop with it; leaving the grid returns false.
  const march = (ox, oy, oz, dx, dy, dz, maxT, visit) => {
    let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
    const sx = Math.sign(dx), sy = Math.sign(dy), sz = Math.sign(dz);
    const tdx = dx ? Math.abs(1 / dx) : Infinity, tdy = dy ? Math.abs(1 / dy) : Infinity, tdz = dz ? Math.abs(1 / dz) : Infinity;
    let tx = dx > 0 ? (x + 1 - ox) / dx : dx < 0 ? (ox - x) / -dx : Infinity;
    let ty = dy > 0 ? (y + 1 - oy) / dy : dy < 0 ? (oy - y) / -dy : Infinity;
    let tz = dz > 0 ? (z + 1 - oz) / dz : dz < 0 ? (oz - z) / -dz : Infinity;
    let t = 0;
    while (t <= maxT) {
      if (!inside(x, y, z)) return false;
      const result = visit(grid[cellIndex(x, y, z)], x, y, z);
      if (result !== undefined) return result;
      if (tx < ty && tx < tz) { x += sx; t = tx; tx += tdx; }
      else if (ty < tz) { y += sy; t = ty; ty += tdy; }
      else { z += sz; t = tz; tz += tdz; }
    }
    return false;
  };
  const matOf = (value) => materials[value & 0xffff];
  const objOf = (value) => world.objects[value >>> 16];
  const blocksCover = (value) => (value && !matOf(value).transparent && objOf(value).sunShadow !== false && objOf(value).cover !== false ? true : undefined);
  const blocksSun = (value) => (value && !matOf(value).transparent && objOf(value).sunShadow !== false ? true : undefined);
  const norm = (v) => { const l = Math.hypot(...v); return v.map((c) => c / l); };
  const sunDir = sun && norm(sun);
  const windowLights = windows.map((w) => ({ ...w, dir: norm(w.dir) }));

  // Lighting is sampled on a half voxel grid, so shadow and light edges
  // follow clean 2:1 or vertical pixel lines.
  const q = (c) => (Math.floor(c * 2) + 0.5) / 2;
  const levelShift = (i) => {
    const f = face[i];
    const [nxv, nyv, nzv] = NORMAL[f];
    let X = PX[i], Y = PY[i], Z = PZ[i];
    if (f === TOP) { X = q(X); Y = q(Y); } else if (f === LEFT) { X = q(X); Z = q(Z); } else { Y = q(Y); Z = q(Z); }
    const ox = X + nxv * 0.01, oy = Y + nyv * 0.01, oz = Z + nzv * 0.01;
    let shift = 0;
    // One shadow tone where the key light is blocked, or where a surface is
    // covered from above (under a desk, a chair, a shelf): contact shadows.
    const covered = f === TOP && cover > 0 && march(ox, oy, oz, 0, 0, 1, cover, blocksCover);
    if (covered || (sunDir && nxv * sunDir[0] + nyv * sunDir[1] + nzv * sunDir[2] > 0 && march(ox, oy, oz, ...sunDir, 400, blocksSun))) shift -= 1;
    for (const w of windowLights) {
      if (nxv * w.dir[0] + nyv * w.dir[1] + nzv * w.dir[2] <= 0) continue;
      const lit = march(ox, oy, oz, ...w.dir, 400, (value, x, y, z) => {
        if (value && !matOf(value).transparent) return false;
        if (w.outside(x, y, z)) return true;
        return undefined;
      });
      if (lit) { shift += 1; break; }
    }
    for (const lamp of lamps) {
      if (lamp.topOnly && f !== TOP) continue;
      const d = [lamp.at[0] - ox, lamp.at[1] - oy, lamp.at[2] - oz];
      const dist = Math.hypot(...d);
      if (dist > lamp.radius || (lamp.topOnly && d[2] <= 0)) continue;
      const dir = d.map((c) => c / dist);
      if (nxv * dir[0] + nyv * dir[1] + nzv * dir[2] <= 0) continue;
      const blocked = march(ox, oy, oz, ...dir, dist - 1, (value) => (value && !matOf(value).transparent && !matOf(value).emissive ? true : undefined));
      if (!blocked) { shift += 1; break; }
    }
    return shift;
  };

  // Shading: ramp and level per pixel, decals, lighting.
  const rampOf = new Int16Array(N).fill(-1);
  const levelOf = new Int8Array(N);
  const objAt = new Uint16Array(N);
  const emissiveAt = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (!face[i]) continue;
    const m = matOf(cell[i]);
    const o = objOf(cell[i]);
    objAt[i] = o.id;
    const f = face[i];
    let ramp = m.rampId;
    let level = f === TOP ? m.top : f === LEFT ? m.left : m.right;
    if (m.round && f !== TOP) level = roundLevel(m, PX[i] - o.origin[0], PY[i] - o.origin[1]);
    let emissive = m.emissive;
    if (m.paint) {
      const r = m.paint(f, PX[i] - o.origin[0], PY[i] - o.origin[1], PZ[i] - o.origin[2], level);
      if (typeof r === "number") level = r;
      else if (r) {
        if (r.ramp) ramp = RAMP_ID[r.ramp];
        if (r.level !== undefined) level = r.level;
        if (r.emissive !== undefined) emissive = r.emissive;
      }
    }
    if (!emissive) level += levelShift(i);
    emissiveAt[i] = emissive ? 1 : 0;
    rampOf[i] = ramp;
    levelOf[i] = Math.max(1, Math.min(RAMP_LIST[ramp].length - 1, level));
  }

  // Ground depth for empty pixels: a virtual floor at z = 0, or nothing.
  const depthAt = (i) => {
    if (face[i]) return vdepth[i];
    if (!ground) return -Infinity;
    const u = (i % W) + uMin + 0.5, v = Math.floor(i / W) + vMin + 0.5;
    return Math.floor((u / 2 + v) / 2) + Math.floor((v - u / 2) / 2) + 0.5; // floor voxel under the ray
  };
  const neighbours = (i) => {
    const px = i % W, py = (i - px) / W;
    const out = [];
    if (px > 0) out.push(i - 1);
    if (px < W - 1) out.push(i + 1);
    if (py > 0) out.push(i - W);
    if (py < H - 1) out.push(i + W);
    return out;
  };

  // Rim light on top edges and creases where parts of one object meet.
  const shift = new Int8Array(N);
  for (let i = 0; i < N; i++) {
    if (!face[i] || emissiveAt[i]) continue;
    const m = matOf(cell[i]);
    if (face[i] === TOP && m.rim && i + W < N) {
      const j = i + W;
      if (face[j] && face[j] !== TOP && objAt[j] === objAt[i] && Math.abs(depth[i] - depth[j]) < 1.6) shift[i] = 1;
    }
    for (const j of neighbours(i)) {
      if (face[j] && objAt[j] === objAt[i] && vdepth[j] - vdepth[i] > CREASE_GAP) { shift[i] = -1; break; }
    }
  }

  const idx = new Int16Array(N).fill(-1);
  for (let i = 0; i < N; i++) {
    if (!face[i]) continue;
    const ramp = RAMP_LIST[rampOf[i]];
    idx[i] = ramp[Math.max(1, Math.min(ramp.length - 1, levelOf[i] + shift[i]))];
  }

  // Selective outline: a pixel behind the silhouette of a nearer object takes
  // the darkest tone of that object's ramp. At ground contact the depth gap
  // is small, so no outline is drawn there.
  const outlined = idx.slice();
  for (let i = 0; i < N; i++) {
    const di = depthAt(i);
    let best = -1;
    let bestDepth = -Infinity;
    for (const j of neighbours(i)) {
      if (!face[j] || (face[i] && objAt[j] === objAt[i])) continue;
      if (vdepth[j] - di > OUTLINE_GAP && vdepth[j] > bestDepth) { best = j; bestDepth = vdepth[j]; }
    }
    if (best >= 0) {
      const m = matOf(cell[best]);
      outlined[i] = m.outline !== undefined ? INDEX[m.outline] : RAMP_LIST[rampOf[best]][0];
    }
  }

  // Hover: a 1 px bright line around the hovered objects.
  if (hover.length) {
    const set = new Set(hover);
    for (let i = 0; i < N; i++) {
      if (face[i] && set.has(objAt[i])) continue;
      if (neighbours(i).some((j) => face[j] && set.has(objAt[j]))) outlined[i] = INDEX[hoverColour];
    }
  }

  return { w: W, h: H, idx: outlined, obj: objAt, uMin, vMin };
}

// ------------------------------------------------------------------- images

export function blank(w, h, fill = -1) {
  return { w, h, idx: new Int16Array(w * h).fill(fill) };
}

/** Crops transparent borders; returns the image and the crop offset. */
export function trim(img) {
  let ax = img.w, ay = img.h, bx = -1, by = -1;
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      if (img.idx[y * img.w + x] < 0) continue;
      if (x < ax) ax = x;
      if (x > bx) bx = x;
      if (y < ay) ay = y;
      if (y > by) by = y;
    }
  }
  const out = blank(bx - ax + 1, by - ay + 1);
  for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) out.idx[(y - ay) * out.w + x - ax] = img.idx[y * img.w + x];
  return { img: out, dx: ax, dy: ay };
}

/** Nearest neighbour integer upscale. */
export function upscale(img, k) {
  const out = blank(img.w * k, img.h * k);
  for (let y = 0; y < out.h; y++) for (let x = 0; x < out.w; x++) out.idx[y * out.w + x] = img.idx[Math.floor(y / k) * img.w + Math.floor(x / k)];
  return out;
}

/** Copies the opaque pixels of src into dst at (x, y). */
export function blit(dst, src, x, y) {
  for (let j = 0; j < src.h; j++) {
    for (let i = 0; i < src.w; i++) {
      const c = src.idx[j * src.w + i];
      const tx = x + i, ty = y + j;
      if (c >= 0 && tx >= 0 && ty >= 0 && tx < dst.w && ty < dst.h) dst.idx[ty * dst.w + tx] = c;
    }
  }
}

export function toPng(img) {
  const rgba = new Uint8Array(img.w * img.h * 4);
  for (let i = 0; i < img.w * img.h; i++) {
    const c = img.idx[i];
    if (c < 0) continue;
    const [r, g, b] = PALETTE[c];
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = 255;
  }
  return encodePng(img.w, img.h, rgba);
}
