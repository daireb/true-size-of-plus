/**
 * Flat-canvas geometry: equal-area projection to a km plane and back.
 * Run: node --experimental-strip-types scripts/verify-flat.ts
 */
import { readFileSync } from 'node:fs'
import { feature } from 'topojson-client'
import { geoArea, geoCentroid, geoDistance } from 'd3-geo'
import {
  geoToPlane,
  planeToGeo,
  planeAreaKm2,
  planeCentroid,
  planeBounds,
  transformRings,
  shapeFromFlatTrace,
  shapeFromGeoTrace,
  EARTH_RADIUS_KM,
} from '../src/lib/flat.ts'

const topo = JSON.parse(readFileSync('public/data/countries-10m.json', 'utf8'))
const fc = feature(topo, topo.objects.countries)
const get = (name) => {
  const f = fc.features.find((x) => x.properties?.name === name)
  if (!f) throw new Error(`missing ${name}`)
  return f
}
const trueAreaKm2 = (g) =>
  geoArea({ type: 'Feature', geometry: g, properties: {} }) * EARTH_RADIUS_KM ** 2

let failures = 0
const check = (label, pass, detail) => {
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures++
}

console.log('\n--- projection to the plane preserves area ---')
// Tolerances scale with size: plane polygons have straight edges where the
// originals have geodesics, so bigger shapes accrue more edge error.
for (const [name, tolPct] of [['Ireland', 0.05], ['Japan', 0.1], ['Russia', 1.0]]) {
  const f = get(name)
  const rings = geoToPlane(f.geometry, geoCentroid(f))
  const err = (Math.abs(planeAreaKm2(rings) - trueAreaKm2(f.geometry)) / trueAreaKm2(f.geometry)) * 100
  check(`${name} plane area within ${tolPct}%`, err < tolPct, `${err.toFixed(4)}% off`)
}

console.log('\n--- plane -> sphere round trip ---')
{
  const f = get('Ireland')
  const home = geoCentroid(f)
  const back = planeToGeo(geoToPlane(f.geometry, home), home, 0)
  const a = JSON.stringify(f.geometry.coordinates).match(/-?\d+\.?\d*(?:e-?\d+)?/g).map(Number)
  const b = JSON.stringify(back.coordinates).match(/-?\d+\.?\d*(?:e-?\d+)?/g).map(Number)
  const worst = a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0)
  check('Ireland round-trips to its own coordinates', worst < 1e-6, `worst drift ${worst.toExponential(2)}°`)
}

console.log('\n--- placing a shape on the sphere ---')
for (const [name, target] of [
  ['Ireland', [120, -35]],
  ['Japan', [-60, 15]],
  ['Russia', [0, 0]],
]) {
  const f = get(name)
  const home = geoCentroid(f)
  const rings = geoToPlane(f.geometry, home)
  const placed = planeToGeo(rings, target, 0)
  const before = trueAreaKm2(f.geometry)
  const drift = (Math.abs(trueAreaKm2(placed) - before) / before) * 100
  check(`${name} keeps true area when placed at ${target}`, drift < 1.5, `drift ${drift.toFixed(4)}%`)
  const c = geoCentroid({ type: 'Feature', geometry: placed, properties: {} })
  const off = geoDistance(c, target) * EARTH_RADIUS_KM
  check(`${name} lands on target`, off < 50, `centroid off by ${off.toFixed(1)} km`)
}

console.log('\n--- bearing ---')
{
  const f = get('Japan')
  const rings = geoToPlane(f.geometry, geoCentroid(f))
  const a0 = trueAreaKm2(planeToGeo(rings, [10, 20], 0))
  const a47 = trueAreaKm2(planeToGeo(rings, [10, 20], 47))
  check('rotation does not change area', Math.abs(a47 - a0) / a0 < 1e-6, `${((a47 - a0) / a0).toExponential(2)} rel`)

  // 90° clockwise: a point due north of centre must end up due east.
  const north = planeToGeo([[[[0, -100], [1, -100], [0, -100]]]], [0, 0], 90)
  const p = north.coordinates[0][0]
  check('90° turns north into east', p[0] > 0.85 && Math.abs(p[1]) < 0.05, `north point -> lon ${p[0].toFixed(3)}, lat ${p[1].toFixed(3)}`)
}

console.log('\n--- plane helpers ---')
{
  // 100x200 km rectangle centred at (50, 30).
  const rect = [[[[0, -70], [100, -70], [100, 130], [0, 130], [0, -70]]]]
  check('rect area', Math.abs(planeAreaKm2(rect) - 20000) < 1e-9, `${planeAreaKm2(rect)} km²`)
  const c = planeCentroid(rect)
  check('rect centroid', Math.abs(c[0] - 50) < 1e-9 && Math.abs(c[1] - 30) < 1e-9, `(${c[0]}, ${c[1]})`)
  const b = planeBounds(rect)
  check('rect bounds', b.minX === 0 && b.maxX === 100 && b.minY === -70 && b.maxY === 130, JSON.stringify(b))
  const shifted = transformRings(rect, ([x, y]) => [x + 5, y - 5])
  check('transform preserves area', Math.abs(planeAreaKm2(shifted) - 20000) < 1e-9)
}

console.log('\n--- traced shapes ---')
{
  // Trace a 400x300 px rectangle on a canvas at 0.5 km/px -> 200x150 km.
  const t = shapeFromFlatTrace([[100, 100], [500, 100], [500, 400], [100, 400]], 0.5)
  check('flat trace area', Math.abs(t.areaKm2 - 30000) < 1e-6, `${t.areaKm2} km²`)
  const c = planeCentroid(t.rings)
  check('flat trace centred on origin', Math.abs(c[0]) < 1e-9 && Math.abs(c[1]) < 1e-9, `(${c[0]}, ${c[1]})`)

  // The same shape placed on the sphere at 60°N keeps its area.
  const onEarth = planeToGeo(t.rings, [10, 60], 0)
  const areaOnEarth = trueAreaKm2(onEarth)
  check('flat trace true-sized on the sphere at 60°N', Math.abs(areaOnEarth - 30000) / 30000 < 0.001, `${areaOnEarth.toFixed(1)} km²`)

  // Trace on Earth: a square-ish patch near Iceland, both windings.
  const pts = [[-20, 64], [-18, 64], [-18, 65], [-20, 65]]
  const cw = shapeFromGeoTrace([...pts].reverse())
  const ccw = shapeFromGeoTrace(pts)
  check('geo trace winding fixed', Math.abs(cw.areaKm2 - ccw.areaKm2) / ccw.areaKm2 < 1e-9,
    `${Math.round(ccw.areaKm2).toLocaleString()} km² both ways`)
  check('geo trace area plausible', ccw.areaKm2 > 9000 && ccw.areaKm2 < 13000, `${Math.round(ccw.areaKm2).toLocaleString()} km²`)
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`)
process.exit(failures === 0 ? 0 : 1)
