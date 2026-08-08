import { simplifyGeometry } from './geo.ts'
import { geoToPlane } from './flat.ts'
import { metricsOf } from './places.ts'
import type { Place } from './places.ts'
import type {
  CustomShape,
  EarthPlaced,
  FlatPlaced,
  StoredPlaced,
} from './store.ts'

/**
 * Vertex budget for geometry drawn while a subject is being manipulated on
 * Earth. See the note in EarthView — under-budget outlines are never touched.
 */
export const DRAG_BUDGET = 3000

export const PALETTE = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
  '#008080', '#f032e6', '#9a6324', '#800000', '#000075',
]

/** Home centroid of a geo shape; flat shapes have no home. */
export const shapeHomeCentroid = (s: CustomShape) =>
  s.def.kind === 'geo' ? metricsOf({ geometry: s.def.geometry } as Place).centroid : null

/** Rebuild a live Earth subject from its stored reference. */
export const earthFromStored = (
  sp: StoredPlaced,
  places: Map<string, Place>,
  shapes: Map<string, CustomShape>
): EarthPlaced | null => {
  const base = {
    uid: sp.uid,
    name: sp.name,
    parent: sp.parent,
    color: sp.color,
    areaKm2: sp.areaKm2,
    bearing: sp.bearing,
    target: sp.target,
    ref: sp.ref,
  }
  if (sp.ref.kind === 'place') {
    const p = places.get(sp.ref.id)
    if (!p) return null
    const { centroid } = metricsOf(p)
    const dragGeometry = simplifyGeometry(p.geometry, DRAG_BUDGET)
    return {
      ...base,
      src: {
        kind: 'geo',
        homeGeometry: p.geometry,
        dragGeometry,
        homeCentroid: centroid,
        simplified: dragGeometry !== p.geometry,
      },
    }
  }
  const s = shapes.get(sp.ref.id)
  if (!s) return null
  if (s.def.kind === 'flat') return { ...base, src: { kind: 'flat', rings: s.def.rings } }
  const centroid = shapeHomeCentroid(s)!
  return {
    ...base,
    src: {
      kind: 'geo',
      homeGeometry: s.def.geometry,
      dragGeometry: simplifyGeometry(s.def.geometry, DRAG_BUDGET),
      homeCentroid: centroid,
      simplified: false,
    },
  }
}

/** Rebuild a live image-canvas subject from its stored reference. */
export const flatFromStored = (
  sp: StoredPlaced,
  places: Map<string, Place>,
  shapes: Map<string, CustomShape>
): FlatPlaced | null => {
  const base = {
    uid: sp.uid,
    name: sp.name,
    parent: sp.parent,
    color: sp.color,
    areaKm2: sp.areaKm2,
    bearing: sp.bearing,
    target: sp.target,
    ref: sp.ref,
  }
  if (sp.ref.kind === 'place') {
    const p = places.get(sp.ref.id)
    if (!p) return null
    return { ...base, rings: geoToPlane(p.geometry, metricsOf(p).centroid) }
  }
  const s = shapes.get(sp.ref.id)
  if (!s) return null
  return {
    ...base,
    rings: s.def.kind === 'flat' ? s.def.rings : geoToPlane(s.def.geometry, shapeHomeCentroid(s)!),
  }
}

export const toStored = (items: (EarthPlaced | FlatPlaced)[]): StoredPlaced[] =>
  items.map((p) => ({
    uid: p.uid,
    name: p.name,
    parent: p.parent,
    color: p.color,
    areaKm2: p.areaKm2,
    bearing: p.bearing,
    target: [p.target[0], p.target[1]],
    ref: p.ref,
  }))
