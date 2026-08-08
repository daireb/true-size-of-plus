/**
 * End-to-end test of the campaign-map feature against a synthetic image of
 * known dimensions: load -> place -> calibrate -> persist across reload.
 *
 * Run: node scripts/smoke-campaign.mjs   (dev server must be running)
 */
import { chromium } from 'playwright'

const IMG_W = 4000
const IMG_H = 2500
const CLAIM_MILES = 1000 // distance we will assert the middle half represents
const EXPECT_TOTAL_MILES = CLAIM_MILES * 2

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const page = await context.newPage()

const errors = []
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))
page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`) })

await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => !!window.__map, null, { timeout: 20000 })
await page.waitForTimeout(2500)

let failures = 0
const check = (label, pass, detail) => {
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures++
}

// --- load a generated image through the real file input --------------------
await page.evaluate(async ({ w, h }) => {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')
  g.fillStyle = '#2b6'
  g.fillRect(0, 0, w, h)
  g.fillStyle = '#048'
  g.fillRect(0, 0, w / 2, h / 2)
  g.fillStyle = '#fff'
  g.fillRect(w * 0.25, h * 0.9, w * 0.5, 12) // a "scale bar" spanning half the width
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
  const file = new File([blob], 'campaign.png', { type: 'image/png' })
  const dt = new DataTransfer()
  dt.items.add(file)
  const input = document.querySelector('input[type=file]')
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
}, { w: IMG_W, h: IMG_H })

await page.waitForSelector('.campaign-meta', { timeout: 15000 })
console.log('\n--- load ---')
check('image accepted and described', true,
  (await page.textContent('.campaign-meta')).replace(/\s+/g, ' ').trim())

const placed = await page.evaluate(() => {
  const s = window.__map.getSource('campaign-image')
  return { hasSource: !!s, hasLayer: !!window.__map.getLayer('campaign-image-layer'), coords: s?.coordinates }
})
check('image source and layer added', placed.hasSource && placed.hasLayer,
  `bounds lon ${placed.coords?.[0][0].toFixed(2)}..${placed.coords?.[1][0].toFixed(2)}`)
check('image layer sits below the countries', await page.evaluate(() => {
  const ids = window.__map.getStyle().layers.map((l) => l.id)
  return ids.indexOf('campaign-image-layer') < ids.indexOf('countries-static-fill')
}), 'drawn under dragged outlines')

// --- calibrate -------------------------------------------------------------
await page.click('.campaign button.primary') // "Set scale"
await page.waitForSelector('.calibrate', { timeout: 5000 })

// Frame the image, then click the two ends of the "scale bar" (middle half).
await page.evaluate(() => {
  const c = window.__map.getSource('campaign-image').coordinates
  window.__map.fitBounds([[c[0][0], c[2][1]], [c[1][0], c[0][1]]], { padding: 60, duration: 0 })
})
await page.waitForTimeout(1200)

const pts = await page.evaluate(() => {
  const c = window.__map.getSource('campaign-image').coordinates
  const west = c[0][0], east = c[1][0]
  const quarter = (east - west) * 0.25
  const a = window.__map.project([west + quarter, 0])
  const b = window.__map.project([east - quarter, 0])
  return [{ x: a.x, y: a.y }, { x: b.x, y: b.y }]
})
for (const p of pts) {
  await page.mouse.click(p.x, p.y)
  await page.waitForTimeout(300)
}
check('two calibration points registered', await page.isVisible('.distance input'),
  `clicked (${pts[0].x.toFixed(0)},${pts[0].y.toFixed(0)}) and (${pts[1].x.toFixed(0)},${pts[1].y.toFixed(0)})`)

await page.fill('.distance input', String(CLAIM_MILES))
await page.selectOption('.distance select', 'mi')
await page.click('.calibrate button.primary')
await page.waitForTimeout(1200)

console.log('\n--- calibration ---')
const extent = (await page.textContent('.campaign-meta .extent')).replace(/\s+/g, ' ').trim()
const gotMiles = Number(extent.match(/([\d,]+) mi across/)?.[1].replace(/,/g, ''))
check(
  `half the width stated as ${CLAIM_MILES} mi gives a ${EXPECT_TOTAL_MILES} mi map`,
  Math.abs(gotMiles - EXPECT_TOTAL_MILES) <= 2,
  extent
)

// Ground truth, independent of the UI: measure the drawn image on the globe.
const measured = await page.evaluate(() => {
  const c = window.__map.getSource('campaign-image').coordinates
  const R = 6371.0088, D = Math.PI / 180
  const [w, e] = [c[0][0], c[1][0]]
  // great-circle distance along the equator
  return Math.acos(Math.min(1, Math.cos((e - w) * D))) * R
})
const expectKm = EXPECT_TOTAL_MILES * 1.609344
check('image really spans that distance on the globe',
  Math.abs(measured - expectKm) / expectKm < 0.001,
  `${Math.round(measured).toLocaleString()} km measured vs ${Math.round(expectKm).toLocaleString()} km expected`)

await page.screenshot({ path: 'scripts/out-campaign.png' })

// --- a real country dropped on it -----------------------------------------
await page.fill('.search input', 'Ireland')
await page.waitForSelector('.results button')
await page.click('.results button')
await page.waitForTimeout(2000)
await page.evaluate(() => {
  const c = window.__map.getSource('campaign-image').coordinates
  window.__map.fitBounds([[c[0][0], c[2][1]], [c[1][0], c[0][1]]], { padding: 40, duration: 0 })
})
await page.waitForTimeout(1500)
await page.screenshot({ path: 'scripts/out-campaign-country.png' })

// --- persistence -----------------------------------------------------------
console.log('\n--- persistence ---')
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => !!window.__map, null, { timeout: 20000 })
await page.waitForSelector('.campaign-meta', { timeout: 15000 })
await page.waitForTimeout(1500)
const after = (await page.textContent('.campaign-meta .extent')).replace(/\s+/g, ' ').trim()
check('map and its scale survive a reload', after === extent, after)

console.log('\nconsole errors:', errors.length ? errors : 'none')
if (errors.length) failures++

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`)
await browser.close()
process.exit(failures === 0 ? 0 : 1)
