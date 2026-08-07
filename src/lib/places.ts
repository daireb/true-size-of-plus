import { feature } from 'topojson-client'
import { geoCentroid, geoArea } from 'd3-geo'
import type { Feature, Geometry } from 'geojson'
import type { Topology, GeometryCollection } from 'topojson-specification'
import type { LonLat } from './geo'

/** Mean Earth radius (IUGG), km. */
const EARTH_RADIUS_KM = 6371.0088

export type PlaceKind = 'country' | 'region'

export interface Place {
  id: string
  name: string
  kind: PlaceKind
  /** Parent country, for regions. */
  parent?: string
  geometry: Geometry
  /** Filled on first use — see metricsOf. */
  metrics?: { centroid: LonLat; areaKm2: number }
}

/**
 * Centroid and true area, computed on demand.
 *
 * Doing this eagerly meant walking the geometry of all 4,589 regions at load,
 * which janks the main thread for no reason: search only needs names, and the
 * numbers are only wanted for the handful of rows actually shown or placed.
 */
export const metricsOf = (p: Place) => {
  if (!p.metrics) {
    const f: Feature = { type: 'Feature', geometry: p.geometry, properties: {} }
    p.metrics = {
      centroid: geoCentroid(f) as LonLat,
      // geoArea returns steradians; multiply by R² for km².
      areaKm2: geoArea(f) * EARTH_RADIUS_KM * EARTH_RADIUS_KM,
    }
  }
  return p.metrics
}

interface Props {
  name: string
  admin?: string
}

const load = async (file: string, object: string, kind: PlaceKind): Promise<Place[]> => {
  const res = await fetch(`${import.meta.env.BASE_URL}data/${file}`)
  if (!res.ok) throw new Error(`Failed to load ${file} (${res.status})`)

  const topo = (await res.json()) as Topology<Record<string, GeometryCollection<Props>>>
  const collection = feature(topo, topo.objects[object])

  return collection.features
    .map((f: Feature<Geometry, Props>, i): Place => ({
      id: `${kind}-${f.id ?? i}-${f.properties.name}`,
      name: f.properties.name,
      kind,
      parent: f.properties.admin,
      geometry: f.geometry,
    }))
    .filter((p) => p.name !== 'Antarctica')
}

/** ~4.3 MB. Loaded up front; the app is unusable without it. */
export const loadCountries = () =>
  load('countries-10m.json', 'countries', 'country')

/** ~8.1 MB (2.7 MB gzipped). Fetched in the background after countries. */
export const loadRegions = () => load('regions-10m.json', 'regions', 'region')

export const formatArea = (km2: number) =>
  km2 >= 1_000_000
    ? `${(km2 / 1_000_000).toFixed(2)}M km²`
    : `${Math.round(km2).toLocaleString()} km²`

/**
 * Rank matches for the search box. Prefix hits beat interior hits, countries
 * beat regions, then shorter names — so "geor" offers Georgia the country
 * before Georgia the US state, and "flo" finds Florida rather than a dozen
 * places with "flo" buried in the middle.
 */
export const searchPlaces = (places: Place[], query: string, limit = 8) => {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const scored: { p: Place; score: number }[] = []
  for (const p of places) {
    const name = p.name.toLowerCase()
    const at = name.indexOf(q)
    if (at === -1) continue
    let score = at === 0 ? 0 : 100
    if (name === q) score -= 10
    if (p.kind === 'region') score += 5
    score += Math.min(name.length, 40) / 100
    scored.push({ p, score })
  }
  return scored
    .sort((a, b) => a.score - b.score || a.p.name.localeCompare(b.p.name))
    .slice(0, limit)
    .map((s) => s.p)
}
