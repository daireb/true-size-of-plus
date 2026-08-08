import type { Geometry, Position } from 'geojson'

export type LonLat = [number, number]
type Vec3 = [number, number, number]

const D2R = Math.PI / 180
const R2D = 180 / Math.PI

/** Web Mercator blows up at the poles; keep coordinates safely inside. */
const MAX_LAT = 89.5

export const clamp = (v: number, lo: number, hi: number) =>
  Math.min(Math.max(v, lo), hi)

const toVec = ([lon, lat]: LonLat): Vec3 => {
  const l = lon * D2R
  const p = lat * D2R
  const cp = Math.cos(p)
  return [cp * Math.cos(l), cp * Math.sin(l), Math.sin(p)]
}

const toLonLat = ([x, y, z]: Vec3): LonLat => [
  Math.atan2(y, x) * R2D,
  Math.atan2(z, Math.hypot(x, y)) * R2D,
]

const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** Rodrigues rotation of a vector about a unit axis. */
const aboutAxis = (axis: Vec3, angle: number) => {
  const sin = Math.sin(angle)
  const cos = Math.cos(angle)
  const t = 1 - cos
  return (v: Vec3): Vec3 => {
    const ca = cross(axis, v)
    const da = dot(axis, v)
    return [
      v[0] * cos + ca[0] * sin + axis[0] * da * t,
      v[1] * cos + ca[1] * sin + axis[1] * da * t,
      v[2] * cos + ca[2] * sin + axis[2] * da * t,
    ]
  }
}

/**
 * Build the transform that carries a country from its home position to `to`,
 * optionally spun by `bearingDeg` (clockwise on screen).
 *
 * Two deliberate choices here:
 *
 * 1. **Always computed from home, never composed incrementally.** Rotations on
 *    a sphere don't commute, so chaining a small rotation per mouse-move frame
 *    accumulates a net spin that depends on the *path* you dragged along
 *    (holonomy) — wiggle a country in a loop and it visibly rotates. Deriving
 *    the transform fresh from the home position each time makes placement a
 *    pure function of the destination: drag anywhere and come back, and you get
 *    bit-identical geometry.
 *
 * 2. **Decomposed into longitude-then-latitude, not one shortest-arc rotation.**
 *    The minimal great-circle rotation from A to B tilts the shape whenever the
 *    move has an east-west component. Rotating about the polar axis to fix
 *    longitude, then about the equatorial axis under the destination meridian to
 *    fix latitude, keeps the country upright at its centroid instead.
 *
 * No rigid motion can keep *every* point upright (the sphere is curved), so
 * this preserves the orientation at the centroid — which is what reads as
 * "not rotating" to the eye. `bearingDeg` is then the only spin, and it's yours.
 */
export const createPlacement = (
  from: LonLat,
  to: LonLat,
  bearingDeg = 0
) => {
  const spinZ = aboutAxis([0, 0, 1], (to[0] - from[0]) * D2R)

  // Axis lying in the equatorial plane, perpendicular to the destination
  // meridian; rotating about it slides a point along that meridian.
  const lonTo = to[0] * D2R
  const meridian = aboutAxis(
    [-Math.sin(lonTo), Math.cos(lonTo), 0],
    (from[1] - to[1]) * D2R
  )

  const spin = bearingDeg ? aboutAxis(toVec(to), -bearingDeg * D2R) : null

  return ([lon, lat]: LonLat): LonLat => {
    let v = meridian(spinZ(toVec([lon, lat])))
    if (spin) v = spin(v)
    const [outLon, outLat] = toLonLat(v)
    return [outLon, clamp(outLat, -MAX_LAT, MAX_LAT)]
  }
}

/** Apply a coordinate transform across any GeoJSON geometry type. */
export const transformGeometry = (
  geometry: Geometry,
  fn: (c: LonLat) => LonLat
): Geometry => {
  const pos = (c: Position): Position => {
    const [lon, lat] = fn([c[0], c[1]])
    return c.length > 2 ? [lon, lat, ...c.slice(2)] : [lon, lat]
  }

  switch (geometry.type) {
    case 'Point':
      return { ...geometry, coordinates: pos(geometry.coordinates) }
    case 'MultiPoint':
    case 'LineString':
      return { ...geometry, coordinates: geometry.coordinates.map(pos) }
    case 'MultiLineString':
    case 'Polygon':
      return {
        ...geometry,
        coordinates: geometry.coordinates.map((r) => r.map(pos)),
      }
    case 'MultiPolygon':
      return {
        ...geometry,
        coordinates: geometry.coordinates.map((p) => p.map((r) => r.map(pos))),
      }
    case 'GeometryCollection':
      return {
        ...geometry,
        geometries: geometry.geometries.map((g) => transformGeometry(g, fn)),
      }
    default:
      return geometry
  }
}

export const countVertices = (geometry: Geometry): number => {
  let n = 0
  const walk = (c: unknown) => {
    if (typeof (c as number[])[0] === 'number') n++
    else (c as unknown[]).forEach(walk)
  }
  if ('coordinates' in geometry) walk(geometry.coordinates)
  else if (geometry.type === 'GeometryCollection')
    geometry.geometries.forEach((g) => (n += countVertices(g)))
  return n
}

// --- simplification ---------------------------------------------------------

/** Squared perpendicular distance from p to segment ab, in degrees². */
const segDistSq = (p: Position, a: Position, b: Position) => {
  let [x, y] = a
  let dx = b[0] - x
  let dy = b[1] - y
  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy)
    if (t > 1) [x, y] = b
    else if (t > 0) {
      x += dx * t
      y += dy * t
    }
  }
  dx = p[0] - x
  dy = p[1] - y
  return dx * dx + dy * dy
}

/** Douglas–Peucker on an open polyline. */
const douglasPeucker = (pts: Position[], tolSq: number): Position[] => {
  if (pts.length <= 2) return pts
  let idx = -1
  let maxSq = tolSq
  for (let i = 1; i < pts.length - 1; i++) {
    const d = segDistSq(pts[i], pts[0], pts[pts.length - 1])
    if (d > maxSq) {
      idx = i
      maxSq = d
    }
  }
  if (idx === -1) return [pts[0], pts[pts.length - 1]]
  return [
    ...douglasPeucker(pts.slice(0, idx + 1), tolSq).slice(0, -1),
    ...douglasPeucker(pts.slice(idx), tolSq),
  ]
}

/** Shoelace signed area. Sign encodes winding direction. */
const signedArea = (ring: Position[]) => {
  let s = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    s += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1])
  }
  return s / 2
}

/**
 * Simplify a closed ring. Split at the vertex farthest from the start before
 * running Douglas–Peucker, because on a closed ring the first and last points
 * coincide and the algorithm would otherwise collapse it immediately.
 * Returns null if the ring degenerates below a valid polygon.
 *
 * Winding is restored afterwards. Dropping points from a thin, contorted
 * sliver can flip its orientation, and a flipped exterior ring means "the whole
 * sphere except this shape" — one 7-point island was reporting 510,000,000 km².
 */
const simplifyRing = (ring: Position[], tolSq: number): Position[] | null => {
  if (ring.length < 5) return ring
  const open = ring.slice(0, -1)
  let far = 0
  let farSq = -1
  for (let i = 1; i < open.length; i++) {
    const dx = open[i][0] - open[0][0]
    const dy = open[i][1] - open[0][1]
    const d = dx * dx + dy * dy
    if (d > farSq) {
      farSq = d
      far = i
    }
  }
  const a = douglasPeucker(open.slice(0, far + 1), tolSq)
  const b = douglasPeucker(open.slice(far), tolSq)
  const out = [...a.slice(0, -1), ...b]
  if (out.length < 4) return null

  const was = signedArea(ring)
  const now = signedArea([...out, out[0]])
  if (now === 0) return null // collapsed to a line; contributes nothing
  if (was !== 0 && Math.sign(now) !== Math.sign(was)) out.reverse()
  return [...out, out[0]]
}

/**
 * Simplify one polygon: outer ring first, then its holes.
 *
 * Returns null if the outer ring collapses, which must drop the whole polygon.
 * Keeping surviving holes after losing their outer ring would promote a hole to
 * exterior status — and since its winding is reversed, d3/GeoJSON then read it
 * as covering everything *except* that shape. That silently turns one small
 * island into an almost-whole-sphere polygon.
 */
const simplifyPolygon = (
  rings: Position[][],
  tolSq: number
): Position[][] | null => {
  const outer = simplifyRing(rings[0], tolSq)
  if (!outer) return null
  const holes = rings
    .slice(1)
    .map((r) => simplifyRing(r, tolSq))
    .filter((r): r is Position[] => !!r)
  return [outer, ...holes]
}

const simplifyAtTolerance = (geometry: Geometry, tolSq: number): Geometry | null => {
  switch (geometry.type) {
    case 'Polygon': {
      const c = simplifyPolygon(geometry.coordinates, tolSq)
      return c ? { ...geometry, coordinates: c } : null
    }
    case 'MultiPolygon': {
      const c = geometry.coordinates
        .map((p) => simplifyPolygon(p, tolSq))
        .filter((p): p is Position[][] => !!p)
      return c.length ? { ...geometry, coordinates: c } : null
    }
    default:
      return geometry
  }
}

/**
 * Reduce a geometry to at most `budget` vertices for smooth dragging.
 *
 * Returns the input untouched when it's already under budget — so only the
 * genuinely heavy outlines (Canada, Russia, the US) lose detail while being
 * dragged, and everything else drags at full resolution. The full-detail
 * geometry is what gets drawn once you drop it.
 */
export const simplifyGeometry = (geometry: Geometry, budget: number): Geometry => {
  if (countVertices(geometry) <= budget) return geometry

  // Escalate tolerance until it fits. Degrees, so 0.002 ~ 200 m at the equator.
  let tol = 0.002
  let best = geometry
  for (let i = 0; i < 24; i++) {
    const next = simplifyAtTolerance(geometry, tol * tol)
    if (!next) break // tolerance so coarse the shape vanished; keep the last fit
    best = next
    if (countVertices(best) <= budget) break
    tol *= 1.6
  }
  return best
}

/**
 * Linear scale factor of the Mercator projection at a given latitude.
 * Area is distorted by the square of this.
 */
export const mercatorScale = (lat: number) =>
  1 / Math.cos(clamp(Math.abs(lat), 0, 89) * D2R)

/**
 * Make each ring's longitudes continuous across the antimeridian.
 *
 * Placement maths emits longitudes wrapped to ±180, so a shape straddling the
 * date line gets a vertex at +179.9 followed by one at -179.9 — which GeoJSON
 * consumers read as a segment travelling 359.8° the long way round the world.
 * Unwrapping (179.9 -> 180.1) keeps each segment short; MapLibre renders
 * out-of-range longitudes in the adjacent world copy, so the shape draws
 * seamlessly across the line. Spherical maths (d3 area/centroid) never cared
 * either way — this is purely for the flat renderer's benefit.
 */
export const unwrapGeometry = (geometry: Geometry): Geometry => {
  const ring = (r: Position[]): Position[] => {
    let offset = 0
    let prev: number | null = null
    return r.map((c) => {
      let lon = c[0] + offset
      if (prev !== null) {
        if (lon - prev > 180) {
          offset -= 360
          lon -= 360
        } else if (lon - prev < -180) {
          offset += 360
          lon += 360
        }
      }
      prev = lon
      return c.length > 2 ? [lon, c[1], ...c.slice(2)] : [lon, c[1]]
    })
  }

  switch (geometry.type) {
    case 'LineString':
      return { ...geometry, coordinates: ring(geometry.coordinates) }
    case 'Polygon':
      return { ...geometry, coordinates: geometry.coordinates.map(ring) }
    case 'MultiPolygon':
      return {
        ...geometry,
        coordinates: geometry.coordinates.map((p) => p.map(ring)),
      }
    case 'GeometryCollection':
      return { ...geometry, geometries: geometry.geometries.map(unwrapGeometry) }
    default:
      return geometry
  }
}
