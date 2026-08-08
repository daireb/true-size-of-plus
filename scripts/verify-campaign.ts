/**
 * Georeferencing maths for a user-supplied campaign map.
 * Run: node --experimental-strip-types scripts/verify-campaign.ts
 */
import { geoDistance } from 'd3-geo'
import {
  boundsFor,
  cornersFor,
  toImagePixel,
  calibrate,
  mercY,
  invMercY,
  describeExtent,
  EARTH_RADIUS_KM,
  KM_PER_DEGREE_LON,
  KM_PER_MILE,
} from '../src/lib/campaign.ts'

let failures = 0
const check = (label, pass, detail) => {
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures++
}
const near = (a, b, tol) => Math.abs(a - b) <= tol

// A typical Inkarnate export: 4096x2560, continent 2000 miles across.
const milesWide = 2000
const map = {
  name: 'test',
  width: 4096,
  height: 2560,
  kmPerPixel: (milesWide * KM_PER_MILE) / 4096,
}

console.log('\n--- mercator helpers round-trip ---')
for (const lat of [0, 1, 15, -22.5, 60, -70]) {
  check(`invMercY(mercY(${lat}))`, near(invMercY(mercY(lat)), lat, 1e-9), `${invMercY(mercY(lat)).toFixed(10)}`)
}

console.log('\n--- the image lands at the size you asked for ---')
{
  const b = boundsFor(map)
  // Ground width measured along the equator, where the image is pinned.
  const measuredKm = geoDistance([b.west, 0], [b.east, 0]) * EARTH_RADIUS_KM
  const wantKm = milesWide * KM_PER_MILE
  const errPct = (Math.abs(measuredKm - wantKm) / wantKm) * 100
  check(
    'equator width matches the calibration',
    errPct < 0.001,
    `${Math.round(measuredKm).toLocaleString()} km vs ${Math.round(wantKm).toLocaleString()} km asked (${errPct.toExponential(1)}% off)`
  )
  check('centred on the prime meridian', near(b.west, -b.east, 1e-12), `${b.west.toFixed(3)}..${b.east.toFixed(3)}`)
  check('centred on the equator', near(b.north, -b.south, 1e-12), `${b.south.toFixed(3)}..${b.north.toFixed(3)}`)
}

console.log('\n--- the picture is not stretched ---')
{
  const b = boundsFor(map)
  // MapLibre interpolates an image source in Mercator space, so that is where
  // the aspect ratio has to match.
  const drawnAspect = (b.east - b.west) / (mercY(b.north) - mercY(b.south))
  const imageAspect = map.width / map.height
  check(
    'aspect ratio preserved in Mercator space',
    near(drawnAspect, imageAspect, 1e-9),
    `drawn ${drawnAspect.toFixed(6)} vs image ${imageAspect.toFixed(6)}`
  )
}

console.log('\n--- pixel mapping is the exact inverse of the draw ---')
{
  const b = boundsFor(map)
  const [tl, tr, br, bl] = cornersFor(b)
  const corners = [
    ['top-left', tl, 0, 0],
    ['top-right', tr, map.width, 0],
    ['bottom-right', br, map.width, map.height],
    ['bottom-left', bl, 0, map.height],
  ]
  for (const [label, ll, wantX, wantY] of corners) {
    const p = toImagePixel(map, b, ll)
    check(`${label} corner -> (${wantX}, ${wantY})`, near(p.x, wantX, 1e-6) && near(p.y, wantY, 1e-6), `(${p.x.toFixed(4)}, ${p.y.toFixed(4)})`)
  }
  const mid = toImagePixel(map, b, [0, 0])
  check('centre -> image centre', near(mid.x, map.width / 2, 1e-6) && near(mid.y, map.height / 2, 1e-6), `(${mid.x.toFixed(2)}, ${mid.y.toFixed(2)})`)
}

console.log('\n--- calibration ---')
{
  const b = boundsFor(map)
  // Draw a line along the equator spanning a known slice of the image, and
  // report the distance that slice really is. The scale must come back the same.
  const frac = 0.25
  const lon = (b.east - b.west) * frac * 0.5
  const trueKm = map.width * frac * map.kmPerPixel
  const got = calibrate(map, b, [-lon, 0], [lon, 0], trueKm)
  check('re-stating the true distance reproduces the scale', near(got, map.kmPerPixel, 1e-12), `${got.toFixed(10)} vs ${map.kmPerPixel.toFixed(10)} km/px`)

  // A wrong provisional scale must not matter: it cancels out.
  const wrong = { ...map, kmPerPixel: map.kmPerPixel * 7.3 }
  const wb = boundsFor(wrong)
  const lonW = (wb.east - wb.west) * frac * 0.5
  const fixed = calibrate(wrong, wb, [-lonW, 0], [lonW, 0], trueKm)
  check('provisional scale cancels out', near(fixed, map.kmPerPixel, 1e-12), `recovered ${fixed.toFixed(10)} km/px from a 7.3x wrong start`)

  check('a degenerate line is rejected', calibrate(map, b, [0, 0], [0, 0], 100) === null, 'returns null')
  check('a nonsense distance is rejected', calibrate(map, b, [-lon, 0], [lon, 0], 0) === null, 'returns null')
}

console.log('\n--- reported extent ---')
{
  const d = describeExtent(map)
  check('width reads back as asked', d.width.includes('2,000 mi'), d.width)
  console.log(`       ${map.width}x${map.height}px at ${map.kmPerPixel.toFixed(4)} km/px -> ${d.width} by ${d.height}`)
}

console.log('\n--- sanity: how much Mercator stretch across the map ---')
{
  const b = boundsFor(map)
  const stretch = 1 / Math.cos((b.north * Math.PI) / 180)
  check(
    'edge-to-centre stretch stays small near the equator',
    stretch < 1.05,
    `top edge at ${b.north.toFixed(2)}° is drawn ${((stretch - 1) * 100).toFixed(2)}% larger than the centre`
  )
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`)
process.exit(failures === 0 ? 0 : 1)
