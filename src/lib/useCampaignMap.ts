import { useCallback, useEffect, useRef, useState } from 'react'
import type * as maplibregl from 'maplibre-gl'
import type { LonLat } from './geo'
import {
  boundsFor,
  cornersFor,
  calibrate,
  describeExtent,
  KM_PER_MILE,
  loadStoredMap,
  saveStoredMap,
  clearStoredMap,
} from './campaign'
import type { CampaignMap } from './campaign'

export const IMAGE_SOURCE = 'campaign-image'
export const IMAGE_LAYER = 'campaign-image-layer'
const CALIB_SOURCE = 'campaign-calibration'
const CALIB_LINE = 'campaign-calibration-line'
const CALIB_POINTS = 'campaign-calibration-points'

/** Placeholder scale so a freshly-loaded image is visible before calibration. */
const DEFAULT_KM_PER_PIXEL = 1

const readSize = (blob: Blob) =>
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

export function useCampaignMap(
  mapRef: React.RefObject<maplibregl.Map | null>,
  mapReady: boolean
) {
  const [map, setMap] = useState<CampaignMap | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [opacity, setOpacity] = useState(0.85)
  const [error, setError] = useState<string | null>(null)
  /** null = off, [] = waiting for first click, [a] = waiting for second. */
  const [picks, setPicks] = useState<LonLat[] | null>(null)

  const urlRef = useRef<string | null>(null)
  const setObjectUrl = useCallback((next: string | null) => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    urlRef.current = next
    setUrl(next)
  }, [])

  // Restore whatever was loaded last session.
  useEffect(() => {
    loadStoredMap().then((stored) => {
      if (!stored) return
      setObjectUrl(URL.createObjectURL(stored.blob))
      setMap({
        name: stored.name,
        width: stored.width,
        height: stored.height,
        kmPerPixel: stored.kmPerPixel,
      })
    })
    return () => setObjectUrl(null)
  }, [setObjectUrl])

  // --- draw the image ------------------------------------------------------
  useEffect(() => {
    const m = mapRef.current
    if (!m || !mapReady) return

    if (!map || !url) {
      if (m.getLayer(IMAGE_LAYER)) m.removeLayer(IMAGE_LAYER)
      if (m.getSource(IMAGE_SOURCE)) m.removeSource(IMAGE_SOURCE)
      return
    }

    const coordinates = cornersFor(boundsFor(map))
    const existing = m.getSource(IMAGE_SOURCE) as maplibregl.ImageSource | undefined
    if (existing) {
      existing.updateImage({ url, coordinates })
    } else {
      m.addSource(IMAGE_SOURCE, { type: 'image', url, coordinates })
      // Beneath the countries, so dragged outlines read on top of the map.
      const below = m.getLayer('countries-static-fill') ? 'countries-static-fill' : undefined
      m.addLayer(
        { id: IMAGE_LAYER, type: 'raster', source: IMAGE_SOURCE, paint: { 'raster-opacity': opacity } },
        below
      )
    }
  }, [map, url, mapReady, mapRef, opacity])

  useEffect(() => {
    const m = mapRef.current
    if (m?.getLayer(IMAGE_LAYER)) m.setPaintProperty(IMAGE_LAYER, 'raster-opacity', opacity)
  }, [opacity, mapRef, map, url])

  // --- calibration ---------------------------------------------------------
  useEffect(() => {
    const m = mapRef.current
    if (!m || !mapReady) return

    const feature = (): GeoJSON.FeatureCollection => ({
      type: 'FeatureCollection',
      features: !picks?.length
        ? []
        : [
            ...picks.map((p): GeoJSON.Feature => ({
              type: 'Feature',
              geometry: { type: 'Point', coordinates: p },
              properties: {},
            })),
            ...(picks.length === 2
              ? [{
                  type: 'Feature' as const,
                  geometry: { type: 'LineString' as const, coordinates: picks },
                  properties: {},
                }]
              : []),
          ],
    })

    const src = m.getSource(CALIB_SOURCE) as maplibregl.GeoJSONSource | undefined
    if (src) {
      src.setData(feature())
      return
    }
    if (!picks) return
    m.addSource(CALIB_SOURCE, { type: 'geojson', data: feature() })
    m.addLayer({
      id: CALIB_LINE,
      type: 'line',
      source: CALIB_SOURCE,
      filter: ['==', ['geometry-type'], 'LineString'],
      paint: { 'line-color': '#ffd166', 'line-width': 2.5, 'line-dasharray': [2, 1.5] },
    })
    m.addLayer({
      id: CALIB_POINTS,
      type: 'circle',
      source: CALIB_SOURCE,
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': 5,
        'circle-color': '#ffd166',
        'circle-stroke-color': '#1b1f27',
        'circle-stroke-width': 2,
      },
    })
  }, [picks, mapReady, mapRef])

  useEffect(() => {
    const m = mapRef.current
    if (!m || !mapReady || !picks || picks.length >= 2) return
    const onClick = (e: maplibregl.MapMouseEvent) => {
      setPicks((prev) => (prev && prev.length < 2 ? [...prev, [e.lngLat.lng, e.lngLat.lat]] : prev))
    }
    m.on('click', onClick)
    return () => { m.off('click', onClick) }
  }, [picks, mapReady, mapRef])

  const loadFile = useCallback(
    async (file: File) => {
      setError(null)
      if (!file.type.startsWith('image/')) {
        setError('That file is not an image.')
        return
      }
      try {
        const { width, height } = await readSize(file)
        const next: CampaignMap = {
          name: file.name,
          width,
          height,
          // Sized so a fresh image is a sensible fraction of the globe until
          // it gets calibrated.
          kmPerPixel: (DEFAULT_KM_PER_PIXEL * 4000) / width,
        }
        setObjectUrl(URL.createObjectURL(file))
        setMap(next)
        await saveStoredMap({ ...next, blob: file })
      } catch (e) {
        setError(String(e instanceof Error ? e.message : e))
      }
    },
    [setObjectUrl]
  )

  const applyCalibration = useCallback(
    async (value: number, unit: 'mi' | 'km') => {
      if (!map || !picks || picks.length < 2) return false
      const km = unit === 'mi' ? value * KM_PER_MILE : value
      const kmPerPixel = calibrate(map, boundsFor(map), picks[0], picks[1], km)
      if (kmPerPixel === null) {
        setError('That line is too short, or the distance is not a positive number.')
        return false
      }
      const next = { ...map, kmPerPixel }
      setMap(next)
      setPicks(null)
      setError(null)
      const stored = await loadStoredMap()
      if (stored) await saveStoredMap({ ...stored, ...next })
      return true
    },
    [map, picks]
  )

  const remove = useCallback(async () => {
    setMap(null)
    setObjectUrl(null)
    setPicks(null)
    setError(null)
    await clearStoredMap()
  }, [setObjectUrl])

  return {
    map,
    url,
    opacity,
    setOpacity,
    error,
    picks,
    calibrating: picks !== null,
    startCalibration: () => { setError(null); setPicks([]) },
    cancelCalibration: () => setPicks(null),
    loadFile,
    applyCalibration,
    remove,
    extent: map ? describeExtent(map) : null,
  }
}
