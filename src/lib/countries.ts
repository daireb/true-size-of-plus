import { feature } from 'topojson-client'
import { geoCentroid, geoArea } from 'd3-geo'
import type { Feature, Geometry } from 'geojson'
import type { Topology, GeometryCollection } from 'topojson-specification'
import type { LonLat } from './geo'

/** Mean Earth radius (IUGG), km. */
const EARTH_RADIUS_KM = 6371.0088

export interface Country {
  id: string
  name: string
  geometry: Geometry
  /** Spherical centroid — the anchor point we rotate about when dragging. */
  centroid: LonLat
  /** True surface area in km², independent of any projection. */
  areaKm2: number
}

export async function loadCountries(): Promise<Country[]> {
  // Natural Earth 1:10m, built by scripts/build-data.mjs. 4.3 MB raw / 1.4 MB
  // gzipped. Ireland is 2394 vertices here vs 315 at 50m and 13 at 110m.
  // Heavy outlines are simplified only while being dragged — see DRAG_BUDGET.
  const res = await fetch(`${import.meta.env.BASE_URL}data/countries-10m.json`)
  if (!res.ok) throw new Error(`Failed to load country data (${res.status})`)

  const topology = (await res.json()) as Topology<{
    countries: GeometryCollection<{ name: string }>
  }>
  const collection = feature(topology, topology.objects.countries)

  return collection.features
    .map((f: Feature<Geometry, { name: string }>, i): Country => {
      const centroid = geoCentroid(f) as LonLat
      return {
        id: String(f.id ?? `c${i}`),
        name: f.properties?.name ?? 'Unknown',
        geometry: f.geometry,
        centroid,
        // geoArea returns steradians; multiply by R² for km².
        areaKm2: geoArea(f) * EARTH_RADIUS_KM * EARTH_RADIUS_KM,
      }
    })
    .filter((c) => c.name !== 'Antarctica' && Number.isFinite(c.centroid[0]))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export const formatArea = (km2: number) =>
  km2 >= 1_000_000
    ? `${(km2 / 1_000_000).toFixed(2)}M km²`
    : `${Math.round(km2).toLocaleString()} km²`
