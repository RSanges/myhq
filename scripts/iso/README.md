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

**Atlas version.** `atlas.hash` is a hash of `floor.png` itself: the runtime
loads `floor.json` first, then `floor.png?v=<hash>`, so a page never pairs a
floor.json with an atlas of another build (a cached image after a rebuild
draws every frame from the wrong rectangle: shifted furniture, cut boards).

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
  atlas: { file, w, h, hash, frames: [[x, y, w, h], ...] }
  tiles: { wood | carpet | tiles | carpet-room | tiles-room | grass: [ { sprite, masks } ] }
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
  sign: { end, segment, post, bottom, top, period: [dx, dy], left, middle, right }
  font: { height, spacing, glyphs: { <char>: [rows of "#" and "."] } }
  office: { cells: [w, d], sprite, states: { pile: [state], mail: [state] }, chair: { seat: [dx, dy], over } }
    state: { sprite, masks: [{ frame, mode, slot }] } | null
```

- **Tiles**: one per cell, a voxel thick, no outline so they tile
  seamlessly. Several variants per kind (`wood`, `carpet`, `grass`): pick one
  by a hash of the cell. `grass` (the leaf ramp, a few lighter blades and
  darker tufts) is the garden between the suites of the single floor. `carpet-room` and `tiles-room` carry `pastel` masks.
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
  `plant-tall`, `plant-small`, `printer`, `water-cooler`, `filing-cabinet`,
  `broom-closet` (a tall cupboard with a spare broom, where the janitor of the
  single floor rests) 1 x 1, `rug` 3 x 2 (room colour border; `flat: true`: draw it right after the
  shadows, before sorting, so characters always walk over it),
  `reception-counter` 3 x 1 (room colour band). The library decor of a room
  (`decor: "library"` of its `room.json`, see `src/ui/floor-plan.ts`):
  `library-shelf`, `library-shelf-b`, `library-shelf-c` 1 x 1 (a tall shelf,
  `LIBRARY_SHELF_TOP` voxels, five rows of books packed tight, three seeds so
  a wall of them does not repeat; side by side they join into a wall of
  books), `library-ladder` 1 x 1 (the same shelf with a ladder hooked to a
  brass rail), `reading-table` 2 x 1 (an open book, a stack, a banker's
  lamp), `armchair` 1 x 1 (four turns, a room colour cushion), `side-table`,
  `floor-lamp` (the hub's), `globe` and `book-stacks` 1 x 1.
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

- **The user's own office** (`office`): the hub's scene (`build-hub.mjs`
  exports its `STATIC` and `DYNAMIC` props and its `lights()`; the same props
  at the same places from the back corner, but the chair pushed in to the desk,
  `OFFICE_CHAIR_AT`) rendered in a room of `cells`
  (6 x 6, the office of the single floor) with the floor's wall height, its
  floor a voxel thick and ending at the room's edges. `sprite` is the whole
  room (floor, back walls, window, furniture, post-its, phone, newspaper,
  calendar) from the top corner of its first cell: the runtime draws it
  instead of the office's tiles, back walls and pieces, as one sorted box. The
  post-its (3), the newspaper and the calendar are drawn once and for all;
  `states.pile[n]` (n from 0 to 14, a folder per item, mask slot k: folder k)
  and `states.mail[n]` (0 to 5 letters) are the hub's states, the pixels that
  change over `sprite`, drawn over it. `chair` seats someone (`floor.owner`
  of a home's `myhq.json`): `seat` is where the sitter's anchor goes, from the
  same corner (the seat centre on the ground, raised 2 px since the hub chair's
  cushion is a voxel above `seatTop`; the sitter faces `NE`, the desk), and
  `over` the chair's back and armrests as the scene shows them, drawn over the
  sitter.

## Signboards and their font (in `floor.json`)

The signboard of a room of the single floor (`signBoard()` in
`furniture.mjs`): a board facing +y that stands on two short wooden posts on
top of the back wall along x, its front flush with the wall's front (y = 0),
from `bottom` (67 voxels) to `top` (79: the wall is 64). Its face takes the
room colour (`room` mask, level 2: the exact colour) and its frame, one voxel
proud of the face, a shade darker (level 1). It is built as one long board
and sliced into three parts, so a board of any length joins without a seam:

- Placement: the anchor is the screen pixel of the board's back left corner
  on the floor, under its front face (world point (u0, Y, 0) for a board
  starting at voxel u0 on a wall whose front is at Y). Refs are
  `[frame, dx, dy]` from the anchor, as everywhere.
- A board of `n` middle segments (n >= 1, each `segment` voxels long, the
  ends `end` voxels each: `2 end + n segment` voxels in all) is the `left`
  part at the anchor, `n - 1` copies of the `middle` part, the k-th shifted
  by k times `period` (`[2 segment, segment]` pixels: 16 to the right and 8
  down), and the `right` part shifted by `n - 1` periods.
  Each part has its `sprite` and its `masks`.
- `face` of each part: `{ x, cols }`, the face's pixel columns from column
  `x` (from the anchor): `[top, height]` of the face in each column, or null.
  The face falls one pixel every two columns (the slope of the wall). The
  runtime writes the name there with the font below, one font pixel a 2 x 2
  square on those stairs, and the logo on its left (`src/ui/room-signs.ts`).
- The counter of a room (what waits for the user there) is a board of the
  same parts with two middle segments and a number on its face. On a wall
  along y the runtime draws the parts mirrored (`scale.x = -1` about the
  anchor, the anchor being the board's back corner on that wall) and paints
  the face on the mirrored columns (`x' = -x - 1`), so the number still reads
  left to right.

`font` is the sign font (`font.mjs`): 7 pixels high, proportional, capitals,
digits and `-_.'&`, drawn for MyHQ (same licence as the palette). Glyphs are
rows of `#` (ink) and `.`, `spacing` pixels apart.

## Characters: `public/sprites/iso-*.png`

One sheet per character: `iso-person-blue`, `iso-person-green`,
`iso-person-mustard`, `iso-person-grey` (a neutral person in four looks),
`iso-receptionist` (headset) and `iso-janitor` (a navy overall and cap, a
broom and a yellow bucket of water). `iso-characters.json` repeats the format and
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
- The janitor (`janitor()` in `character.mjs`, the sheet of an agent with
  `floor.behaviour: "roam"`) never sits: its `type` row is **sweeping**,
  standing, both hands on the broom, the brush going side to side in front
  of the feet (4 frames, 150 ms), the bucket on the floor. Standing still it
  holds the broom upright, the bucket by its left foot; walking, it carries
  both. Same format otherwise, so it needs no row of its own.
- Everything a character holds stays within `|x| + |y| <= 12` voxels of its
  feet: further out, the bottom of the frame (15 px under the anchor) cuts
  it in some direction (`renderSheet` throws).
- Walking: a human moves 3 voxels per walk frame (`walk.voxelsPerFrame`;
  a sheet from a private home may give another value in its own JSON), along the axis it faces: per voxel, `+x` is (+2, +1) px,
  `+y` is (-2, +1) px. Paths are axis aligned (no diagonal directions).
- Scale: a standing person is about 53 voxels (106 px), next to a desk top
  at 25 voxels: check `mock-floor@3x.png`.

The rig lives in `character.mjs`: a model is a function `(b, pose)` that
draws a character facing +y with its feet centre at the origin; `human(look,
rig)` takes a `rig` to place the hands and draw what they hold (the
janitor's broom and bucket); `poseOf()` gives the shared poses, `renderSheet()` turns the model per direction and
packs the sheet, `sheetFormat()` gives the JSON. A private home can draw its
own model (a mascot) with the same rig and format by importing these files.

`human(look)` also draws a few faces, none of them used by the shipped
sheets: `hairStyle: "side-part"` (short at the back and sides, a quiff on top
swept to the +x side, a voxel more forehead), `brows` (`true` for the hair's
colour, or a material), `eyes` (a material, ink by default),
`expression: "smile"` (the eyes narrowed to a short dash, and the lips showing
under the mouth's line, in `lips`, a material, by default the skin's ramp two
levels darker), `beard` (a material: a full beard below the mouth,
sideburns at the back of the cheeks up to the hair, a little wider than the
head at the back and down over the collar; the cheeks and a row of skin under
the mouth stay bare) and `moustache` (`{ style, colour }`: `"plain"`, or
`"handlebar"`, a voxel high in the middle, bare skin between it and the nose,
about two thirds of the face's width, its tips curling up inside the face
under the eyes; `colour` defaults to the beard's, then the hair's; the same
ramp with a lighter `top` lets the light catch it where it stands out). They
stay within the frame of the other characters.

## Files

- `engine.mjs`: world, builder (with quarter turns and sub-assemblies),
  rasterizer, lighting, outlines, tint codes, normal shading.
- `palette.mjs`: the 32 colours and their ramps; `addRamp` and `deriveRamp`
  for extra colours in a private build.
- `image.mjs`: RGBA images, tint masks, hover rings, atlas packing, contact
  sheets, a tiny font, PNG output. `png.mjs`: the PNG encoder.
- `props.mjs`: the hub props. `furniture.mjs`: the floor set, with the
  signboard. `font.mjs`: the sign font.
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
