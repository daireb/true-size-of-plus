/**
 * End-to-end test of image canvases: upload -> calibrate -> place a country ->
 * drag/rotate -> pan/zoom -> persistence across reload -> switch back to Earth.
 *
 * Run: node scripts/smoke-flat.mjs   (dev server must be running)
 */
import { chromium } from 'playwright'

const IMG_W = 4000
const IMG_H = 2500

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

// --- upload a generated map through the real input --------------------------
await page.evaluate(async ({ w, h }) => {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')
  g.fillStyle = '#2a6f4e'
  g.fillRect(0, 0, w, h)
  g.fillStyle = '#0a4a78'
  g.fillRect(0, h / 2, w, h / 2)
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
  const dt = new DataTransfer()
  dt.items.add(new File([blob], 'testworld.png', { type: 'image/png' }))
  const input = document.querySelector('[data-testid=canvas-file]')
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
}, { w: IMG_W, h: IMG_H })

await page.waitForSelector('[data-testid=flatview]', { timeout: 15000 })
await page.waitForFunction(() => !!window.__flat, null, { timeout: 10000 })
await page.waitForTimeout(800)

console.log('--- upload ---')
check('canvas chip created and active',
  await page.evaluate(() => document.querySelector('.chip.active')?.textContent) === 'testworld',
  await page.evaluate(() => [...document.querySelectorAll('.chip')].map((c) => c.textContent).join(' | ')))
check('calibration starts automatically', await page.isVisible('.calibrate'))

// --- calibrate: two clicks 2000 image px apart, declared 1000 miles ---------
const clickWorld = async (wx, wy) => {
  const [sx, sy] = await page.evaluate((p) => window.__flat.screenFromWorld(p), [wx, wy])
  await page.mouse.click(sx, sy)
  await page.waitForTimeout(150)
}
await clickWorld(1000, 1250)
await clickWorld(3000, 1250)
check('two picks registered', await page.isVisible('.distance input'))
await page.fill('.distance input', '1000')
await page.selectOption('.distance select', 'mi')
await page.click('.calibrate button.primary')
await page.waitForTimeout(400)

console.log('--- calibration ---')
const extent = (await page.textContent('.extent')).replace(/\s+/g, ' ').trim()
check('4000px map at 1000mi/2000px reads 2,000 mi wide', extent.includes('2,000 mi ×'), extent)

// --- place Ireland at true size ---------------------------------------------
await page.fill('.search input', 'Ireland')
await page.waitForSelector('.results button')
await page.click('.results button')
await page.waitForTimeout(600)

console.log('--- subjects ---')
check('placed list row appears', (await page.textContent('.placed li .meta')).includes('Ireland'))
check('renderer has one subject', await page.evaluate(() => window.__flat.count()) === 1)

const hit = await page.evaluate(() => {
  const it = window.__flat.items()[0]
  const [sx, sy] = window.__flat.screenFromWorld(it.target)
  return { uid: it.uid, hit: window.__flat.hitAt(sx, sy), sx, sy, target: it.target }
})
check('subject is hit-testable where drawn', hit.hit === hit.uid, `hit ${hit.hit}`)

// Ireland's plane bbox is 303x437 km; at 1000 mi / 2000 px (0.8047 km/px)
// that must draw as 377x543 image px. Checked from the actual drawn rings.
const bbox = await page.evaluate(() => window.__flat.bboxPx(window.__flat.items()[0].uid))
check('Ireland drawn at true size (377x543 img px at this scale)',
  Math.abs(bbox.w - 377) < 4 && Math.abs(bbox.h - 543) < 4,
  `${bbox.w.toFixed(0)}x${bbox.h.toFixed(0)} px`)

// --- drag --------------------------------------------------------------------
const before = hit.target
await page.mouse.move(hit.sx, hit.sy)
await page.mouse.down()
for (let i = 1; i <= 10; i++) await page.mouse.move(hit.sx + i * 12, hit.sy + i * 6)
await page.mouse.up()
await page.waitForTimeout(300)
const after = await page.evaluate(() => window.__flat.items()[0].target)
const zoom = await page.evaluate(() => window.__flat.viewport().zoom)
check('drag moves the subject', Math.abs(after[0] - before[0] - 120 / zoom) < 3 && after[0] > before[0],
  `moved ${(after[0] - before[0]).toFixed(1)} img px (expected ~${(120 / zoom).toFixed(1)})`)

// --- rotate -------------------------------------------------------------------
await page.click('.placed li .row') // expand the row to reach the slider
await page.waitForTimeout(150)
await page.evaluate(() => {
  const s = document.querySelector('.rotate input')
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  set.call(s, '55')
  s.dispatchEvent(new Event('input', { bubbles: true }))
  s.dispatchEvent(new Event('change', { bubbles: true }))
})
await page.waitForTimeout(200)
check('rotation applies', await page.evaluate(() => window.__flat.items()[0].bearing) === 55,
  `bearing ${await page.evaluate(() => window.__flat.items()[0].bearing)}`)

// --- on-map rotate handle -----------------------------------------------------
console.log('--- rotate handle ---')
await page.mouse.click(1200, 100) // empty space deselects
await page.waitForTimeout(200)
check('clicking empty space deselects', !(await page.isVisible('.placed li.open')))
const subj = await page.evaluate(() => {
  const it = window.__flat.items()[0]
  return { s: window.__flat.screenFromWorld(it.target), b: it.bearing }
})
await page.mouse.click(subj.s[0], subj.s[1]) // click subject selects it
await page.waitForTimeout(200)
check('clicking a subject selects it', await page.isVisible('.placed li.open'))

// Knob sits 46px from the anchor in the bearing direction (55°). Drag it to
// due-right of the anchor: bearing becomes 90.
const a55 = (55 * Math.PI) / 180
const knob = [subj.s[0] + Math.sin(a55) * 46, subj.s[1] - Math.cos(a55) * 46]
await page.mouse.move(knob[0], knob[1])
await page.mouse.down()
await page.mouse.move(subj.s[0] + 80, subj.s[1], { steps: 6 })
await page.mouse.up()
await page.waitForTimeout(200)
const bKnob = await page.evaluate(() => window.__flat.items()[0].bearing)
check('dragging the knob rotates the subject', Math.abs(bKnob - 90) <= 2, `bearing ${bKnob}`)

// Keyboard nudges on the selection.
await page.keyboard.press(']')
await page.waitForTimeout(120)
const bNudge = await page.evaluate(() => window.__flat.items()[0].bearing)
check('] nudges +1°', bNudge === bKnob + 1, `bearing ${bNudge}`)
await page.keyboard.press('Shift+[')
await page.waitForTimeout(120)
const bBig = await page.evaluate(() => window.__flat.items()[0].bearing)
check('Shift+[ nudges -15°', bBig === bNudge - 15, `bearing ${bBig}`)

// Back to 55° so the persistence assertions below stay meaningful.
await page.evaluate(() => {
  const s = document.querySelector('.rotate input')
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  set.call(s, '55')
  s.dispatchEvent(new Event('input', { bubbles: true }))
  s.dispatchEvent(new Event('change', { bubbles: true }))
})
await page.waitForTimeout(200)

// --- pan / zoom ---------------------------------------------------------------
const vp0 = await page.evaluate(() => window.__flat.viewport())
await page.mouse.move(1100, 700)
await page.mouse.down()
await page.mouse.move(1000, 650, { steps: 4 })
await page.mouse.up()
const vp1 = await page.evaluate(() => window.__flat.viewport())
check('drag on empty space pans', Math.abs(vp1.tx - vp0.tx + 100) < 2 && Math.abs(vp1.ty - vp0.ty + 50) < 2,
  `dtx ${(vp1.tx - vp0.tx).toFixed(1)} dty ${(vp1.ty - vp0.ty).toFixed(1)}`)
await page.mouse.move(640, 400)
await page.mouse.wheel(0, -400)
await page.waitForTimeout(200)
const vp2 = await page.evaluate(() => window.__flat.viewport())
check('wheel zooms', vp2.zoom > vp1.zoom, `${vp1.zoom.toFixed(3)} -> ${vp2.zoom.toFixed(3)}`)

// --- persistence ---------------------------------------------------------------
await page.waitForTimeout(700) // let the debounced session write land
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => !!window.__flat, null, { timeout: 20000 })
await page.waitForTimeout(1500)

console.log('--- persistence ---')
check('image canvas is still the active one after reload',
  await page.evaluate(() => document.querySelector('.chip.active')?.textContent) === 'testworld')
check('calibration survives reload',
  ((await page.textContent('.extent')) ?? '').includes('2,000 mi ×'))
const restored = await page.evaluate(() => window.__flat.items())
check('subject restored with position and bearing', restored.length === 1 && restored[0].bearing === 55 &&
  Math.abs(restored[0].target[0] - after[0]) < 1,
  JSON.stringify(restored.map((r) => ({ t: r.target.map(Math.round), b: r.bearing }))))
const vpR = await page.evaluate(() => window.__flat.viewport())
check('viewport survives reload', Math.abs(vpR.zoom - vp2.zoom) < 1e-6, `zoom ${vpR.zoom.toFixed(3)}`)

// --- switch to Earth and back ---------------------------------------------------
await page.click('.chip') // first chip is Earth
await page.waitForTimeout(1200)
console.log('--- canvas switching ---')
check('Earth becomes visible', await page.evaluate(() => {
  const v = document.querySelector('.view')
  return getComputedStyle(v).visibility === 'visible' && !!document.querySelector('.maplibregl-canvas')
}))
check('Earth session is separate (no Ireland here)',
  await page.evaluate(() => document.querySelectorAll('.placed li').length) === 0)
await page.click('.chipwrap .chip')
await page.waitForTimeout(600)
check('back on the image canvas, subject still there',
  await page.evaluate(() => window.__flat?.count()) === 1)

// --- delete: confirmation dialog -----------------------------------------------
await page.click('[data-testid=map-settings]')
await page.waitForTimeout(150)
await page.click('button[title="Delete map"]')
await page.waitForTimeout(200)
check('delete asks for confirmation naming the map',
  await page.isVisible('.modal') && (await page.textContent('.modal')).includes('testworld') &&
    (await page.$$eval('.chipwrap', (els) => els.length)) === 1)
await page.click('.modal button.danger')
await page.waitForTimeout(600)
check('deleting the canvas falls back to Earth',
  await page.evaluate(() => document.querySelector('.chip.active')?.textContent?.includes('Earth')))
check('canvas delete offers undo', await page.isVisible('.undo'))

console.log('\nconsole errors:', errors.length ? errors : 'none')
if (errors.length) failures++
console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`)
await browser.close()
process.exit(failures === 0 ? 0 : 1)
