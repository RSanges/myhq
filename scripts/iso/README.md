# Iso pixel art pipeline

A small voxel to isometric rasterizer in plain Node (no dependency): every
prop is a JS function that places voxels, the engine projects them at 1x
with a z-buffer, then shades, lights and outlines the result. Same code, same
bytes.

```
node scripts/iso/build.mjs            # pile of 6 documents
node scripts/iso/build.mjs --pile 11  # the pile height follows a count
```

Outputs land in `public/iso/`: `scene-desk.png` (1x), `scene-desk@3x.png`,
`scene-desk-hover.png` (the document pile with its hover outline), one
transparent PNG per prop, `props.json` and `contact-sheet@3x.png`.

## Files

- `engine.mjs`: world, builder helpers, rasterizer, lighting, outlines, image helpers.
- `palette.mjs`: the 32 colours and their ramps.
- `props.mjs`: one function per prop.
- `build.mjs`: the scene layout, the lights, the outputs.
- `png.mjs`: PNG encoder on `node:zlib`.

## Add an asset

1. In `props.mjs`, write `export function thing(b, options) { ... }`. Draw in
   local voxels: x and y on the floor from 0, z up from 0 at ground contact.
   Use `b.box(x, y, z, w, d, h, m)`, `b.cylinder(cx, cy, z, r, h, m, inner)`,
   `b.line(a, c, m)`, `b.ellipsoid(...)`, `b.set`, `b.clear`.
2. Materials: `material({ ramp, top, left, right })` picks a ramp of
   `palette.mjs` and a level per face (top lightest, left mid, right dark).
   Add `paint(face, x, y, z, level)` for decals (lines, labels, screens): it
   gets the local surface point and returns a level or `{ ramp, level,
   emissive }`. `round: [cx, cy]` shades a cylinder smoothly, `emissive`
   ignores lighting, `transparent` lets light through.
3. Add it to `PROPS` in `build.mjs` (its own PNG) and, if it belongs in the
   scene, to `LAYOUT` with the world position of its local origin.
4. Run the build and look at the PNGs at 1x and 3x before committing.

## Constants

- Projection: 2:1 dimetric, `u = 2(x - y)`, `v = x + y - 2z`. One voxel is a
  4 x 2 px top diamond with 2 px vertical edges, a 16 x 16 voxel floor cell
  is a 64 x 32 px tile. One voxel is about 3 cm; desk items are about 1.4
  times life size so they read at 1x.
- Faces: top = ramp level `base + 1`, left (+y) = `base`, right (+x) =
  `base - 1`; index 0 of a ramp is its outline tone.
- Outline (`OUTLINE_GAP`, 2.5): a pixel behind the silhouette of a nearer
  object, measured on voxel centre depth, takes that object's darkest ramp
  tone. At ground contact the gap is small, so there is no outline there.
- Crease (`CREASE_GAP`, 2): the same rule inside one object, one tone
  darker. Top edges get a one tone rim light.
- Lights (in `build.mjs`): key light `SUN = [0, 0.55, 1]` (one tone of
  shadow, edges on a half voxel grid so they stay on clean 2:1 lines),
  `COVER = 24` contact shadow under furniture, daylight through the window
  `[-1, 0, 1]` (one tone lighter), the desk lamp (top faces) and the floor
  lamp (halo) as point lights.
- Hover: a 1 px `gold2` line around the hovered object ids.

## Palette

32 colours crafted for MyHQ (not a lospec palette), free to reuse under the
repository licence, in hue-shifted ramps: ink (cool purple greys and paper
whites), wood, sage (walls), leaf, pink (built around the example room colour
`#ff3d7f`, which a spine shows on its lit face), blue, gold, and sky. The
build fails if the palette exceeds 32 colours.

## props.json

For each prop: `file`, `w`, `h`, `anchor` (pixel of the footprint centre on
the ground plane, from the top-left corner of the PNG), `origin` (pixel of
local voxel (0, 0, 0)) and `footprint` in voxels. `scene.objects` lists the
pixel box of every object in `scene-desk.png`, for hit areas.
