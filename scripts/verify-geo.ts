/**
 * Headless check of the projection maths behind the drag interaction.
 * Run: node --experimental-strip-types scripts/verify-geo.ts
 */
import { readFileSync } from 'node:fs'
import { feature } from 'topojson-client'
import { geoArea, geoCentroid, geoDistance } from 'd3-geo'
import {
  createPlacement,
  transformGeometry,
  simplifyGeometry,
  countVertices,
  mercatorScale,
} from '../src/lib/geo.ts'

const EARTH_RADIUS_KM = 6371.0088
const DRAG_BUDGET = 3000
const topo = JSON.parse(readFileSync('public/data/countries-10m.json', 'utf8'))
const fc = feature(topo, topo.objects.countries)

const get = (name) => {
  const f = fc.features.find((x) => x.properties?.name === name)
  if (!f) throw new Error(`missing ${name}`)
  return f
}
const areaKm2 = (g) => geoArea({ type: 'Feature', geometry: g, properties: {} }) * EARTH_RADIUS_KM ** 2
const centroid = (g) => geoCentroid({ type: 'Feature', geometry: g, properties: {} })
const place = (g, from, to, bearing = 0) =>
  transformGeometry(g, createPlacement(from, to, bearing))

let failures = 0
const check = (label, pass, detail) => {
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures++
}

console.log('\n--- true area vs. published figures (Natural Earth 10m) ---')
const published = {
  Greenland: 2_166_086,
  Australia: 7_692_024,
  Brazil: 8_515_767,
  India: 3_287_263,
  Ireland: 70_273,
  Japan: 377_975,
  Italy: 301_340,
}
for (const [name, expected] of Object.entries(published)) {
  const got = areaKm2(get(name).geometry)
  const errPct = (Math.abs(got - expected) / expected) * 100
  check(`${name} area`, errPct < 6, `${Math.round(got).toLocaleString()} km² (${errPct.toFixed(1)}% off)`)
}

console.log('\n--- placement lands exactly on target ---')
for (const [name, to] of [
  ['Greenland', [0, 0]],
  ['Ireland', [120, -35]],
  ['Japan', [-60, 15]],
]) {
  const f = get(name)
  const home = geoCentroid(f)
  const moved = place(f.geometry, home, to)
  const c = centroid(moved)
  const off = geoDistance(c, to) * EARTH_RADIUS_KM
  check(`${name} centroid reaches target`, off < 1, `off by ${off.toFixed(4)} km`)
}

console.log('\n--- placement preserves true area and shape ---')
for (const name of ['Greenland', 'Russia', 'Ireland']) {
  const f = get(name)
  const home = geoCentroid(f)
  const before = areaKm2(f.geometry)
  const moved = place(f.geometry, home, [30, -10], 47)
  const drift = (Math.abs(areaKm2(moved) - before) / before) * 100
  check(`${name} area unchanged (moved + rotated 47°)`, drift < 0.01, `drift ${drift.toExponential(2)}%`)
}

console.log('\n--- countries stay upright (the old bug) ---')
// A point due north of the centroid must still read as due north afterwards.
for (const [name, to] of [
  ['Ireland', [140, 5]],      // large east-west move: the case that used to tilt
  ['Japan', [-120, 60]],
  ['Brazil', [10, 40]],
]) {
  const f = get(name)
  const home = geoCentroid(f)
  const p = createPlacement(home, to)
  const north = p([home[0], home[1] + 0.05])
  const at = p(home)
  const lonSkew = Math.abs(north[0] - at[0])
  check(
    `${name} keeps north up after moving to ${to}`,
    lonSkew < 1e-6 && north[1] > at[1],
    `longitude skew ${lonSkew.toExponential(2)}°`
  )
}

console.log('\n--- no path dependence or drift ---')
{
  const f = get('Greenland')
  const home = geoCentroid(f)
  const target = [25, -12]

  // Straight there.
  const direct = JSON.stringify(place(f.geometry, home, target))

  // Via a long wandering drag: every frame recomputes from home, so only the
  // final target can matter. Under the old incremental scheme this accumulated
  // a visible spin.
  let last
  for (let i = 0; i <= 200; i++) {
    const t = i / 200
    const wander = [
      home[0] + (target[0] - home[0]) * t + Math.sin(t * 12) * 40,
      home[1] + (target[1] - home[1]) * t + Math.cos(t * 9) * 25,
    ]
    last = place(f.geometry, home, i === 200 ? target : wander)
  }
  check('wandering drag ends identical to direct placement', JSON.stringify(last) === direct, '200 intermediate frames')

  // Not byte-identical: the transform round-trips through 3D vectors even when
  // the rotation is the identity. What matters is that the error is at FP noise
  // level and, crucially, does not accumulate across repeated placements.
  const homeAgain = place(f.geometry, home, home)
  const a = JSON.parse(JSON.stringify(f.geometry.coordinates)).flat(3)
  const b = JSON.parse(JSON.stringify(homeAgain.coordinates)).flat(3)
  const worst = a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0)
  check('placing back home restores the original', worst < 1e-9, `worst coordinate drift ${worst.toExponential(2)}°`)
}

console.log('\n--- drag simplification budget ---')
for (const name of ['Canada', 'Russia', 'Ireland']) {
  const f = get(name)
  const full = countVertices(f.geometry)
  const simp = simplifyGeometry(f.geometry, DRAG_BUDGET)
  const n = countVertices(simp)
  const areaErr = (Math.abs(areaKm2(simp) - areaKm2(f.geometry)) / areaKm2(f.geometry)) * 100
  if (full <= DRAG_BUDGET) {
    check(`${name} left untouched (under budget)`, simp === f.geometry, `${full} vertices`)
  } else {
    check(
      `${name} fits drag budget`,
      // 3% not 0%: fitting the budget means dropping the smallest islands
      // (Canada has 412 separate polygons). This geometry is only ever shown
      // mid-drag; the full-detail outline is restored on release.
      n <= DRAG_BUDGET && areaErr < 3,
      `${full.toLocaleString()} -> ${n.toLocaleString()} vertices, area off ${areaErr.toFixed(2)}%`
    )
  }
}

console.log('\n--- Mercator: what the map draws vs. what is true ---')
{
  const grn = get('Greenland')
  const homeLat = geoCentroid(grn)[1]
  const ratio = (mercatorScale(homeLat) / mercatorScale(0)) ** 2
  check(
    'Greenland shrinks dragged to the equator',
    ratio > 8 && ratio < 16,
    `drawn ${ratio.toFixed(1)}x larger at home (lat ${homeLat.toFixed(1)}°)`
  )
  const africaish = ['Algeria', 'Dem. Rep. Congo', 'Sudan', 'Libya', 'Chad']
    .reduce((s, n) => s + areaKm2(get(n).geometry), 0)
  check(
    'Greenland is far smaller than it looks',
    areaKm2(grn.geometry) < africaish,
    `${(areaKm2(grn.geometry) / 1e6).toFixed(2)}M km² vs 5 African countries ${(africaish / 1e6).toFixed(2)}M km²`
  )
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`)
process.exit(failures === 0 ? 0 : 1)
