# Iso pixel art pipeline

A small voxel to isometric rasterizer in plain Node (no dependency): every
asset is a JS function that places voxels, the engine projects them at 1x
with a z-buffer, then shades, lights and outlines the result. Same code, same
bytes (the build is deterministic, checked by hashing two runs).

```
node scripts/iso/build.mjs                 # everything (about 25 s)
node scripts/iso/build.mjs hub             # public/iso/hub/
node scripts/iso/build.mjs floor mock      # public/iso/floor/, with the mock floor
node scripts/iso/build.mjs characters      # public/sprites/iso-*.png
```

Every asset is 1x pixel art: draw it at an integer scale with nearest
neighbour sampling (`image-rendering: pixelated`, or Pixi
`scaleMode: "nearest"`), never at a fractional scale.

## Conventions shared by every output

- Projection: 2:1 dimetric, `screen x = 2(x - y)`, `screen y = x + y - 2z`,
  x towards the lower right, y towards the lower left, z up. One voxel is a
  4 x 2 px top diamond with 2 px vertical edges; a floor cell is 16 x 16
  voxels, a 64 x 32 px diamond. One voxel is about 3 cm; furniture is life
  size (desk top z = 25, chair seat z = 14).
- Directions on screen: `SW` = facing +y (lower left), `SE` = +x (lower
  right), `NE` = -y (upper right, back to the viewer), `NW` = -x (upper
  left). The other orientation of a piece is an exact quarter turn of its
  voxel model, never a mirrored sprite (light comes from the same side).
- Light: key light from the front left (`SUN = [0, 0.55, 1]`, one tone of
  shadow), contact shadow under furniture (`COVER = 24` voxels), daylight
  through windows, point lamps in the hub.
- Hover (every interactive object of the hub): the object rises by 2 px and
  gets two 1 px rings, white (`ink6`) inside, gold (`gold2`) outside. It
  reads at 1x and 3x. The hover frame replaces the normal frame.
- Atlas frames are `[x, y, w, h]` rectangles in the atlas PNG.

## Runtime tint (room colours)

Anything that takes a room colour at runtime (pile spines, room carpets and
tiles, rug borders, sofa pillows, the reception band) ships a **tint mask**:
an image of the same placement as its sprite, grey where tinted (the grey
is a multiply factor), transparent elsewhere. A mask has a `mode`:

- `room`: multiply by the room colour itself. Factors: 1.0 on lit faces
  (the exact colour), 0.68 in shade, 0.34 for outlines.
- `pastel`: multiply by a pastel of the room colour: 55 % of the way from
  the colour to `#fffaf0` (`pastel()` in `image.mjs`). For carpets and tiles.

Draw the sprite, then each mask on top, tinted:

- Pixi: a `Sprite` of the mask frame with `tint = colour` (Pixi multiplies).
- Canvas 2D: on an offscreen canvas of the mask size: draw the mask, set
  `globalCompositeOperation = "multiply"`, `fillStyle = colour`,
  `fillRect`, then `"destination-in"` and draw the mask again (restores its
  alpha); draw that canvas at the mask position. Cache per colour.
- Reference implementation: `tintOnto()` in `image.mjs`.

A mask also has a `slot` (0 to 15): which colour it takes when one object
shows several (the document pile: slot k = folder k). Single colour assets
use slot 0.

## Hub: `public/iso/hub/`

The owner's desk scene. `background.png` (340 x 322) is the scene without
its dynamic objects; `hub.png` is the atlas of every state of every dynamic
object; `hub.json` says where to draw them. A state's frame holds the
object, its outline and the shadows it casts on the desk or the wall, so
drawing it over the background gives exactly the full render.

```
hub.json
  background: { file, w, h }
  atlas: { file, w, h, frames: [[x, y, w, h], ...] }
  hover: { lift: 2, rings: 2 }
  calendar: { cols: 7, rows: 6, firstDay: "monday" }
  objects: {
    <name>: {
      module,                       // what it opens (a suggestion)
      states: {
        <state>: null               // nothing to draw (absent newspaper, no post-its)
        | {
          frame,                    // atlas frame index
          at: [x, y],               // where to draw it in the background
          hit: [x, y, w, h],        // hit box in background pixels (the object itself)
          masks: [{ frame, at, mode, slot }],
          hover: { frame, at, masks }
        }
      }
    }
  }
```

Objects and states:

| object | states | notes |
|---|---|---|
| `pile` | `"0"` to `"14"` | documents to approve, one folder per item, on a leather pad (state 0 is the empty pad). Mask slot k is the spine of folder k from the bottom: tint it with the room colour of item k. Gold "sign here" flags on every third folder. |
| `mail` | `"0"` to `"5"` | letter tray with that many envelopes. |
| `postits` | `"0"` to `"5"` | post-its on the monitor; `"0"` is null (no hit box: open the module some other way). |
| `newspaper` | `absent`, `present` | `absent` is null. |
| `calendar` | `default` | plus `calendar.today` below. |
| `phone` | `idle`, `unread` | desk phone; `unread` lights the message lamp and shows an envelope on the display. |

Calendar "today": `objects.calendar.today = { frame, cells }`. `cells[i]`
is where to draw the today frame for grid cell `i = row * 7 + col` (rows
from the top, Monday first): `i = (weekday of the 1st, Monday = 0) + day - 1`
(at most 36). When the calendar is hovered, draw it 2 px higher.

Compose: background, then for each object its current state (or its hover
state under the pointer), then its masks tinted. Objects do not overlap,
so their order does not matter. Previews: `preview.png`, `preview@3x.png`
(pile 9, 3 letters, 3 post-its, newspaper, unread phone, today = cell 10)
and `preview-hover*.png` (every object hovered at once, to judge the rings).

## Floor: `public/iso/floor/`

The office floor: cutaway rooms, back walls at full height (64 voxels),
front walls as a low rim (6 voxels). `floor.png` is one atlas with every
tile, wall and furniture frame, their floor shadows and tint masks;
`floor.json` describes them; `contact-sheet.png` (and `@3x`) shows them all
tinted with an example colour; `mock-floor.png` (and `@3x`) is a composed
floor with two rooms and characters.

**Placement.** Floor cell `(cx, cy)` has its top corner at screen
`(32 (cx - cy), 16 (cx + cy))` from the floor origin. Every frame reference
in `floor.json` is `[frame, dx, dy]`: draw atlas frame `frame` at
`corner + (dx, dy)`, where `corner` is the top corner of the piece's first
cell (its smallest cx and cy). Tiles, walls, shadows, masks and chair layers
all use that same corner.

```
floor.json
  cell: { voxels: 16, w: 64, h: 32 }
  wall: { height: 64, thick: 4, rim: 6 }
  seatTop: 14, deskTop: 25, shadowAlpha: 72
  atlas: { file, w, h, frames: [[x, y, w, h], ...] }
  tiles: { wood | carpet | tiles | carpet-room | tiles-room: [ { sprite, masks } ] }
  walls: {
    wall | wall-window | wall-door: { 0: { edge: "-y", sprite }, 1: { edge: "-x", sprite } },
    rim: { 0: { edge: "+y", sprite }, 1: { edge: "+x", sprite } },
    wall-corner: { sprite }, rim-corner: { sprite }
  }
  furniture: {
    <name>: { cells: [w, d], turns: { <turn>: {
      cells: [w, d],               // footprint in cells for this turn
      flat,                        // true for rugs: draw before the sorted pieces
      faces: "SW" | "SE" | ...,    // where its front faces
      sprite, shadow, masks: [{ frame, mode, slot }],
      // chairs: layers around a sitter
      under: [refs], over: [refs], sitterFaces, seat: [dx, dy],
      // workstation: where its chair goes (cell offset from the corner, chair turn)
      chair: { cell, turn, sitterFaces },
      // reception counter: where the receptionist stands
      staff: { cell, faces }
    } } }
  }
```

- **Tiles**: one per cell, a voxel thick, no outline so they tile
  seamlessly. Several variants per kind (`wood`, `carpet`): pick one by a
  hash of the cell. `carpet-room` and `tiles-room` carry `pastel` masks.
  Draw all tiles first, back to front (by `cx + cy`).
- **Walls**: `wall*` turn 0 stands behind cell `(cx, cy)` along its `-y`
  edge (the back right wall), turn 1 along its `-x` edge (the back left
  wall). `wall-corner` is the post behind the cell's top corner. `rim` turn
  0 runs along the `+y` edge of the cell (front left), turn 1 along `+x`
  (front right); `rim-corner` is the post at the cell's bottom corner. Leave
  a rim out for an opening. Pieces join without seams. A full height back
  wall hides what is behind it: keep rooms that sit behind another one away
  from its back walls (the mock offsets the second room).
- **Floor shadows**: `shadow` frames are ink at alpha 72/255, the contact
  shadow and key light shadow inside the footprint. Draw every shadow after
  the tiles, before the furniture.
- **Furniture** (front facing `SW` at turn 0, `SE` at turn 1):
  `workstation` 2 x 1 (desk, monitor, keyboard), `desk-chair` 1 x 1 (four
  turns), `meeting-table` 3 x 2 (with six chairs), `sofa` 2 x 1 (room colour
  pillows), `coffee-corner` 2 x 1, `whiteboard` 2 x 1, `bookshelf` 2 x 1,
  `plant-tall`, `plant-small`, `printer`, `water-cooler`, `filing-cabinet`
  1 x 1, `rug` 3 x 2 (room colour border; `flat: true`: draw it right after the
  shadows, before sorting, so characters always walk over it), and
  `reception-counter` 3 x 1 (room colour band).
- **Desk and chair**: a `workstation` at turn t takes a `desk-chair` at
  turn t in cell `corner + chair.cell`; the sitter faces the screen
  (`NE` at turn 0, `NW` at turn 1). With a sitter, draw the chair's `under`
  frames, then the sitter's frame with its anchor on `corner + seat`, then
  the chair's `over` frames (the low backrest, which is in front of the
  sitter at turns 0 and 1). Without a sitter, draw `sprite`.
- **Depth order**: everything except tiles, rugs and shadows is sorted back
  to front by footprint: box A is behind box B when A ends before B starts
  on x or on y (`A.x1 <= B.x0` or `A.y1 <= B.y0`); ties by the sum of the
  box centres. A character is a small box (8 x 8 voxels) around its feet; a
  seated character is drawn inside its chair's slot. `depthSort()` in
  `compose.mjs` is the reference; `composeFloor()` draws a whole floor.

## Characters: `public/sprites/iso-*.png`

One sheet per character: `iso-person-blue`, `iso-person-green`,
`iso-person-mustard`, `iso-person-grey` (a neutral person in four looks) and
`iso-receptionist` (headset). `iso-characters.json` repeats the format and
lists the sheets. Previews: `public/iso/characters-preview.png` and
`characters-walk@3x.png`.

- Frame: 96 x 136 px, every frame the same size. Anchor: pixel (48, 120)
  of the frame is the point on the ground under the character's feet
  (seated frames: the ground under the seat centre, see chairs above).
- Columns: frames, 8 per row (unused cells are empty).
- Rows: direction x animation, directions in the order `NE, SE, SW, NW`,
  animations `idle` (2 frames, 600 ms), `walk` (8 frames, 100 ms), `type`
  (4 frames, 150 ms, seated, hands on a keyboard at desk height in front).
  Row = `direction * 3 + animation`: NE idle is row 0, SE walk row 4, NW
  type row 11.
- Walking: a human moves 3 voxels per walk frame (`walk.voxelsPerFrame`;
  a sheet from a private home may give another value in its own JSON), along the axis it faces: per voxel, `+x` is (+2, +1) px,
  `+y` is (-2, +1) px. Paths are axis aligned (no diagonal directions).
- Scale: a standing person is about 53 voxels (106 px), next to a desk top
  at 25 voxels: check `mock-floor@3x.png`.

The rig lives in `character.mjs`: a model is a function `(b, pose)` that
draws a character facing +y with its feet centre at the origin; `poseOf()`
gives the shared poses, `renderSheet()` turns the model per direction and
packs the sheet, `sheetFormat()` gives the JSON. A private home can draw its
own model (a mascot) with the same rig and format by importing these files.

## Files

- `engine.mjs`: world, builder (with quarter turns and sub-assemblies),
  rasterizer, lighting, outlines, tint codes, normal shading.
- `palette.mjs`: the 32 colours and their ramps; `addRamp` and `deriveRamp`
  for extra colours in a private build.
- `image.mjs`: RGBA images, tint masks, hover rings, atlas packing, contact
  sheets, a tiny font, PNG output. `png.mjs`: the PNG encoder.
- `props.mjs`: the hub props. `furniture.mjs`: the floor set.
  `character.mjs`: the rig, poses and sheets. `compose.mjs`: the floor
  composer (reference for the runtime).
- `build.mjs`: entry point; `build-hub.mjs`, `build-floor.mjs`,
  `build-characters.mjs`: one group each.

## Add an asset

1. Write `export function thing(b, options) { ... }` in `props.mjs` (hub) or
   `furniture.mjs` (floor). Draw in local voxels: x and y on the floor from
   0, z up from 0 at ground contact, front towards +y. Use `b.box`,
   `b.cylinder`, `b.capsule`, `b.ellipsoid`, `b.line`, `b.set`, `b.clear`,
   and `b.at(dx, dy, dz)` for a shifted sub-assembly.
2. Materials: `material({ ramp, top, left, right })` picks a ramp of
   `palette.mjs` and a level per face (top lightest, left mid, right dark).
   `paint(face, x, y, z, level)` draws decals in model coordinates (they
   follow a turned object); `round`, `crease: false`, `emissive`,
   `transparent`, `tint` and `slot` are documented in `engine.mjs`.
3. Floor piece: add it to `FURNITURE` with its `cells` and `turns`. Hub
   object: add it to `STATIC` or `DYNAMIC` in `build-hub.mjs`.
4. Run the build and look at the PNGs at 1x and 3x before committing.

## Palette

32 colours crafted for MyHQ (not a lospec palette), free to reuse under the
repository licence, in hue-shifted ramps: ink (cool purple greys and paper
whites), wood, sage (walls), leaf, pink (built around the example room colour
`#ff3d7f`), blue, gold, and sky. The build fails if the shared palette
exceeds 32 colours; tinted pixels and extra ramps of a private build are on
top of it.
