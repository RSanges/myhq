// Voxel characters: a small rig (head, torso, arms, legs), its poses, and
// the sheet renderer. A model is a function `(b, pose)` that draws the
// character facing +y with its feet centre at the local origin; the sheet
// turns it a quarter turn per direction (never mirrors a lit sprite).
//
// Sheet format (see README.md): rows = direction x animation, in the order
// of DIRECTIONS then ANIMATIONS; columns = frames; every frame is FRAME.w x
// FRAME.h px with the feet anchor at FRAME.anchor.
import { World, material, render } from "./engine.mjs";
import { Img, bbox, blit, crop, fromRender } from "./image.mjs";

/** Directions in row order, with the quarter turn that makes the model face them. */
export const DIRECTIONS = [
  { name: "NE", rot: 2 }, // facing -y, back to the viewer
  { name: "SE", rot: 1 }, // facing +x
  { name: "SW", rot: 0 }, // facing +y
  { name: "NW", rot: 3 }, // facing -x
];
/** Animations in row order: frames, ms per frame. */
export const ANIMATIONS = [
  { name: "idle", frames: 2, ms: 600 },
  { name: "walk", frames: 8, ms: 100 },
  { name: "type", frames: 4, ms: 150 },
];
export const COLUMNS = 8;
/** Frame size and the feet anchor (seated frames: the seat centre on the ground). */
export const FRAME = { w: 96, h: 136, anchor: [48, 120] };
/** Seat top height for seated frames, matching the floor chairs. */
export const SEAT_TOP = 14;

// ---------------------------------------------------------------- poses

/**
 * The pose of one frame, shared by every model: `phase` (walk cycle, 0 to
 * 1), `seated`, `breath` (idle, 0 or 1), `keys` (typing: which hand is up,
 * -1 left, 1 right, 0 none), `stride` (walk: forward offset of the left
 * foot, -1 to 1, the right foot is opposite), `lift` (walk: how high each
 * foot is, 0 to 1) and `bob` (walk: body rise, 0 or 1).
 */
export function poseOf(animation, frame) {
  if (animation === "walk") {
    const p = frame / 8;
    const s = Math.cos(2 * Math.PI * p); // 1: left foot forward (contact), -1: right foot forward
    // Frames 0 and 4 are contacts, 2 and 6 passing poses with the body up.
    const swingLeft = Math.sin(2 * Math.PI * p) < -0.01; // the left foot moves forward in the second half
    const up = Math.abs(Math.sin(2 * Math.PI * p));
    return {
      animation, frame, phase: p, seated: false, stride: s,
      lift: [swingLeft ? up : 0, swingLeft ? 0 : up],
      bob: frame % 4 === 2 ? 1 : 0,
    };
  }
  if (animation === "type") return { animation, frame, seated: true, keys: [-1, 0, 1, 0][frame] };
  return { animation, frame, seated: false, breath: frame };
}

// ---------------------------------------------------------------- humans

const rad = (deg) => (deg * Math.PI) / 180;
const add = (a, b) => a.map((v, k) => v + b[k]);
const scale = (a, s) => a.map((v) => v * s);
const sub = (a, b) => a.map((v, k) => v - b[k]);
const len = (a) => Math.hypot(...a);
const norm = (a) => scale(a, 1 / (len(a) || 1));

/** Two bone IK: the elbow (or knee) between `a` and target `c`, bending towards `pole`. */
export function bend(a, c, l1, l2, pole) {
  const d = Math.min(len(sub(c, a)), l1 + l2 - 0.01);
  const dir = norm(sub(c, a));
  const x = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - x * x));
  const p = sub(pole, scale(dir, pole[0] * dir[0] + pole[1] * dir[1] + pole[2] * dir[2]));
  return add(add(a, scale(dir, x)), scale(norm(p), h));
}

/**
 * A box with rounded edges: voxels within r of the box shrunk by r. `pick(x,
 * y, z)` returns the material of each voxel, or null to skip it.
 */
function rounded(b, x0, y0, z0, w, d, h, r, pick) {
  const c = (v, lo, size) => Math.max(lo + r, Math.min(lo + size - r, v));
  for (let x = x0; x < x0 + w; x++) for (let y = y0; y < y0 + d; y++) for (let z = z0; z < z0 + h; z++) {
    const px = x + 0.5, py = y + 0.5, pz = z + 0.5;
    if (Math.hypot(px - c(px, x0, w), py - c(py, y0, d), pz - c(pz, z0, h)) > r + 0.25) continue;
    const m = pick(x, y, z);
    if (m) b.set(x, y, z, m);
  }
}

/**
 * The wing of a moustache, on the -x side (mirrored for the other): [x, y, z
 * above the base of the head], from the middle (x -2 to 1) out. A plain one
 * stops at the corner of the mouth; a handlebar's tip curls up inside the
 * face, under the eye, the whole about two thirds of the face's width.
 */
const WINGS = {
  plain: [[-3, 5, 2]],
  handlebar: [
    [-3, 5, 2],
    [-4, 5, 3],
  ],
};

const looks = new Map();
/** Materials of a look, created once. */
function lookMaterials(look) {
  const key = JSON.stringify(look);
  if (looks.has(key)) return looks.get(key);
  const m = (spec, extra = {}) => material({ rim: false, ...spec, ...extra });
  const out = {
    skin: m(look.skin),
    hair: m(look.hair),
    top: m(look.top),
    sleeve: m(look.top, { crease: false, top: look.top.left }),
    trim: m(look.trim ?? look.top),
    bottom: m(look.bottom),
    leg: m(look.bottom, { crease: false, top: look.bottom.left }),
    shoes: m(look.shoes ?? { ramp: "ink", top: 2, left: 1, right: 1 }),
    extra: look.extra ? m(look.extra) : null,
    beard: look.beard ? m(look.beard) : null,
    moustache: look.moustache ? m(look.moustache.colour ?? look.beard ?? look.hair) : null,
    brows: look.brows ? m(look.brows === true ? look.hair : look.brows) : null,
    lips: m(look.lips ?? { ...look.skin, top: Math.max(1, look.skin.top - 2), left: Math.max(1, look.skin.left - 2), right: Math.max(1, look.skin.right - 2) }),
  };
  looks.set(key, out);
  return out;
}

/**
 * A human, about 51 voxels tall, facing +y, feet centre at (0, 0, 0).
 * `look`: { skin, hair, top, bottom, shoes, trim, extra } material specs
 * ({ ramp, top, left, right }), `hairStyle` (short, bun, long, or
 * side-part: short sides and back, a quiff on top swept to the +x side),
 * `headset`, `cap` (a cap with a peak towards +y, in the `extra` material).
 * Face, all optional: `eyes` (a material spec, ink by default), `brows`
 * (true for the hair's colour, or a spec), `expression: "smile"` (eyes
 * narrowed to a dash, the lips showing, in `lips`, a spec, the skin's ramp
 * two levels darker by default), `beard` (a spec: a full beard, sideburns to
 * the hair, a full jaw and chin under bare cheeks), `moustache` ({ style,
 * colour }: style "plain" or "handlebar", thin in the middle, about two thirds
 * of the face's width, a handlebar's tips curling up inside the face under the
 * eyes; colour a spec, the beard's or the hair's by default), `eyeLift`
 * (whole voxels the eyes sit higher, 0 by default).
 * `rig` lets a model hold things: `hand(pose, { side, k, shoulder, sz })`
 * returns a hand target (or null for the shared pose), `props(b, pose,
 * { sz, hipZ, H, hands })` draws what the hands hold, after the body.
 */
export function human(look, rig = {}) {
  const M = lookMaterials(look);
  const eyes = material({ rim: false, ...(look.eyes ?? { ramp: "ink", top: 1, left: 1, right: 1 }) });
  const eyeLift = look.eyeLift ?? 0;
  return (b, pose) => {
    const L1 = 10, L2 = 10; // thigh, shin
    const A1 = 7, A2 = 7; // upper arm, forearm
    const seated = pose.seated;
    // Hips, legs and feet.
    const hipZ = seated ? SEAT_TOP + 1.5 : 22 + (pose.bob ?? 0);
    const legs = [-1, 1].map((side, k) => {
      const hip = [side * 2.5, 0, hipZ];
      if (seated) {
        const knee = [side * 2.6, 9, hipZ];
        const ankle = [side * 2.6, 10.5, 4];
        return { hip, knee, ankle, footY: 1 };
      }
      if (pose.animation === "walk") {
        const stride = (k === 0 ? 1 : -1) * pose.stride * 5.5;
        const lift = pose.lift[k] * 3;
        const ankle = [side * 2.5, stride, 2 + lift];
        const knee = bend(hip, ankle, L1, L2, [0, 1, 0]);
        return { hip, knee, ankle, footY: 1 };
      }
      const ankle = [side * 2.5, 0, 2];
      return { hip, knee: bend(hip, ankle, L1, L2, [0, 1, 0]), ankle, footY: 1 };
    });
    for (const { hip, knee, ankle } of legs) {
      b.capsule(hip, knee, 1.75, M.leg);
      b.capsule(knee, ankle, 1.6, M.leg);
      const fx = Math.round(ankle[0] - 1.5), fy = Math.round(ankle[1] - 1.5), fz = Math.round(ankle[2] - 2);
      b.box(fx, fy, fz, 3, 5, 2, M.shoes);
    }
    // Torso: a rounded block, the trousers' waistband below.
    const breath = pose.breath ?? 0;
    const tz = hipZ - 1;
    const top = tz + 15 - breath;
    b.box(-5, -3, tz, 10, 6, 3, M.bottom);
    rounded(b, -5, -3, tz + 3, 10, 6, top - tz - 3, 1.4, () => M.top);
    b.box(-3, -1, top, 6, 3, 1, M.trim); // collar
    b.box(-1, -1, top + 1, 2, 2, 1, M.skin); // neck
    // Head: a rounded block, eyes on the +y face; the hair covers the top,
    // the back and the temples, with a little volume on top and behind.
    const H = Math.round(top + 1);
    // A side parting shows more forehead: the hairline is a voxel higher in front.
    const hairline = look.hairStyle === "side-part" ? (y) => (y >= 3 ? H + 9 : H + 8) : () => H + 8;
    const isHair = (x, y, z) => z >= hairline(y) || (y <= -2 && z >= H + 3) || (Math.abs(x + 0.5) >= 4 && y <= 1 && z >= H + 5);
    // A full beard: the jaw and the chin up to the mouth, the sideburns up to the hair; the
    // cheeks stay bare, so a moustache reads against them.
    const isBeard = (x, y, z) => {
      if (M.beard === null || y < -2) return false;
      const side = Math.abs(x + 0.5);
      // The sideburns at the back of the cheek only; in front, a row of skin under the mouth.
      return z <= (side >= 4 && y <= 0 ? H + 5 : y >= 3 ? H - 1 : H);
    };
    rounded(b, -5, -5, H, 10, 10, 11, 2.2, (x, y, z) => (isHair(x, y, z) ? M.hair : isBeard(x, y, z) ? M.beard : M.skin));
    const empty = (m) => (x, y, z) => (b.has(x, y, z) ? null : m);
    if (look.hairStyle === "side-part") {
      // Short at the back and sides: no volume behind; on top a quiff, higher at the front and on the +x side.
      rounded(b, -5, -5, H + 9, 10, 10, 3, 1.6, empty(M.hair));
      rounded(b, -3, -3, H + 11, 8, 9, 2, 1, empty(M.hair));
      rounded(b, -4, 1, H + 10, 9, 5, 3, 1.2, empty(M.hair));
    } else {
      rounded(b, -5, -6, H + 4, 10, 6, 8, 2.2, empty(M.hair)); // volume at the back
      rounded(b, -5, -5, H + 9, 10, 9, 3, 1.6, empty(M.hair)); // volume on top
    }
    if (M.beard) {
      // Full: the jaw a little wider than the head at the back, the chin down over the collar.
      rounded(b, -6, -2, H - 1, 12, 5, 2, 1, empty(M.beard));
      rounded(b, -4, 0, H - 3, 8, 6, 3, 1.6, (x, y, z) => (y >= 1 || !b.has(x, y, z) ? M.beard : null));
    }
    if (look.expression === "smile") {
      // Eyes narrowed by the smile (a short dash each), and the lips under the moustache, a voxel in front of
      // the face so that they show.
      for (const x of [-4, 2]) b.box(x, 4, H + 4 + eyeLift, 2, 1, 1, eyes);
      b.box(-2, 5, H + 1, 4, 1, 1, M.lips);
    } else {
      for (const x of [-3, 2]) for (const z of [H + 4, H + 5]) b.set(x, 4, z + eyeLift, eyes);
    }
    if (M.brows) for (const x of [-4, -3, 2, 3]) b.set(x, 5, H + 6, M.brows);
    if (M.moustache) {
      // Over the mouth, in front of the face, a voxel high: bare skin between it and the nose.
      b.box(-2, 5, H + 2, 4, 1, 1, M.moustache);
      b.box(-1, 6, H + 2, 2, 1, 1, M.moustache);
      // Its wings, out from the middle (x towards -x, then mirrored).
      const wing = WINGS[look.moustache.style === "handlebar" ? "handlebar" : "plain"];
      for (const side of [-1, 1]) {
        const x = (v) => (side < 0 ? v : -1 - v); // mirror about the head's centre (x = -0.5)
        for (const [wx, wy, wz] of wing) b.set(x(wx), wy, H + wz, M.moustache);
      }
    }
    if (look.hairStyle === "bun") b.ellipsoid(0, -5, H + 11, 2.8, 2.8, 2.8, M.hair);
    if (look.hairStyle === "long") rounded(b, -4, -6, H - 2, 8, 3, 9, 1.4, (x, y, z) => (b.has(x, y, z) ? null : M.hair));
    if (look.cap) {
      rounded(b, -5, -6, H + 8, 10, 11, 4, 1.6, () => M.extra); // crown over the hair
      b.box(-4, 5, H + 8, 8, 3, 1, M.extra); // peak
    }
    if (look.headset) {
      b.box(-6, -1, H + 3, 1, 3, 5, M.extra);
      b.box(5, -1, H + 3, 1, 3, 5, M.extra);
      b.box(-5, -1, H + 12, 10, 2, 1, M.extra);
      b.line([-6, 1, H + 3], [-4, 5, H + 2], M.extra);
    }
    // Arms: shoulders, elbows, hands.
    const sz = top - 2;
    const arms = [-1, 1].map((side, k) => {
      const shoulder = [side * 6, 0, sz];
      let hand;
      if (seated) {
        const up = pose.keys === (k === 0 ? -1 : 1) ? 1.5 : 0;
        hand = [side * 3.5, 12, 26.5 + up];
      } else if (pose.animation === "walk") {
        const swing = -(k === 0 ? 1 : -1) * pose.stride * 4;
        hand = [side * 7, swing, sz - 13];
      } else {
        hand = [side * 7, 0.5, sz - 13.5 + breath];
      }
      hand = rig.hand?.(pose, { side, k, shoulder, sz }) ?? hand;
      const elbow = bend(shoulder, hand, A1, A2, [side * 0.6, -0.4, -1]);
      return { shoulder, elbow, hand };
    });
    for (const { shoulder, elbow, hand } of arms) {
      b.capsule(shoulder, elbow, 1.45, M.sleeve);
      b.capsule(elbow, hand, 1.35, M.sleeve);
      b.ellipsoid(hand[0], hand[1], hand[2] - 0.5, 1.6, 1.6, 1.6, M.skin);
    }
    rig.props?.(b, pose, { sz, hipZ, H, hands: arms.map((arm) => arm.hand) });
  };
}

// ---------------------------------------------------------------- janitor

/**
 * Where the brush is in the sweep frames (the `type` row of a janitor's
 * sheet): an arc in front of the feet, from the middle to the right. Everything a character
 * holds stays within |x| + |y| <= 12 voxels of its feet, or the frame's
 * bottom (15 px under the anchor) cuts it in some direction.
 */
const SWEEP = [
  [1, 6],
  [4, 4.5],
  [6, 2],
  [4, 4.5],
];

/**
 * The floor's janitor: a human (see `human`) with a broom (a wooden handle
 * and a brush) and a bucket of water with a bail. Standing still, the broom
 * stands in the right hand and the bucket on the floor by the left foot;
 * walking, it carries both; the `type` row of its sheet is not seated
 * typing but sweeping, standing, both hands on the handle, the brush going
 * side to side in front, the bucket on the floor.
 */
export function janitor(look) {
  const wood = material({ ramp: "wood", top: 4, left: 4, right: 3, rim: false, crease: false });
  const brush = material({ ramp: "wood", top: 2, left: 2, right: 1, rim: false });
  const bristle = material({ ramp: "gold", top: 4, left: 3, right: 2, rim: false, crease: false });
  const pail = material({ ramp: "gold", top: 4, left: 3, right: 2, round: [0, 0], rim: false });
  const water = material({ ramp: "sky", top: 2, left: 2, right: 1, rim: false, emissive: true });
  const bail = material({ ramp: "ink", top: 3, left: 2, right: 2, rim: false, crease: false });

  /** The broom: a handle from `foot` (the brush, on the ground) to `top`, the brush across x (sweeping) or along y (carried). */
  const broom = (b, foot, top, across) => {
    b.capsule(foot, top, 0.9, wood);
    const [x, y, z] = foot.map(Math.round);
    const [bx, by, w, d] = across ? [x - 3, y - 1, 7, 3] : [x - 1, y - 2, 2, 5];
    b.box(bx, by, z + 1, w, d, 2, brush);
    b.box(bx, by, z - 2, w, d, 3, bristle);
  };
  /** The bucket, its bottom centre at (x, y, z): a yellow pail, water inside, its bail up to `grip` (or resting on the rim). */
  const bucket = (b, [x, y, z], grip = null) => {
    const r = 3.6, h = 8;
    b.cylinder(x, y, z, r - 0.5, 1, pail);
    b.cylinder(x, y, z + 1, r, h - 1, pail, r - 1.3);
    b.cylinder(x, y, z + h - 2, r - 1.2, 1, water);
    const top = z + h;
    if (grip) {
      b.line([x - r + 0.5, y, top - 1], grip, bail);
      b.line([x + r - 0.5, y, top - 1], grip, bail);
    } else {
      b.line([x - r + 0.5, y, top - 1], [x, y + r - 0.5, top - 1], bail);
    }
  };
  const sweeping = (pose) => pose.animation === "sweep";
  /** Brush and top of the handle while sweeping: the brush on the ground, the top of the handle in front of the chest. */
  const sweepHandle = (pose) => {
    const [bx, by] = SWEEP[pose.frame % SWEEP.length];
    return { foot: [bx, by, 2], top: [1, 6, 37] };
  };
  const along = ({ foot, top }, t) => foot.map((v, k) => v + (top[k] - v) * t);

  const body = human(look, {
    hand(pose, { side, sz }) {
      if (sweeping(pose)) return along(sweepHandle(pose), side < 0 ? 0.8 : 0.55);
      if (pose.animation === "walk") {
        // Right hand: the broom, carried upright; left hand: the bucket. Both swing a little.
        const swing = (side < 0 ? 1 : -1) * pose.stride * 1.5;
        return side > 0 ? [6.5, 1 + swing, sz - 12] : [-7.5, swing, sz - 13.5];
      }
      return side > 0 ? [6.5, 1.5, sz - 12 + (pose.breath ?? 0)] : null;
    },
    props(b, pose, { hands }) {
      const [left, right] = hands;
      if (sweeping(pose)) {
        const { foot, top } = sweepHandle(pose);
        broom(b, foot, top, true);
        bucket(b, [-8, -1, 0]);
        return;
      }
      broom(b, [right[0] + 0.5, right[1] + 1, 2], [right[0], right[1] - 1, right[2] + 18], false);
      if (pose.animation === "walk") bucket(b, [left[0], left[1], left[2] - 14], [left[0], left[1], left[2] - 1]);
      else bucket(b, [-8, 0, 0]);
    },
  });
  return (b, pose) => body(b, pose.animation === "type" ? { animation: "sweep", frame: pose.frame, seated: false } : pose);
}

// ---------------------------------------------------------------- sheets

/**
 * Renders the full sheet of a model: returns { img, frames } where frames
 * lists, per row, the frame count. Throws when a frame does not fit.
 */
export function renderSheet(model, { frame = FRAME, measure = null } = {}) {
  const rows = DIRECTIONS.length * ANIMATIONS.length;
  const img = new Img(frame.w * COLUMNS, frame.h * rows);
  DIRECTIONS.forEach((dir, d) => {
    ANIMATIONS.forEach((anim, a) => {
      for (let f = 0; f < anim.frames; f++) {
        const world = new World();
        world.add("character", [0, 0, 0], (b) => model(b, poseOf(anim.name, f)), { rot: dir.rot });
        const r = render(world, { ground: true });
        const { sprite } = fromRender(r);
        const box = bbox(sprite);
        // Anchor: the screen pixel of world (0, 0, 0).
        const ox = frame.anchor[0] + r.uMin, oy = frame.anchor[1] + r.vMin;
        const x = ox + box.x, y = oy + box.y;
        if (measure) {
          measure.left = Math.min(measure.left ?? 0, x - frame.anchor[0]);
          measure.top = Math.min(measure.top ?? 0, y - frame.anchor[1]);
          measure.right = Math.max(measure.right ?? 0, x + box.w - frame.anchor[0]);
          measure.bottom = Math.max(measure.bottom ?? 0, y + box.h - frame.anchor[1]);
          continue;
        }
        if (x < 1 || y < 1 || x + box.w > frame.w - 1 || y + box.h > frame.h - 1) {
          throw new Error(`${dir.name} ${anim.name} ${f}: ${box.w}x${box.h} at ${x},${y} does not fit the ${frame.w}x${frame.h} frame`);
        }
        const cell = new Img(frame.w, frame.h);
        blit(cell, crop(sprite, box), x, y);
        blit(img, cell, f * frame.w, (d * ANIMATIONS.length + a) * frame.h);
      }
    });
  });
  return img;
}

/** One frame of a sheet, as an image. */
export function frameOf(sheet, direction, animation, index, frame = FRAME) {
  const d = DIRECTIONS.findIndex((x) => x.name === direction);
  const a = ANIMATIONS.findIndex((x) => x.name === animation);
  return crop(sheet, { x: index * frame.w, y: (d * ANIMATIONS.length + a) * frame.h, w: frame.w, h: frame.h });
}

/** The sheet format, for the JSON next to the sheets. */
export function sheetFormat(frame = FRAME) {
  return {
    frame: { w: frame.w, h: frame.h },
    anchor: frame.anchor,
    columns: COLUMNS,
    rows: DIRECTIONS.flatMap((d) => ANIMATIONS.map((a) => ({ direction: d.name, animation: a.name, frames: a.frames, ms: a.ms }))),
    seatTop: SEAT_TOP,
  };
}
