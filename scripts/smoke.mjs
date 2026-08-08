/**
 * End-to-end smoke test in a real browser (the in-app preview pane blocks
 * Web Workers, which MapLibre needs to parse GeoJSON, so it can't see this).
 *
 * Run: node scripts/smoke.mjs   (dev server must be running on :5173)
 */
import { chromium } from 'playwright'

const URL = process.env.URL ?? 'http://localhost:5173'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })

const errors = []
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`)
})
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))

await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => !!window.__map, null, { timeout: 20000 })

const workersOk = await page.evaluate(async () => {
  try {
    const b = new Blob(['self.onmessage=()=>self.postMessage(1)'], { type: 'text/javascript' })
    const w = new Worker(URL.createObjectURL(b))
    return await new Promise((res) => {
      w.onmessage = () => res(true)
      setTimeout(() => res(false), 2000)
      w.postMessage(0)
    })
  } catch {
    return false
  }
})
console.log('web workers available:', workersOk)

// Capture MapLibre's own error channel before touching anything.
await page.evaluate(() => {
  window.__mapErrors = []
  const attach = () => {
    if (!window.__map) return setTimeout(attach, 50)
    window.__map.on('error', (e) =>
      window.__mapErrors.push(String((e && e.error && e.error.message) || e))
    )
  }
  attach()
})
await page.waitForTimeout(500)

// Spy on setData so we can tell "never called" apart from "called with junk".
await page.evaluate(() => {
  window.__setDataCalls = []
  const src = window.__map.getSource('countries-static')
  const orig = src.setData.bind(src)
  src.setData = (d) => {
    window.__setDataCalls.push({
      n: d?.features?.length ?? null,
      first: d?.features?.[0]
        ? { id: d.features[0].id, props: d.features[0].properties, gtype: d.features[0].geometry?.type }
        : null,
    })
    return orig(d)
  }
})

// Add Greenland through the real UI.
await page.fill('.search input', 'Greenl')
await page.waitForSelector('.results button')
await page.click('.results button')
await page.waitForTimeout(2500)

const state = await page.evaluate(() => {
  const mp = window.__map
  const src = mp.getSource('countries-static')
  return {
    hasSource: !!src,
    styleLoaded: mp.isStyleLoaded(),
    sourceLoaded: mp.isSourceLoaded('countries-static'),
    renderedFeatures: mp.queryRenderedFeatures({ layers: ['countries-active-fill', 'countries-static-fill'] }).length,
    sidebarRows: document.querySelectorAll('.placed li').length,
    center: mp.getCenter(),
    zoom: mp.getZoom(),
    mapErrors: window.__mapErrors,
    setDataCalls: window.__setDataCalls,
    // What did we actually hand to the source?
    sourceData: (() => {
      const d = src && (src._data ?? src._options?.data)
      if (!d) return 'unreadable'
      return {
        type: d.type,
        n: d.features?.length,
        first: d.features?.[0]
          ? { id: d.features[0].id, props: d.features[0].properties, gtype: d.features[0].geometry?.type }
          : null,
      }
    })(),
  }
})
console.log('state:', JSON.stringify(state, null, 2))
console.log('console errors/warnings:', errors.length ? errors : 'none')

await page.screenshot({ path: 'scripts/out-added.png' })

// Now drag it towards the equator and confirm it actually moved.
if (state.renderedFeatures > 0) {
  // Find a screen point that actually hits the fill layer.
  const grab = await page.evaluate(() => {
    const mp = window.__map
    const { width, height } = mp.getCanvas().getBoundingClientRect()
    for (let y = 40; y < height - 40; y += 12) {
      for (let x = 360; x < width - 40; x += 12) {
        if (mp.queryRenderedFeatures([x, y], { layers: ['countries-active-fill', 'countries-static-fill'] }).length)
          return { x, y }
      }
    }
    return null
  })
  if (!grab) throw new Error('could not find a point inside the country')

  const latBefore = await page.evaluate(
    () => window.__map.queryRenderedFeatures({ layers: ['countries-active-fill', 'countries-static-fill'] })[0]
      .geometry.coordinates.flat(3).filter((_, i) => i % 2 === 1)
      .reduce((a, b, _, arr) => a + b / arr.length, 0)
  )

  await page.mouse.move(grab.x, grab.y)
  await page.mouse.down()
  for (let i = 1; i <= 12; i++) await page.mouse.move(grab.x, grab.y + i * 25, { steps: 2 })
  await page.mouse.up()
  await page.waitForTimeout(600)

  const after = await page.evaluate(() => ({
    sidebar: document.querySelector('.placed li .meta')?.innerText.replace(/\n/g, ' | '),
    meanLat: window.__map.queryRenderedFeatures({ layers: ['countries-active-fill', 'countries-static-fill'] })[0]
      ?.geometry.coordinates.flat(3).filter((_, i) => i % 2 === 1)
      .reduce((a, b, _, arr) => a + b / arr.length, 0),
  }))
  console.log(`drag: grabbed (${grab.x},${grab.y}); mean lat ${latBefore.toFixed(2)} -> ${after.meanLat?.toFixed(2)}`)
  console.log('sidebar after drag:', after.sidebar)
  await page.screenshot({ path: 'scripts/out-dragged.png' })
  if (!(after.meanLat < latBefore - 1)) {
    console.log('DRAG FAILED: country did not move south')
    await browser.close()
    process.exit(1)
  }
  console.log('DRAG OK')

  // --- rotate handle on Earth ------------------------------------------------
  // The drag moved the country south; find a point inside it again.
  const grab2 = await page.evaluate(() => {
    const mp = window.__map
    const { width, height } = mp.getCanvas().getBoundingClientRect()
    for (let y = 40; y < height - 40; y += 12)
      for (let x = 360; x < width - 40; x += 12)
        if (mp.queryRenderedFeatures([x, y], { layers: ['countries-active-fill', 'countries-static-fill'] }).length)
          return { x, y }
    return null
  })
  await page.mouse.click(grab2.x, grab2.y) // click (no move) selects
  await page.waitForTimeout(300)
  console.log('select on click:', await page.isVisible('.placed li.open') ? 'OK' : 'FAILED')
  const hs = await page.evaluate(async () => {
    const d = await window.__map.getSource('rotate-handle').getData()
    const knob = d.features.find((f) => f.properties?.role === 'knob')
    const anchor = d.features.find((f) => f.properties?.role === 'anchor')
    const k = window.__map.project(knob.geometry.coordinates)
    const a = window.__map.project(anchor.geometry.coordinates)
    return { k: [k.x, k.y], a: [a.x, a.y] }
  })
  await page.mouse.move(hs.k[0], hs.k[1])
  await page.mouse.down()
  await page.mouse.move(hs.a[0] + 80, hs.a[1], { steps: 6 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  const deg = await page.evaluate(() => document.querySelector('.deg')?.textContent)
  console.log('knob drag on Earth:', /^(8[89]|9[012])°$/.test(deg ?? '') ? `OK (${deg})` : `FAILED (${deg})`)
  if (!/^(8[89]|9[012])°$/.test(deg ?? '')) {
    await browser.close()
    process.exit(1)
  }
}

await browser.close()
process.exit(state.renderedFeatures > 0 ? 0 : 1)
