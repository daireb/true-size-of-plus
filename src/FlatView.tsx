import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react'
import { planeBounds, hitTracePoint } from './lib/flat'
import type { PlanePoint } from './lib/flat'
import type { FlatPlaced, FlatViewport, ImageCanvasDef } from './lib/store'

const D2R = Math.PI / 180

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
    picking,
    picks,
    traceRings = [],
    traceEditing = false,
    onPick,
    onTraceMove,
    onTraceInsert,
    onTraceDelete,
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
    | { kind: 'item'; uid: string; offX: number; offY: number }
    | { kind: 'pan'; lastX: number; lastY: number }
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
    | null
  >(null)

  // Path2D per subject, in local px (km / kmPerPixel), origin at its centroid.
  const pathCache = useRef(new Map<string, { rings: unknown; kpp: number; path: Path2D }>())

  const propsRef = useRef({ placed, activeUid, picks, traceRings, traceEditing, picking, def })
  propsRef.current = { placed, activeUid, picks, traceRings, traceEditing, picking, def }
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
      ctx.strokeStyle = '#ffd166'
      ctx.lineWidth = 2 / zoom
      ctx.setLineDash([6 / zoom, 4 / zoom])
      ctx.beginPath()
      ring.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)))
      ctx.closePath()
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
      // Faint closing hint once the ring could be finished.
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
  }, [placed, activeUid, picks, traceRings, def.kmPerPixel, scheduleDraw])

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

    const onDown = (e: PointerEvent) => {
      // Primary button only: right-click is deletion (contextmenu), and must
      // never fall through to add-a-point or start a pan.
      if (e.button !== 0) return
      const [sx, sy] = local(e)
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
            cv.setPointerCapture(e.pointerId)
            return
          }
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
        cv.setPointerCapture(e.pointerId)
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
        }
        setActiveUid(uid)
        cv.style.cursor = 'grabbing'
      } else {
        dragRef.current = { kind: 'pan', lastX: e.clientX, lastY: e.clientY }
      }
      cv.setPointerCapture(e.pointerId)
    }

    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) {
        const [sx, sy] = local(e)
        const [wx, wy] = worldFromScreen(sx, sy)
        if (propsRef.current.picking) {
          let cursor = 'crosshair'
          if (propsRef.current.traceEditing) {
            const hit = hitTraceAt(sx, sy)
            if (hit) cursor = hit.kind === 'vertex' ? 'move' : 'copy'
          }
          cv.style.cursor = cursor
        } else {
          cv.style.cursor = hitTest(wx, wy) ? 'grab' : ''
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
      if (drag.kind === 'item') {
        const [sx, sy] = local(e)
        const [wx, wy] = worldFromScreen(sx, sy)
        const target: PlanePoint = [wx - drag.offX, wy - drag.offY]
        setPlaced((prev) => prev.map((p) => (p.uid === drag.uid ? { ...p, target } : p)))
      } else {
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
      const drag = dragRef.current
      dragRef.current = null
      if (drag?.kind === 'item') setActiveUid(null)
      if (drag?.kind === 'maybe-pick') {
        // Never moved: it was a click, so it places a point where it started.
        if (!drag.moved) onPickRef.current([drag.wx, drag.wy])
        else if (vpRef.current) onViewportRef.current?.(vpRef.current)
      }
      if (drag?.kind === 'pan' && vpRef.current) onViewportRef.current?.(vpRef.current)
      cv.style.cursor = ''
      if (cv.hasPointerCapture(e.pointerId)) cv.releasePointerCapture(e.pointerId)
    }

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
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
