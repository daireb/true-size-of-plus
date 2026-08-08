# true-size-of-plus

**[Try it → daireb.github.io/true-size-of-plus](https://daireb.github.io/true-size-of-plus/)**

A size-comparison map. Search a country and drag it across the globe to watch
Mercator inflate and shrink it while its real area never moves — the familiar
"true size of" trick. Then upload your own map, a D&D campaign world or
anything else, set its scale, and drop real countries onto it at their true
size. Trace outlines on either and carry them between the two: put your kingdom
next to France, or Florida onto your continent.

Everything runs in the browser. Your maps never leave it — no account, no
server, no upload. Export writes the lot to one JSON file you can keep.

---

## Running it

Needs Node 22.6+ (the check scripts use native TypeScript stripping).

```bash
npm install
npm run dev        # http://localhost:5173
npm run build
```

Checks:

```bash
npm run verify         # 77 headless assertions on the geometry and search
npm run smoke          # 95 end-to-end browser assertions (dev server must be up)
npm run perf           # drag frame times for the heaviest outlines
npm run perf:bystander # frame times with heavy countries parked on the map
npm run data           # rebuild public/data from Natural Earth
npm run deploy         # build and publish to the gh-pages branch
```

The browser tests drive real Chromium through Playwright, clicking and dragging
the actual UI. This is necessary rather than thorough: much of what can go wrong
here is silent. A GeoJSON source that never loads still renders a perfectly good
basemap, and a country drawn at the wrong size looks entirely plausible.

---

## The model

A **canvas** is the reference frame you compare things inside. A **subject** is
a thing you drag around one. A **shape** is an outline you traced yourself,
which can be placed on any canvas as a subject.

**Earth** is a canvas: CARTO raster tiles in Web Mercator, rendered by MapLibre.
Subjects distort as they move, which is the entire point.

**A map you upload** is a canvas too — an image plus a declared projection,
rendered by a purpose-built canvas2d view. Currently that projection is always
`flat`: a hand-drawn fantasy map has one uniform scale everywhere, being a
drawing rather than a projection of a sphere, so there is no global projection
to apply. Each subject instead brings its own azimuthal equal-area projection
centred on its own centroid, landing at exactly its true area and locally
faithful in shape, and dragging never changes it. A `mercator` option for
fantasy maps drawn as projections can join later without disturbing the model.

Every canvas keeps its own session — placed subjects, camera — in IndexedDB,
restored when you come back. Only references and transforms are stored, never
geometry, so sessions survive dataset upgrades.

### Scale calibration

Click two points on your map (along its scale bar, or corner to corner) and say
how far apart they are. World coordinates on an image canvas are *image pixels*,
so recalibrating resizes subjects but never slides them off the coastline they
were placed on.

Keep uploads under about 8,192 px on the long edge: decoded images cost 4 bytes
per pixel regardless of how well the PNG compresses.

### Selection and rotation

Clicking a subject selects it — its panel row expands and a rotate handle
appears on the map, a knob on a stalk in the Figma mould. Drag the knob to
rotate, Shift snaps to 15°, `[` and `]` nudge by 1° (15° with Shift). The
expanded row keeps a slider for exact values. Clicking empty map, pressing
Escape, or clicking the subject again deselects.

### Tracing

"Trace a shape" outlines a polygon on whichever canvas is active, driven from a
floating toolbar:

| gesture | effect |
| --- | --- |
| click | add a point |
| drag a vertex | move it |
| click an edge | insert a point there, dragging in the same motion |
| right-click a vertex | delete it (double-click also works) |
| drag inside the outline | slide the whole trace, every island at once |
| drag outside it | pan the map |
| Ctrl/Cmd-Z | undo any of the above, one step at a time |
| Escape | abandon the trace |

"＋ Island" finishes the current outline and starts another, so archipelagos
save as one multi-polygon whose area is the sum of its islands. Finished islands
stay fully editable in place, which is why there is no "active island" concept:
a closed ring has no end, so inserting on its closing edge already *is*
appending.

A saved shape spawns onto its canvas at the spot it was drawn and remembers
that spot as its home — the ⟲ button sends it back after wandering. The ✎ on a
shape row copies it back into the editor, switching to its home canvas so the
original vertices return exactly. Saving under the same name **updates the shape
in place**: references point at the shape's id rather than its geometry, so
every placement on every canvas follows automatically. A new name forks it
instead, which makes a work-in-progress trace just a shape you keep re-editing.

### Save / load

Export writes everything — canvases with their images inlined as data URLs,
shapes, and every canvas's session — to a single JSON file. Import reads one
back and merges by id, so re-importing is idempotent. No accounts, no server;
the file is the save.

---

## Notes on the tricky parts

### Placement

The interesting code is [`src/lib/geo.ts`](src/lib/geo.ts), and two decisions
carry it.

**Placement is recomputed from home, never composed.** Rotations on a sphere
don't commute, so applying a small incremental rotation per mouse-move
accumulates a net spin that depends on the path you dragged along (holonomy) —
wiggle a country around and it visibly rotates. Instead each subject stores only
a `target` centroid and a `bearing`, and the drawn outline is derived fresh from
untouched home geometry. Placement is a pure function of the destination:
`npm run verify` drags Greenland through 200 wandering intermediate positions
and asserts the result is byte-identical to going straight there.

**The move is decomposed into longitude-then-latitude, not one shortest-arc
rotation.** The minimal great-circle rotation from A to B tilts the shape
whenever the move has an east-west component. Rotating about the polar axis to
fix longitude, then about the equatorial axis under the destination meridian to
fix latitude, keeps the subject upright at its centroid. No rigid motion can
keep *every* point upright — the sphere is curved — so this preserves
orientation at the centroid, which is what reads as "not rotating". Any spin is
then yours alone.

Neither transform changes true area: after moving and rotating 47°, area drifts
by ~1e-14%.

Longitudes are unwrapped before rendering. Placement emits them wrapped to
±180, so a subject straddling the antimeridian gets a vertex at +179.9 followed
by one at −179.9, which reads as a segment travelling 359.8° the long way round
the planet — visible as slivers lassoing the globe. Unwrapping keeps each
segment short and MapLibre draws the overflow in the adjacent world copy.

### Resolution and the drag budget

Resolution matters more than it looks. Ireland is 13 vertices at 1:110m, with
its area 17% wrong; 315 at 1:50m; 2,394 at 1:10m and 1.6% off.

**Heavy outlines are simplified only while you move them.** `DRAG_BUDGET` is
3,000 vertices; anything under it — the vast majority, Ireland included — drags
at full detail and is never touched. Only the few genuinely huge outlines get
decimated by Douglas–Peucker (Canada: 68,191 → 2,835), and full detail returns
the instant you let go. Measured by `npm run perf`:

```
Canada    median 18.5ms  p95 28.8ms  (~54fps)   68,191 vertices
Russia    median 20.0ms  p95 27.8ms  (~50fps)   36,746 vertices
Ireland   median 13.2ms  p95 16.8ms  (~76fps)    2,394 vertices, unsimplified
```

Simplification has to restore ring winding afterwards. Dropping points from a
thin, contorted sliver can flip its orientation, and a flipped exterior ring
means "the whole sphere except this shape" — one 7-point Canadian island was
silently reporting 510,000,000 km².

### Why Earth has two map sources

`countries-static` holds everything sitting still; `countries-active` holds only
what is being dragged. This is a performance fix, not tidiness.

With one combined source, every mouse-move rewrote the whole FeatureCollection,
so MapLibre re-serialised and re-tiled every placed country each frame. Leaving
Canada parked on the map dropped dragging Ireland from ~75fps to ~26, and three
heavy bystanders took it to ~19. Two things fix it: placed geometry is cached
per subject, keyed on that subject's own target and bearing, so dragging one
never re-transforms the others; and the static source is updated through
`updateData()` with a per-feature diff rather than `setData()`, so picking a
subject up removes one feature and putting it down adds one back instead of
resending ~277k coordinates twice per drag.

What remains is the GPU drawing those outlines, unavoidable while they are on
screen. A probe that kept Canada in the source but filtered it out of the layers
returned frame times to baseline (20.4ms against 22.1ms alone, versus 32.6ms
drawn), which is how we know the source path itself is clean.

### Search

Search is **accent-folded**: 706 of the region names carry diacritics, so
without folding most are unreachable from an ordinary keyboard. "oita" finds
Ōita, "kyoto" finds Kyōto, "entre rios" finds Entre Ríos. NFD splits an accented
letter into base plus combining mark and the marks are dropped; the 13 letters
that don't decompose that way (ø Ø Đ Ð ð ə ı œ æ ħ Ħ Ł ß) are mapped explicitly.
`npm run verify` asserts all 4,847 names fold to pure ASCII.

Region names need their parent country shown, and not for tidiness: 28 collide
with a country name (Belgium has a Luxembourg province, Nigeria a Niger state)
and 95 repeat across countries — La Paz appears three times. Prefix matches
outrank interior ones and countries outrank regions, so "Georgia" offers the
country before the US state. Typing a country name also surfaces its regions,
ranked below any direct name match.

### maplibre-gl is pinned to v5

Do not bump to v6 without checking. v6 loads its worker from a separate
`maplibre-gl-worker.mjs` that Vite neither serves in dev (404) nor emits into
the production bundle, so every GeoJSON source silently never loads: the basemap
renders, no error is raised anywhere, and country layers simply never appear.
v5 inlines the worker as a blob and works out of the box. `npm run smoke`
catches exactly this.

---

## Data

Both datasets are built by [`scripts/build-data.mjs`](scripts/build-data.mjs)
from [natural-earth-vector](https://github.com/nvkelso/natural-earth-vector) and
committed so the repo is self-contained. `npm run data` regenerates them.

| file | contents | size |
| --- | --- | --- |
| `countries-10m.json` | 258 countries, Natural Earth 1:10m | 4.3 MB (1.4 MB gzipped) |
| `regions-10m.json` | 4,589 admin_1 regions — US states, Scottish council areas, Japanese prefectures, Irish counties | 8.1 MB (2.7 MB gzipped) |

Regions are fetched **in the background after countries** rather than blocking
startup: countries are searchable at ~1.0s, regions at ~1.5s. Centroid and area
are computed lazily per place, because walking 4,589 geometries up front janked
the main thread for numbers only ever needed by the handful of rows on screen.

1:50m is not a usable fallback for regions. It sounds cheap at 0.21 MB gzipped
but holds only 294 features across 9 countries — no Scotland, no Bavaria, no
Irish counties.

### Known limitations

- **Overseas territories** count as part of the parent country. Natural Earth's
  "France" spans longitude −61.8 to 55.8 (Guadeloupe to Réunion) and totals
  635,066 km² against metropolitan France's 551,695; the Netherlands likewise
  includes its Caribbean islands. Dragging such a country moves the whole set,
  and the reported area includes it.
- Latitudes are clamped near the poles, where Mercator goes to infinity.
- Antarctica is excluded — it has no meaningful Mercator representation.
- Only two levels exist, countries and admin_1 regions. Informal groupings such
  as Japan's Kyushu are not in the data as shapes. Natural Earth does tag some
  admin_1 rows with a `region` grouping, but it is unreliable — its Kyushu
  covers five prefectures and omits Saga and Nagasaki — so it is not used.

### Fictional maps

No fictional maps ship here: published fantasy maps are copyrighted artwork, and
even a traced outline of a distinctive fictional continent is derivative of it.
Import your own copy — the calibration tool exists for exactly this. Two rough
reference points for setting scale: fan cartography commonly puts Tamriel's
mainland somewhere around 3,000–4,000 km across, and George R. R. Martin has
described Westeros as roughly the size of South America, with the Wall about 300
miles long, which doubles as an in-map scale bar.

---

## Attribution

- Country and region geometry: [Natural Earth](https://www.naturalearthdata.com/)
  via [natural-earth-vector](https://github.com/nvkelso/natural-earth-vector),
  public domain.
- Earth basemap tiles: [CARTO](https://carto.com/attributions) and
  [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
- The spherical placement approach was cribbed conceptually from
  [ObservedObserver/world-map-reality](https://github.com/ObservedObserver/world-map-reality).
  That repo carries no licence, so this is an independent implementation of the
  standard mathematics rather than a copy of its source.

## Licence

[MIT](LICENSE). The bundled Natural Earth data is public domain and carries no
restriction of its own; basemap tiles are fetched from CARTO at runtime under
their attribution terms.
