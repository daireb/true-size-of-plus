# true-size-of-plus

A "true size of" map — search a country, drag it anywhere on Earth, and watch
Mercator's distortion inflate or shrink it while its real area stays fixed.

```bash
npm run dev      # http://localhost:5173
npm run verify   # headless checks of all the geometry (90+ assertions)
npm run smoke    # end-to-end browser tests (dev server must be running)
npm run perf     # drag frame times for the heaviest outlines
npm run data     # rebuild public/data from Natural Earth
npm run build
```

## How placement works

The interesting part is [`src/lib/geo.ts`](src/lib/geo.ts). Two decisions matter:

**Placement is recomputed from home every frame, never composed.** Rotations on
a sphere don't commute, so applying a small incremental rotation per mouse-move
accumulates a net spin that depends on the path you dragged along (holonomy) —
wiggle a country around and it visibly rotates. Instead each country stores only
a `target` centroid and a `bearing`, and the drawn outline is derived fresh from
the untouched home geometry. Placement is a pure function of the destination:
`npm run verify` drags Greenland through 200 wandering intermediate positions
and asserts the result is byte-identical to going straight there.

**The move is decomposed into longitude-then-latitude, not one shortest-arc
rotation.** The minimal great-circle rotation from A to B tilts the shape
whenever the move has an east-west component. Rotating about the polar axis to
fix longitude, then about the equatorial axis under the destination meridian to
fix latitude, keeps the country upright at its centroid. No rigid motion can
keep *every* point upright — the sphere is curved — so this preserves the
orientation at the centroid, which is what reads as "not rotating". Any spin is
then yours alone, via the rotation slider.

Neither transform changes true area: after moving and rotating 47°, area drifts
by ~1e-14%.

## Data

`public/data/countries-10m.json` is Natural Earth **1:10m**, built by
[`scripts/build-data.mjs`](scripts/build-data.mjs) from
[natural-earth-vector](https://github.com/nvkelso/natural-earth-vector) (public
domain). 4.3 MB raw, 1.4 MB gzipped. Committed so the repo is self-contained;
`npm run data` regenerates it.

Resolution matters more than it looks. Ireland is 13 vertices at 1:110m (area
17% wrong), 315 at 1:50m, and 2,394 at 1:10m (1.6% off).

**Heavy outlines are simplified only while you move them.** `DRAG_BUDGET` in
[`src/App.tsx`](src/App.tsx) is 3,000 vertices. Anything already under it — the
vast majority, Ireland included — is dragged at full detail and never touched.
Only the few genuinely huge outlines are decimated (Canada: 68,191 -> 2,835)
via Douglas–Peucker, and the full-detail geometry is restored the instant you
let go. Measured with `npm run perf`:

```
Canada    median 18.5ms  p95 28.8ms  (~54fps)   68,191 vertices
Russia    median 20.0ms  p95 27.8ms  (~50fps)   36,746 vertices
Ireland   median 13.2ms  p95 16.8ms  (~76fps)    2,394 vertices, unsimplified
```

Simplification must restore ring winding afterwards. Dropping points from a
thin, contorted sliver can flip its orientation, and a flipped exterior ring
means "the whole sphere except this shape" — one 7-point Canadian island was
silently reporting 510,000,000 km².

**Caveat — overseas territories.** Natural Earth counts them as part of the
parent country. Its "France" spans longitude -61.8 to 55.8 (Guadeloupe to
Réunion) and totals 635,066 km² against metropolitan France's 551,695. The
Netherlands likewise includes its Caribbean islands. Dragging such a country
moves the whole set, and the reported area includes it.

## Pinned to maplibre-gl v5

Do not bump to v6 without checking. v6 loads its worker from a separate
`maplibre-gl-worker.mjs` that Vite neither serves in dev (404) nor emits into
the production bundle, so every GeoJSON source silently never loads: the
basemap renders, no error is raised anywhere, and country layers just never
appear. v5 inlines the worker as a blob and works out of the box.

`npm run smoke` catches exactly this — it asserts a country actually renders
and actually moves when dragged.

## Known limitations

- Latitudes are clamped near the poles, where Mercator goes to infinity.
- Antarctica is excluded — it has no meaningful Mercator representation.
- Only two levels exist: countries and admin_1 regions. Informal groupings such
  as Japan's Kyushu are not in the data as shapes. Natural Earth does tag some
  admin_1 rows with a `region` grouping, but it is unreliable — its Kyushu
  covers 5 prefectures and omits Saga and Nagasaki — so it is not used.

## Regions

As well as the 258 countries, `public/data/regions-10m.json` holds **4,589
sub-national regions** (Natural Earth admin_1) — US states, Scottish council
areas, Japanese prefectures, Irish counties. Search finds both.

Search is **accent-folded**: 706 of the region names carry diacritics, so
without folding most of them are unreachable from an ordinary keyboard. "oita"
finds Ōita, "kyoto" finds Kyōto, "entre rios" finds Entre Ríos. NFD splits an
accented letter into base plus combining mark and the marks are dropped; the 13
letters that don't decompose that way (ø Ø Đ Ð ð ə ı œ æ ħ Ħ Ł ß) are mapped
explicitly. `npm run verify` asserts all 4,847 names fold to pure ASCII.

Typing a country name also surfaces its regions, ranked below any direct name
match — "japan" gives Japan, then its prefectures.

Region names need their parent country shown, and not just for tidiness: 28 of
them collide with a country name (Belgium has a Luxembourg province, Nigeria a
Niger state) and 95 repeat across countries — La Paz appears three times. The
search ranks prefix matches over interior ones and countries over regions, so
"Georgia" offers the country before the US state.

The file is 8.1 MB (2.7 MB gzipped), so it is fetched **in the background after
countries** rather than blocking startup: countries are searchable at ~1.0s,
regions at ~1.5s. Centroid and area are computed lazily per place — walking
4,589 geometries up front janked the main thread for numbers only ever needed
for the handful of rows actually shown.

1:50m is not a usable fallback here. It sounds cheap at 0.21 MB gzipped but
holds only 294 features covering 9 countries — no Scotland, no Bavaria, no
Irish counties.

## Why there are two map sources

`countries-static` holds everything sitting still; `countries-active` holds only
whatever is being dragged. This is a performance fix, not tidiness.

With one combined source, every mouse-move rewrote the whole FeatureCollection,
so MapLibre re-serialised and re-tiled every placed country on every frame.
Leaving Canada parked on the map dropped dragging Ireland from ~75fps to ~26,
and three heavy bystanders took it to ~19.

Two things fix it. Placed geometry is cached per country, keyed on that
country's own target and bearing, so dragging one never re-transforms the
others. And the static source is updated through `updateData()` with a
per-feature diff rather than `setData()` — picking a country up removes one
feature and putting it down adds one back, instead of resending ~277k
coordinates twice per drag.

What remains is the GPU drawing those outlines, which is unavoidable while they
are on screen. `npm run perf:bystander` tracks the regression; a probe that
kept Canada in the source but filtered it out of the layers returned frame
times to baseline (20.4ms vs 22.1ms alone, against 32.6ms drawn), which is how
we know the source path is clean.

## Selection and rotation

Clicking a placed subject selects it: its panel row expands and a rotate
handle appears on the map — a knob on a stalk from the subject's anchor, in
the Figma mould. Drag the knob to rotate (Shift snaps to 15°), or nudge with
[ and ] (Shift for 15°). The expanded row keeps a slider for exact values and
the degree readout resets to 0 on click. Clicking empty map, pressing Escape,
or clicking the subject again deselects. Rotation is part of the stored
transform, so it composes with dragging without drift.

## Canvases

A *canvas* is the reference frame you compare things inside; a *subject* is a
thing you drag around one. Earth is a canvas (CARTO tiles, Web Mercator,
rendered by MapLibre — subjects distort as they drag, which is the point).
Every other canvas is an image you upload plus a declared projection, rendered
by a purpose-built canvas2d view.

**Flat canvases.** A hand-drawn fantasy map has one uniform scale everywhere —
it is a drawing, not a projection of a sphere — so there is no global
projection to apply. Each subject instead brings its own azimuthal equal-area
projection centred on its own centroid: it lands at exactly its true area,
locally faithful in shape, and dragging never changes it. (A 'mercator' option
for fantasy maps drawn as projections can join later without changing the
model.)

**Scale calibration.** Click two points on your map — along its scale bar, or
corner to corner — and say how far apart they are. World coordinates on an
image canvas are image pixels, so recalibrating re-sizes subjects but never
slides them off the coastline they were placed on.

**Sessions.** Every canvas keeps what you were doing on it — placed subjects,
camera — in IndexedDB, restored when you come back. Only references and
transforms are stored, never geometry.

Images stay on your machine: object URL for display, IndexedDB for storage,
nothing uploaded anywhere. Keep exports under ~8,192 px on the long edge —
decoded images cost 4 bytes/pixel regardless of PNG compression.

## Traced shapes

"Trace a shape" outlines a polygon on whatever canvas is active, with a
floating toolbar at the bottom of the map. Click to add a point; press-drag
still pans, so you can navigate mid-trace. Drag a vertex to move it, click an
edge to insert a point there (and drag it in the same motion), right-click a
vertex to delete it (double-click works too; a completed island that drops
below 3 points is removed with it), Ctrl/Cmd-Z
undoes any edit — appended points, vertex moves, edge inserts, island commits —
one step at a time (a whole drag is one step), and Escape abandons the trace. "＋ Island" finishes the current outline
and starts another, so archipelagos save as one multi-polygon shape whose area
is the sum of its islands, with winding normalised per ring. Finished islands
stay fully editable in place — move, insert, delete — which is why there is no
"active island" concept: a closed ring has no end, so inserting on its closing
edge already is appending.

A freshly saved shape spawns straight onto the canvas it was traced on, at the
spot it was drawn, and remembers that spot as its home: place it on its own map
again and it lands there, and the ⟲ button sends it back after wandering. The
link is deliberately loose — delete that map and the shape survives, it just
falls back to spawning at the view centre.

The ✎ on a shape row copies it back into the trace editor, switching to the
shape's home canvas so the original vertices return exactly (Earth at the
origin if its home map no longer exists). Dragging from inside the outline
slides the whole trace — every island at once, one undo step — while clicking
inside still just adds a point. Saving under the same name **updates the
shape in place**: because references point at the shape's id rather than its
geometry, every placement on every canvas follows automatically, and the
replaced version sits in the 12-second undo. Saving under a new name forks it
and leaves the original untouched, so a work-in-progress trace is just a shape
you keep re-editing. The Save button reads "Update" whenever the name matches
an existing shape.

Named shapes
join a library that works everywhere: trace your kingdom on your campaign map
and drop it next to France on Earth, or trace a patch of Earth and drop it onto
your map. Cross-canvas placement goes through the equal-area projection in both
directions, so area is preserved exactly. Shapes traced on Earth get their ring
winding normalised — a polygon traced the wrong way round would otherwise read
as the whole sphere minus itself.

Deleting a shape or a canvas opens a confirmation naming exactly what goes —
a popup rather than an armed button, so a habitual double-click can't blow
through it and adjacent rows can't be mixed up. Either delete can be undone
for 12 seconds afterwards; undo restores a shape's placements as well.

## Save / load

Export writes everything — canvases (images inlined as data URLs), shapes, and
every canvas's session — to a single JSON file. Import reads one back and
merges by id, so re-importing a snapshot is idempotent. No accounts, no server;
the file is the save. Verified by `scripts/smoke-data.mjs`, which exports from
one browser profile and imports into a pristine one.

## Fictional maps (Tamriel, Middle-earth, …)

No fictional maps ship with this repo: published fantasy maps are copyrighted
artwork, and even a traced outline of a distinctive fictional continent is a
derivative of it. Import your own copy instead — the calibration tool is built
for exactly this. Two useful reference points for setting scale, both
approximate: fan cartography commonly puts Tamriel's mainland in the region of
3,000–4,000 km across, and George R. R. Martin has described Westeros as
roughly the size of South America, with the Wall about 300 miles long — a
handy in-map scale bar. Calibrate against whichever figure you trust and the
tool takes care of the rest.

## Credit

The spherical rotate/scale approach was cribbed conceptually from
[ObservedObserver/world-map-reality](https://github.com/ObservedObserver/world-map-reality).
That repo has no LICENSE file, so this is an independent implementation of the
standard maths rather than a copy of its source.
