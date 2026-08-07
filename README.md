# true-size-of-plus

A "true size of" map — search a country, drag it anywhere on Earth, and watch
Mercator's distortion inflate or shrink it while its real area stays fixed.

```bash
npm run dev      # http://localhost:5173
npm run verify   # headless check of the projection maths (20 assertions)
npm run smoke    # end-to-end browser test (dev server must be running)
npm run perf     # drag frame times for the heaviest outlines
npm run data     # rebuild public/data/countries-10m.json from Natural Earth
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

- A country dragged across the antimeridian (±180°) renders wrapped rather than
  clipped cleanly.
- Latitudes are clamped near the poles, where Mercator goes to infinity.
- Antarctica is excluded — it has no meaningful Mercator representation.

## Rotation

Each placed country has a rotation slider (-180° to 180°, clockwise). Clicking
the degree readout resets it to 0. Rotation is part of the stored transform, so
it composes with dragging without drift.

## Not yet built

Loading a custom (e.g. D&D campaign) map as the basemap and placing real
countries on it. The plan: pin the map image at the equator as a MapLibre
`image` source, with its corner coordinates set so its width in km matches the
map's stated scale. Distortion is negligible there, so comparisons stay honest
and the existing drag code works unchanged.

## Credit

The spherical rotate/scale approach was cribbed conceptually from
[ObservedObserver/world-map-reality](https://github.com/ObservedObserver/world-map-reality).
That repo has no LICENSE file, so this is an independent implementation of the
standard maths rather than a copy of its source.
