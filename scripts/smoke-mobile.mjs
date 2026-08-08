/**
 * Mobile behaviour: the panel collapses to a bottom sheet, and pinch-zoom
 * works on both views. Touch is driven through CDP so the real touch -> pointer
 * event pipeline runs, not synthetic PointerEvents.
 *
 * Run: node scripts/smoke-mobile.mjs   (dev server must be running)
 */
import { chromium } from 'playwright'

const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
})
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))
page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`) })

let failures = 0
const check = (label, pass, detail) => {
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures++
}

const cdp = await context.newCDPSession(page)

/** Two-finger pinch: both fingers move from `from` pairs to `to` pairs. */
const pinch = async (from, to, steps = 12) => {
  const at = (t) =>
    from.map((f, i) => ({
      x: f.x + (to[i].x - f.x) * t,
      y: f.y + (to[i].y - f.y) * t,
      id: i,
    }))
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(0) })
  for (let s = 1; s <= steps; s++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(s / steps) })
    await page.waitForTimeout(16)
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => !!window.__map, null, { timeout: 20000 })
await page.waitForTimeout(2000)

// --- panel is a collapsed bottom sheet ---------------------------------------
console.log('--- panel ---')
check('panel starts collapsed on a phone', await page.isVisible('.panel.closed'))
check('collapsed panel hides the search box', !(await page.isVisible('.search input')))
const panelBox = await page.locator('.panel').boundingBox()
check('collapsed sheet sits at the bottom, map on top', panelBox.y > 700, `top at ${panelBox.y}`)

await page.tap('.panel header')
await page.waitForTimeout(300)
check('tapping the header expands it', !(await page.isVisible('.panel.closed')))
check('search is reachable when open', await page.isVisible('.search input'))
const openBox = await page.locator('.panel').boundingBox()
check('open sheet still leaves the map visible', openBox.height < 844 * 0.6, `height ${openBox.height}`)

// --- placing a country auto-collapses the sheet ------------------------------
await page.fill('.search input', 'Greenl')
await page.waitForSelector('.results button')
await page.click('.results button')
await page.waitForTimeout(2500)
check('placing a country collapses the sheet to show it', await page.isVisible('.panel.closed'))

// --- pinch on Earth ----------------------------------------------------------
console.log('--- earth pinch ---')
const z0 = await page.evaluate(() => window.__map.getZoom())
await pinch(
  [{ x: 165, y: 350 }, { x: 225, y: 450 }],
  [{ x: 90, y: 250 }, { x: 300, y: 550 }]
)
await page.waitForTimeout(400)
const z1 = await page.evaluate(() => window.__map.getZoom())
check('pinch-out zooms Earth in', z1 > z0 + 0.5, `zoom ${z0.toFixed(2)} -> ${z1.toFixed(2)}`)

// One finger on Greenland, then pinch: must zoom, not drag the country.
const grab = await page.evaluate(() => {
  const mp = window.__map
  const { width, height } = mp.getCanvas().getBoundingClientRect()
  for (let y = 40; y < height - 200; y += 10)
    for (let x = 20; x < width - 20; x += 10)
      if (mp.queryRenderedFeatures([x, y], { layers: ['countries-active-fill', 'countries-static-fill'] }).length)
        return { x, y }
  return null
})
check('found Greenland on screen to pinch over', !!grab, JSON.stringify(grab))
if (grab) {
  // Mean latitude of the placement's SOURCE geometry (not tile-clipped
  // rendered features): it only changes if the country is actually dragged.
  const meanLat = () =>
    page.evaluate(async () => {
      const d = await window.__map.getSource('countries-static').getData()
      const f = d.features[0]
      if (!f) return null
      const lats = f.geometry.coordinates.flat(3).filter((_, i) => i % 2 === 1)
      return lats.reduce((a, b) => a + b, 0) / lats.length
    })
  const latBefore = await meanLat()
  const z2 = await page.evaluate(() => window.__map.getZoom())
  // Fingers land one after the other, like a real pinch: the first starts a
  // country drag, the second must cancel it and hand the gesture to MapLibre.
  const f1 = { x: grab.x, y: grab.y, id: 0 }
  const f2 = { x: grab.x + 60, y: grab.y + 80, id: 1 }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [f1] })
  await page.waitForTimeout(60)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [f1, f2] })
  for (let s = 1; s <= 12; s++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: f1.x - (40 * s) / 12, y: f1.y - (40 * s) / 12, id: 0 },
        { x: f2.x + (60 * s) / 12, y: f2.y + (60 * s) / 12, id: 1 },
      ],
    })
    await page.waitForTimeout(16)
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await page.waitForTimeout(400)
  const z3 = await page.evaluate(() => window.__map.getZoom())
  const latAfter = await meanLat()
  check('pinch starting on a country still zooms', z3 > z2 + 0.3, `zoom ${z2.toFixed(2)} -> ${z3.toFixed(2)}`)
  check('…and does not drag the country', latAfter !== null && Math.abs(latAfter - latBefore) < 0.5,
    `mean lat ${latBefore?.toFixed(2)} -> ${latAfter?.toFixed(2)}`)
}

// --- pinch on a flat canvas ---------------------------------------------------
console.log('--- flat pinch ---')
await page.evaluate(async () => {
  const c = document.createElement('canvas')
  c.width = 2000
  c.height = 1200
  const g = c.getContext('2d')
  g.fillStyle = '#2a6f4e'
  g.fillRect(0, 0, 2000, 1200)
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
  const dt = new DataTransfer()
  dt.items.add(new File([blob], 'phoneworld.png', { type: 'image/png' }))
  const input = document.querySelector('[data-testid=canvas-file]')
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
})
await page.waitForSelector('[data-testid=flatview]', { timeout: 15000 })
await page.waitForFunction(() => !!window.__flat, null, { timeout: 10000 })
await page.waitForTimeout(800)

const fv0 = await page.evaluate(() => window.__flat.viewport())
// Under the fixed midpoint (195, 300) before the gesture starts.
const anchorWorld = await page.evaluate(() => window.__flat.worldFromScreen([195, 300]))
await pinch(
  [{ x: 165, y: 300 }, { x: 225, y: 300 }],   // 60px apart
  [{ x: 75, y: 300 }, { x: 315, y: 300 }]     // 240px apart -> ~4x
)
await page.waitForTimeout(300)
const fv1 = await page.evaluate(() => window.__flat.viewport())
check('pinch-out zooms the flat canvas ~4x', fv1.zoom / fv0.zoom > 3 && fv1.zoom / fv0.zoom < 5,
  `zoom ${fv0.zoom.toFixed(3)} -> ${fv1.zoom.toFixed(3)} (${(fv1.zoom / fv0.zoom).toFixed(2)}x)`)
const anchorAfter = await page.evaluate(
  (w) => window.__flat.screenFromWorld(w), anchorWorld)
check('point under the finger midpoint stays put',
  Math.hypot(anchorAfter[0] - 195, anchorAfter[1] - 300) < 12,
  `drifted to (${anchorAfter[0].toFixed(0)}, ${anchorAfter[1].toFixed(0)})`)

// Pinch-in goes back out.
await pinch(
  [{ x: 75, y: 300 }, { x: 315, y: 300 }],
  [{ x: 165, y: 300 }, { x: 225, y: 300 }]
)
await page.waitForTimeout(300)
const fv2 = await page.evaluate(() => window.__flat.viewport())
check('pinch-in zooms back out', fv2.zoom < fv1.zoom * 0.5,
  `zoom ${fv1.zoom.toFixed(3)} -> ${fv2.zoom.toFixed(3)}`)

// One-finger drag still pans, and a fast release keeps gliding (momentum).
const pan0 = await page.evaluate(() => window.__flat.viewport())
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 200, y: 300, id: 0 }] })
for (let s = 1; s <= 10; s++) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 200 - s * 8, y: 300 - s * 4, id: 0 }] })
  await page.waitForTimeout(16)
}
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
const atRelease = await page.evaluate(() => window.__flat.viewport())
await page.waitForTimeout(700)
const settled = await page.evaluate(() => window.__flat.viewport())
check('one-finger drag still pans the flat canvas',
  atRelease.tx - pan0.tx < -70 && atRelease.ty - pan0.ty < -33,
  `dtx ${(atRelease.tx - pan0.tx).toFixed(1)} dty ${(atRelease.ty - pan0.ty).toFixed(1)}`)
check('release at speed glides on like MapLibre',
  settled.tx < atRelease.tx - 15 && settled.ty < atRelease.ty - 7,
  `glided a further ${(atRelease.tx - settled.tx).toFixed(0)}px`)

console.log('\nconsole errors:', errors.length ? errors : 'none')
if (errors.length) failures++
console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`)
await browser.close()
process.exit(failures === 0 ? 0 : 1)
