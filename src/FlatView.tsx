import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react'
import { planeBounds, hitTracePoint, pointInRing } from './lib/flat'
import type { PlanePoint } from './lib/flat'
import type { FlatPlaced, FlatViewport, ImageCanvasDef } from './lib/store'

const D2R = Math.PI / 180
const R2D = 180 / Math.PI
/** Screen distance from a selected subject's anchor to its rotate knob. */
const HANDLE_PX = 46
const KNOB_R = 7

export interface FlatViewHandle {
  /** Centre of the current viewport, in image pixels. */
  viewCenter(): PlanePoint
}

interface Props {
  def: ImageCanvasDef
  placed: FlatPlaced[]
  setPlaced: React.Dispatch<React.SetStateAction<FlatPlaced[]>>
  activeUid: string | null
  setActiveUid: (u: string | null) => void
  /** Persistently selected subject: shows the rotate handle. */
  selectedUid: string | null
  onSelect: (u: string | null) => void
  onRotate: (uid: string, bearing: number) => void
  /** When true, clicks are reported via onPick instead of starting drags. */
  picking: boolean
  picks: PlanePoint[]
  /** Completed islands of a trace in progress. */
  traceRings?: PlanePoint[][]
  /** Enables vertex dragging and edge insertion on the trace. */
  traceEditing?: boolean
  onPick: (p: PlanePoint) => void
  onTraceMove?: (ring: number, index: number, p: PlanePoint) => void
  onTraceInsert?: (ring: number, index: number, p: PlanePoint) => void
  /** Double-click on a vertex. */
  onTraceDelete?: (ring: number, index: number) => void
  /** Drag from inside the outline: translate every vertex of the trace. */
  onTraceTranslate?: (dx: number, dy: number) => void
  /** Called on pointer-down before a vertex drag or edge insert begins. */
  onTraceEditStart?: () => void
  initialViewport?: FlatViewport
  onViewportChange?: (v: FlatViewport) => void
}

interface TestHook {
  viewport(): FlatViewport
  screenFromWorld(p: PlanePoint): PlanePoint
  worldFromScreen(p: PlanePoint): PlanePoint
  hitAt(sx: number, sy: number): string | null
  count(): number
  trace(): { picks: PlanePoint[]; rings: PlanePoint[][] }
  /** Drawn footprint of a subject in image px, from its actual rings. */
  bboxPx(uid: string): { w: number; h: number } | null
  items(): { uid: string; target: PlanePoint; bearing: number }[]
}

/**
 * Renderer for image canvases: one PNG as the world, subjects as km-plane
 * polygons drawn at true size. Everything is canvas2d — at these subject
 * counts a full redraw is cheap, and Path2D objects are cached per subject in
 * local coordinates so pan/zoom/drag only changes a transform, never
 * re-tessellates geometry.
 *
 * World coordinates are IMAGE PIXELS, not km. That anchors placements and
 * calibration picks to features of the picture, so recalibrating the scale
 * re-sizes subjects but never slides them off the coastline they were on.
 */
const FlatView = forwardRef<FlatViewHandle, Props>(function FlatView(
  {
    def,
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
    traceEditing = false,
    onPick,
    onTraceMove,
    onTraceInsert,
    onTraceDelete,
    onTraceTranslate,
    onTraceEditStart,
    initialViewport,
    onViewportChange,
  },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const bitmapRef = useRef<ImageBitmap | null>(null)
  const vpRef = useRef<FlatViewport | null>(initialViewport ?? null)
  const sizeRef = useRef({ w: 0, h: 0 })
  const rafRef = useRef(0)
  const dragRef = useRef<
    | { kind: 'item'; uid: string; offX: number; offY: number; startX: number; startY: number; moved: boolean }
    | { kind: 'pan'; lastX: number; lastY: number; startX: number; startY: number; moved: boolean }
    | {
        kind: 'maybe-pick'
        wx: number
        wy: number
        startX: number
        startY: number
        lastX: number
        lastY: number
        moved: boolean
      }
    | { kind: 'trace-vertex'; ring: number; index: number }
    | {
        kind: 'trace-pan'
        wx: number
        wy: number
        lastWX: number
        lastWY: number
        startX: number
        startY: number
        moved: boolean
      }
    | { kind: 'rotate'; uid: string }
    | { kind: 'pinch'; p1: number; p2: number; lastMid: PlanePoint; lastDist: number }
    | null
  >(null)

  // Inertial-pan bookkeeping. Refs, not effect-locals: the interactions
  // effect re-runs whenever the parent re-renders (its setPlaced prop is a
  // fresh function each render), and the viewport commit on release causes
  // exactly such a render — effect-local state would kill a glide instantly.
  const glideRef = useRef(0)
  const samplesRef = useRef<{ t: number; x: number; y: number }[]>([])

  // Path2D per subject, in local px (km / kmPerPixel), origin at its centroid.
  const pathCache = useRef(new Map<string, { rings: unknown; kpp: number; path: Path2D }>())

  const propsRef = useRef({ placed, activeUid, selectedUid, picks, traceRings, traceEditing, picking, def })
  propsRef.current = { placed, activeUid, selectedUid, picks, traceRings, traceEditing, picking, def }
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
  const onViewportRef = useRef(onViewportChange)
  onViewportRef.current = onViewportChange

  const pathFor = useCallback((item: FlatPlaced, kpp: number): Path2D => {
    const hit = pathCache.current.get(item.uid)
    if (hit && hit.rings === item.rings && hit.kpp === kpp) return hit.path
    const path = new Path2D()
    for (const poly of item.rings) {
      for (const ring of poly) {
        ring.forEach(([x, y], i) => {
          if (i === 0) path.moveTo(x / kpp, y / kpp)
          else path.lineTo(x / kpp, y / kpp)
        })
        path.closePath()
      }
    }
    pathCache.current.set(item.uid, { rings: item.rings, kpp, path })
    return path
  }, [])

  const fitViewport = useCallback((): FlatViewport => {
    const { w, h } = sizeRef.current
    const zoom = Math.min(w / def.width, h / def.height) * 0.92 || 1
    return {
      zoom,
      tx: (w - def.width * zoom) / 2,
      ty: (h - def.height * zoom) / 2,
    }
  }, [def.width, def.height])

  const draw = useCallback(() => {
    const cv = canvasRef.current
    const ctx = cv?.getContext('2d')
    if (!cv || !ctx) return
    const dpr = window.devicePixelRatio || 1
    // Never derive a viewport before the ResizeObserver has reported a real
    // size — fitting to a 0x0 canvas would cache a nonsense transform.
    if (!vpRef.current) {
      if (!sizeRef.current.w || !sizeRef.current.h) return
      vpRef.current = fitViewport()
    }
    const { tx, ty, zoom } = vpRef.current
    const { placed: items, activeUid: active, picks: pk, def: d } = propsRef.current

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = '#11151b'
    ctx.fillRect(0, 0, cv.width, cv.height)
    ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * tx, dpr * ty)

    if (bitmapRef.current) ctx.drawImage(bitmapRef.current, 0, 0)
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'
    ctx.lineWidth = 1 / zoom
    ctx.strokeRect(0, 0, d.width, d.height)

    // Static subjects first, active one last so it draws on top.
    const ordered = [...items.filter((p) => p.uid !== active), ...items.filter((p) => p.uid === active)]
    for (const item of ordered) {
      const path = pathFor(item, d.kmPerPixel)
      ctx.save()
      ctx.translate(item.target[0], item.target[1])
      ctx.rotate(item.bearing * D2R)
      ctx.globalAlpha = 0.55
      ctx.fillStyle = item.color
      ctx.fill(path)
      ctx.globalAlpha = 1
      ctx.strokeStyle = item.color
      ctx.lineWidth = 1.5 / zoom
      ctx.stroke(path)
      ctx.restore()
    }

    // Rotate handle for the selected subject: a stalk from its anchor to a
    // knob that tracks the bearing, so "up the stalk" is the shape's north.
    const sel = items.find((p) => p.uid === propsRef.current.selectedUid)
    if (sel && !propsRef.current.picking) {
      const dWorld = HANDLE_PX / zoom
      const a = sel.bearing * D2R
      const kx = sel.target[0] + Math.sin(a) * dWorld
      const ky = sel.target[1] - Math.cos(a) * dWorld
      ctx.strokeStyle = '#6ea8fe'
      ctx.lineWidth = 2 / zoom
      ctx.beginPath()
      ctx.moveTo(sel.target[0], sel.target[1])
      ctx.lineTo(kx, ky)
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(kx, ky, KNOB_R / zoom, 0, Math.PI * 2)
      ctx.fillStyle = '#6ea8fe'
      ctx.fill()
      ctx.strokeStyle = '#11151b'
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(sel.target[0], sel.target[1], 3 / zoom, 0, Math.PI * 2)
      ctx.fillStyle = '#6ea8fe'
      ctx.fill()
    }

    // Trace overlay: completed islands, then the ring being drawn.
    const { traceRings: rings } = propsRef.current
    const handle = (x: number, y: number, r: number) => {
      ctx.beginPath()
      ctx.arc(x, y, r / zoom, 0, Math.PI * 2)
      ctx.fillStyle = '#ffd166'
      ctx.fill()
      ctx.strokeStyle = '#1b1f27'
      ctx.lineWidth = 2 / zoom
      ctx.stroke()
    }
    for (const ring of rings) {
      ctx.beginPath()
      ring.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)))
      ctx.closePath()
      // A light wash of the editor's amber: signals "drag inside to move"
      // without ever being mistaken for a placed subject (those are solid
      // palette colours at 0.55; this is reserved amber at 0.15, dashed).
      ctx.globalAlpha = 0.15
      ctx.fillStyle = '#ffd166'
      ctx.fill()
      ctx.globalAlpha = 1
      ctx.strokeStyle = '#ffd166'
      ctx.lineWidth = 2 / zoom
      ctx.setLineDash([6 / zoom, 4 / zoom])
      ctx.stroke()
      ctx.setLineDash([])
      for (const [x, y] of ring) handle(x, y, 4)
    }
    if (pk.length) {
      ctx.strokeStyle = '#ffd166'
      ctx.lineWidth = 2.5 / zoom
      ctx.setLineDash([6 / zoom, 4 / zoom])
      if (pk.length >= 2) {
        ctx.beginPath()
        pk.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)))
        ctx.stroke()
      }
      // Faint closing hint once the ring could be finished, and a fainter
      // wash still — this ring is provisional until committed or saved.
      if (pk.length >= 3) {
        ctx.beginPath()
        pk.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)))
        ctx.closePath()
        ctx.globalAlpha = 0.1
        ctx.fillStyle = '#ffd166'
        ctx.fill()
        ctx.globalAlpha = 1
      }
      if (pk.length >= 3) {
        ctx.globalAlpha = 0.35
        ctx.beginPath()
        ctx.moveTo(pk[pk.length - 1][0], pk[pk.length - 1][1])
        ctx.lineTo(pk[0][0], pk[0][1])
        ctx.stroke()
        ctx.globalAlpha = 1
      }
      ctx.setLineDash([])
      for (const [x, y] of pk) handle(x, y, 5)
    }
  }, [fitViewport, pathFor])

  const scheduleDraw = useCallback(() => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      draw()
    })
  }, [draw])

  // Redraw whenever React-visible inputs change.
  useEffect(() => {
    scheduleDraw()
  }, [placed, activeUid, selectedUid, picks, traceRings, def.kmPerPixel, scheduleDraw])

  // Decode the image off the main thread.
  useEffect(() => {
    let cancelled = false
    createImageBitmap(def.blob).then((bmp) => {
      if (cancelled) {
        bmp.close()
        return
      }
      bitmapRef.current = bmp
      scheduleDraw()
    })
    return () => {
      cancelled = true
      bitmapRef.current?.close()
      bitmapRef.current = null
    }
  }, [def.blob, scheduleDraw])

  // Keep the backing store at device resolution.
  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const ro = new ResizeObserver(() => {
      const rect = cv.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      sizeRef.current = { w: rect.width, h: rect.height }
      cv.width = Math.max(1, Math.round(rect.width * dpr))
      cv.height = Math.max(1, Math.round(rect.height * dpr))
      scheduleDraw()
    })
    ro.observe(cv)
    return () => ro.disconnect()
  }, [scheduleDraw])

  // --- coordinate mapping ----------------------------------------------------
  const worldFromScreen = useCallback((sx: number, sy: number): PlanePoint => {
    const { tx, ty, zoom } = vpRef.current ?? fitViewport()
    return [(sx - tx) / zoom, (sy - ty) / zoom]
  }, [fitViewport])

  const screenFromWorld = useCallback((p: PlanePoint): PlanePoint => {
    const { tx, ty, zoom } = vpRef.current ?? fitViewport()
    return [p[0] * zoom + tx, p[1] * zoom + ty]
  }, [fitViewport])

  const hitTest = useCallback(
    (wx: number, wy: number): string | null => {
      const ctx = canvasRef.current?.getContext('2d')
      if (!ctx) return null
      const { placed: items, def: d } = propsRef.current
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i]
        const dx = wx - item.target[0]
        const dy = wy - item.target[1]
        const a = -item.bearing * D2R
        const lx = dx * Math.cos(a) - dy * Math.sin(a)
        const ly = dx * Math.sin(a) + dy * Math.cos(a)
        if (ctx.isPointInPath(pathFor(item, d.kmPerPixel), lx, ly)) return item.uid
      }
      return null
    },
    [pathFor]
  )

  // --- interactions ----------------------------------------------------------
  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return

    const local = (e: PointerEvent | WheelEvent) => {
      const r = cv.getBoundingClientRect()
      return [e.clientX - r.left, e.clientY - r.top] as PlanePoint
    }

    /** Live screen position of every pressed pointer, for pinch-zoom. */
    const pointers = new Map<number, PlanePoint>()

    // Inertial panning, to match MapLibre's feel on the Earth view: velocity
    // is read from the last ~120ms of the gesture and decays exponentially.
    const stopGlide = () => {
      if (glideRef.current) cancelAnimationFrame(glideRef.current)
      glideRef.current = 0
    }
    const sample = (e: PointerEvent) => {
      const s = samplesRef.current
      const now = performance.now()
      s.push({ t: now, x: e.clientX, y: e.clientY })
      while (s.length && now - s[0].t > 120) s.shift()
    }
    /** Returns true if a glide started; it commits the viewport when it rests. */
    const startGlide = (): boolean => {
      // Window the samples against the moment of RELEASE, not against the last
      // sample. Pruning only on new samples would leave a stale burst of speed
      // sitting in the buffer, so dragging fast, holding still, then letting go
      // would fling — the one gesture that most clearly means "stop here".
      const now = performance.now()
      const s = samplesRef.current.filter((p) => now - p.t <= 120)
      if (s.length < 2) return false
      const a = s[0]
      const b = s[s.length - 1]
      const dt = b.t - a.t
      if (dt < 30) return false // too brief to read a direction from
      let vx = (b.x - a.x) / dt
      let vy = (b.y - a.y) / dt
      const speed = Math.hypot(vx, vy)
      if (speed < 0.05) return false
      const MAX = 1.4 // px/ms, roughly MapLibre's clamp
      if (speed > MAX) {
        vx *= MAX / speed
        vy *= MAX / speed
      }
      let last = performance.now()
      const tick = () => {
        glideRef.current = 0
        const now = performance.now()
        const step = now - last
        last = now
        const vp = vpRef.current
        if (!vp) return
        vpRef.current = { ...vp, tx: vp.tx + vx * step, ty: vp.ty + vy * step }
        scheduleDraw()
        const k = Math.exp(-step / 325)
        vx *= k
        vy *= k
        if (Math.hypot(vx, vy) > 0.02) glideRef.current = requestAnimationFrame(tick)
        else onViewportRef.current?.(vpRef.current)
      }
      glideRef.current = requestAnimationFrame(tick)
      return true
    }

    const capture = (id: number) => {
      // Synthetic events (tests) carry pointerIds the browser doesn't know.
      try {
        cv.setPointerCapture(id)
      } catch {
        /* ignore */
      }
    }

    /** Screen position of the selected subject's rotate knob, if shown. */
    const knobScreen = (): PlanePoint | null => {
      const { placed: items, selectedUid: sel, picking: pk } = propsRef.current
      if (!sel || pk) return null
      const it = items.find((p) => p.uid === sel)
      const vp = vpRef.current
      if (!it || !vp) return null
      const a = it.bearing * D2R
      const sx = it.target[0] * vp.zoom + vp.tx
      const sy = it.target[1] * vp.zoom + vp.ty
      return [sx + Math.sin(a) * HANDLE_PX, sy - Math.cos(a) * HANDLE_PX]
    }

    // Screen-space hit test against the trace being edited. The current ring
    // is ring -1 and open; completed islands are closed.
    const hitTraceAt = (sx: number, sy: number) => {
      const vp = vpRef.current
      if (!vp) return null
      const toScreen = (p: PlanePoint): PlanePoint => [
        p[0] * vp.zoom + vp.tx,
        p[1] * vp.zoom + vp.ty,
      ]
      const { picks: pk, traceRings: rings } = propsRef.current
      return hitTracePoint(
        [
          ...rings.map((pts, i) => ({ ring: i, pts: pts.map(toScreen), closed: true })),
          { ring: -1, pts: pk.map(toScreen), closed: false },
        ],
        sx,
        sy
      )
    }

    /** Is a world point inside any island or the (closable) current ring? */
    const insideTrace = (wx: number, wy: number) => {
      const { picks: pk, traceRings: rings } = propsRef.current
      return (
        rings.some((r) => pointInRing([wx, wy], r)) ||
        (pk.length >= 3 && pointInRing([wx, wy], pk))
      )
    }

    const onDown = (e: PointerEvent) => {
      // Primary button only: right-click is deletion (contextmenu), and must
      // never fall through to add-a-point or start a pan.
      if (e.button !== 0) return
      stopGlide()
      samplesRef.current = [{ t: performance.now(), x: e.clientX, y: e.clientY }]
      const [sx, sy] = local(e)
      pointers.set(e.pointerId, [sx, sy])
      capture(e.pointerId)
      // A second finger turns whatever gesture was underway into a pinch.
      if (pointers.size === 2) {
        const drag = dragRef.current
        if (drag?.kind === 'item' || drag?.kind === 'rotate') setActiveUid(null)
        const [i, j] = [...pointers.keys()]
        const [a, b] = [...pointers.values()]
        dragRef.current = {
          kind: 'pinch',
          p1: i,
          p2: j,
          lastMid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
          lastDist: Math.hypot(a[0] - b[0], a[1] - b[1]),
        }
        return
      }
      if (pointers.size > 2) return
      const [wx, wy] = worldFromScreen(sx, sy)
      if (propsRef.current.picking) {
        // Grab a vertex, split an edge, or — failing both — wait to see
        // whether this press is a click (add a point) or a drag (pan).
        if (propsRef.current.traceEditing) {
          const hit = hitTraceAt(sx, sy)
          if (hit) {
            onTraceEditStartRef.current?.()
            if (hit.kind === 'edge') onTraceInsertRef.current?.(hit.ring, hit.index, [wx, wy])
            dragRef.current = { kind: 'trace-vertex', ring: hit.ring, index: hit.index }
            return
          }
        }
        // Dragging from inside the outline moves the whole trace; a plain
        // click there still just adds a point.
        if (propsRef.current.traceEditing && insideTrace(wx, wy)) {
          dragRef.current = {
            kind: 'trace-pan',
            wx,
            wy,
            lastWX: wx,
            lastWY: wy,
            startX: e.clientX,
            startY: e.clientY,
            moved: false,
          }
          return
        }
        dragRef.current = {
          kind: 'maybe-pick',
          wx,
          wy,
          startX: e.clientX,
          startY: e.clientY,
          lastX: e.clientX,
          lastY: e.clientY,
          moved: false,
        }
        return
      }
      // The rotate knob wins over everything under it.
      const ks = knobScreen()
      if (ks && Math.hypot(sx - ks[0], sy - ks[1]) <= KNOB_R + 5) {
        dragRef.current = { kind: 'rotate', uid: propsRef.current.selectedUid! }
        setActiveUid(propsRef.current.selectedUid)
        cv.style.cursor = 'grabbing'
        return
      }
      const uid = hitTest(wx, wy)
      if (uid) {
        const item = propsRef.current.placed.find((p) => p.uid === uid)!
        dragRef.current = {
          kind: 'item',
          uid,
          offX: wx - item.target[0],
          offY: wy - item.target[1],
          startX: e.clientX,
          startY: e.clientY,
          moved: false,
        }
        setActiveUid(uid)
        cv.style.cursor = 'grabbing'
      } else {
        dragRef.current = {
          kind: 'pan',
          lastX: e.clientX,
          lastY: e.clientY,
          startX: e.clientX,
          startY: e.clientY,
          moved: false,
        }
      }
    }

    const onMove = (e: PointerEvent) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, local(e))
      const drag = dragRef.current
      if (drag?.kind === 'pan' || drag?.kind === 'maybe-pick') sample(e)
      if (drag?.kind === 'pinch') {
        const a = pointers.get(drag.p1)
        const b = pointers.get(drag.p2)
        if (!a || !b) return
        const mid: PlanePoint = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
        const dist = Math.hypot(a[0] - b[0], a[1] - b[1])
        if (drag.lastDist > 1 && dist > 1) {
          const vp = vpRef.current ?? fitViewport()
          const zoom = Math.min(Math.max(vp.zoom * (dist / drag.lastDist), 0.01), 64)
          // The world point that was under the finger midpoint stays under
          // it — that one constraint does both the zoom and the pan.
          const wx = (drag.lastMid[0] - vp.tx) / vp.zoom
          const wy = (drag.lastMid[1] - vp.ty) / vp.zoom
          vpRef.current = { zoom, tx: mid[0] - wx * zoom, ty: mid[1] - wy * zoom }
          scheduleDraw()
        }
        drag.lastMid = mid
        drag.lastDist = dist
        return
      }
      if (!drag) {
        const [sx, sy] = local(e)
        const [wx, wy] = worldFromScreen(sx, sy)
        if (propsRef.current.picking) {
          let cursor = 'crosshair'
          if (propsRef.current.traceEditing) {
            const hit = hitTraceAt(sx, sy)
            if (hit) cursor = hit.kind === 'vertex' ? 'move' : 'copy'
            else if (insideTrace(wx, wy)) cursor = 'move'
          }
          cv.style.cursor = cursor
        } else {
          const ks = knobScreen()
          cv.style.cursor =
            ks && Math.hypot(sx - ks[0], sy - ks[1]) <= KNOB_R + 5
              ? 'grab'
              : hitTest(wx, wy)
                ? 'grab'
                : ''
        }
        return
      }
      if (drag.kind === 'trace-pan') {
        if (
          !drag.moved &&
          Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 4
        ) {
          drag.moved = true
          onTraceEditStartRef.current?.() // one undo step for the whole slide
        }
        if (drag.moved) {
          const [sx, sy] = local(e)
          const [wx, wy] = worldFromScreen(sx, sy)
          onTraceTranslateRef.current?.(wx - drag.lastWX, wy - drag.lastWY)
          drag.lastWX = wx
          drag.lastWY = wy
        }
        return
      }
      if (drag.kind === 'trace-vertex') {
        const [sx, sy] = local(e)
        const [wx, wy] = worldFromScreen(sx, sy)
        onTraceMoveRef.current?.(drag.ring, drag.index, [wx, wy])
        return
      }
      if (drag.kind === 'maybe-pick') {
        if (
          !drag.moved &&
          Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 4
        )
          drag.moved = true
        if (drag.moved) {
          const vp = vpRef.current ?? fitViewport()
          vpRef.current = {
            ...vp,
            tx: vp.tx + (e.clientX - drag.lastX),
            ty: vp.ty + (e.clientY - drag.lastY),
          }
          drag.lastX = e.clientX
          drag.lastY = e.clientY
          scheduleDraw()
        }
        return
      }
      if (drag.kind === 'rotate') {
        const [sx, sy] = local(e)
        const [wx, wy] = worldFromScreen(sx, sy)
        const it = propsRef.current.placed.find((p) => p.uid === drag.uid)
        if (!it) return
        const raw = Math.atan2(wx - it.target[0], -(wy - it.target[1])) * R2D
        const b = e.shiftKey ? Math.round(raw / 15) * 15 : Math.round(raw)
        onRotateRef.current(drag.uid, b)
        return
      }
      if (drag.kind === 'item') {
        if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 4)
          drag.moved = true
        const [sx, sy] = local(e)
        const [wx, wy] = worldFromScreen(sx, sy)
        const target: PlanePoint = [wx - drag.offX, wy - drag.offY]
        setPlaced((prev) => prev.map((p) => (p.uid === drag.uid ? { ...p, target } : p)))
      } else {
        if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 4)
          drag.moved = true
        const vp = vpRef.current ?? fitViewport()
        vpRef.current = {
          ...vp,
          tx: vp.tx + (e.clientX - drag.lastX),
          ty: vp.ty + (e.clientY - drag.lastY),
        }
        drag.lastX = e.clientX
        drag.lastY = e.clientY
        scheduleDraw()
      }
    }

    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId)
      const drag = dragRef.current
      if (drag?.kind === 'pinch') {
        // Either finger lifting ends the pinch; the survivor does nothing
        // until it is pressed again.
        if (e.pointerId === drag.p1 || e.pointerId === drag.p2) {
          dragRef.current = null
          if (vpRef.current) onViewportRef.current?.(vpRef.current)
        }
        if (cv.hasPointerCapture(e.pointerId)) cv.releasePointerCapture(e.pointerId)
        return
      }
      dragRef.current = null
      if (drag?.kind === 'rotate') setActiveUid(null)
      if (drag?.kind === 'item') {
        setActiveUid(null)
        // A press that never moved is a click: select (or toggle off).
        if (!drag.moved)
          onSelectRef.current(propsRef.current.selectedUid === drag.uid ? null : drag.uid)
      }
      if (drag?.kind === 'pan' && !drag.moved) onSelectRef.current(null)
      if (drag?.kind === 'trace-pan' && !drag.moved)
        onPickRef.current([drag.wx, drag.wy])
      // Never moved: it was a click, so it places a point where it started.
      if (drag?.kind === 'maybe-pick' && !drag.moved) onPickRef.current([drag.wx, drag.wy])
      if (drag?.kind === 'pan' || drag?.kind === 'maybe-pick') {
        // A fast release glides on; the glide commits the viewport when it
        // rests. Committing here too would re-render the parent, and that
        // re-registers these handlers — which must not kill the glide.
        if (!(drag.moved && startGlide()) && vpRef.current)
          onViewportRef.current?.(vpRef.current)
      }
      cv.style.cursor = ''
      if (cv.hasPointerCapture(e.pointerId)) cv.releasePointerCapture(e.pointerId)
    }

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      stopGlide()
      const vp = vpRef.current ?? fitViewport()
      const [sx, sy] = local(e)
      const [wx, wy] = worldFromScreen(sx, sy)
      const factor = Math.exp(-e.deltaY * 0.0015)
      const zoom = Math.min(Math.max(vp.zoom * factor, 0.01), 64)
      vpRef.current = { zoom, tx: sx - wx * zoom, ty: sy - wy * zoom }
      scheduleDraw()
      onViewportRef.current?.(vpRef.current)
    }

    // Right-click (primary) or double-click a vertex to delete it.
    // Right-click is the safer gesture: missing the vertex is a no-op, where
    // a missed double-click would append two stray points. Double-click still
    // works and is safe on a vertex, since a press there is a grab, not an
    // append.
    const deleteAt = (e: MouseEvent) => {
      if (!propsRef.current.picking || !propsRef.current.traceEditing) return false
      const r = cv.getBoundingClientRect()
      const hit = hitTraceAt(e.clientX - r.left, e.clientY - r.top)
      if (hit?.kind === 'vertex') {
        onTraceDeleteRef.current?.(hit.ring, hit.index)
        return true
      }
      return false
    }
    const onDblClick = (e: MouseEvent) => {
      deleteAt(e)
    }
    const onContextMenu = (e: MouseEvent) => {
      if (!propsRef.current.picking || !propsRef.current.traceEditing) return
      e.preventDefault() // no browser menu mid-trace, hit or miss
      deleteAt(e)
    }

    cv.addEventListener('dblclick', onDblClick)
    cv.addEventListener('contextmenu', onContextMenu)
    cv.addEventListener('pointerdown', onDown)
    cv.addEventListener('pointermove', onMove)
    cv.addEventListener('pointerup', onUp)
    cv.addEventListener('pointercancel', onUp)
    cv.addEventListener('wheel', onWheel, { passive: false })
    // Deliberately NOT cancelling the glide here: this effect re-runs on
    // parent re-renders, and the glide must outlive those. Unmount cleanup
    // is handled by its own effect below.
    return () => {
      cv.removeEventListener('dblclick', onDblClick)
      cv.removeEventListener('contextmenu', onContextMenu)
      cv.removeEventListener('pointerdown', onDown)
      cv.removeEventListener('pointermove', onMove)
      cv.removeEventListener('pointerup', onUp)
      cv.removeEventListener('pointercancel', onUp)
      cv.removeEventListener('wheel', onWheel)
    }
  }, [worldFromScreen, hitTest, setPlaced, setActiveUid, fitViewport, scheduleDraw])

  // Unmount is the only thing that should cancel a running glide.
  useEffect(() => () => cancelAnimationFrame(glideRef.current), [])

  useImperativeHandle(ref, () => ({
    viewCenter: () => {
      const { w, h } = sizeRef.current
      return worldFromScreen(w / 2, h / 2)
    },
  }))

  // Test hook: canvas2d has no queryRenderedFeatures, so Playwright drives this.
  useEffect(() => {
    const hook: TestHook = {
      viewport: () => vpRef.current ?? fitViewport(),
      screenFromWorld,
      worldFromScreen: (p) => worldFromScreen(p[0], p[1]),
      hitAt: (sx, sy) => {
        const [wx, wy] = worldFromScreen(sx, sy)
        return hitTest(wx, wy)
      },
      count: () => propsRef.current.placed.length,
      trace: () => ({
        picks: propsRef.current.picks,
        rings: propsRef.current.traceRings,
      }),
      bboxPx: (uid) => {
        const it = propsRef.current.placed.find((p) => p.uid === uid)
        if (!it) return null
        const b = planeBounds(it.rings)
        const kpp = propsRef.current.def.kmPerPixel
        return { w: (b.maxX - b.minX) / kpp, h: (b.maxY - b.minY) / kpp }
      },
      items: () =>
        propsRef.current.placed.map((p) => ({
          uid: p.uid,
          target: p.target,
          bearing: p.bearing,
        })),
    }
    ;(window as unknown as { __flat?: TestHook }).__flat = hook
    return () => {
      delete (window as unknown as { __flat?: TestHook }).__flat
    }
  }, [screenFromWorld, worldFromScreen, hitTest, fitViewport])

  return <canvas ref={canvasRef} className="flatview" data-testid="flatview" />
})

export default FlatView
