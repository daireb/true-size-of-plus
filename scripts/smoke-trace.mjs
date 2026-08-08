/**
 * End-to-end test of shape tracing: trace on an image canvas -> save -> place
 * on the same canvas and on Earth -> trace on Earth -> place on the image
 * canvas -> persistence -> deletion cascades.
 *
 * Run: node scripts/smoke-trace.mjs   (dev server must be running)
 */
import { chromium } from 'playwright'

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))
page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`) })

let failures = 0
const check = (label, pass, detail) => {
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures++
}

await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => !!window.__map, null, { timeout: 20000 })
await page.waitForTimeout(2000)

// --- set up a calibrated canvas: 4000px / 2000 mi -> 0.8047 km/px -----------
await page.evaluate(async () => {
  const c = document.createElement('canvas')
  c.width = 4000
  c.height = 2500
  const g = c.getContext('2d')
  g.fillStyle = '#3d6b52'
  g.fillRect(0, 0, 4000, 2500)
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
  const dt = new DataTransfer()
  dt.items.add(new File([blob], 'traceworld.png', { type: 'image/png' }))
  const input = document.querySelector('[data-testid=canvas-file]')
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
})
await page.waitForFunction(() => !!window.__flat, null, { timeout: 10000 })
await page.waitForTimeout(800)
const clickWorld = async (wx, wy) => {
  const [sx, sy] = await page.evaluate((p) => window.__flat.screenFromWorld(p), [wx, wy])
  await page.mouse.click(sx, sy)
  await page.waitForTimeout(120)
}
await clickWorld(1000, 1250)
await clickWorld(3000, 1250)
await page.fill('.distance input', '1000')
await page.selectOption('.distance select', 'mi')
await page.click('.calibrate button.primary')
await page.waitForTimeout(300)
const KPP = (1000 * 1.609344) / 2000 // 0.8047 km/px

// --- trace a 1000x500 image-px rectangle -------------------------------------
console.log('--- trace on the image canvas ---')
await page.click('.shapes .campaign-actions button') // "Trace a shape"
check('trace mode entered', await page.isVisible('.shapes .calibrate'))
// Clicks must land clear of the side panel (viewport x > ~340), so the
// rectangle sits in the middle of the image: still exactly 1000x500 px.
await clickWorld(1400, 600)
await clickWorld(2400, 600)
await clickWorld(2400, 1100)
await clickWorld(1400, 1100)
check('picks counted', (await page.textContent('.shapes .calibrate p')).includes('4 points'))
await page.fill('.shapes .distance input', 'Testlands')
await page.click('.shapes .calibrate button.primary')
await page.waitForTimeout(400)

const expectedArea = 1000 * KPP * 500 * KPP // 323,764 km²
const row = (await page.textContent('.shapelist li .meta')).replace(/\s+/g, ' ')
const gotArea = Number(row.match(/([\d,]+) km²/)?.[1].replace(/,/g, ''))
check('shape saved with correct area (~323,764 km²)',
  row.includes('Testlands') && Math.abs(gotArea - expectedArea) / expectedArea < 0.005,
  `${row} (expected ~${Math.round(expectedArea).toLocaleString()})`)
check('trace mode exits after save', !(await page.isVisible('.shapes .calibrate')))

// --- place it on the same canvas ----------------------------------------------
await page.click('.shapelist li button[title="Place Testlands"]')
await page.waitForTimeout(300)
console.log('--- place on image canvas ---')
check('subject added to canvas', await page.evaluate(() => window.__flat.count()) === 1)
const bbox = await page.evaluate(() => window.__flat.bboxPx(window.__flat.items()[0].uid))
check('placed at exactly its traced size (1000x500 img px)',
  Math.abs(bbox.w - 1000) < 2 && Math.abs(bbox.h - 500) < 2, `${bbox.w.toFixed(1)}x${bbox.h.toFixed(1)} px`)
check('row shows in placed list', (await page.textContent('.placed li .meta')).includes('Testlands'))

// --- place it on Earth -----------------------------------------------------------
await page.click('.chip') // Earth
await page.waitForTimeout(1200)
await page.click('.shapelist li button[title="Place Testlands"]')
await page.waitForTimeout(1500)
console.log('--- place on Earth ---')
check('Earth placed list gains the shape',
  (await page.textContent('.placed li .meta') ?? '').includes('Testlands'))
const drawn = await page.evaluate(() =>
  window.__map.queryRenderedFeatures({ layers: ['countries-active-fill', 'countries-static-fill'] }).length
)
check('shape renders on Earth', drawn > 0, `${drawn} features`)

// --- trace on Earth ---------------------------------------------------------------
console.log('--- trace on Earth ---')
// Pin the camera so the trace points project on-screen and clear of the panel.
await page.evaluate(() => window.__map.jumpTo({ center: [-14, 64.5], zoom: 4 }))
await page.waitForTimeout(600)
await page.click('.shapes .campaign-actions button')
await page.waitForTimeout(300)
// A patch over the north Atlantic, ~roughly Iceland-sized.
for (const [lon, lat] of [[-24, 63], [-16, 63], [-16, 66], [-24, 66]]) {
  const pt = await page.evaluate(([ln, lt]) => window.__map.project([ln, lt]), [lon, lat])
  await page.mouse.click(pt.x, pt.y)
  await page.waitForTimeout(120)
}
await page.fill('.shapes .distance input', 'EarthPatch')
await page.click('.shapes .calibrate button.primary')
await page.waitForTimeout(400)
const rows = await page.$$eval('.shapelist li .meta', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ')))
check('second shape saved from Earth trace', rows.some((r) => r.includes('EarthPatch') && r.includes('traced on Earth')), rows.join(' | '))
// ~8° lon x 3° lat at 64.5N: ≈ 385 km x 334 km ≈ 128,000 km²
const patchArea = await page.evaluate(() => {
  const el = [...document.querySelectorAll('.shapelist li .meta')].find((e) => e.textContent.includes('EarthPatch'))
  return el.textContent
})
check('Earth trace area plausible (~128k km²)', /1[12][0-9],\d{3} km²/.test(patchArea), patchArea.replace(/\s+/g, ' '))

// --- place the Earth trace on the image canvas ------------------------------------
await page.click('.chip:nth-child(2)')
await page.waitForFunction(() => !!window.__flat, null, { timeout: 10000 })
await page.waitForTimeout(600)
await page.click('.shapelist li button[title="Place EarthPatch"]')
await page.waitForTimeout(300)
console.log('--- cross-canvas ---')
check('image canvas now has both subjects', await page.evaluate(() => window.__flat.count()) === 2)
const pb = await page.evaluate(() => window.__flat.bboxPx(window.__flat.items()[1].uid))
// 385 km / 0.8047 ≈ 478 px wide, 334 km / 0.8047 ≈ 415 px tall
check('Earth trace lands true-sized (~478x415 img px)',
  Math.abs(pb.w - 478) < 25 && Math.abs(pb.h - 415) < 25, `${pb.w.toFixed(0)}x${pb.h.toFixed(0)} px`)

// --- persistence --------------------------------------------------------------------
await page.waitForTimeout(700)
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => !!window.__flat, null, { timeout: 20000 })
await page.waitForTimeout(1500)
console.log('--- persistence ---')
check('shapes survive reload', await page.$$eval('.shapelist li', (els) => els.length) === 2)
check('placed shapes rehydrate', await page.evaluate(() => window.__flat.count()) === 2)

// --- deletion cascades ----------------------------------------------------------------
await page.click('.shapelist li button[title="Delete Testlands"]')
await page.waitForTimeout(400)
console.log('--- deletion ---')
check('shape removed from library', await page.$$eval('.shapelist li', (els) => els.length) === 1)
check('its placements evict too', await page.evaluate(() => window.__flat.count()) === 1)

// Clean up: delete the test canvas and the remaining shape.
await page.click('.shapelist li button[title="Delete EarthPatch"]')
await page.click('.canvas-info button[title="Delete map"]')
await page.waitForTimeout(400)

console.log('\nconsole errors:', errors.length ? errors : 'none')
if (errors.length) failures++
console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`)
await browser.close()
process.exit(failures === 0 ? 0 : 1)
