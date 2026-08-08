import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { mercatorScale } from './lib/geo'
import type { LonLat } from './lib/geo'
import { geoToPlane, describeKm, KM_PER_MILE, shapeFromFlatTrace, shapeFromGeoTrace } from './lib/flat'
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
  putShape,
  removeShape,
  getSessions,
  putSession,
  exportSnapshot,
  importSnapshot,
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
import { DRAG_BUDGET, PALETTE, earthFromStored, flatFromStored, toStored, shapeHomeCentroid } from './lib/session'
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

/**
 * Two-click delete: first click arms (turns red), second click within 3s
 * fires. Exists because a one-click delete sat next to the place button and
 * ate a shape someone had spent an evening tracing.
 */
function ConfirmButton({
  title,
  armedLabel,
  onConfirm,
  children,
}: {
  title: string
  armedLabel?: string
  onConfirm: () => void
  children: React.ReactNode
}) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 3000)
    return () => clearTimeout(t)
  }, [armed])
  return (
    <button
      className={armed ? 'danger' : undefined}
      title={armed ? 'Click again to confirm' : title}
      onClick={() => {
        if (armed) {
          setArmed(false)
          onConfirm()
        } else setArmed(true)
      }}
    >
      {armed && armedLabel ? armedLabel : children}
    </button>
  )
}

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
  const [mode, setMode] = useState<'none' | 'calibrate' | 'trace'>('none')
  const [picks, setPicks] = useState<PlanePoint[]>([])
  /** Completed islands of the trace in progress; picks is the ring being drawn. */
  const [traceRings, setTraceRings] = useState<PlanePoint[][]>([])
  /**
   * Undo history: a snapshot of the whole trace before each edit — appends,
   * inserts, vertex moves, island commits alike. Traces are tiny, so full
   * snapshots beat a command pattern on simplicity and are just as cheap.
   */
  const [traceHistory, setTraceHistory] = useState<
    { picks: PlanePoint[]; rings: PlanePoint[][] }[]
  >([])
  /**
   * A drag gesture stashes its pre-state here on pointer-down and only
   * commits it to history on the first actual change — so one drag is one
   * undo step, and a grab that never moves pollutes nothing.
   */
  const gestureRef = useRef<{ picks: PlanePoint[]; rings: PlanePoint[][] } | null>(null)
  const [shapeName, setShapeName] = useState('')
  const [distance, setDistance] = useState('')
  const [unit, setUnit] = useState<'mi' | 'km'>('mi')
  const fileRef = useRef<HTMLInputElement>(null)
  const importRef = useRef<HTMLInputElement>(null)
  const [dataMsg, setDataMsg] = useState<string | null>(null)

  /**
   * One-slot undo for deletions. Confirmation stops slips; this catches the
   * confident-but-wrong click. Holds the deleted thing in memory for 12s.
   */
  type Trash =
    | { kind: 'shape'; shape: CustomShape; placements: Record<string, AnyPlaced[]> }
    | { kind: 'canvas'; def: ImageCanvasDef; session?: StoredSession }
  const [trash, setTrash] = useState<Trash | null>(null)
  useEffect(() => {
    if (!trash) return
    const t = setTimeout(() => setTrash(null), 12000)
    return () => clearTimeout(t)
  }, [trash])

  const undoDelete = async () => {
    if (!trash) return
    if (trash.kind === 'shape') {
      await putShape(trash.shape)
      setShapes((prev) => [...prev, trash.shape])
      setLive((prev) => {
        const next = { ...prev }
        for (const [k, items] of Object.entries(trash.placements))
          next[k] = [...(next[k] ?? []), ...items]
        return next
      })
    } else {
      await putCanvas(trash.def)
      setCanvases((prev) => [...prev, trash.def])
      if (trash.session) {
        storedRef.current[trash.def.id] = trash.session
        await putSession(trash.def.id, trash.session)
      }
    }
    setTrash(null)
  }

  const doExport = async () => {
    // Flush the active session first so the file matches what's on screen.
    if (live[activeId])
      await putSession(activeId, {
        placed: toStored(live[activeId]),
        viewport: viewports[activeId],
      })
    const json = await exportSnapshot()
    const blob = new Blob([json], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `true-size-of-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(a.href)
    setDataMsg('Exported.')
  }

  const doImport = async (file: File) => {
    try {
      const n = await importSnapshot(await file.text())
      setDataMsg(`Imported ${n.canvases} map(s), ${n.shapes} shape(s). Reloading…`)
      // Everything rehydrates from storage on boot; a reload is the one code
      // path that is guaranteed to pick all of it up consistently.
      setTimeout(() => window.location.reload(), 400)
    } catch (e) {
      setDataMsg(String(e instanceof Error ? e.message : e))
    }
  }

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
    setMode('none')
    setPicks([])
    setTraceRings([])
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
      setMode('calibrate')
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    }
  }

  const deleteCanvas = async (id: string) => {
    const def = canvases.find((c) => c.id === id)
    if (def) setTrash({ kind: 'canvas', def, session: storedRef.current[id] })
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
    setMode('none')
    setPicks([])
    setDistance('')
    setError(null)
  }

  // --- shapes ------------------------------------------------------------------
  const startTrace = () => {
    setMode('trace')
    setPicks([])
    setTraceRings([])
    setTraceHistory([])
    gestureRef.current = null
    setShapeName('')
  }

  const cancelTrace = () => {
    setMode('none')
    setPicks([])
    setTraceRings([])
    setTraceHistory([])
    gestureRef.current = null
    setShapeName('')
  }

  /** Snapshot the current trace onto the history stack (capped). */
  const pushTraceHistory = useCallback(() => {
    setTraceHistory((prev) => [...prev.slice(-199), { picks, rings: traceRings }])
  }, [picks, traceRings])

  const addTracePoint = useCallback(
    (p: PlanePoint) => {
      pushTraceHistory()
      setPicks((prev) => [...prev, p])
    },
    [pushTraceHistory]
  )

  /** Finish the current outline and start another island. */
  const newIsland = () => {
    if (picks.length < 3) return
    pushTraceHistory()
    setTraceRings((prev) => [...prev, picks])
    setPicks([])
  }

  /** Undo any edit — append, insert, move, or island commit. */
  const undoPoint = useCallback(() => {
    if (!traceHistory.length) return
    const last = traceHistory[traceHistory.length - 1]
    setPicks(last.picks)
    setTraceRings(last.rings)
    setTraceHistory(traceHistory.slice(0, -1))
    gestureRef.current = null
  }, [traceHistory])

  /** Views call this on pointer-down before a vertex drag or edge insert. */
  const beginTraceEdit = useCallback(() => {
    gestureRef.current = { picks, rings: traceRings }
  }, [picks, traceRings])

  const commitGesture = () => {
    const g = gestureRef.current
    if (!g) return
    gestureRef.current = null
    setTraceHistory((prev) => [...prev.slice(-199), g])
  }

  const moveTracePoint = useCallback((ring: number, i: number, p: PlanePoint) => {
    commitGesture()
    if (ring < 0) setPicks((prev) => prev.map((q, j) => (j === i ? p : q)))
    else
      setTraceRings((prev) =>
        prev.map((r, ri) => (ri === ring ? r.map((q, j) => (j === i ? p : q)) : r))
      )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * Delete one vertex (double-click). A completed ring that would drop below
   * 3 points stops being a polygon, so it goes with its last vertex — undo
   * brings the whole island back.
   */
  const deleteTracePoint = useCallback(
    (ring: number, i: number) => {
      pushTraceHistory()
      if (ring < 0) setPicks((prev) => prev.filter((_, j) => j !== i))
      else
        setTraceRings((prev) =>
          prev
            .map((r, ri) => (ri === ring ? r.filter((_, j) => j !== i) : r))
            .filter((r) => r.length >= 3)
        )
    },
    [pushTraceHistory]
  )

  const insertTracePoint = useCallback((ring: number, i: number, p: PlanePoint) => {
    commitGesture()
    if (ring < 0) setPicks((prev) => [...prev.slice(0, i), p, ...prev.slice(i)])
    else
      setTraceRings((prev) =>
        prev.map((r, ri) => (ri === ring ? [...r.slice(0, i), p, ...r.slice(i)] : r))
      )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Ctrl/Cmd-Z undoes the last point, Escape abandons the trace. The name
  // input keeps its native text undo.
  useEffect(() => {
    if (mode !== 'trace') return
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        if ((e.target as HTMLElement).tagName === 'INPUT') return
        e.preventDefault()
        undoPoint()
      } else if (e.key === 'Escape') {
        cancelTrace()
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [mode, undoPoint])

  const traceReady = traceRings.length > 0 || picks.length >= 3

  const saveShape = async () => {
    const name = shapeName.trim()
    // Stray 1-2 point current rings are ignored rather than blocking the save.
    const rings = [...traceRings, ...(picks.length >= 3 ? [picks] : [])]
    if (!rings.length || !name) return
    let shape: CustomShape
    if (onEarth) {
      const t = shapeFromGeoTrace(rings as LonLat[][])
      shape = {
        id: freshId('shape'),
        name,
        def: { kind: 'geo', geometry: t.geometry },
        areaKm2: t.areaKm2,
        tracedOn: 'Earth',
      }
    } else {
      const t = shapeFromFlatTrace(rings, activeCanvas!.kmPerPixel)
      shape = {
        id: freshId('shape'),
        name,
        def: { kind: 'flat', rings: t.rings },
        areaKm2: t.areaKm2,
        tracedOn: activeCanvas!.name,
      }
    }
    await putShape(shape)
    setShapes((prev) => [...prev, shape])
    cancelTrace()
  }

  const placeShape = (s: CustomShape) => {
    const uid = freshId('p')
    const target: [number, number] = onEarth
      ? s.def.kind === 'geo'
        ? shapeHomeCentroid(s)!
        : ((viewports[EARTH_ID] as EarthViewport | undefined)?.center ?? [0, 20])
      : flatRef.current?.viewCenter() ?? [
          (activeCanvas?.width ?? 0) / 2,
          (activeCanvas?.height ?? 0) / 2,
        ]
    const sp = {
      uid,
      name: s.name,
      color: PALETTE[placed.length % PALETTE.length],
      areaKm2: s.areaKm2,
      bearing: 0,
      target,
      ref: { kind: 'shape' as const, id: s.id },
    }
    const item = onEarth
      ? earthFromStored(sp, placesById, shapesById)
      : flatFromStored(sp, placesById, shapesById)
    if (!item) return
    setPlacedFor(activeId)((prev) => [...prev, item])
    if (onEarth) earthRef.current?.flyTo(target as LonLat, 3)
  }

  const deleteShape = async (id: string) => {
    const shape = shapesById.get(id)
    if (shape) {
      const placements: Record<string, AnyPlaced[]> = {}
      for (const [k, items] of Object.entries(live)) {
        const mine = items.filter((p) => p.ref.kind === 'shape' && p.ref.id === id)
        if (mine.length) placements[k] = mine
      }
      setTrash({ kind: 'shape', shape, placements })
    }
    await removeShape(id)
    setShapes((prev) => prev.filter((s) => s.id !== id))
    // Evict live placements of it everywhere; stored ones on other canvases
    // simply fail to rehydrate later, which is the same outcome.
    setLive((prev) =>
      Object.fromEntries(
        Object.entries(prev).map(([k, items]) => [
          k,
          items.filter((p) => !(p.ref.kind === 'shape' && p.ref.id === id)),
        ])
      )
    )
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
          picking={onEarth && mode === 'trace'}
          picks={onEarth && mode === 'trace' ? (picks as LonLat[]) : []}
          traceRings={onEarth && mode === 'trace' ? (traceRings as LonLat[][]) : []}
          onPick={addTracePoint}
          onTraceMove={moveTracePoint}
          onTraceInsert={insertTracePoint}
          onTraceDelete={deleteTracePoint}
          onTraceEditStart={beginTraceEdit}
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
            picking={mode === 'calibrate' ? picks.length < 2 : mode === 'trace'}
            picks={picks}
            traceRings={mode === 'trace' ? traceRings : []}
            traceEditing={mode === 'trace'}
            onPick={(p) => {
              if (mode === 'trace') addTracePoint(p)
              else setPicks((prev) => (prev.length >= 2 ? prev : [...prev, p]))
            }}
            onTraceMove={moveTracePoint}
            onTraceInsert={insertTracePoint}
            onTraceDelete={deleteTracePoint}
            onTraceEditStart={beginTraceEdit}
            initialViewport={viewports[activeId] as FlatViewport | undefined}
            onViewportChange={(v) =>
              setViewports((prev) => ({ ...prev, [activeId]: v }))
            }
          />
        </div>
      )}

      {mode === 'trace' && (
        <div className="tracebar">
          <span className="count">
            {traceRings.length + (picks.length >= 3 ? 1 : 0) > 1 &&
              `${traceRings.length + (picks.length >= 3 ? 1 : 0)} islands · `}
            {picks.length} pt{picks.length === 1 ? '' : 's'}
          </span>
          <input
            value={shapeName}
            placeholder="Name this shape…"
            onChange={(e) => setShapeName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && saveShape()}
          />
          <button
            className="primary"
            disabled={!traceReady || !shapeName.trim()}
            onClick={saveShape}
          >
            Save
          </button>
          <button
            disabled={picks.length < 3}
            onClick={newIsland}
            title="Finish this outline and start another island"
          >
            ＋ Island
          </button>
          <button
            disabled={!traceHistory.length}
            onClick={undoPoint}
            title="Undo (Ctrl+Z)"
          >
            ↩
          </button>
          <button onClick={cancelTrace} title="Cancel (Esc)">
            ✕
          </button>
          <small>
            click to add · drag point to move · click edge to insert ·
            right-click point to delete · drag map to pan
          </small>
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

        {trash && (
          <p className="undo">
            Deleted “{trash.kind === 'shape' ? trash.shape.name : trash.def.name}”.{' '}
            <button onClick={undoDelete}>Undo</button>
          </p>
        )}

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
            {mode !== 'calibrate' ? (
              <div className="campaign-actions">
                <button className="primary" onClick={() => { setMode('calibrate'); setPicks([]) }}>
                  Set scale
                </button>
                <ConfirmButton
                  title="Delete map"
                  armedLabel="Sure?"
                  onConfirm={() => deleteCanvas(activeCanvas.id)}
                >
                  Delete
                </ConfirmButton>
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
                  <button onClick={() => { setMode('none'); setPicks([]) }}>Cancel</button>
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

        <section className="shapes">
          <h2>Shapes</h2>
          {mode !== 'trace' ? (
            <div className="campaign-actions">
              <button onClick={startTrace}>✏️ Trace a shape on this map</button>
            </div>
          ) : (
            <p className="hint">Tracing — use the bar at the bottom of the map.</p>
          )}
          {shapes.length > 0 && (
            <ul className="shapelist">
              {shapes.map((sh) => (
                <li key={sh.id}>
                  <div className="meta">
                    <strong>{sh.name}</strong>
                    <small>
                      {formatArea(sh.areaKm2)}
                      {sh.tracedOn ? ` · traced on ${sh.tracedOn}` : ''}
                    </small>
                  </div>
                  <button onClick={() => placeShape(sh)} title={`Place ${sh.name}`}>
                    ＋
                  </button>
                  <ConfirmButton title={`Delete ${sh.name}`} onConfirm={() => deleteShape(sh.id)}>
                    ×
                  </ConfirmButton>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="shapes data">
          <h2>Save / load</h2>
          <div className="campaign-actions">
            <button onClick={doExport} title="Export everything to a file">
              ⬇ Export file
            </button>
            <button onClick={() => importRef.current?.click()} title="Import a snapshot file">
              ⬆ Import file
            </button>
            <input
              ref={importRef}
              data-testid="import-file"
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) doImport(f)
                e.target.value = ''
              }}
            />
          </div>
          {dataMsg && <p className="hint">{dataMsg}</p>}
          <p className="hint">
            Everything — maps, shapes, placements — in one JSON file. No
            account, nothing uploaded.
          </p>
        </section>

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
