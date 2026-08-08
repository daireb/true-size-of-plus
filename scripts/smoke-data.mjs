/**
 * Export/import round trip: build state in one browser profile, export the
 * snapshot file, import it into a brand-new profile (empty IndexedDB), and
 * check everything arrives — canvas, calibration, shapes, placements.
 *
 * Run: node scripts/smoke-data.mjs   (dev server must be running)
 */
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

const browser = await chromium.launch()
let failures = 0
const check = (label, pass, detail) => {
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures++
}

// --- profile A: create a world ------------------------------------------------
const ctxA = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  acceptDownloads: true,
})
const a = await ctxA.newPage()
await a.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' })
await a.waitForFunction(() => !!window.__map, null, { timeout: 20000 })
await a.waitForTimeout(2000)

await a.evaluate(async () => {
  const c = document.createElement('canvas')
  c.width = 3000
  c.height = 2000
  const g = c.getContext('2d')
  g.fillStyle = '#4a5d3a'
  g.fillRect(0, 0, 3000, 2000)
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
  const dt = new DataTransfer()
  dt.items.add(new File([blob], 'exportworld.png', { type: 'image/png' }))
  const input = document.querySelector('[data-testid=canvas-file]')
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
})
await a.waitForFunction(() => !!window.__flat, null, { timeout: 10000 })
await a.waitForTimeout(800)

const clickWorld = async (page, wx, wy) => {
  const [sx, sy] = await page.evaluate((p) => window.__flat.screenFromWorld(p), [wx, wy])
  await page.mouse.click(sx, sy)
  await page.waitForTimeout(120)
}
// Calibrate: 1500 px = 600 km -> 0.4 km/px -> map is 1,200 km across.
await clickWorld(a, 750, 1000)
await clickWorld(a, 2250, 1000)
await a.fill('.distance input', '600')
await a.selectOption('.distance select', 'km')
await a.click('.calibrate button.primary')
await a.waitForTimeout(300)

// Trace a shape and place it; also place Ireland.
await a.click('[data-testid=trace-start]')
await clickWorld(a, 1200, 600)
await clickWorld(a, 2000, 600)
await clickWorld(a, 2000, 1200)
await a.fill('.tracebar input', 'Snapshotia')
await a.click('.tracebar button.primary')
await a.waitForTimeout(300)
await a.click('.shapelist li button[title="Place Snapshotia"]')
await a.fill('.search input', 'Ireland')
await a.waitForSelector('.results button')
await a.click('.results button')
await a.waitForTimeout(600)
check('profile A has 2 subjects placed', await a.evaluate(() => window.__flat.count()) === 2)

// Export.
const [download] = await Promise.all([
  a.waitForEvent('download'),
  a.click('.panelfoot button[title="Export everything to a file"]'),
])
// The temp download vanishes when its context closes — copy it out first.
const file = 'scripts/out-snapshot.json'
await download.saveAs(file)
const snap = JSON.parse(readFileSync(file, 'utf8'))
console.log('--- export ---')
check('snapshot has the canvas with its calibration',
  snap.canvases.length === 1 && Math.abs(snap.canvases[0].kmPerPixel - 0.4) < 1e-9,
  `${snap.canvases.length} canvas(es), ${snap.canvases[0]?.kmPerPixel} km/px`)
check('snapshot embeds the image', snap.canvases[0].image.startsWith('data:image/png;base64,'),
  `${(snap.canvases[0].image.length / 1024).toFixed(0)} KB data URL`)
check('snapshot has the shape', snap.shapes.length === 1 && snap.shapes[0].name === 'Snapshotia')
check('snapshot has the session', Object.values(snap.sessions).some((s) => s.placed?.length === 2))
await ctxA.close()

// --- profile B: pristine, import ------------------------------------------------
const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const b = await ctxB.newPage()
const errors = []
b.on('pageerror', (e) => errors.push(String(e.message)))
await b.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' })
await b.waitForFunction(() => !!window.__map, null, { timeout: 20000 })
await b.waitForTimeout(1500)

console.log('--- import into a fresh profile ---')
check('profile B starts empty', await b.$$eval('.chip', (els) => els.length) === 2) // Earth + Add
await b.setInputFiles('[data-testid=import-file]', file)
await b.waitForTimeout(1200) // message + reload
await b.waitForFunction(() => !!window.__map, null, { timeout: 20000 })
await b.waitForTimeout(2500)

check('canvas chip appears after import',
  await b.evaluate(() => [...document.querySelectorAll('.chip')].some((c) => c.textContent === 'exportworld')))
await b.evaluate(() => {
  const chip = [...document.querySelectorAll('.chip')].find((c) => c.textContent === 'exportworld')
  chip.click()
})
await b.waitForFunction(() => !!window.__flat, null, { timeout: 10000 })
await b.waitForTimeout(1500)
check('calibration imported', ((await b.textContent('.extent')) ?? '').includes('1,200 km / 746 mi ×'),
  (await b.textContent('.extent')).replace(/\s+/g, ' '))
check('shape library imported',
  (await b.textContent('.shapelist li .meta')).includes('Snapshotia'))
check('placements rehydrate in the new profile',
  await b.evaluate(() => window.__flat.count()) === 2,
  `${await b.evaluate(() => window.__flat.count())} subjects`)
const names = await b.$$eval('.placed li .meta strong', (els) => els.map((e) => e.textContent))
check('both subjects present by name', names.includes('Snapshotia') && names.includes('Ireland'), names.join(', '))

console.log('\npage errors:', errors.length ? errors : 'none')
if (errors.length) failures++
console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`)
await browser.close()
process.exit(failures === 0 ? 0 : 1)
