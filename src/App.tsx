import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as maplibregl from 'maplibre-gl'
import type { Feature, Geometry } from 'geojson'
import 'maplibre-gl/dist/maplibre-gl.css'

import {
  createPlacement,
  transformGeometry,
  simplifyGeometry,
  countVertices,
  mercatorScale,
  clamp,
} from './lib/geo'
import type { LonLat } from './lib/geo'
import { loadCountries, loadRegions, metricsOf, formatArea, searchPlaces } from './lib/places'
import type { Place } from './lib/places'
import { useCampaignMap } from './lib/useCampaignMap'
import CampaignPanel from './CampaignPanel'
import './App.css'

/**
 * Two sources, not one. Everything sitting still lives in `static`, which is
 * written only when a placement actually changes; whatever is being dragged
 * lives alone in `active`, which is rewritten every frame.
 *
 * With a single combined source, each mouse-move re-serialised every placed
 * country and made MapLibre's worker re-tile all of them — so leaving Canada
 * (68k vertices) parked on the map dropped dragging Ireland from 75fps to 26.
 */
const STATIC_SOURCE = 'countries-static'
const ACTIVE_SOURCE = 'countries-active'
const STATIC_FILL = 'countries-static-fill'
const STATIC_LINE = 'countries-static-line'
const ACTIVE_FILL = 'countries-active-fill'
const ACTIVE_LINE = 'countries-active-line'
/** Active first: it renders on top, so it should win hit-testing too. */
const FILL_LAYERS = [ACTIVE_FILL, STATIC_FILL]

/**
 * Vertex budget for the geometry drawn *while* a country is being manipulated.
 * Anything already under this is dragged at full detail and never simplified;
 * only the handful of genuinely huge outlines (Canada is 68k vertices at 1:10m)
 * get decimated, and they snap back to full detail the moment you let go.
 */
const DRAG_BUDGET = 3000

const PALETTE = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
  '#008080', '#f032e6', '#9a6324', '#800000', '#000075',
]

interface Placed {
  uid: string
  name: string
  kind: Place['kind']
  parent?: string
  color: string
  areaKm2: number
  /** Full-detail outline, at its real-world position. Never mutated. */
  homeGeometry: Geometry
  /** Simplified stand-in used during interaction; same object if under budget. */
  dragGeometry: Geometry
  homeCentroid: LonLat
  /** Where the centroid currently sits. The whole transform derives from this. */
  target: LonLat
  /** Manual spin in degrees, clockwise. */
  bearing: number
  simplified: boolean
}

const createStyle = (): maplibregl.StyleSpecification => ({
  version: 8,
  sources: {
    basemap: {
      type: 'raster',
      tiles: [
        'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
        'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
        'https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
      ],
      tileSize: 256,
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
    },
    [STATIC_SOURCE]: {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
      // Lets us call updateData() with per-feature diffs instead of resending
      // the whole collection. uid is already unique per placed country.
      promoteId: 'uid',
    },
    [ACTIVE_SOURCE]: {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    },
  },
  layers: [
    { id: 'basemap', type: 'raster', source: 'basemap' },
    {
      id: STATIC_FILL,
      type: 'fill',
      source: STATIC_SOURCE,
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.55 },
    },
    {
      id: STATIC_LINE,
      type: 'line',
      source: STATIC_SOURCE,
      paint: { 'line-color': ['get', 'color'], 'line-width': 1.5 },
    },
    {
      id: ACTIVE_FILL,
      type: 'fill',
      source: ACTIVE_SOURCE,
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.55 },
    },
    {
      id: ACTIVE_LINE,
      type: 'line',
      source: ACTIVE_SOURCE,
      paint: { 'line-color': ['get', 'color'], 'line-width': 1.5 },
    },
  ],
})

const wrapLon = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const [mapReady, setMapReady] = useState(false)

  const [countries, setCountries] = useState<Place[]>([])
  const [regions, setRegions] = useState<Place[]>([])
  const [regionsPending, setRegionsPending] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [placed, setPlaced] = useState<Placed[]>([])
  /** Whoever is mid-drag or mid-rotate; drawn from the simplified geometry. */
  const [activeUid, setActiveUid] = useState<string | null>(null)

  const dragRef = useRef<{ uid: string; grab: LonLat; from: LonLat } | null>(null)

  const campaign = useCampaignMap(mapRef, mapReady)

  useEffect(() => {
    loadCountries().then(setCountries).catch((e) => setError(String(e)))
    // Regions are ~8 MB and the app is fully usable without them, so they load
    // in the background rather than holding up first paint.
    loadRegions()
      .then(setRegions)
      .catch(() => {})
      .finally(() => setRegionsPending(false))
  }, [])

  // --- map setup -----------------------------------------------------------
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: createStyle(),
      center: [0, 20],
      zoom: 1.6,
      maxZoom: 8,
      renderWorldCopies: true,
      dragRotate: false,
    })
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    map.touchZoomRotate.disableRotation()

    // Styles are injected by JS, so the container can still be 0x0 when the
    // map is constructed — it would then latch onto a 400x300 canvas.
    const ro = new ResizeObserver(() => map.resize())
    ro.observe(containerRef.current)

    // Wait for the style to parse before the first setData. Polling rather than
    // listening keeps this independent of which one-shot event fires when.
    let raf = 0
    const waitForStyle = () => {
      if (map.getSource(STATIC_SOURCE)) setMapReady(true)
      else raf = requestAnimationFrame(waitForStyle)
    }
    waitForStyle()

    mapRef.current = map
    // Exposed for the Playwright smoke test and for poking at from the console.
    ;(window as unknown as { __map: maplibregl.Map }).__map = map

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      map.remove()
      mapRef.current = null
      setMapReady(false)
    }
  }, [])

  // --- geometry ------------------------------------------------------------
  // Every outline is rebuilt from its home position, never from its previous
  // drawn state, so repeated drags can't accumulate drift or spin. The cache
  // means "rebuilt" only actually happens when that country's own placement
  // changed — dragging one country doesn't re-transform any of the others.
  const cacheRef = useRef(new Map<string, { key: string; feature: Feature }>())

  const { staticFeatures, activeFeatures } = useMemo(() => {
    const cache = cacheRef.current
    const statics: Feature[] = []
    const actives: Feature[] = []

    for (const p of placed) {
      const isActive = p.uid === activeUid
      const key = `${isActive ? 'a' : 's'}|${p.target[0]}|${p.target[1]}|${p.bearing}`
      const hit = cache.get(p.uid)
      let feature: Feature
      if (hit?.key === key) {
        feature = hit.feature
      } else {
        feature = {
          type: 'Feature',
          geometry: transformGeometry(
            isActive ? p.dragGeometry : p.homeGeometry,
            createPlacement(p.homeCentroid, p.target, p.bearing)
          ),
          properties: { uid: p.uid, color: p.color, name: p.name },
        }
        cache.set(p.uid, { key, feature })
      }
      ;(isActive ? actives : statics).push(feature)
    }

    if (cache.size > placed.length) {
      const live = new Set(placed.map((p) => p.uid))
      for (const uid of cache.keys()) if (!live.has(uid)) cache.delete(uid)
    }
    return { staticFeatures: statics, activeFeatures: actives }
  }, [placed, activeUid])

  const setSourceData = useCallback((id: string, fs: Feature[]) => {
    const src = mapRef.current?.getSource(id) as maplibregl.GeoJSONSource | undefined
    src?.setData({ type: 'FeatureCollection', features: fs })
  }, [])

  // Static layer: send a per-feature diff, never the whole collection.
  //
  // Picking a country up removes exactly one feature and putting it down adds
  // one back. Resending the collection instead would re-serialise every
  // bystander on both events — with Canada parked on the map that meant
  // pushing ~277k coordinates through the worker twice per drag, felt as a
  // hitch the moment you grabbed anything.
  //
  // Unchanged countries come back as identical objects from the cache, so
  // reference equality is enough to spot what actually moved.
  const lastStatic = useRef(new Map<string, Feature>())
  useEffect(() => {
    if (!mapReady) return
    const src = mapRef.current?.getSource(STATIC_SOURCE) as
      | maplibregl.GeoJSONSource
      | undefined
    if (!src) return

    const prev = lastStatic.current
    const next = new Map(
      staticFeatures.map((f) => [String(f.properties?.uid), f])
    )

    const diff: maplibregl.GeoJSONSourceDiff = {}
    for (const uid of prev.keys())
      if (!next.has(uid)) (diff.remove ??= []).push(uid)
    for (const [uid, f] of next) {
      const before = prev.get(uid)
      if (!before) (diff.add ??= []).push(f)
      else if (before !== f)
        (diff.update ??= []).push({ id: uid, newGeometry: f.geometry })
    }

    if (!diff.remove && !diff.add && !diff.update) return
    lastStatic.current = next
    src.updateData(diff)
  }, [staticFeatures, mapReady])

  // Active layer: rewritten every frame, but it holds at most one country and
  // that country is under the vertex budget.
  useEffect(() => {
    if (mapReady) setSourceData(ACTIVE_SOURCE, activeFeatures)
  }, [activeFeatures, mapReady, setSourceData])

  // --- dragging ------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return

    const onDown = (e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent) => {
      // While picking calibration points, clicks belong to the campaign map.
      if (campaign.calibrating) return
      const hit = map.queryRenderedFeatures(e.point, { layers: FILL_LAYERS })[0]
      if (!hit) return
      const uid = String(hit.properties?.uid)
      const p = placed.find((x) => x.uid === uid)
      if (!p) return

      e.preventDefault()
      dragRef.current = {
        uid,
        grab: [e.lngLat.lng, e.lngLat.lat],
        from: p.target,
      }
      setActiveUid(uid)
      map.dragPan.disable()
      map.getCanvas().style.cursor = 'grabbing'
    }

    const onMove = (e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent) => {
      const drag = dragRef.current
      if (!drag) {
        if (campaign.calibrating) {
          map.getCanvas().style.cursor = 'crosshair'
          return
        }
        const over = map.queryRenderedFeatures(e.point, { layers: FILL_LAYERS })
        map.getCanvas().style.cursor = over.length ? 'grab' : ''
        return
      }
      // Only the target point moves. The outline is re-derived from home, so
      // this stays a pure function of where the cursor is now.
      const target: LonLat = [
        wrapLon(drag.from[0] + (e.lngLat.lng - drag.grab[0])),
        clamp(drag.from[1] + (e.lngLat.lat - drag.grab[1]), -85, 85),
      ]
      setPlaced((prev) =>
        prev.map((p) => (p.uid === drag.uid ? { ...p, target } : p))
      )
    }

    const onUp = () => {
      if (!dragRef.current) return
      dragRef.current = null
      setActiveUid(null)
      map.dragPan.enable()
      map.getCanvas().style.cursor = ''
    }

    map.on('mousedown', onDown)
    map.on('touchstart', onDown)
    map.on('mousemove', onMove)
    map.on('touchmove', onMove)
    map.on('mouseup', onUp)
    map.on('touchend', onUp)
    map.on('mouseout', onUp)

    return () => {
      map.off('mousedown', onDown)
      map.off('touchstart', onDown)
      map.off('mousemove', onMove)
      map.off('touchmove', onMove)
      map.off('mouseup', onUp)
      map.off('touchend', onUp)
      map.off('mouseout', onUp)
    }
  }, [mapReady, placed, campaign.calibrating])

  // --- actions -------------------------------------------------------------
  const addPlace = (c: Place) => {
    const { centroid, areaKm2 } = metricsOf(c)
    const dragGeometry = simplifyGeometry(c.geometry, DRAG_BUDGET)
    setPlaced((prev) => [
      ...prev,
      {
        uid: `${c.id}-${prev.length}`,
        name: c.name,
        kind: c.kind,
        parent: c.parent,
        color: PALETTE[prev.length % PALETTE.length],
        areaKm2,
        homeGeometry: c.geometry,
        dragGeometry,
        homeCentroid: centroid,
        target: centroid,
        bearing: 0,
        simplified: dragGeometry !== c.geometry,
      },
    ])
    setQuery('')
    // Regions are far smaller than countries, so zoom to fit rather than fixed.
    mapRef.current?.flyTo({
      center: centroid,
      zoom: c.kind === 'region' ? 4 : 2.4,
      duration: 900,
    })
  }

  const update = (uid: string, patch: Partial<Placed>) =>
    setPlaced((prev) => prev.map((p) => (p.uid === uid ? { ...p, ...patch } : p)))

  const matches = useMemo(
    () => searchPlaces([...countries, ...regions], query),
    [query, countries, regions]
  )

  return (
    <div className="app">
      <div ref={containerRef} className="map" />

      <aside className="panel">
        <header>
          <h1>True Size Of</h1>
          <p>
            Search a country, then drag it across the map. Its real shape and
            area never change — only Mercator's lie about them.
          </p>
        </header>

        <div className="search">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              countries.length
                ? 'Search a country or region…'
                : 'Loading countries…'
            }
            disabled={!countries.length}
          />
          {query.trim() && regionsPending && (
            <p className="loading">Still loading regions…</p>
          )}
          {matches.length > 0 && (
            <ul className="results">
              {matches.map((c) => (
                <li key={c.id}>
                  <button onClick={() => addPlace(c)}>
                    <span className="hit">
                      {c.name}
                      {c.parent && <em>{c.parent}</em>}
                    </span>
                    <small>{formatArea(metricsOf(c).areaKm2)}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {error && <p className="error">{error}</p>}

        <ul className="placed">
          {placed.map((p) => {
            const ratio =
              (mercatorScale(p.target[1]) / mercatorScale(p.homeCentroid[1])) ** 2
            const moved = Math.abs(ratio - 1) > 0.005
            return (
              <li key={p.uid}>
                <div className="row">
                  <span className="swatch" style={{ background: p.color }} />
                  <div className="meta">
                    <strong>{p.name}</strong>
                    <small>
                      {formatArea(p.areaKm2)} · true area
                      {p.parent ? ` · ${p.parent}` : ''}
                    </small>
                    {moved && (
                      <small className={ratio > 1 ? 'up' : 'down'}>
                        drawn {ratio.toFixed(2)}× its home size
                      </small>
                    )}
                  </div>
                  <button
                    onClick={() =>
                      update(p.uid, { target: p.homeCentroid, bearing: 0 })
                    }
                    title="Send home"
                  >
                    ⟲
                  </button>
                  <button
                    onClick={() =>
                      setPlaced((prev) => prev.filter((x) => x.uid !== p.uid))
                    }
                    title="Remove"
                  >
                    ×
                  </button>
                </div>
                <div className="rotate">
                  <input
                    type="range"
                    min={-180}
                    max={180}
                    step={1}
                    value={p.bearing}
                    aria-label={`Rotate ${p.name}`}
                    onPointerDown={() => setActiveUid(p.uid)}
                    onPointerUp={() => setActiveUid(null)}
                    onBlur={() => setActiveUid(null)}
                    onChange={(e) =>
                      update(p.uid, { bearing: Number(e.target.value) })
                    }
                  />
                  <button
                    className="deg"
                    onClick={() => update(p.uid, { bearing: 0 })}
                    title="Reset rotation"
                  >
                    {p.bearing}°
                  </button>
                </div>
              </li>
            )
          })}
        </ul>

        {placed.length === 0 && (
          <p className="hint">
            Try Greenland — then drag it down to the equator. Regions work
            too: Florida, Scotland, Hokkaido.
          </p>
        )}
        <CampaignPanel c={campaign} />

        {placed.some((p) => p.simplified) && (
          <p className="hint">
            Outlines over {DRAG_BUDGET.toLocaleString()} points are simplified
            while you move them, then redrawn at full detail.{' '}
            {placed
              .filter((p) => p.simplified)
              .map((p) => `${p.name} (${countVertices(p.homeGeometry).toLocaleString()})`)
              .join(', ')}
          </p>
        )}
      </aside>
    </div>
  )
}
