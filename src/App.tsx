import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { mercatorScale } from './lib/geo'
import type { LonLat } from './lib/geo'
import { geoToPlane, describeKm, KM_PER_MILE } from './lib/flat'
import type { PlanePoint } from './lib/flat'
import { simplifyGeometry, countVertices } from './lib/geo'
import { loadCountries, loadRegions, metricsOf, formatArea, searchPlaces } from './lib/places'
import type { Place } from './lib/places'
import {
  freshId,
  listCanvases,
  putCanvas,
  removeCanvas,
  listShapes,
  getSessions,
  putSession,
} from './lib/store'
import type {
  CustomShape,
  EarthPlaced,
  EarthViewport,
  FlatPlaced,
  FlatViewport,
  ImageCanvasDef,
  StoredSession,
} from './lib/store'
import { DRAG_BUDGET, PALETTE, earthFromStored, flatFromStored, toStored } from './lib/session'
import EarthView from './EarthView'
import type { EarthViewHandle } from './EarthView'
import FlatView from './FlatView'
import type { FlatViewHandle } from './FlatView'
import './App.css'

const EARTH_ID = 'earth'
const ACTIVE_KEY = 'tsop-active-canvas'

type AnyPlaced = EarthPlaced | FlatPlaced

const readImageSize = (blob: Blob) =>
  new Promise<{ width: number; height: number }>((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight })
      URL.revokeObjectURL(url)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Could not read that image'))
    }
    img.src = url
  })

export default function App() {
  // --- datasets --------------------------------------------------------------
  const [countries, setCountries] = useState<Place[]>([])
  const [regions, setRegions] = useState<Place[]>([])
  const [regionsPending, setRegionsPending] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadCountries().then(setCountries).catch((e) => setError(String(e)))
    // Regions are ~8 MB and the app is fully usable without them, so they load
    // in the background rather than holding up first paint.
    loadRegions()
      .then(setRegions)
      .catch(() => {})
      .finally(() => setRegionsPending(false))
  }, [])

  const placesById = useMemo(
    () => new Map([...countries, ...regions].map((p) => [p.id, p])),
    [countries, regions]
  )

  // --- canvases, shapes, sessions ---------------------------------------------
  const [canvases, setCanvases] = useState<ImageCanvasDef[]>([])
  const [shapes, setShapes] = useState<CustomShape[]>([])
  const [activeId, setActiveId] = useState<string>(EARTH_ID)
  const [booted, setBooted] = useState(false)

  /** Raw stored sessions, straight from IndexedDB. */
  const storedRef = useRef<Record<string, StoredSession>>({})
  /** Live (rehydrated) placed subjects, per canvas id. */
  const [live, setLive] = useState<Record<string, AnyPlaced[]>>({})
  const [viewports, setViewports] = useState<Record<string, EarthViewport | FlatViewport>>({})
  /** Stored subjects whose dataset (regions) has not arrived yet. */
  const pendingRef = useRef<Record<string, StoredSession['placed']>>({})

  const shapesById = useMemo(() => new Map(shapes.map((s) => [s.id, s])), [shapes])

  useEffect(() => {
    Promise.all([listCanvases(), listShapes(), getSessions()]).then(
      ([cs, sh, sess]) => {
        setCanvases(cs)
        setShapes(sh)
        storedRef.current = sess
        const vps: Record<string, EarthViewport | FlatViewport> = {}
        for (const [id, s] of Object.entries(sess)) if (s.viewport) vps[id] = s.viewport
        setViewports(vps)
        const wanted = localStorage.getItem(ACTIVE_KEY)
        if (wanted && (wanted === EARTH_ID || cs.some((c) => c.id === wanted)))
          setActiveId(wanted)
        setBooted(true)
      }
    )
  }, [])

  const activeCanvas = activeId === EARTH_ID ? null : canvases.find((c) => c.id === activeId) ?? null

  // Rehydrate the active canvas's session once its dependencies exist.
  useEffect(() => {
    if (!booted || !countries.length || live[activeId]) return
    if (activeId !== EARTH_ID && !activeCanvas) return
    const stored = storedRef.current[activeId]?.placed ?? []
    const items: AnyPlaced[] = []
    const pending: StoredSession['placed'] = []
    for (const sp of stored) {
      const item =
        activeId === EARTH_ID
          ? earthFromStored(sp, placesById, shapesById)
          : flatFromStored(sp, placesById, shapesById)
      if (item) items.push(item)
      else if (sp.ref.kind === 'place' && regionsPending) pending.push(sp)
    }
    pendingRef.current[activeId] = pending
    setLive((prev) => ({ ...prev, [activeId]: items }))
  }, [booted, countries, activeId, activeCanvas, placesById, shapesById, live, regionsPending])

  // Late arrivals: regions land after boot; resolve subjects that waited.
  useEffect(() => {
    if (!regions.length) return
    for (const [canvasId, pend] of Object.entries(pendingRef.current)) {
      if (!pend?.length) continue
      const resolved = pend
        .map((sp) =>
          canvasId === EARTH_ID
            ? earthFromStored(sp, placesById, shapesById)
            : flatFromStored(sp, placesById, shapesById)
        )
        .filter((x): x is AnyPlaced => !!x)
      pendingRef.current[canvasId] = []
      if (resolved.length)
        setLive((prev) => ({
          ...prev,
          [canvasId]: [...(prev[canvasId] ?? []), ...resolved],
        }))
    }
  }, [regions, placesById, shapesById])

  // Persist the active session, debounced.
  useEffect(() => {
    if (!booted || !live[activeId]) return
    const t = setTimeout(() => {
      const session: StoredSession = {
        placed: toStored(live[activeId]),
        viewport: viewports[activeId],
      }
      storedRef.current[activeId] = session
      putSession(activeId, session)
    }, 400)
    return () => clearTimeout(t)
  }, [live, viewports, activeId, booted])

  useEffect(() => {
    if (booted) localStorage.setItem(ACTIVE_KEY, activeId)
  }, [activeId, booted])

  // Restore Earth's camera once after boot.
  const earthRef = useRef<EarthViewHandle>(null)
  const restoredEarth = useRef(false)
  useEffect(() => {
    if (!booted || restoredEarth.current) return
    restoredEarth.current = true
    const v = storedRef.current[EARTH_ID]?.viewport as EarthViewport | undefined
    if (v?.center) earthRef.current?.jumpTo(v)
  }, [booted])

  // --- interaction state -------------------------------------------------------
  const flatRef = useRef<FlatViewHandle>(null)
  const [query, setQuery] = useState('')
  const [activeUid, setActiveUid] = useState<string | null>(null)
  const [calibrating, setCalibrating] = useState(false)
  const [picks, setPicks] = useState<PlanePoint[]>([])
  const [distance, setDistance] = useState('')
  const [unit, setUnit] = useState<'mi' | 'km'>('mi')
  const fileRef = useRef<HTMLInputElement>(null)

  const placed = live[activeId] ?? []
  const setPlacedFor = useCallback(
    (canvasId: string): React.Dispatch<React.SetStateAction<AnyPlaced[]>> =>
      (updater) =>
        setLive((prev) => ({
          ...prev,
          [canvasId]:
            typeof updater === 'function'
              ? (updater as (x: AnyPlaced[]) => AnyPlaced[])(prev[canvasId] ?? [])
              : updater,
        })),
    []
  )

  const switchCanvas = (id: string) => {
    if (id === activeId) return
    setCalibrating(false)
    setPicks([])
    setActiveUid(null)
    setActiveId(id)
  }

  // --- canvas management ---------------------------------------------------
  const addCanvas = async (file: File) => {
    setError(null)
    if (!file.type.startsWith('image/')) {
      setError('That file is not an image.')
      return
    }
    try {
      const { width, height } = await readImageSize(file)
      const def: ImageCanvasDef = {
        id: freshId('img'),
        name: file.name.replace(/\.[a-z0-9]+$/i, ''),
        width,
        height,
        // Placeholder scale until calibrated; sized to a sensible continent.
        kmPerPixel: 4000 / width,
        projection: 'flat',
        blob: file,
      }
      await putCanvas(def)
      setCanvases((prev) => [...prev, def])
      switchCanvas(def.id)
      // A fresh map has a made-up scale — walk straight into calibration.
      setCalibrating(true)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    }
  }

  const deleteCanvas = async (id: string) => {
    await removeCanvas(id)
    setCanvases((prev) => prev.filter((c) => c.id !== id))
    setLive((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    delete storedRef.current[id]
    if (activeId === id) switchCanvas(EARTH_ID)
  }

  const applyScale = async () => {
    if (!activeCanvas || picks.length < 2) return
    const value = Number(distance)
    const km = unit === 'mi' ? value * KM_PER_MILE : value
    const px = Math.hypot(picks[1][0] - picks[0][0], picks[1][1] - picks[0][1])
    if (!Number.isFinite(km) || km <= 0 || px < 1) {
      setError('That line is too short, or the distance is not a positive number.')
      return
    }
    const def = { ...activeCanvas, kmPerPixel: km / px }
    await putCanvas(def)
    setCanvases((prev) => prev.map((c) => (c.id === def.id ? def : c)))
    setCalibrating(false)
    setPicks([])
    setDistance('')
    setError(null)
  }

  // --- subjects --------------------------------------------------------------
  const addPlace = (c: Place) => {
    const { centroid, areaKm2 } = metricsOf(c)
    const uid = `${c.id}-${placed.length}-${Date.now().toString(36)}`
    const color = PALETTE[placed.length % PALETTE.length]
    const common = { uid, name: c.name, parent: c.parent, color, areaKm2, bearing: 0 }
    const ref = { kind: 'place' as const, id: c.id }

    if (activeId === EARTH_ID) {
      const dragGeometry = simplifyGeometry(c.geometry, DRAG_BUDGET)
      const item: EarthPlaced = {
        ...common,
        target: centroid,
        ref,
        src: {
          kind: 'geo',
          homeGeometry: c.geometry,
          dragGeometry,
          homeCentroid: centroid,
          simplified: dragGeometry !== c.geometry,
        },
      }
      setPlacedFor(EARTH_ID)((prev) => [...prev, item])
      earthRef.current?.flyTo(centroid, c.kind === 'region' ? 4 : 2.4)
    } else {
      const item: FlatPlaced = {
        ...common,
        target: flatRef.current?.viewCenter() ?? [
          (activeCanvas?.width ?? 0) / 2,
          (activeCanvas?.height ?? 0) / 2,
        ],
        ref,
        rings: geoToPlane(c.geometry, centroid),
      }
      setPlacedFor(activeId)((prev) => [...prev, item])
    }
    setQuery('')
  }

  const updatePlaced = (uid: string, patch: Partial<AnyPlaced>) =>
    setPlacedFor(activeId)((prev) =>
      prev.map((p) => (p.uid === uid ? ({ ...p, ...patch } as AnyPlaced) : p))
    )

  const removePlaced = (uid: string) =>
    setPlacedFor(activeId)((prev) => prev.filter((p) => p.uid !== uid))

  const matches = useMemo(
    () => searchPlaces([...countries, ...regions], query),
    [query, countries, regions]
  )

  const onEarth = activeId === EARTH_ID
  const earthPlaced = (live[EARTH_ID] ?? []) as EarthPlaced[]
  const simplifiedNames = onEarth
    ? earthPlaced
        .filter((p) => p.src.kind === 'geo' && p.src.simplified)
        .map((p) =>
          p.src.kind === 'geo'
            ? `${p.name} (${countVertices(p.src.homeGeometry).toLocaleString()})`
            : p.name
        )
    : []

  // --- render ------------------------------------------------------------------
  return (
    <div className="app">
      <div className={onEarth ? 'view' : 'view hidden'}>
        <EarthView
          ref={earthRef}
          placed={earthPlaced}
          setPlaced={setPlacedFor(EARTH_ID) as React.Dispatch<React.SetStateAction<EarthPlaced[]>>}
          activeUid={onEarth ? activeUid : null}
          setActiveUid={setActiveUid}
          picking={false}
          picks={[]}
          onPick={() => {}}
          onViewportChange={(v) =>
            setViewports((prev) => ({ ...prev, [EARTH_ID]: v }))
          }
        />
      </div>
      {activeCanvas && (
        <div className="view" key={activeCanvas.id}>
          <FlatView
            ref={flatRef}
            def={activeCanvas}
            placed={placed as FlatPlaced[]}
            setPlaced={setPlacedFor(activeId) as React.Dispatch<React.SetStateAction<FlatPlaced[]>>}
            activeUid={activeUid}
            setActiveUid={setActiveUid}
            picking={calibrating && picks.length < 2}
            picks={picks}
            onPick={(p) => setPicks((prev) => (prev.length < 2 ? [...prev, p] : prev))}
            initialViewport={viewports[activeId] as FlatViewport | undefined}
            onViewportChange={(v) =>
              setViewports((prev) => ({ ...prev, [activeId]: v }))
            }
          />
        </div>
      )}

      <aside className="panel">
        <header>
          <h1>True Size Of</h1>
          <p>
            Search a country, then drag it across the map. Its real shape and
            area never change — only projections lie about them.
          </p>
        </header>

        <div className="canvases">
          <button
            className={onEarth ? 'chip active' : 'chip'}
            onClick={() => switchCanvas(EARTH_ID)}
          >
            🌍 Earth
          </button>
          {canvases.map((c) => (
            <button
              key={c.id}
              className={c.id === activeId ? 'chip active' : 'chip'}
              onClick={() => switchCanvas(c.id)}
              title={c.name}
            >
              {c.name}
            </button>
          ))}
          <button className="chip add" onClick={() => fileRef.current?.click()}>
            ＋ Add map
          </button>
          <input
            ref={fileRef}
            data-testid="canvas-file"
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) addCanvas(f)
              e.target.value = ''
            }}
          />
        </div>

        {activeCanvas && (
          <section className="canvas-info">
            <div className="campaign-meta">
              <small>
                {activeCanvas.width.toLocaleString()} × {activeCanvas.height.toLocaleString()} px
                · flat, uniform scale
              </small>
              <small className="extent">
                {describeKm(activeCanvas.width * activeCanvas.kmPerPixel)} across ·{' '}
                {describeKm(activeCanvas.height * activeCanvas.kmPerPixel)} tall
              </small>
            </div>
            {!calibrating ? (
              <div className="campaign-actions">
                <button className="primary" onClick={() => { setCalibrating(true); setPicks([]) }}>
                  Set scale
                </button>
                <button onClick={() => deleteCanvas(activeCanvas.id)} title="Delete map">
                  Delete
                </button>
              </div>
            ) : (
              <div className="calibrate">
                {picks.length < 2 ? (
                  <p>
                    Click <strong>two points</strong> on your map — along its
                    scale bar, or corner to corner if you know the width.
                    {picks.length === 1 && ' Now the second point.'}
                  </p>
                ) : (
                  <>
                    <p>How far apart are those two points?</p>
                    <div className="distance">
                      <input
                        autoFocus
                        type="number"
                        min="0"
                        step="any"
                        value={distance}
                        placeholder="e.g. 100"
                        onChange={(e) => setDistance(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && applyScale()}
                      />
                      <select value={unit} onChange={(e) => setUnit(e.target.value as 'mi' | 'km')}>
                        <option value="mi">miles</option>
                        <option value="km">km</option>
                      </select>
                    </div>
                  </>
                )}
                <div className="campaign-actions">
                  {picks.length >= 2 && (
                    <button className="primary" onClick={applyScale}>
                      Apply
                    </button>
                  )}
                  <button onClick={() => { setCalibrating(false); setPicks([]) }}>Cancel</button>
                </div>
              </div>
            )}
          </section>
        )}

        <div className="search">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              countries.length ? 'Search a country or region…' : 'Loading countries…'
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
            const geoSrc = onEarth && (p as EarthPlaced).src.kind === 'geo'
            const home = geoSrc
              ? ((p as EarthPlaced).src as { homeCentroid: LonLat }).homeCentroid
              : null
            const ratio = home
              ? (mercatorScale(p.target[1]) / mercatorScale(home[1])) ** 2
              : 1
            const moved = home ? Math.abs(ratio - 1) > 0.005 : false
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
                  {home && (
                    <button
                      onClick={() => updatePlaced(p.uid, { target: home, bearing: 0 })}
                      title="Send home"
                    >
                      ⟲
                    </button>
                  )}
                  <button onClick={() => removePlaced(p.uid)} title="Remove">
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
                    onChange={(e) => updatePlaced(p.uid, { bearing: Number(e.target.value) })}
                  />
                  <button
                    className="deg"
                    onClick={() => updatePlaced(p.uid, { bearing: 0 })}
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
            {onEarth
              ? 'Try Greenland — then drag it down to the equator. Regions work too: Florida, Scotland, Hokkaido.'
              : 'Search for a country or region to drop it onto your map at true size.'}
          </p>
        )}

        {simplifiedNames.length > 0 && (
          <p className="hint">
            Outlines over {DRAG_BUDGET.toLocaleString()} points are simplified
            while you move them, then redrawn at full detail.{' '}
            {simplifiedNames.join(', ')}
          </p>
        )}
      </aside>
    </div>
  )
}
