import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import * as maplibregl from 'maplibre-gl'
import type { Feature } from 'geojson'
import 'maplibre-gl/dist/maplibre-gl.css'

import { createPlacement, transformGeometry, unwrapGeometry, clamp } from './lib/geo'
import type { LonLat } from './lib/geo'
import { planeToGeo, hitTracePoint, pointInRing } from './lib/flat'
import type { PlanePoint } from './lib/flat'
import type { EarthPlaced, EarthViewport } from './lib/store'

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
const PICK_SOURCE = 'pick-overlay'
const HANDLE_SOURCE = 'rotate-handle'
const R2D = 180 / Math.PI
const D2R = Math.PI / 180
/** Screen distance from a selected subject's anchor to its rotate knob. */
const HANDLE_PX = 46
/** Active first: it renders on top, so it should win hit-testing too. */
const FILL_LAYERS = [ACTIVE_FILL, STATIC_FILL]

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
      // the whole collection. uid is already unique per placed subject.
      promoteId: 'uid',
    },
    [ACTIVE_SOURCE]: {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    },
    [PICK_SOURCE]: {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    },
    [HANDLE_SOURCE]: {
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
    {
      id: 'handle-stalk',
      type: 'line',
      source: HANDLE_SOURCE,
      filter: ['==', ['geometry-type'], 'LineString'],
      paint: { 'line-color': '#6ea8fe', 'line-width': 2 },
    },
    {
      id: 'handle-knob',
      type: 'circle',
      source: HANDLE_SOURCE,
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': ['case', ['==', ['get', 'role'], 'knob'], 7, 3],
        'circle-color': '#6ea8fe',
        'circle-stroke-color': '#11151b',
        'circle-stroke-width': ['case', ['==', ['get', 'role'], 'knob'], 2, 0],
      },
    },
    {
      id: 'pick-line',
      type: 'line',
      source: PICK_SOURCE,
      filter: ['==', ['geometry-type'], 'LineString'],
      paint: { 'line-color': '#ffd166', 'line-width': 2.5, 'line-dasharray': [2, 1.5] },
    },
    {
      id: 'pick-points',
      type: 'circle',
      source: PICK_SOURCE,
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': 5,
        'circle-color': '#ffd166',
        'circle-stroke-color': '#1b1f27',
        'circle-stroke-width': 2,
      },
    },
  ],
})

const wrapLon = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180

export interface EarthViewHandle {
  flyTo(center: LonLat, zoom: number): void
  jumpTo(v: EarthViewport): void
}

interface Props {
  placed: EarthPlaced[]
  setPlaced: React.Dispatch<React.SetStateAction<EarthPlaced[]>>
  activeUid: string | null
  setActiveUid: (u: string | null) => void
  /** Persistently selected subject: shows the rotate handle. */
  selectedUid: string | null
  onSelect: (u: string | null) => void
  onRotate: (uid: string, bearing: number) => void
  /** When true, clicks are reported via onPick instead of starting drags. */
  picking: boolean
  picks: LonLat[]
  /** Completed islands of a trace in progress. */
  traceRings?: LonLat[][]
  onPick: (p: LonLat) => void
  onTraceMove?: (ring: number, index: number, p: LonLat) => void
  onTraceInsert?: (ring: number, index: number, p: LonLat) => void
  /** Double-click on a vertex. */
  onTraceDelete?: (ring: number, index: number) => void
  /** Drag from inside the outline: translate every vertex of the trace. */
  onTraceTranslate?: (dLng: number, dLat: number) => void
  /** Called on mouse-down before a vertex drag or edge insert begins. */
  onTraceEditStart?: () => void
  onViewportChange?: (v: EarthViewport) => void
}

const EarthView = forwardRef<EarthViewHandle, Props>(function EarthView(
  {
    placed,
    setPlaced,
    activeUid,
    setActiveUid,
    selectedUid,
    onSelect,
    onRotate,
    picking,
    picks,
    traceRings = [],
    onPick,
    onTraceMove,
    onTraceInsert,
    onTraceDelete,
    onTraceTranslate,
    onTraceEditStart,
    onViewportChange,
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const [mapReady, setMapReady] = useState(false)

  const dragRef = useRef<
    | { kind: 'move'; uid: string; grab: LonLat; from: LonLat; moved: boolean; start: { x: number; y: number } }
    | { kind: 'rotate'; uid: string }
    | null
  >(null)
  const selRef = useRef<{ selectedUid: string | null; placed: EarthPlaced[] }>({ selectedUid, placed })
  selRef.current = { selectedUid, placed }
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const onRotateRef = useRef(onRotate)
  onRotateRef.current = onRotate
  const onPickRef = useRef(onPick)
  onPickRef.current = onPick
  const onTraceMoveRef = useRef(onTraceMove)
  onTraceMoveRef.current = onTraceMove
  const onTraceInsertRef = useRef(onTraceInsert)
  onTraceInsertRef.current = onTraceInsert
  const onTraceEditStartRef = useRef(onTraceEditStart)
  onTraceEditStartRef.current = onTraceEditStart
  const onTraceDeleteRef = useRef(onTraceDelete)
  onTraceDeleteRef.current = onTraceDelete
  const onTraceTranslateRef = useRef(onTraceTranslate)
  onTraceTranslateRef.current = onTraceTranslate
  const traceStateRef = useRef({ picks, traceRings })
  traceStateRef.current = { picks, traceRings }
  /** Set when a mousedown was consumed by vertex/edge editing, so the click
   *  MapLibre fires afterwards must not also append a point. */
  const suppressClickRef = useRef(false)
  const onViewportRef = useRef(onViewportChange)
  onViewportRef.current = onViewportChange

  useImperativeHandle(ref, () => ({
    flyTo: (center, zoom) => mapRef.current?.flyTo({ center, zoom, duration: 900 }),
    jumpTo: (v) => mapRef.current?.jumpTo({ center: v.center, zoom: v.zoom }),
  }))

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

    map.on('moveend', () => {
      const c = map.getCenter()
      onViewportRef.current?.({ center: [c.lng, c.lat], zoom: map.getZoom() })
    })

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
  // means "rebuilt" only actually happens when that subject's own placement
  // changed — dragging one never re-transforms the others.
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
          // Unwrapped so shapes straddling the antimeridian draw across into
          // the neighbouring world copy instead of lassoing the whole planet.
          geometry: unwrapGeometry(
            p.src.kind === 'geo'
              ? transformGeometry(
                  isActive ? p.src.dragGeometry : p.src.homeGeometry,
                  createPlacement(p.src.homeCentroid, p.target, p.bearing)
                )
              : // Traced flat shapes carry their own equal-area projection, so
                // they land true-sized wherever they're dropped on Earth.
                planeToGeo(p.src.rings, p.target, p.bearing)
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

  // Static layer: send a per-feature diff, never the whole collection.
  //
  // Picking a subject up removes exactly one feature and putting it down adds
  // one back. Resending the collection instead would re-serialise every
  // bystander on both events — with Canada parked on the map that meant
  // pushing ~277k coordinates through the worker twice per drag, felt as a
  // hitch the moment you grabbed anything.
  //
  // Unchanged subjects come back as identical objects from the cache, so
  // reference equality is enough to spot what actually moved.
  const lastStatic = useRef(new Map<string, Feature>())
  useEffect(() => {
    if (!mapReady) return
    const src = mapRef.current?.getSource(STATIC_SOURCE) as
      | maplibregl.GeoJSONSource
      | undefined
    if (!src) return

    const prev = lastStatic.current
    const next = new Map(staticFeatures.map((f) => [String(f.properties?.uid), f]))

    const diff: maplibregl.GeoJSONSourceDiff = {}
    for (const uid of prev.keys()) if (!next.has(uid)) (diff.remove ??= []).push(uid)
    for (const [uid, f] of next) {
      const before = prev.get(uid)
      if (!before) (diff.add ??= []).push(f)
      else if (before !== f) (diff.update ??= []).push({ id: uid, newGeometry: f.geometry })
    }

    if (!diff.remove && !diff.add && !diff.update) return
    lastStatic.current = next
    src.updateData(diff)
  }, [staticFeatures, mapReady])

  // Active layer: rewritten every frame, but it holds at most one subject and
  // that subject is under the vertex budget.
  useEffect(() => {
    if (!mapReady) return
    const src = mapRef.current?.getSource(ACTIVE_SOURCE) as
      | maplibregl.GeoJSONSource
      | undefined
    src?.setData({ type: 'FeatureCollection', features: activeFeatures })
  }, [activeFeatures, mapReady])

  // --- pick overlay (calibration/tracing) -----------------------------------
  useEffect(() => {
    if (!mapReady) return
    const src = mapRef.current?.getSource(PICK_SOURCE) as
      | maplibregl.GeoJSONSource
      | undefined
    const features: Feature[] = []
    for (const ring of traceRings) {
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [...ring, ring[0]] },
        properties: {},
      })
      for (const p of ring)
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: p },
          properties: {},
        })
    }
    for (const p of picks)
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: p },
        properties: {},
      })
    if (picks.length >= 2)
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: picks },
        properties: {},
      })
    src?.setData({ type: 'FeatureCollection', features })
  }, [picks, traceRings, mapReady])

  // Rotate handle for the selected subject. The knob sits a fixed number of
  // SCREEN pixels from the anchor, so its geographic position must be
  // recomputed on every camera move.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const src = map.getSource(HANDLE_SOURCE) as maplibregl.GeoJSONSource | undefined
    if (!src) return

    const update = () => {
      const { selectedUid: sel, placed: items } = selRef.current
      const p = !picking && sel ? items.find((x) => x.uid === sel) : undefined
      if (!p) {
        src.setData({ type: 'FeatureCollection', features: [] })
        return
      }
      const c = map.project(p.target)
      const a = p.bearing * D2R
      const knob = map.unproject([
        c.x + Math.sin(a) * HANDLE_PX,
        c.y - Math.cos(a) * HANDLE_PX,
      ])
      src.setData({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: [p.target, [knob.lng, knob.lat]] },
            properties: {},
          },
          { type: 'Feature', geometry: { type: 'Point', coordinates: p.target }, properties: { role: 'anchor' } },
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [knob.lng, knob.lat] },
            properties: { role: 'knob' },
          },
        ],
      })
    }

    update()
    map.on('move', update)
    return () => {
      map.off('move', update)
    }
  }, [mapReady, placed, selectedUid, picking])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady || !picking) return

    // Screen-space hit test against the trace. Ring -1 is the ring being
    // drawn (open); completed islands are closed.
    const hitTraceAt = (sx: number, sy: number) => {
      const { picks: pk, traceRings: rings } = traceStateRef.current
      const toScreen = (p: LonLat): PlanePoint => {
        const q = map.project(p)
        return [q.x, q.y]
      }
      return hitTracePoint(
        [
          ...rings.map((pts, i) => ({ ring: i, pts: pts.map(toScreen), closed: true })),
          { ring: -1, pts: pk.map(toScreen), closed: false },
        ],
        sx,
        sy
      )
    }

    let editing: { ring: number; index: number } | null = null
    let sliding: {
      lastLng: number
      lastLat: number
      startX: number
      startY: number
      moved: boolean
    } | null = null

    const insideTrace = (lng: number, lat: number) => {
      const { picks: pk, traceRings: rings } = traceStateRef.current
      const pt: PlanePoint = [lng, lat]
      return (
        rings.some((r) => pointInRing(pt, r as PlanePoint[])) ||
        (pk.length >= 3 && pointInRing(pt, pk as PlanePoint[]))
      )
    }

    const onDown = (e: maplibregl.MapMouseEvent) => {
      if (e.originalEvent.button !== 0) return // right-click is deletion only
      const hit = hitTraceAt(e.point.x, e.point.y)
      if (!hit) {
        // Dragging from inside the outline moves the whole trace; a plain
        // click there still just adds a point (the click event handles it).
        if (insideTrace(e.lngLat.lng, e.lngLat.lat)) {
          sliding = {
            lastLng: e.lngLat.lng,
            lastLat: e.lngLat.lat,
            startX: e.point.x,
            startY: e.point.y,
            moved: false,
          }
          e.preventDefault()
          map.dragPan.disable()
        }
        return
      }
      onTraceEditStartRef.current?.()
      if (hit.kind === 'edge')
        onTraceInsertRef.current?.(hit.ring, hit.index, [e.lngLat.lng, e.lngLat.lat])
      editing = { ring: hit.ring, index: hit.index }
      suppressClickRef.current = true
      e.preventDefault()
      map.dragPan.disable()
    }
    const onMove = (e: maplibregl.MapMouseEvent) => {
      if (sliding) {
        if (
          !sliding.moved &&
          Math.hypot(e.point.x - sliding.startX, e.point.y - sliding.startY) > 4
        ) {
          sliding.moved = true
          suppressClickRef.current = true // this gesture is a slide, not a click
          onTraceEditStartRef.current?.()
        }
        if (sliding.moved) {
          onTraceTranslateRef.current?.(
            e.lngLat.lng - sliding.lastLng,
            e.lngLat.lat - sliding.lastLat
          )
          sliding.lastLng = e.lngLat.lng
          sliding.lastLat = e.lngLat.lat
        }
        return
      }
      if (!editing) {
        const hit = hitTraceAt(e.point.x, e.point.y)
        map.getCanvas().style.cursor = hit
          ? hit.kind === 'vertex'
            ? 'move'
            : 'copy'
          : insideTrace(e.lngLat.lng, e.lngLat.lat)
            ? 'move'
            : 'crosshair'
        return
      }
      onTraceMoveRef.current?.(editing.ring, editing.index, [e.lngLat.lng, e.lngLat.lat])
    }
    const onUp = () => {
      if (!editing && !sliding) return
      editing = null
      sliding = null
      map.dragPan.enable()
    }
    // MapLibre only fires 'click' when the pointer didn't drag, so panning
    // while tracing works natively; the suppress flag covers edit-mousedowns.
    const onClick = (e: maplibregl.MapMouseEvent) => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false
        return
      }
      onPickRef.current([e.lngLat.lng, e.lngLat.lat])
    }

    // Right-click (primary) or double-click deletes a vertex; right-click is
    // safer because missing the handle is a no-op rather than two appends.
    const deleteAt = (e: maplibregl.MapMouseEvent) => {
      const hit = hitTraceAt(e.point.x, e.point.y)
      if (hit?.kind === 'vertex') onTraceDeleteRef.current?.(hit.ring, hit.index)
    }
    const onDbl = (e: maplibregl.MapMouseEvent) => {
      e.preventDefault() // no double-click zoom mid-trace
      deleteAt(e)
    }
    const onContextMenu = (e: maplibregl.MapMouseEvent) => {
      e.preventDefault()
      deleteAt(e)
    }

    map.on('mousedown', onDown)
    map.on('mousemove', onMove)
    map.on('mouseup', onUp)
    map.on('click', onClick)
    map.on('dblclick', onDbl)
    map.on('contextmenu', onContextMenu)
    map.doubleClickZoom.disable()
    map.getCanvas().style.cursor = 'crosshair'
    return () => {
      map.off('mousedown', onDown)
      map.off('mousemove', onMove)
      map.off('mouseup', onUp)
      map.off('click', onClick)
      map.off('dblclick', onDbl)
      map.off('contextmenu', onContextMenu)
      map.doubleClickZoom.enable()
      map.dragPan.enable()
      map.getCanvas().style.cursor = ''
    }
  }, [picking, mapReady])

  // --- dragging ------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return

    const knobScreen = () => {
      const { selectedUid: sel, placed: items } = selRef.current
      const p = sel ? items.find((x) => x.uid === sel) : undefined
      if (!p) return null
      const c = map.project(p.target)
      const a = p.bearing * D2R
      return { x: c.x + Math.sin(a) * HANDLE_PX, y: c.y - Math.cos(a) * HANDLE_PX, uid: p.uid }
    }

    const onDown = (e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent) => {
      if (picking) return
      // The rotate knob wins over everything under it.
      const ks = knobScreen()
      if (ks && Math.hypot(e.point.x - ks.x, e.point.y - ks.y) <= 12) {
        e.preventDefault()
        dragRef.current = { kind: 'rotate', uid: ks.uid }
        setActiveUid(ks.uid)
        map.dragPan.disable()
        map.getCanvas().style.cursor = 'grabbing'
        return
      }
      const hit = map.queryRenderedFeatures(e.point, { layers: FILL_LAYERS })[0]
      if (!hit) return
      const uid = String(hit.properties?.uid)
      const p = placed.find((x) => x.uid === uid)
      if (!p) return

      e.preventDefault()
      dragRef.current = {
        kind: 'move',
        uid,
        grab: [e.lngLat.lng, e.lngLat.lat],
        from: p.target,
        moved: false,
        start: { x: e.point.x, y: e.point.y },
      }
      setActiveUid(uid)
      map.dragPan.disable()
      map.getCanvas().style.cursor = 'grabbing'
    }

    const onMove = (e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent) => {
      const drag = dragRef.current
      if (!drag) {
        if (picking) return
        const ks = knobScreen()
        const overKnob = ks && Math.hypot(e.point.x - ks.x, e.point.y - ks.y) <= 12
        const over = overKnob || map.queryRenderedFeatures(e.point, { layers: FILL_LAYERS }).length
        map.getCanvas().style.cursor = over ? 'grab' : ''
        return
      }
      if (drag.kind === 'rotate') {
        const p = selRef.current.placed.find((x) => x.uid === drag.uid)
        if (!p) return
        const c = map.project(p.target)
        const raw = Math.atan2(e.point.x - c.x, -(e.point.y - c.y)) * R2D
        const shift = (e.originalEvent as MouseEvent).shiftKey
        onRotateRef.current(drag.uid, shift ? Math.round(raw / 15) * 15 : Math.round(raw))
        return
      }
      if (!drag.moved && Math.hypot(e.point.x - drag.start.x, e.point.y - drag.start.y) > 4)
        drag.moved = true
      // Only the target point moves. The outline is re-derived from home, so
      // this stays a pure function of where the cursor is now.
      const target: LonLat = [
        wrapLon(drag.from[0] + (e.lngLat.lng - drag.grab[0])),
        clamp(drag.from[1] + (e.lngLat.lat - drag.grab[1]), -85, 85),
      ]
      setPlaced((prev) => prev.map((p) => (p.uid === drag.uid ? { ...p, target } : p)))
    }

    const onUp = () => {
      const drag = dragRef.current
      if (!drag) return
      dragRef.current = null
      setActiveUid(null)
      // A press that never moved is a click: select (or toggle off).
      if (drag.kind === 'move' && !drag.moved)
        onSelectRef.current(selRef.current.selectedUid === drag.uid ? null : drag.uid)
      map.dragPan.enable()
      map.getCanvas().style.cursor = ''
    }

    // Clicking empty basemap clears the selection; MapLibre only fires
    // 'click' when the pointer didn't drag, so panning never deselects.
    const onEmptyClick = (e: maplibregl.MapMouseEvent) => {
      if (picking) return
      const ks = knobScreen()
      if (ks && Math.hypot(e.point.x - ks.x, e.point.y - ks.y) <= 12) return
      if (!map.queryRenderedFeatures(e.point, { layers: FILL_LAYERS }).length)
        onSelectRef.current(null)
    }

    map.on('mousedown', onDown)
    map.on('touchstart', onDown)
    map.on('mousemove', onMove)
    map.on('touchmove', onMove)
    map.on('mouseup', onUp)
    map.on('touchend', onUp)
    map.on('mouseout', onUp)
    map.on('click', onEmptyClick)

    return () => {
      map.off('mousedown', onDown)
      map.off('touchstart', onDown)
      map.off('mousemove', onMove)
      map.off('touchmove', onMove)
      map.off('mouseup', onUp)
      map.off('touchend', onUp)
      map.off('mouseout', onUp)
      map.off('click', onEmptyClick)
    }
  }, [mapReady, placed, picking, setPlaced, setActiveUid])

  return <div ref={containerRef} className="map" />
})

export default EarthView
