import type { LonLat } from './geo'

/** Mean Earth radius (IUGG), km — the same sphere the area figures use. */
export const EARTH_RADIUS_KM = 6371.0088
/** Ground km per degree of longitude at the equator. */
export const KM_PER_DEGREE_LON = (Math.PI * EARTH_RADIUS_KM) / 180
export const KM_PER_MILE = 1.609344

export interface CampaignMap {
  name: string
  /** Natural size of the source image. */
  width: number
  height: number
  /** The calibration: ground km represented by one image pixel. */
  kmPerPixel: number
}

export interface Bounds {
  west: number
  east: number
  north: number
  south: number
}

const D2R = Math.PI / 180
const R2D = 180 / Math.PI

/**
 * Web Mercator northing, expressed in "degrees" so it shares units with
 * longitude. A square in (lon, mercY) space is a square on screen.
 */
export const mercY = (lat: number) => R2D * Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2))
export const invMercY = (y: number) => R2D * (2 * Math.atan(Math.exp(y * D2R)) - Math.PI / 2)

/**
 * Where to pin the image: centred on 0°,0°.
 *
 * The equator is chosen deliberately. Mercator's distortion is 1.0 there and
 * grows as sec(latitude), so this is the one place a fantasy map can sit and
 * have real countries dragged alongside it at an honest scale.
 *
 * The latitude extent is derived in Mercator space rather than from a plain
 * degrees-per-km ratio. MapLibre draws an image source as a quad interpolated
 * in Mercator coordinates, so matching the image's aspect ratio *there* is what
 * keeps the picture itself unstretched.
 */
export const boundsFor = (m: CampaignMap): Bounds => {
  const widthKm = m.width * m.kmPerPixel
  const halfLon = Math.min(widthKm / KM_PER_DEGREE_LON, 359) / 2
  const halfY = halfLon * (m.height / m.width)
  return {
    west: -halfLon,
    east: halfLon,
    north: invMercY(halfY),
    south: invMercY(-halfY),
  }
}

/** Corner order MapLibre's image source expects: TL, TR, BR, BL. */
export const cornersFor = (b: Bounds): [LonLat, LonLat, LonLat, LonLat] => [
  [b.west, b.north],
  [b.east, b.north],
  [b.east, b.south],
  [b.west, b.south],
]

/** Map coordinate back to a pixel in the source image. Exact inverse of the draw. */
export const toImagePixel = (m: CampaignMap, b: Bounds, [lon, lat]: LonLat) => {
  const yTop = mercY(b.north)
  const ySpan = yTop - mercY(b.south)
  return {
    x: ((lon - b.west) / (b.east - b.west)) * m.width,
    y: ((yTop - mercY(lat)) / ySpan) * m.height,
  }
}

/**
 * Derive the real scale from a line drawn across the map.
 *
 * Whatever provisional scale the image was placed at cancels out: the two
 * clicked points are converted back to image pixels, so the answer depends only
 * on the pixel length of the line and the distance the user says it represents.
 * Drag along a scale bar, or corner to corner if you know the total width.
 */
export const calibrate = (
  m: CampaignMap,
  b: Bounds,
  a: LonLat,
  c: LonLat,
  realKm: number
) => {
  const p = toImagePixel(m, b, a)
  const q = toImagePixel(m, b, c)
  const px = Math.hypot(q.x - p.x, q.y - p.y)
  if (px < 1 || !Number.isFinite(realKm) || realKm <= 0) return null
  return realKm / px
}

export const describeExtent = (m: CampaignMap) => {
  const w = m.width * m.kmPerPixel
  const h = m.height * m.kmPerPixel
  const fmt = (km: number) =>
    `${Math.round(km).toLocaleString()} km / ${Math.round(km / KM_PER_MILE).toLocaleString()} mi`
  return { width: fmt(w), height: fmt(h), areaKm2: w * h }
}

// --- persistence ------------------------------------------------------------
// IndexedDB rather than localStorage: campaign maps are multi-megabyte images
// and localStorage caps at ~5 MB, which base64 encoding would blow through.

const DB_NAME = 'true-size-of-plus'
const STORE = 'campaign-map'
const KEY = 'current'

const openDb = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })

const tx = async <T,>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) => {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

export interface StoredMap extends CampaignMap {
  blob: Blob
}

export const saveStoredMap = (m: StoredMap) =>
  tx('readwrite', (s) => s.put(m, KEY)).catch(() => undefined)

export const loadStoredMap = () =>
  tx<StoredMap | undefined>('readonly', (s) => s.get(KEY)).catch(() => undefined)

export const clearStoredMap = () =>
  tx('readwrite', (s) => s.delete(KEY)).catch(() => undefined)
