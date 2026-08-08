import type { Geometry } from 'geojson'
import type { LonLat } from './geo.ts'
import type { PlanePoint, PlaneRings } from './flat.ts'

// --- model -------------------------------------------------------------------
//
// A *canvas* is the reference frame you compare things inside. Earth is one
// canvas (CARTO raster tiles + Web Mercator, rendered by MapLibre). Every
// other canvas is a user image plus a declared projection. A *subject* is a
// thing you drag around a canvas: a country, a region, or a traced shape.

export interface ImageCanvasDef {
  id: string
  name: string
  width: number
  height: number
  /** Ground km represented by one image pixel — the calibration. */
  kmPerPixel: number
  /**
   * How to read coordinates drawn on this image. 'flat' means one uniform
   * scale everywhere — a drawing, not a projection of a sphere — so subjects
   * are drawn at true size and dragging never changes them. A 'mercator'
   * option can join later without changing this model.
   */
  projection: 'flat'
  blob: Blob
}

export type ShapeDef =
  | { kind: 'geo'; geometry: Geometry }
  | { kind: 'flat'; rings: PlaneRings }

/** A user-traced shape, insertable on any canvas. */
export interface CustomShape {
  id: string
  name: string
  def: ShapeDef
  areaKm2: number
  /** Name of the canvas it was traced on, for provenance. */
  tracedOn?: string
}

export type PlacedRef = { kind: 'place' | 'shape'; id: string }

/** A subject placed on the Earth canvas. */
export interface EarthPlaced {
  uid: string
  name: string
  parent?: string
  color: string
  areaKm2: number
  bearing: number
  target: LonLat
  ref: PlacedRef
  src:
    | {
        kind: 'geo'
        homeGeometry: Geometry
        dragGeometry: Geometry
        homeCentroid: LonLat
        simplified: boolean
      }
    | { kind: 'flat'; rings: PlaneRings }
}

/** A subject placed on an image canvas. Target is in image pixels. */
export interface FlatPlaced {
  uid: string
  name: string
  parent?: string
  color: string
  areaKm2: number
  bearing: number
  target: PlanePoint
  ref: PlacedRef
  /** km, centred on the subject's own centroid. */
  rings: PlaneRings
}

// --- persistence -------------------------------------------------------------
// Geometry is never persisted for placed subjects — only the reference and the
// transform. Sessions rehydrate from the same datasets and shape store, so the
// stored records stay tiny and survive dataset upgrades.

export interface StoredPlaced {
  uid: string
  name: string
  parent?: string
  color: string
  areaKm2: number
  bearing: number
  /** LonLat on Earth, image px on an image canvas. */
  target: [number, number]
  ref: PlacedRef
}

export type EarthViewport = { center: LonLat; zoom: number }
export type FlatViewport = { tx: number; ty: number; zoom: number }

export interface StoredSession {
  placed: StoredPlaced[]
  viewport?: EarthViewport | FlatViewport
}

export const freshId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

// --- IndexedDB ----------------------------------------------------------------
// IndexedDB rather than localStorage because canvases carry multi-megabyte
// image blobs and localStorage caps at ~5 MB before base64 inflation.

const DB_NAME = 'true-size-of-plus'
const DB_VERSION = 2

const openDb = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      const utx = req.transaction!
      if (!db.objectStoreNames.contains('canvases'))
        db.createObjectStore('canvases', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('shapes'))
        db.createObjectStore('shapes', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions')
      // v1 stored a single campaign-map overlay; carry it over as a canvas.
      // The old store is left in place — deleting it mid-transaction while a
      // read is pending is exactly the kind of cleverness that corrupts data.
      if (db.objectStoreNames.contains('campaign-map')) {
        const get = utx.objectStore('campaign-map').get('current')
        get.onsuccess = () => {
          const m = get.result
          if (m?.blob) {
            utx.objectStore('canvases').put({
              id: 'img-migrated',
              name: m.name ?? 'campaign map',
              width: m.width,
              height: m.height,
              kmPerPixel: m.kmPerPixel ?? 1,
              projection: 'flat',
              blob: m.blob,
            } satisfies ImageCanvasDef)
          }
        }
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })

const tx = async <T,>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>
): Promise<T> => {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const r = fn(db.transaction(store, mode).objectStore(store))
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => reject(r.error)
    })
  } finally {
    db.close()
  }
}

export const listCanvases = () =>
  tx<ImageCanvasDef[]>('canvases', 'readonly', (s) => s.getAll()).catch(() => [] as ImageCanvasDef[])
export const putCanvas = (c: ImageCanvasDef) =>
  tx('canvases', 'readwrite', (s) => s.put(c)).catch(() => undefined)
export const removeCanvas = async (id: string) => {
  await tx('canvases', 'readwrite', (s) => s.delete(id)).catch(() => undefined)
  await tx('sessions', 'readwrite', (s) => s.delete(id)).catch(() => undefined)
}

export const listShapes = () =>
  tx<CustomShape[]>('shapes', 'readonly', (s) => s.getAll()).catch(() => [] as CustomShape[])
export const putShape = (s: CustomShape) =>
  tx('shapes', 'readwrite', (st) => st.put(s)).catch(() => undefined)
export const removeShape = (id: string) =>
  tx('shapes', 'readwrite', (s) => s.delete(id)).catch(() => undefined)

export const putSession = (canvasId: string, s: StoredSession) =>
  tx('sessions', 'readwrite', (st) => st.put(s, canvasId)).catch(() => undefined)

export const getSessions = async (): Promise<Record<string, StoredSession>> => {
  try {
    const db = await openDb()
    try {
      return await new Promise((resolve, reject) => {
        const store = db.transaction('sessions', 'readonly').objectStore('sessions')
        const keys = store.getAllKeys()
        const vals = store.getAll()
        vals.onsuccess = () => {
          const out: Record<string, StoredSession> = {}
          keys.result.forEach((k, i) => {
            out[String(k)] = vals.result[i]
          })
          resolve(out)
        }
        vals.onerror = () => reject(vals.error)
      })
    } finally {
      db.close()
    }
  } catch {
    return {}
  }
}

// --- snapshot export/import ----------------------------------------------------
// One self-contained JSON file, images inlined as data URLs. No accounts, no
// server: the file IS the save. Import merges by id, so re-importing the same
// snapshot is idempotent rather than duplicating.

export interface Snapshot {
  app: 'true-size-of-plus'
  version: 1
  exportedAt: string
  canvases: (Omit<ImageCanvasDef, 'blob'> & { image: string })[]
  shapes: CustomShape[]
  sessions: Record<string, StoredSession>
}

const blobToDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })

export const exportSnapshot = async (): Promise<string> => {
  const [canvases, shapes, sessions] = await Promise.all([
    listCanvases(),
    listShapes(),
    getSessions(),
  ])
  const snap: Snapshot = {
    app: 'true-size-of-plus',
    version: 1,
    exportedAt: new Date().toISOString(),
    canvases: await Promise.all(
      canvases.map(async ({ blob, ...def }) => ({
        ...def,
        image: await blobToDataUrl(blob),
      }))
    ),
    shapes,
    sessions,
  }
  return JSON.stringify(snap)
}

export const importSnapshot = async (
  json: string
): Promise<{ canvases: number; shapes: number }> => {
  const snap = JSON.parse(json) as Snapshot
  if (snap.app !== 'true-size-of-plus' || snap.version !== 1)
    throw new Error('Not a true-size-of-plus snapshot file')
  for (const { image, ...def } of snap.canvases ?? []) {
    const blob = await (await fetch(image)).blob()
    await putCanvas({ ...def, blob })
  }
  for (const s of snap.shapes ?? []) await putShape(s)
  for (const [id, sess] of Object.entries(snap.sessions ?? {})) await putSession(id, sess)
  return { canvases: snap.canvases?.length ?? 0, shapes: snap.shapes?.length ?? 0 }
}
