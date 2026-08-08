import { geoAzimuthalEqualArea, geoArea, geoCentroid } from 'd3-geo'
import type { Geometry, Position } from 'geojson'
import { clamp } from './geo.ts'
import type { LonLat } from './geo.ts'

export const EARTH_RADIUS_KM = 6371.0088
export const KM_PER_MILE = 1.609344

const D2R = Math.PI / 180
/** Keep coordinates handed back to Earth clear of the Mercator singularity. */
const MAX_LAT = 89.5

export type PlanePoint = [number, number]
/** [polygon][ring][vertex], km on a plane, y increasing downward. */
export type PlaneRings = PlanePoint[][][]

/**
 * Azimuthal equal-area projection onto the tangent plane at `center`,
 * in km, y-down (d3's screen convention, which matches image pixels).
 *
 * This is how a subject gets drawn on a flat canvas: projected about its own
 * centroid, so its area is exact and its local shape faithful, no matter where
 * on the canvas it is placed. There is no global projection of a flat fantasy
 * map — the map itself is already flat — so each subject brings its own.
 */
const projectionAt = ([lon, lat]: LonLat) =>
  geoAzimuthalEqualArea()
    .rotate([-lon, -lat])
    .scale(EARTH_RADIUS_KM)
    .translate([0, 0])

/** Project a (Multi)Polygon onto the tangent plane at `center`, km, y-down. */
export const geoToPlane = (geometry: Geometry, center: LonLat): PlaneRings => {
  const proj = projectionAt(center)
  const ring = (r: Position[]) =>
    r
      .map((c) => proj([c[0], c[1]]))
      .filter((p): p is [number, number] => !!p && Number.isFinite(p[0]) && Number.isFinite(p[1]))
  if (geometry.type === 'Polygon') return [geometry.coordinates.map(ring)]
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.map((p) => p.map(ring))
  throw new Error(`geoToPlane: unsupported geometry ${geometry.type}`)
}

/**
 * The inverse: put a flat shape onto the sphere at `target`, optionally spun
 * by `bearingDeg` (clockwise on screen). Because the projection is equal-area,
 * the shape's true area is preserved exactly wherever it lands.
 */
export const planeToGeo = (rings: PlaneRings, target: LonLat, bearingDeg = 0): Geometry => {
  const proj = projectionAt(target)
  const a = bearingDeg * D2R
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const pt = ([x, y]: PlanePoint): Position => {
    const ll = proj.invert!([x * cos - y * sin, x * sin + y * cos])!
    return [ll[0], clamp(ll[1], -MAX_LAT, MAX_LAT)]
  }
  const polys = rings.map((p) => p.map((r) => r.map(pt)))
  return polys.length === 1
    ? { type: 'Polygon', coordinates: polys[0] }
    : { type: 'MultiPolygon', coordinates: polys }
}

export const transformRings = (rings: PlaneRings, fn: (p: PlanePoint) => PlanePoint): PlaneRings =>
  rings.map((poly) => poly.map((ring) => ring.map(fn)))

/** Shoelace, signed. Sign encodes winding; callers mostly want magnitudes. */
const ringSigned = (r: PlanePoint[]) => {
  let s = 0
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    s += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1])
  }
  return s / 2
}

/**
 * Area in km². Outer ring minus holes per polygon. Relies on GeoJSON's
 * opposite-winding convention for holes surviving projection, which it does —
 * the projection is a diffeomorphism away from the antipode.
 */
export const planeAreaKm2 = (rings: PlaneRings) =>
  rings.reduce(
    (sum, poly) =>
      sum +
      Math.abs(ringSigned(poly[0])) -
      poly.slice(1).reduce((h, r) => h + Math.abs(ringSigned(r)), 0),
    0
  )

/** Area-weighted centroid. Holes cancel via their opposite winding. */
export const planeCentroid = (rings: PlaneRings): PlanePoint => {
  let ax = 0
  let ay = 0
  let atot = 0
  for (const poly of rings) {
    for (const ring of poly) {
      let a = 0
      let cx = 0
      let cy = 0
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const cross = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
        a += cross
        cx += (ring[j][0] + ring[i][0]) * cross
        cy += (ring[j][1] + ring[i][1]) * cross
      }
      // a is 2x signed area; centroid formula divides by 6x signed area.
      ax += cx / 3
      ay += cy / 3
      atot += a
    }
  }
  if (Math.abs(atot) < 1e-9) {
    // Degenerate: fall back to bbox centre.
    const b = planeBounds(rings)
    return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2]
  }
  return [ax / atot, ay / atot]
}

export const planeBounds = (rings: PlaneRings) => {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const poly of rings)
    for (const ring of poly)
      for (const [x, y] of ring) {
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
  return { minX, minY, maxX, maxY }
}

// --- traced shapes -----------------------------------------------------------

/**
 * Normalise polygons traced on a flat canvas (image px) into a reusable shape:
 * km units, centred on the combined centroid so placement is a translation.
 * Each traced ring becomes its own polygon (an archipelago, not holes), and
 * winding is normalised per ring — a clockwise island and an anticlockwise one
 * would otherwise cancel each other out of the centroid.
 */
export const shapeFromFlatTrace = (ringsPx: PlanePoint[][], kmPerPixel: number) => {
  const polys: PlaneRings = ringsPx.map((ring) => {
    const km = ring.map(([x, y]) => [x * kmPerPixel, y * kmPerPixel] as PlanePoint)
    const first = km[0]
    const last = km[km.length - 1]
    if (first[0] !== last[0] || first[1] !== last[1]) km.push([first[0], first[1]])
    if (ringSigned(km) < 0) km.reverse()
    return [km]
  })
  const c = planeCentroid(polys)
  const centered = transformRings(polys, ([x, y]) => [x - c[0], y - c[1]])
  return { rings: centered, areaKm2: planeAreaKm2(centered) }
}

/**
 * Normalise polygons traced on Earth (lon/lat clicks) into a geo shape.
 * Winding is fixed per ring: one traced "the wrong way round" would otherwise
 * be read by d3 as covering the whole sphere except the shape.
 */
export const shapeFromGeoTrace = (rings: LonLat[][]) => {
  const polys = rings.map((points) => {
    const ring: Position[] = [...points.map((p) => [p[0], p[1]] as Position)]
    const first = ring[0]
    const last = ring[ring.length - 1]
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]])
    let poly: Position[][] = [ring]
    if (geoArea({ type: 'Polygon', coordinates: poly }) > 2 * Math.PI)
      poly = [[...ring].reverse()]
    return poly
  })
  const geometry: Geometry =
    polys.length === 1
      ? { type: 'Polygon', coordinates: polys[0] }
      : { type: 'MultiPolygon', coordinates: polys }
  return {
    geometry,
    centroid: geoCentroid(geometry) as LonLat,
    areaKm2: geoArea(geometry) * EARTH_RADIUS_KM * EARTH_RADIUS_KM,
  }
}

export const describeKm = (km: number) =>
  `${Math.round(km).toLocaleString()} km / ${Math.round(km / KM_PER_MILE).toLocaleString()} mi`

// --- trace editing -------------------------------------------------------------

export interface TraceHit {
  kind: 'vertex' | 'edge'
  /** Ring index; -1 is the ring currently being drawn. */
  ring: number
  /** Vertex index to move, or insertion index for an edge hit. */
  index: number
}

const distToSegment = (px: number, py: number, a: PlanePoint, b: PlanePoint) => {
  let [x, y] = a
  const dx = b[0] - x
  const dy = b[1] - y
  if (dx !== 0 || dy !== 0) {
    const t = Math.max(0, Math.min(1, ((px - x) * dx + (py - y) * dy) / (dx * dx + dy * dy)))
    x += dx * t
    y += dy * t
  }
  return Math.hypot(px - x, py - y)
}

/**
 * Hit-test a pointer against trace rings, all in screen px. Vertices win over
 * edges so a point can always be grabbed even where segments crowd it.
 */
export const hitTracePoint = (
  rings: { ring: number; pts: PlanePoint[]; closed: boolean }[],
  sx: number,
  sy: number,
  vertexR = 8,
  edgeR = 6
): TraceHit | null => {
  let best: TraceHit | null = null
  let bestD = vertexR
  for (const { ring, pts } of rings) {
    for (let i = 0; i < pts.length; i++) {
      const d = Math.hypot(pts[i][0] - sx, pts[i][1] - sy)
      if (d <= bestD) {
        bestD = d
        best = { kind: 'vertex', ring, index: i }
      }
    }
  }
  if (best) return best
  let bestE = edgeR
  for (const { ring, pts, closed } of rings) {
    const n = pts.length
    if (n < 2) continue
    const segs = closed ? n : n - 1
    for (let i = 0; i < segs; i++) {
      const d = distToSegment(sx, sy, pts[i], pts[(i + 1) % n])
      if (d <= bestE) {
        bestE = d
        best = { kind: 'edge', ring, index: i + 1 }
      }
    }
  }
  return best
}

/** Ray-cast point-in-polygon test on one ring (open or closed). */
export const pointInRing = (pt: PlanePoint, ring: PlanePoint[]): boolean => {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi)
      inside = !inside
  }
  return inside
}
